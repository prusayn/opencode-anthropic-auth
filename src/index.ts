import type { Plugin } from '@opencode-ai/plugin'
import { AccountManager, parseModelPins } from './accounts.ts'
import { authorize, exchange } from './auth.ts'
import {
  ANTHROPIC_AUTH_MODEL_PIN_ENV_VAR,
  resolveClaudeCodeVersion,
  resolveQuotaCacheTtlMs,
  shouldProbeIdleAccounts,
} from './config.ts'
import { CLAUDE_CODE_VERSION } from './constants.ts'
import { fetchAccountEmail, fetchQuota, getUtilization } from './quota.ts'
import {
  accountFromOAuthSnapshot,
  addAccount,
  loadAccounts,
  removeAccount,
  resolveStoragePath,
  type StoredAccount,
  saveAccounts,
  setAccountEnabled,
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

/** Compact duration for usage lines, e.g. `45s`, `3h 12m`, `2d 4h`. */
function formatWait(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  if (hours < 48) return `${hours}h ${totalMinutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
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

  /**
   * Finish an account-menu flow without changing credentials: return the
   * active account's (refreshed) tokens so `/connect` completes. Never throws.
   */
  const getExistingOAuthResult = async (): Promise<
    | { type: 'success'; refresh: string; access: string; expires: number }
    | { type: 'failed' }
  > => {
    const data = loadAccounts(storagePath)
    const active = data.accounts[data.cursor] ?? data.accounts[0]
    if (!active) return { type: 'failed' }
    const { refresh, access, expires } = active
    if (access && expires && expires > Date.now() + 30_000) {
      return { type: 'success', refresh, access, expires }
    }
    try {
      const tokens = await refreshAccessToken(refresh)
      active.refresh = tokens.refresh
      active.access = tokens.access
      active.expires = tokens.expires
      try {
        saveAccounts(data, storagePath)
      } catch {
        // Persistence is best-effort here; the returned tokens still apply.
      }
      await syncAuthJson(client, tokens)
      return { type: 'success', ...tokens }
    } catch {
      return { type: 'failed' }
    }
  }

  /**
   * One numbered line per account for the auth-menu methods. Refreshes expired
   * tokens and reads quota best-effort; anything failing degrades to
   * `unavailable` rather than failing the menu. Never throws.
   */
  const describeAccounts = async (): Promise<string> => {
    const data = loadAccounts(storagePath)
    if (data.accounts.length === 0) {
      return 'No accounts configured. Use Claude Pro/Max first.'
    }
    const lines = await Promise.all(
      data.accounts.map(async (account, i) => {
        const n = i + 1
        const label = account.label || account.email || `Account ${n}`
        const status = account.enabled ? 'enabled' : 'disabled'
        const active = i === data.cursor ? ' (active)' : ''
        if (
          typeof account.rateLimitedUntil === 'number' &&
          account.rateLimitedUntil > Date.now()
        ) {
          return `  ${n}. ${label} [${status}]${active} — rate-limited, retry in ${formatWait(account.rateLimitedUntil - Date.now())}`
        }
        let access = account.access
        if (!access || (account.expires ?? 0) < Date.now() + 30_000) {
          try {
            const tokens = await refreshAccessToken(account.refresh)
            account.refresh = tokens.refresh
            account.access = tokens.access
            account.expires = tokens.expires
            access = tokens.access
          } catch {
            return `  ${n}. ${label} [${status}]${active} — token refresh failed, re-authenticate`
          }
        }
        const quota = access ? await fetchQuota(access).catch(() => null) : null
        const utilization = quota ? getUtilization(quota) : null
        if (utilization === null || utilization === undefined) {
          return `  ${n}. ${label} [${status}]${active} — usage unavailable`
        }
        const resetsAt = quota?.sevenDayResetsAt ?? quota?.fiveHourResetsAt
        const resets =
          resetsAt && !Number.isNaN(Date.parse(resetsAt))
            ? ` (resets in ${formatWait(Date.parse(resetsAt) - Date.now())})`
            : ''
        return `  ${n}. ${label} [${status}]${active} — ${(utilization * 100).toFixed(1)}% used${resets}`
      }),
    )
    try {
      saveAccounts(data, storagePath)
    } catch {
      // Best-effort: refreshed tokens are still returned by the menu flow.
    }
    return `Anthropic accounts:\n${lines.join('\n')}`
  }

  return {
    auth: {
      provider: 'anthropic',
      async loader(
        getAuth: () => Promise<OAuthSnapshot>,
        provider: { models: Record<string, { cost: unknown }> },
      ) {
        // Zero-config migration: a single-account OAuth setup becomes account[0].
        // Silent by design: version-override logging asserts exact call counts,
        // and the migration is documented in the README.
        let manager = AccountManager.load(storagePath)
        if (manager.count() === 0) {
          const auth = await getAuth()
          const seed =
            auth.type === 'oauth' ? accountFromOAuthSnapshot(auth) : null
          if (seed) {
            try {
              addAccount(seed, storagePath)
              manager = AccountManager.load(storagePath)
            } catch {
              // Unwritable disk: run this session from memory; the manager
              // persists best-effort, so no separate single-account path is needed.
              manager = new AccountManager([seed], 0, storagePath)
            }
          }
        }

        const auth = await getAuth()
        if (auth.type !== 'oauth' || manager.count() === 0) return {}

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
                  const current = loadAccounts(storagePath)
                  const added = current.accounts[index]
                  if (added) {
                    if (email) {
                      added.email = email
                      added.label = email
                    } else if (!added.label) {
                      added.label = label
                    }
                    saveAccounts(current, storagePath)
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
        {
          label: 'View Account Usage',
          type: 'oauth',
          authorize: async () => {
            // Shown in the host UI and echoed to the log for hosts that
            // auto-complete code-less methods without displaying instructions.
            const table = await describeAccounts()
            console.log(table)
            return {
              url: '',
              instructions: `${table}\n\nType anything to finish.`,
              method: 'code',
              callback: async () => getExistingOAuthResult(),
            }
          },
        },
        {
          label: 'Manage Accounts',
          type: 'oauth',
          authorize: async () => {
            const table = await describeAccounts()
            const instructions =
              `${table}\n\n` +
              'Reply with <number> to remove it, e<number> to enable, ' +
              'd<number> to disable, or anything else to cancel.'
            console.log(instructions)
            return {
              url: '',
              instructions,
              method: 'code',
              callback: async (input: string) => {
                const text = (input ?? '').trim().toLowerCase()
                const remove = text.match(/^(\d+)$/)
                const toggle = text.match(/^([ed])\s*(\d+)$/)
                const data = loadAccounts(storagePath)
                const valid = (n: number) =>
                  Number.isInteger(n) && n >= 1 && n <= data.accounts.length
                // Anything unrecognized (or out of range) cancels: storage untouched.
                if (remove) {
                  const n = Number.parseInt(remove[1] ?? '', 10)
                  if (valid(n)) removeAccount(n - 1, storagePath)
                } else if (toggle) {
                  const n = Number.parseInt(toggle[2] ?? '', 10)
                  if (valid(n)) {
                    setAccountEnabled(n - 1, toggle[1] === 'e', storagePath)
                  }
                }
                return getExistingOAuthResult()
              },
            }
          },
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
