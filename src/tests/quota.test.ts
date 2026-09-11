import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  fetchAccountEmail,
  fetchQuota,
  getUtilization,
  msToReset,
  snapshotFromResponse,
} from '../quota'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('fetchQuota', () => {
  test('calls the usage API with the required headers', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse(200, { five_hour: { utilization: 0.5 } })),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchQuota('token-abc')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const [url, init] = calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({
      authorization: 'Bearer token-abc',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    })
  })

  test('normalizes percentage utilization to ratios', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        jsonResponse(200, {
          five_hour: { utilization: 42, resets_at: '2026-01-15T12:00:00Z' },
          seven_day: { utilization: 0.15, resets_at: '2026-01-20T00:00:00Z' },
        }),
      ),
    ) as unknown as typeof fetch

    const snapshot = await fetchQuota('token-abc')
    expect(snapshot?.fiveHour).toBeCloseTo(0.42)
    expect(snapshot?.sevenDay).toBe(0.15)
    expect(snapshot?.sevenDayResetsAt).toBe('2026-01-20T00:00:00Z')
  })

  test('returns null on non-OK, network error, or missing token', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse(403, { error: 'forbidden' })),
    ) as unknown as typeof fetch
    await expect(fetchQuota('token-abc')).resolves.toBeNull()

    globalThis.fetch = mock(() =>
      Promise.reject(new Error('down')),
    ) as unknown as typeof fetch
    await expect(fetchQuota('token-abc')).resolves.toBeNull()

    await expect(fetchQuota('')).resolves.toBeNull()
  })
})

describe('fetchAccountEmail', () => {
  test('extracts a top-level email', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse(200, { email: 'a@example.com' })),
    ) as unknown as typeof fetch
    await expect(fetchAccountEmail('token-abc')).resolves.toBe('a@example.com')
  })

  test('returns null when no email is present or the call fails', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse(200, { login: 'someone' })),
    ) as unknown as typeof fetch
    await expect(fetchAccountEmail('token-abc')).resolves.toBeNull()

    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse(401, { error: 'unauthorized' })),
    ) as unknown as typeof fetch
    await expect(fetchAccountEmail('token-abc')).resolves.toBeNull()
  })
})

describe('quota helpers', () => {
  test('getUtilization prefers the weekly window', () => {
    expect(getUtilization({ fiveHour: 0.1, sevenDay: 0.8 })).toBe(0.8)
    expect(getUtilization({ fiveHour: 0.1, sevenDay: null })).toBe(0.1)
    expect(getUtilization({ fiveHour: null, sevenDay: null })).toBeNull()
  })

  test('snapshotFromResponse drops unparseable resets_at values', () => {
    const snapshot = snapshotFromResponse(
      { five_hour: { utilization: 0.5, resets_at: 'not-a-date' } },
      1_700_000_000_000,
    )
    expect(snapshot.fiveHour).toBe(0.5)
    expect(snapshot.fiveHourResetsAt).toBeUndefined()
    expect(snapshot.fetchedAt).toBe(1_700_000_000_000)
  })

  test('msToReset returns null for unknown or past resets', () => {
    const now = 1_700_000_000_000
    expect(msToReset(undefined, now)).toBeNull()
    expect(msToReset('garbage', now)).toBeNull()
    expect(msToReset(new Date(now - 1000).toISOString(), now)).toBeNull()
    expect(msToReset(new Date(now + 5000).toISOString(), now)).toBe(5000)
  })
})
