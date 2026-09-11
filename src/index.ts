import type { Plugin } from '@opencode-ai/plugin'
import { AccountManager, parseModelPins } from './accounts.ts'
import { authorize, exchange } from './auth.ts'
import {
  ANTHROPIC_AUTH_MODEL_PIN_ENV_VAR,
  resolveClaudeCodeVersion,
  resolveQuotaCacheTtlMs,
  shouldProbeIdleAccounts,
} from './config.ts'
import { CLAUDE_CODE_VERSION, CLIENT_ID, TOKEN_URL } from './constants.ts'
import { fetchAccountEmail, fetchQuota } from './quota.ts'
import {
  accountFromOAuthSnapshot,
  addAccount,
  loadAccounts,
  resolveStoragePath,
  type StoredAccount,
  saveAccounts,
} from './storage.ts'
import {
  isStrategyOverridden,
  parseStrategy,
  pickForStrategy,
  STRATEGY_ENV_VAR,
  type StrategyName,
} from './strategy.ts'
import { refreshAccessToken } from './token-refresh.ts'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

type OAuthSnapshot = {
  type: string
  access?: string
  refresh?: string
  expires?: number
}

async function logPluginEvent(
  client: unknown,
  level: 'warn' | 'error',
  message: string,
): Promise<void> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose app.log
    await (client as any)?.app?.log({
      body: { service: 'anthropic-auth', level, message },
    })
  } catch {
    /* Logging is best-effort; the request path still applies. */
  }
}

/** Parse Retry-After (seconds, or HTTP-date) to ms. Defaults to 60s. */
export function parseRetryAfterMs(response: Response): number {
  const header = response.headers.get('retry-after')?.trim()
  if (header) {
    const seconds = Number.parseFloat(header)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const date = Date.parse(header)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  return 60_000
}

async function syncAuthJson(
  client: unknown,
  tokens: { refresh: string; access: string; expires: number },
): Promise<void> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
    await (client as any).auth.set({
      path: { id: 'anthropic' },
      body: { type: 'oauth', ...tokens },
    })
  } catch {
    // Best-effort: the multi-account store is the source of truth.
  }
}

