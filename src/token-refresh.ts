import { CLIENT_ID, TOKEN_URL } from './constants.ts'

export type RefreshedTokens = {
  refresh: string
  access: string
  expires: number
}

function isNetworkError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('fetch failed') ||
      ('code' in error &&
        (error.code === 'ECONNRESET' ||
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'UND_ERR_CONNECT_TIMEOUT')))
  )
}

function isInvalidGrant(status: number, body: string): boolean {
  return status === 400 || status === 401 ? /invalid_grant/i.test(body) : false
}

/**
 * Refresh one account's tokens. Extracted from the single-account loader so
 * multi-account callers share the same retry/backoff semantics: 2 retries,
 * exponential 500ms backoff, 5xx + network retry, no retry on 4xx.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<RefreshedTokens> {
  const maxRetries = 2
  const baseDelayMs = 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)),
      )
    }
    try {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'axios/1.13.6',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
      })

      if (!response.ok) {
        if (response.status >= 500 && attempt < maxRetries) {
          await response.body?.cancel().catch(() => {})
          continue
        }
        const body = await response.text().catch(() => '')
        const invalid = isInvalidGrant(response.status, body)
        throw new Error(
          `Token refresh failed: ${response.status} — ${body}${invalid ? ' (invalid_grant: re-authenticate this account)' : ''}`,
        )
      }

      const json = (await response.json()) as {
        refresh_token: string
        access_token: string
        expires_in: number
      }
      return {
        refresh: json.refresh_token,
        access: json.access_token,
        expires: Date.now() + json.expires_in * 1000,
      }
    } catch (error) {
      if (attempt < maxRetries && isNetworkError(error)) continue
      throw error
    }
  }
  throw new Error('Token refresh exhausted all retries')
}
