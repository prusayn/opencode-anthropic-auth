const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile'
const REQUEST_TIMEOUT_MS = 10_000

export type QuotaResponse = {
  five_hour?: { utilization?: unknown; resets_at?: unknown }
  seven_day?: { utilization?: unknown; resets_at?: unknown }
}

export type QuotaSnapshot = {
  fiveHour: number | null
  sevenDay: number | null
  fiveHourResetsAt?: string
  sevenDayResetsAt?: string
  fetchedAt: number
}

function toRatio(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  if (value <= 1) return value
  if (value <= 100) return value / 100
  return 1
}

function toDateString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : value
}

/** Prefer the weekly window (the binding constraint); fall back to 5-hour. */
export function getUtilization(snapshot: {
  fiveHour: number | null
  sevenDay: number | null
}): number | null {
  return snapshot.sevenDay ?? snapshot.fiveHour
}

export function snapshotFromResponse(
  quota: QuotaResponse,
  now = Date.now(),
): QuotaSnapshot {
  return {
    fiveHour: toRatio(quota.five_hour?.utilization),
    sevenDay: toRatio(quota.seven_day?.utilization),
    ...(toDateString(quota.five_hour?.resets_at)
      ? { fiveHourResetsAt: toDateString(quota.five_hour?.resets_at) }
      : {}),
    ...(toDateString(quota.seven_day?.resets_at)
      ? { sevenDayResetsAt: toDateString(quota.seven_day?.resets_at) }
      : {}),
    fetchedAt: now,
  }
}

/** Milliseconds until `resetsAt`, or null when unknown/already passed. */
export function msToReset(
  resetsAt: string | undefined,
  now = Date.now(),
): number | null {
  if (!resetsAt) return null
  const time = Date.parse(resetsAt)
  if (Number.isNaN(time)) return null
  const remaining = time - now
  return remaining > 0 ? remaining : null
}

async function getJsonWithTimeout(
  url: string,
  accessToken: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    return (await response.json()) as unknown
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Fetch quota for one account. Returns null on any failure (never throws). */
export async function fetchQuota(
  accessToken: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<QuotaSnapshot | null> {
  if (!accessToken) return null
  const json = await getJsonWithTimeout(USAGE_ENDPOINT, accessToken, timeoutMs)
  if (!json || typeof json !== 'object') return null
  return snapshotFromResponse(json as QuotaResponse)
}

/**
 * §9 email/label auto-fill. Best-effort profile lookup; null when the
 * endpoint, token, or network can't provide one. Never throws.
 */
export async function fetchAccountEmail(
  accessToken: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<string | null> {
  if (!accessToken) return null
  const json = await getJsonWithTimeout(
    PROFILE_ENDPOINT,
    accessToken,
    timeoutMs,
  )
  if (!json || typeof json !== 'object') return null
  const record = json as { email?: unknown; user?: { email?: unknown } | null }
  const email = record.email ?? record.user?.email
  return typeof email === 'string' && email.includes('@') ? email : null
}