export const AnthropicAuthPlugin: Plugin = async ({ client }) => {
  // Resolved once per plugin instance so every request reports the same
  // version in both the user-agent and the billing header.
  const resolution = resolveClaudeCodeVersion()
  if (resolution.type === 'invalid') {
    await logPluginEvent(client, 'error', resolution.error)
  } else if (resolution.type === 'outdated') {
    await logPluginEvent(client, 'warn', resolution.warning)
  }
  // Only a malformed override lacks a usable version; an outdated one was set
  // deliberately, so it is reported as configured.
  const claudeCodeVersion =
    resolution.type === 'invalid' ? CLAUDE_CODE_VERSION : resolution.version

  const strategyRaw = process.env[STRATEGY_ENV_VAR]
  const strategy: StrategyName = parseStrategy(strategyRaw)
  if (isStrategyOverridden(strategyRaw)) {
    await logPluginEvent(
      client,
      'warn',
      `${STRATEGY_ENV_VAR} is set to ${JSON.stringify(strategyRaw)} which is not a known strategy (smart|lowest_quota|round_robin). Using "smart".`,
    )
  }
  const quotaTtlMs = resolveQuotaCacheTtlMs()
  const modelPins = parseModelPins(
    process.env[ANTHROPIC_AUTH_MODEL_PIN_ENV_VAR],
  )
  const storagePath = resolveStoragePath()

  return {
    auth: {
      provider: 'anthropic',
      async loader(
        getAuth: () => Promise<OAuthSnapshot>,
        provider: { models: Record<string, { cost: unknown }> },
      ) {
        // Zero-config migration: a single-account OAuth setup becomes account[0].
        let manager = AccountManager.load(storagePath)
        if (manager.count() === 0) {
          const auth = await getAuth()
          const seed =
            auth.type === 'oauth' ? accountFromOAuthSnapshot(auth) : null
          if (seed) {
            try {
              addAccount(seed, storagePath)
            } catch {
              // Filesystem failures fall through to single-account behavior below.
            }
            manager = AccountManager.load(storagePath)
            // Silent by design: version-override logging asserts exact call
            // counts, and the migration is documented in the README.
          }
        }

        const auth = await getAuth()
        if (auth.type !== 'oauth' || manager.count() === 0) {
          if (auth.type === 'oauth') {
            // Storage unwritable: fall back to the original single-account path.
            return singleAccountFetch(client, getAuth, claudeCodeVersion)
          }
          return {}
        }

        // zero out cost for max plan
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: {
              read: 0,
              write: 0,
            },
          }
        }

        // Sticky strategies pick once per session; round_robin rotates per request.
        if (strategy !== 'round_robin' && manager.count() > 1) {
          try {
            if (shouldProbeIdleAccounts()) {
              await refreshExpiredForProbe(manager, client)
            }
            await manager.selectSticky(strategy, quotaTtlMs, fetchQuota)
          } catch {
            // Quota API down: sticky pick falls back to LRU internally; a throw
            // here only means persistence failed, which is non-fatal.
          }
        } else {
          manager.markUsed(manager.getCursor())
        }

        const refreshInflight = new Map<number, Promise<string>>()

        /**
         * Resolve the freshest refresh token for `index`.
         *
         * A single-account store mirrors the native auth slot, so the live
         * getAuth() snapshot wins (rotation-safe, as in v1). With several
         * accounts the slot may belong to another account, so the stored token
         * wins and disk is only a cross-process fallback.
         */
        const resolveRefreshToken = async (
          index: number,
          stored: string,
        ): Promise<string> => {
          if (manager.count() === 1) {
            try {
              const latest = await getAuth()
              if (latest.type === 'oauth' && latest.refresh)
                return latest.refresh
            } catch {
              // Fall through to stored/disk copies.
            }
          }
          try {
            const fromDisk = loadAccounts(storagePath).accounts[index]?.refresh
            if (fromDisk && fromDisk !== stored)
              manager.adoptRefresh(index, fromDisk)
            if (fromDisk) return fromDisk
          } catch {
            // Fall through to the in-memory copy.
          }
          return stored
        }

        /**
         * Refresh account `index` and persist + sync exactly once per attempt.
         * Concurrent callers share the inflight promise (no 401 cascades, no
         * duplicate auth.set writes under token rotation).
         */
        const refreshAndStore = (
          index: number,
          refreshToken: string,
        ): Promise<string> => {
          const existing = refreshInflight.get(index)
          if (existing) return existing
          const promise = (async () => {
            const tokens = await refreshAccessToken(refreshToken)
            manager.updateTokens(index, tokens)
            await syncAuthJson(client, tokens)
            return tokens.access
          })().finally(() => {
            if (refreshInflight.get(index) === promise)
              refreshInflight.delete(index)
          })
          refreshInflight.set(index, promise)
          return promise
        }

        /** Refresh account `index` when expired (30s leeway). Returns live access token. */
        const getValidAccess = async (index: number): Promise<string> => {
          const account = manager.get(index)
          if (!account) throw new Error('Anthropic account no longer exists')
          if (
            account.access &&
            account.expires &&
            account.expires > Date.now() + 30_000
          ) {
            return account.access
          }
          const refreshToken = await resolveRefreshToken(index, account.refresh)
          return refreshAndStore(index, refreshToken)
        }

        /** Forced refresh after a 401 (ignores the expiry check). */
        const forceRefresh = async (index: number): Promise<string> => {
          const account = manager.get(index)
          if (!account) throw new Error('Anthropic account no longer exists')
          const refreshToken = await resolveRefreshToken(index, account.refresh)
          // Bypass the inflight cache: the 401 proved any settled result is stale.
          // (Settled promises are already removed, so this only races concurrent 401s.)
          refreshInflight.delete(index)
          return refreshAndStore(index, refreshToken)
        }

        const doRequest = async (
          input: string | URL | Request,
          init: RequestInit | undefined,
          accessToken: string,
        ): Promise<Response> => {
          const requestHeaders = mergeHeaders(input, init)
          setOAuthHeaders(requestHeaders, accessToken, claudeCodeVersion)
          let body = init?.body
          if (body && typeof body === 'string') {
            body = rewriteRequestBody(body, claudeCodeVersion)
          }
          const rewritten = rewriteUrl(input)
          const response = await fetch(rewritten.input, {
            ...init,
            body,
            headers: requestHeaders,
            ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
          })
          return createStrippedStream(response)
        }

        return {
          apiKey: '',
          async fetch(input: string | URL | Request, init?: RequestInit) {
            const auth = await getAuth()
            if (auth.type !== 'oauth') return fetch(input, init)

            // §9 per-model routing: pinned model prefixes stick to one account.
            const pinned = manager.resolvePinned(init?.body, modelPins)
            let index: number
            if (pinned) {
              index = pinned.index
            } else if (strategy === 'round_robin') {
              const next = manager.nextRoundRobin()
              if (!next) return fetch(input, init)
              index = next.index
            } else {
              const cursor = manager.getCursor()
              const current = manager.get(cursor)
              const currentUsable =
                current &&
                current.enabled !== false &&
                (current.rateLimitedUntil ?? 0) <= Date.now()
              const eligible = currentUsable
                ? cursor
                : pickForStrategy(
                    strategy,
                    manager.getAccounts(),
                    cursor,
                    Date.now(),
                  )
              if (eligible === null || eligible === undefined)
                return fetch(input, init)
              index = eligible
              manager.markUsed(index)
            }

            let accessToken: string
            try {
              accessToken = await getValidAccess(index)
            } catch (error) {
              // Refresh failed (e.g. revoked grant): fail over once.
              const next = manager.failover(index, strategy, 0)
              if (!next) throw error
              await logPluginEvent(
                client,
                'warn',
                `Anthropic account ${index + 1} refresh failed; switched to account ${next.index + 1}.`,
              )
              accessToken = await getValidAccess(next.index)
              index = next.index
            }

            let response = await doRequest(input, init, accessToken)

            if (response.status === 401) {
              await response.body?.cancel().catch(() => {})
              try {
                accessToken = await forceRefresh(index)
              } catch {
                const next = manager.failover(index, strategy, 0)
                if (!next) {
                  throw new Error(
                    `Anthropic request unauthorized on account ${index + 1} and no other accounts are available. Re-authenticate via /connect.`,
                  )
                }
                accessToken = await getValidAccess(next.index)
                index = next.index
                return doRequest(input, init, accessToken)
              }
              response = await doRequest(input, init, accessToken)
              if (response.status === 401) {
                await response.body?.cancel().catch(() => {})
                const next = manager.failover(index, strategy, 0)
                if (!next) return response
                accessToken = await getValidAccess(next.index)
                index = next.index
                await logPluginEvent(
                  client,
                  'warn',
                  `Anthropic account still unauthorized after refresh; switched to account ${index + 1}.`,
                )
                return doRequest(input, init, accessToken)
              }
              return response
            }

            if (response.status === 429) {
              const retryAfterMs = parseRetryAfterMs(response)
              await response.body?.cancel().catch(() => {})
              const next = manager.failover(index, strategy, retryAfterMs)
              if (!next) {
                const shortest = manager.getShortestWait()
                const waitMsg =
                  shortest !== null
                    ? ` Shortest wait: ${Math.ceil(shortest / 1000)}s.`
                    : ''
                throw new Error(
                  `All Anthropic accounts rate-limited.${waitMsg} Try again later.`,
                )
              }
              await logPluginEvent(
                client,
                'warn',
                `Anthropic account ${index + 1} rate-limited; switched to account ${next.index + 1}.`,
              )
              const nextAccess = await getValidAccess(next.index)
              const switched = manager.get(next.index)
              await syncAuthJson(client, {
                refresh: switched?.refresh ?? next.account.refresh,
                access: nextAccess,
                expires: switched?.expires ?? Date.now() + 3600_000,
              })
              return doRequest(input, init, nextAccess)
            }

            return response
          },
        }
      },
      methods: [
        {
          label: 'Claude Pro/Max',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('max')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                if (credentials.type === 'failed') return credentials
                const stored: StoredAccount = {
                  refresh: credentials.refresh,
                  access: credentials.access,
                  expires: credentials.expires,
                  addedAt: Date.now(),
                  enabled: true,
                }
                try {
                  const data = addAccount(stored, storagePath)
                  const index = data.accounts.length - 1
                  const label = `Account ${index + 1}`
                  // §9 auto-fill: label + email without blocking the callback.
                  const email = await fetchAccountEmail(
                    credentials.access,
                  ).catch(() => null)
                  if (email) {
                    const current = loadAccounts(storagePath)
                    const added = current.accounts[index]
                    if (added) {
                      added.email = email
                      added.label = email
                      saveAccounts(current, storagePath)
                    }
                  } else {
                    const current = loadAccounts(storagePath)
                    const added = current.accounts[index]
                    if (added && !added.label) {
                      added.label = label
                      saveAccounts(current, storagePath)
                    }
                  }
                } catch {
                  // Filesystem failure: still return success so the single-account
                  // path (auth.json) keeps working.
                }
                await syncAuthJson(client, {
                  refresh: credentials.refresh,
                  access: credentials.access,
                  expires: credentials.expires,
                })
                return {
                  type: 'success' as const,
                  refresh: credentials.refresh,
                  access: credentials.access,
                  expires: credentials.expires,
                }
              },
            }
          },
        },
        {
          label: 'Create an API Key',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('console')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                if (credentials.type === 'failed') return credentials
                const apiKey = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json() as Promise<{ raw_key: string }>)
                return { type: 'success' as const, key: apiKey.raw_key }
              },
            }
          },
        },
        {
          provider: 'anthropic',
          label: 'Manually enter API Key',
          type: 'api',
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: Plugin type doesn't include undocumented auth/hooks
  } as any
}

