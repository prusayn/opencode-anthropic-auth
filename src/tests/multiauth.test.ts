import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnthropicAuthPlugin } from '../index'
import type { StoredAccount } from '../storage'
import { ACCOUNTS_PATH_ENV_VAR, loadAccounts, saveAccounts } from '../storage'
import { STRATEGY_ENV_VAR } from '../strategy'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const FUTURE = Date.now() + 3600_000

function createMockClient() {
  return {
    auth: { set: mock(() => Promise.resolve()) },
    app: { log: mock(() => Promise.resolve()) },
  }
}

function seedAccount(partial: Partial<StoredAccount> = {}): StoredAccount {
  return {
    refresh: 'refresh-default',
    access: 'access-default',
    expires: FUTURE,
    addedAt: Date.now() - 1000,
    enabled: true,
    ...partial,
  }
}

function extractUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/** Route mocked fetch by URL; record messages-call Authorization headers. */
function mockRouter(handler: (url: string, init?: RequestInit) => Response) {
  const seen: string[] = []
  globalThis.fetch = mock((input: any, init: any) => {
    const url = extractUrl(input)
    if (url.includes('/v1/messages')) {
      seen.push((init?.headers as Headers)?.get('authorization') ?? '')
    }
    return Promise.resolve(handler(url, init))
  }) as unknown as typeof fetch
  return seen
}

