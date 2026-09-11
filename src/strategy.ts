import { msToReset } from './quota.ts'
import type { StoredAccount } from './storage.ts'

export type StrategyName = 'smart' | 'lowest_quota' | 'round_robin'

export const STRATEGY_ENV_VAR = 'ANTHROPIC_AUTH_STRATEGY'
export const DEFAULT_STRATEGY: StrategyName = 'smart'

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000

/** Parse without throwing; unknown values fall back to `smart`. */
export function parseStrategy(raw: string | undefined): StrategyName {
  const normalized = (raw ?? '').trim().toLowerCase()
  if (normalized === 'round_robin' || normalized === 'round-robin')
    return 'round_robin'
  if (normalized === 'lowest_quota' || normalized === 'lowest-quota')
    return 'lowest_quota'
  return 'smart'
}

export function isStrategyOverridden(raw: string | undefined): boolean {
  const normalized = (raw ?? '').trim().toLowerCase()
  return (
    normalized !== '' &&
    parseStrategy(raw) === 'smart' &&
    normalized !== 'smart'
  )
}

/** Accounts eligible for selection: enabled and not currently rate-limited. */
export function eligibleIndexes(
  accounts: StoredAccount[],
  now = Date.now(),
): number[] {
  const indexes: number[] = []
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]
    if (!account || account.enabled === false || !account.refresh) continue
    if (
      typeof account.rateLimitedUntil === 'number' &&
      account.rateLimitedUntil > now
    ) {
      continue
    }
    indexes.push(i)
  }
  return indexes
}

/**
 * Next account in rotation after `cursor`. Wraps around; falls back to the
 * first eligible index when the cursor points at an ineligible account.
 */
export function pickRoundRobin(
  accounts: StoredAccount[],
  cursor: number,
  now = Date.now(),
): number | null {
  const eligible = eligibleIndexes(accounts, now)
  if (eligible.length === 0) return null
  const next = eligible.find((index) => index > cursor) ?? eligible[0]
  return next ?? null
}

/** Fallback when quota data is unavailable: least-recently-used first. */
export function pickLeastRecentlyUsed(
  accounts: StoredAccount[],
  eligible: number[],
): number {
  const unused = eligible.find(
    (index) => accounts[index]?.lastUsed === undefined,
  )
  if (unused !== undefined) return unused
  let selected = eligible[0] ?? 0
  let oldest = Number.POSITIVE_INFINITY
  for (const index of eligible) {
    const lastUsed = accounts[index]?.lastUsed ?? Number.POSITIVE_INFINITY
    if (lastUsed < oldest) {
      oldest = lastUsed
      selected = index
    }
  }
  return selected
}

function utilizationOf(account: StoredAccount): {
  fiveHour: number | null
  sevenDay: number | null
} {
  return {
    fiveHour: account.quota?.fiveHour ?? null,
    sevenDay: account.quota?.sevenDay ?? null,
  }
}

/**
 * Lowest weekly utilization wins (the binding constraint); 5-hour breaks ties
 * only via the fallback term. Missing data sorts after any measured account.
 */
export function pickLowestQuota(
  accounts: StoredAccount[],
  now = Date.now(),
): number | null {
  const eligible = eligibleIndexes(accounts, now)
  if (eligible.length === 0) return null

  const scored: { index: number; primary: number }[] = []
  for (const index of eligible) {
    const account = accounts[index]
    if (!account) continue
    const { fiveHour, sevenDay } = utilizationOf(account)
    const primary = sevenDay ?? fiveHour
    if (primary !== null) scored.push({ index, primary })
  }

  if (scored.length === 0) return pickLeastRecentlyUsed(accounts, eligible)

  scored.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary - b.primary
    const aUsed = accounts[a.index]?.lastUsed ?? Number.NEGATIVE_INFINITY
    const bUsed = accounts[b.index]?.lastUsed ?? Number.NEGATIVE_INFINITY
    return aUsed - bUsed
  })
  const best = scored[0]
  return best ? best.index : pickLeastRecentlyUsed(accounts, eligible)
}

/**
 * Smart selection: weekly-first base (simulation winner) + drain bonus for
 * accounts whose weekly window resets soon + 5h guardrail + weekly-fairness
 * drift penalty (§9). Pure function of cached quota; never fetches.
 */
export function scoreAccount(
  account: StoredAccount,
  meanSevenDay: number | null,
  now = Date.now(),
): number | null {
  const { fiveHour, sevenDay } = utilizationOf(account)
  const knownSeven = sevenDay ?? fiveHour
  const knownFive = fiveHour ?? sevenDay
  if (knownSeven === null || knownFive === null) return null

  const rem7 = 1 - knownSeven
  const rem5 = 1 - knownFive
  const weeklyLeft = msToReset(account.quota?.sevenDayResetsAt, now)
  const fiveHourLeft = msToReset(account.quota?.fiveHourResetsAt, now)
  const weeklyUrgency =
    weeklyLeft === null ? 0 : 1 - Math.min(1, weeklyLeft / SEVEN_DAY_MS)

  let score = 0.6 * rem7 + 0.25 * rem5 + 0.15 * weeklyUrgency

  // Guardrail: preserve 5h headroom during peak, unless the 5h window renews
  // imminently (then spending is nearly free).
  if (
    rem5 < 0.1 &&
    (fiveHourLeft === null || fiveHourLeft > 0.4 * FIVE_HOUR_MS)
  ) {
    score -= 0.3
  }

  // §9 fairness: penalize accounts far above the mean weekly utilization so
  // one account doesn't absorb the whole week while others idle.
  if (meanSevenDay !== null && sevenDay !== null) {
    const excess = sevenDay - meanSevenDay - 0.15
    if (excess > 0) score -= 0.1 * excess
  }

  return score
}

export function pickSmart(
  accounts: StoredAccount[],
  now = Date.now(),
): number | null {
  const eligible = eligibleIndexes(accounts, now)
  if (eligible.length === 0) return null

  const measuredSeven = eligible
    .map((index) => accounts[index]?.quota?.sevenDay ?? null)
    .filter((value): value is number => value !== null)
  const meanSevenDay =
    measuredSeven.length > 0
      ? measuredSeven.reduce((sum, value) => sum + value, 0) /
        measuredSeven.length
      : null

  const scored: { index: number; score: number }[] = []
  for (const index of eligible) {
    const account = accounts[index]
    if (!account) continue
    const score = scoreAccount(account, meanSevenDay, now)
    if (score !== null) scored.push({ index, score })
  }

  if (scored.length === 0) return pickLeastRecentlyUsed(accounts, eligible)

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const aUsed = accounts[a.index]?.lastUsed ?? Number.NEGATIVE_INFINITY
    const bUsed = accounts[b.index]?.lastUsed ?? Number.NEGATIVE_INFINITY
    return aUsed - bUsed
  })
  const best = scored[0]
  return best ? best.index : pickLeastRecentlyUsed(accounts, eligible)
}

export function pickForStrategy(
  strategy: StrategyName,
  accounts: StoredAccount[],
  cursor: number,
  now = Date.now(),
): number | null {
  if (strategy === 'round_robin') return pickRoundRobin(accounts, cursor, now)
  if (strategy === 'lowest_quota') return pickLowestQuota(accounts, now)
  return pickSmart(accounts, now)
}