/** Opt-in idle probe: refresh expired tokens so quota windows can be discovered. */
async function refreshExpiredForProbe(
  manager: AccountManager,
  client: unknown,
): Promise<void> {
  const now = Date.now()
  await Promise.allSettled(
    manager.getAccounts().map(async (account, index) => {
      if (account.enabled === false) return
      if (account.access && account.expires && account.expires > now + 30_000)
        return
      if (!account.refresh) return
      try {
        const tokens = await refreshAccessToken(account.refresh)
        manager.updateTokens(index, tokens)
      } catch (error) {
        await logPluginEvent(
          client,
          'warn',
          `Anthropic account ${index + 1} probe refresh failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        )
      }
    }),
  )
}

/**
 * Original single-account fetch path, used when multi-account storage is
 * unwritable. Preserves the exact retry/dedupe semantics of v1.
 */
async function singleAccountFetch(
  client: unknown,
  getAuth: () => Promise<OAuthSnapshot>,
  claudeCodeVersion: string,
): Promise<{
  apiKey: string
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>
}> {
  // Shared inflight refresh promise — prevents concurrent token refreshes
  // from racing against each other (and causing 401 cascades with token rotation)
  let refreshPromise: Promise<string> | null = null

  return {
    apiKey: '',
    async fetch(input: string | URL | Request, init?: RequestInit) {
      const auth = await getAuth()
      if (auth.type !== 'oauth') return fetch(input, init)
      if (!auth.access || !auth.expires || auth.expires < Date.now()) {
        if (!refreshPromise) {
          refreshPromise = (async () => {
            const maxRetries = 2
            const baseDelayMs = 500

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
              try {
                if (attempt > 0) {
                  const delay = baseDelayMs * 2 ** (attempt - 1)
                  await new Promise((resolve) => setTimeout(resolve, delay))
                }

                // Re-read auth to get the latest refresh token.
                // The outer `auth` snapshot may be stale if tokens
                // were rotated since the fetch() call was made.
                const freshAuth = await getAuth()

                const response = await fetch(TOKEN_URL, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/plain, */*',
                    'User-Agent': 'axios/1.13.6',
                  },
                  body: JSON.stringify({
                    grant_type: 'refresh_token',
                    refresh_token: freshAuth.refresh,
                    client_id: CLIENT_ID,
                  }),
                })

                if (!response.ok) {
                  if (response.status >= 500 && attempt < maxRetries) {
                    await response.body?.cancel()
                    continue
                  }

                  const body = await response.text().catch(() => '')
                  throw new Error(
                    `Token refresh failed: ${response.status} — ${body}`,
                  )
                }

                const json = (await response.json()) as {
                  refresh_token: string
                  access_token: string
                  expires_in: number
                }

                // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
                await (client as any).auth.set({
                  path: {
                    id: 'anthropic',
                  },
                  body: {
                    type: 'oauth',
                    refresh: json.refresh_token,
                    access: json.access_token,
                    expires: Date.now() + json.expires_in * 1000,
                  },
                })

                return json.access_token
              } catch (error) {
                const isNetworkError =
                  error instanceof Error &&
                  (error.message.includes('fetch failed') ||
                    ('code' in error &&
                      (error.code === 'ECONNRESET' ||
                        error.code === 'ECONNREFUSED' ||
                        error.code === 'ETIMEDOUT' ||
                        error.code === 'UND_ERR_CONNECT_TIMEOUT')))

                if (attempt < maxRetries && isNetworkError) {
                  continue
                }

                throw error
              }
            }
            // Unreachable — each iteration either returns or throws.
            // Kept as a TypeScript exhaustiveness guard.
            throw new Error('Token refresh exhausted all retries')
          })().finally(() => {
            refreshPromise = null
          })
        }
        auth.access = await refreshPromise
      }

      const requestHeaders = mergeHeaders(input, init)
      // biome-ignore lint/style/noNonNullAssertion: access is guaranteed set above
      setOAuthHeaders(requestHeaders, auth.access!, claudeCodeVersion)

      let body = init?.body
      if (body && typeof body === 'string') {
        body = rewriteRequestBody(body, claudeCodeVersion)
      }

      const rewritten = rewriteUrl(input)

      const response = await fetch(rewritten.input, {
        ...init,
        body,
        headers: requestHeaders,
        ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
      })

      return createStrippedStream(response)
    },
  }
}