function tokenResponse(
  refresh = 'new-refresh',
  access = 'new-access',
): Response {
  return new Response(
    JSON.stringify({
      refresh_token: refresh,
      access_token: access,
      expires_in: 3600,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

const originalFetch = globalThis.fetch
const originalStrategy = process.env[STRATEGY_ENV_VAR]
const originalAccountsPath = process.env[ACCOUNTS_PATH_ENV_VAR]
let sandboxDir = ''
let accountsFile = ''

beforeEach(() => {
  sandboxDir = mkdtempSync(join(tmpdir(), 'anthropic-multiauth-test-'))
  accountsFile = join(sandboxDir, 'anthropic-accounts.json')
  process.env[ACCOUNTS_PATH_ENV_VAR] = accountsFile
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalStrategy === undefined) delete process.env[STRATEGY_ENV_VAR]
  else process.env[STRATEGY_ENV_VAR] = originalStrategy
  if (originalAccountsPath === undefined)
    delete process.env[ACCOUNTS_PATH_ENV_VAR]
  else process.env[ACCOUNTS_PATH_ENV_VAR] = originalAccountsPath
  rmSync(sandboxDir, { recursive: true, force: true })
})

async function getLoader(
  client = createMockClient(),
  getAuth: () => Promise<any> = () =>
    Promise.resolve({
      type: 'oauth',
      access: 'x',
      refresh: 'x',
      expires: FUTURE,
    }),
) {
  const plugin = (await AnthropicAuthPlugin({
    // @ts-expect-error: minimal mock for testing
    client,
  })) as any
  return plugin.auth.loader(getAuth, { models: {} })
}

describe('multi-auth request routing', () => {
  test('round_robin rotates Bearer tokens across requests', async () => {
    process.env[STRATEGY_ENV_VAR] = 'round_robin'
    saveAccounts(
      {
        version: 1,
        cursor: 1,
        accounts: [
          seedAccount({ refresh: 'r0', access: 'a0' }),
          seedAccount({ refresh: 'r1', access: 'a1' }),
        ],
      },
      accountsFile,
    )
    const seen = mockRouter(() => new Response(null, { status: 200 }))
    const result = await getLoader()

    await result.fetch(MESSAGES_URL, { method: 'POST', body: '{}' })
    await result.fetch(MESSAGES_URL, { method: 'POST', body: '{}' })

    expect(seen).toEqual(['Bearer a0', 'Bearer a1'])
  })

  test('429 fails over to the next account and retries once', async () => {
    process.env[STRATEGY_ENV_VAR] = 'round_robin'
    saveAccounts(
      {
        version: 1,
        cursor: 1,
        accounts: [
          seedAccount({ refresh: 'r0', access: 'a0' }),
          seedAccount({ refresh: 'r1', access: 'a1' }),
        ],
      },
      accountsFile,
    )
    let messagesCalls = 0
    const seen = mockRouter((url) => {
      if (url.includes('/v1/messages')) {
        messagesCalls++
        if (messagesCalls === 1) {
          return new Response('slow down', {
            status: 429,
            headers: { 'retry-after': '0.1' },
          })
        }
        return new Response(null, { status: 200 })
      }
      return new Response(null, { status: 200 })
    })
    const result = await getLoader()

    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(200)
    expect(seen).toEqual(['Bearer a0', 'Bearer a1'])
    expect(
      loadAccounts(accountsFile).accounts[0]?.rateLimitedUntil,
    ).toBeGreaterThan(Date.now())
  })

  test('429 on the only account throws with the shortest wait', async () => {
    process.env[STRATEGY_ENV_VAR] = 'round_robin'
    saveAccounts(
      {
        version: 1,
        cursor: 0,
        accounts: [seedAccount({ refresh: 'r0', access: 'a0' })],
      },
      accountsFile,
    )
    mockRouter((url) => {
      if (url.includes('/v1/messages')) {
        return new Response('slow down', {
          status: 429,
          headers: { 'retry-after': '5' },
        })
      }
      return new Response(null, { status: 200 })
    })
    const result = await getLoader()

    const error = await result
      .fetch(MESSAGES_URL, { method: 'POST', body: '{}' })
      .then(
        () => null,
        (error: Error) => error,
      )
    expect(error?.message).toContain('All Anthropic accounts rate-limited')
    expect(error?.message).toContain('Shortest wait')
  })

  test('401 refreshes the token and retries the same account', async () => {
    process.env[STRATEGY_ENV_VAR] = 'round_robin'
    saveAccounts(
      {
        version: 1,
        cursor: 0,
        accounts: [seedAccount({ refresh: 'r0', access: 'a0' })],
      },
      accountsFile,
    )
    let messagesCalls = 0
    mockRouter((url) => {
      if (url.includes('/v1/oauth/token'))
        return tokenResponse('r-new', 'a-new')
      messagesCalls++
      if (messagesCalls === 1)
        return new Response('unauthorized', { status: 401 })
      return new Response(null, { status: 200 })
    })
    const result = await getLoader()

    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(200)
    expect(loadAccounts(accountsFile).accounts[0]).toMatchObject({
      refresh: 'r-new',
      access: 'a-new',
    })
  })

  test('smart sticks to the lowest-quota account for the session', async () => {
    process.env[STRATEGY_ENV_VAR] = 'smart'
    const now = Date.now()
    saveAccounts(
      {
        version: 1,
        cursor: 0,
        accounts: [
          seedAccount({
            refresh: 'r0',
            access: 'a0',
            quota: { fiveHour: 0.9, sevenDay: 0.9, fetchedAt: now },
          }),
          seedAccount({
            refresh: 'r1',
            access: 'a1',
            quota: { fiveHour: 0.1, sevenDay: 0.1, fetchedAt: now },
          }),
        ],
      },
      accountsFile,
    )
    const seen = mockRouter((url) => {
      if (url.includes('/api/oauth/usage')) {
        throw new Error('quota API must not be called with fresh caches')
      }
      return new Response(null, { status: 200 })
    })
    const result = await getLoader()

    await result.fetch(MESSAGES_URL, { method: 'POST', body: '{}' })
    await result.fetch(MESSAGES_URL, { method: 'POST', body: '{}' })

    expect(seen).toEqual(['Bearer a1', 'Bearer a1'])
  })

  test('empty storage migrates the single-account login to account 1', async () => {
    process.env[STRATEGY_ENV_VAR] = 'round_robin'
    const seen = mockRouter(() => new Response(null, { status: 200 }))
    const result = await getLoader(createMockClient(), () =>
      Promise.resolve({
        type: 'oauth',
        access: 'a-mig',
        refresh: 'r-mig',
        expires: FUTURE,
      }),
    )

    await result.fetch(MESSAGES_URL, { method: 'POST', body: '{}' })

    expect(seen).toEqual(['Bearer a-mig'])
    expect(loadAccounts(accountsFile).accounts.map((a) => a.refresh)).toEqual([
      'r-mig',
    ])
  })

  test('parseRetryAfterMs honors seconds, dates, and the default', async () => {
    const { parseRetryAfterMs } = await import('../index')
    expect(
      parseRetryAfterMs(
        new Response(null, { headers: { 'retry-after': '2' } }),
      ),
    ).toBe(2000)
    expect(parseRetryAfterMs(new Response(null, { status: 429 }))).toBe(60_000)
    const future = new Date(Date.now() + 10_000).toUTCString()
    const parsed = parseRetryAfterMs(
      new Response(null, { headers: { 'retry-after': future } }),
    )
    expect(parsed).toBeGreaterThan(0)
    expect(parsed).toBeLessThanOrEqual(10_000)
  })
})
