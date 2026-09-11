import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnthropicAuthPlugin } from '../index'
import { ACCOUNTS_PATH_ENV_VAR, loadAccounts } from '../storage'

const originalFetch = globalThis.fetch
const originalAccountsPath = process.env[ACCOUNTS_PATH_ENV_VAR]
let sandboxDir = ''

beforeEach(() => {
  sandboxDir = mkdtempSync(join(tmpdir(), 'anthropic-methods-test-'))
  process.env[ACCOUNTS_PATH_ENV_VAR] = join(
    sandboxDir,
    'anthropic-accounts.json',
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalAccountsPath === undefined)
    delete process.env[ACCOUNTS_PATH_ENV_VAR]
  else process.env[ACCOUNTS_PATH_ENV_VAR] = originalAccountsPath
  rmSync(sandboxDir, { recursive: true, force: true })
})

type FetchCall = {
  url: string
  init?: RequestInit
}

function installFetchStub(handler: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      const call = { url, init }
      calls.push(call)
      return Promise.resolve(handler(call))
    },
  ) as unknown as typeof fetch
  return calls
}

function tokenResponse(): Response {
  return Response.json({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
  })
}

async function getOAuthMethod(index: number) {
  const plugin = (await AnthropicAuthPlugin({
    // @ts-expect-error: minimal client mock; authorize handlers do not use it
    client: {},
  })) as any
  const method = plugin.auth.methods[index]
  if (method?.type !== 'oauth') {
    throw new Error(`Expected OAuth method at index ${index}`)
  }
  return method
}

function callbackCode(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get('state')
  if (!state) throw new Error('Authorization URL is missing state')
  return `authorization-code#${state}`
}

describe('Claude Pro/Max OAuth method', () => {
  test('creates a claude.ai authorization code flow', async () => {
    const method = await getOAuthMethod(0)
    const authorization = await method.authorize()
    const url = new URL(authorization.url)

    expect(url.origin).toBe('https://claude.ai')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(authorization.method).toBe('code')
    expect(authorization.callback).toBeFunction()
  })

  test('callback exchanges the authorization code for OAuth credentials', async () => {
    const method = await getOAuthMethod(0)
    const authorization = await method.authorize()
    const calls = installFetchStub(({ url }) => {
      if (url.includes('/api/oauth/profile')) {
        return Response.json({ email: 'new@example.com' })
      }
      return tokenResponse()
    })

    const credentials = await authorization.callback(
      callbackCode(authorization.url),
    )

    expect(credentials.type).toBe('success')
    expect(credentials.access).toBe('access-token')
    expect(credentials.refresh).toBe('refresh-token')
    // Token exchange + best-effort profile lookup for email auto-fill.
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe('https://platform.claude.com/v1/oauth/token')

    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.code).toBe('authorization-code')
    expect(body.grant_type).toBe('authorization_code')

    // The new account is persisted to multi-account storage with its email.
    const stored = loadAccounts(process.env[ACCOUNTS_PATH_ENV_VAR])
    expect(stored.accounts).toHaveLength(1)
    expect(stored.accounts[0]).toMatchObject({
      refresh: 'refresh-token',
      email: 'new@example.com',
    })
  })

  test('callback reports a failed token exchange', async () => {
    const method = await getOAuthMethod(0)
    const authorization = await method.authorize()
    const calls = installFetchStub(
      () => new Response('invalid grant', { status: 400 }),
    )

    const credentials = await authorization.callback(
      callbackCode(authorization.url),
    )

    expect(credentials).toEqual({ type: 'failed' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://platform.claude.com/v1/oauth/token')
  })
})

describe('Create an API Key OAuth method', () => {
  test('creates a platform.claude.com authorization code flow', async () => {
    const method = await getOAuthMethod(1)
    const authorization = await method.authorize()
    const url = new URL(authorization.url)

    expect(url.origin).toBe('https://platform.claude.com')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('scope')).toContain('org:create_api_key')
    expect(authorization.method).toBe('code')
  })

  test('callback creates an API key using the exchanged access token', async () => {
    const method = await getOAuthMethod(1)
    const authorization = await method.authorize()
    const calls = installFetchStub(({ url }) => {
      if (url.endsWith('/v1/oauth/token')) return tokenResponse()
      if (url.endsWith('/api/oauth/claude_cli/create_api_key')) {
        return Response.json({ raw_key: 'sk-ant-created' })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const credentials = await authorization.callback(
      callbackCode(authorization.url),
    )

    expect(credentials).toEqual({ type: 'success', key: 'sk-ant-created' })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.init?.method).toBe('POST')

    const headers = new Headers(calls[1]?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer access-token')
    expect(headers.get('content-type')).toBe('application/json')
  })

  test('does not request an API key when token exchange fails', async () => {
    const method = await getOAuthMethod(1)
    const authorization = await method.authorize()
    const calls = installFetchStub(
      () => new Response('invalid grant', { status: 400 }),
    )

    const credentials = await authorization.callback(
      callbackCode(authorization.url),
    )

    expect(credentials).toEqual({ type: 'failed' })
    expect(calls).toHaveLength(1)
  })
})
