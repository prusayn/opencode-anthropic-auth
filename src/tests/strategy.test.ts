import { describe, expect, test } from 'bun:test'
import type { StoredAccount } from '../storage'
import {
  eligibleIndexes,
  isStrategyOverridden,
  parseStrategy,
  pickLeastRecentlyUsed,
  pickLowestQuota,
  pickRoundRobin,
  pickSmart,
  scoreAccount,
} from '../strategy'

const NOW = 1_700_000_000_000

function makeAccount(partial: Partial<StoredAccount> = {}): StoredAccount {
  return {
    refresh: 'refresh-default',
    access: 'access-default',
    expires: NOW + 3600_000,
    addedAt: NOW - 10_000,
    enabled: true,
    ...partial,
  }
}

function withQuota(
  partial: Partial<StoredAccount>,
  quota: {
    fiveHour?: number | null
    sevenDay?: number | null
    sevenDayResetsAt?: string
    fiveHourResetsAt?: string
  },
): StoredAccount {
  return makeAccount({
    ...partial,
    quota: {
      fiveHour: quota.fiveHour ?? null,
      sevenDay: quota.sevenDay ?? null,
      ...(quota.fiveHourResetsAt
        ? { fiveHourResetsAt: quota.fiveHourResetsAt }
        : {}),
      ...(quota.sevenDayResetsAt
        ? { sevenDayResetsAt: quota.sevenDayResetsAt }
        : {}),
      fetchedAt: NOW,
    },
  })
}

describe('parseStrategy', () => {
  test('defaults unknown values to smart', () => {
    expect(parseStrategy(undefined)).toBe('smart')
    expect(parseStrategy('')).toBe('smart')
    expect(parseStrategy('bogus')).toBe('smart')
    expect(parseStrategy('round_robin')).toBe('round_robin')
    expect(parseStrategy('lowest_quota')).toBe('lowest_quota')
  })

  test('isStrategyOverridden flags unknown non-empty values', () => {
    expect(isStrategyOverridden(undefined)).toBe(false)
    expect(isStrategyOverridden('smart')).toBe(false)
    expect(isStrategyOverridden('bogus')).toBe(true)
  })
})

describe('eligibleIndexes', () => {
  test('skips disabled and rate-limited accounts', () => {
    const accounts = [
      makeAccount({ refresh: 'r0', rateLimitedUntil: NOW + 60_000 }),
      makeAccount({ refresh: 'r1', enabled: false }),
      makeAccount({ refresh: 'r2' }),
    ]
    expect(eligibleIndexes(accounts, NOW)).toEqual([2])
  })
})

describe('pickRoundRobin', () => {
  test('advances past the cursor and wraps around', () => {
    const accounts = [makeAccount(), makeAccount(), makeAccount()]
    expect(pickRoundRobin(accounts, 0, NOW)).toBe(1)
    expect(pickRoundRobin(accounts, 2, NOW)).toBe(0)
  })

  test('skips ineligible accounts and returns null when exhausted', () => {
    const accounts = [
      makeAccount({ rateLimitedUntil: NOW + 60_000 }),
      makeAccount({ enabled: false }),
    ]
    expect(pickRoundRobin(accounts, 0, NOW)).toBeNull()
  })
})

describe('pickLeastRecentlyUsed', () => {
  test('prefers never-used accounts, then the oldest lastUsed', () => {
    const accounts = [
      makeAccount({ lastUsed: 3000 }),
      makeAccount({ lastUsed: 1000 }),
      makeAccount(),
    ]
    expect(pickLeastRecentlyUsed(accounts, [0, 1, 2])).toBe(2)
    expect(pickLeastRecentlyUsed(accounts, [0, 1])).toBe(1)
  })
})

describe('pickLowestQuota', () => {
  test('picks the lowest seven-day utilization', () => {
    const accounts = [
      withQuota({ refresh: 'r0' }, { fiveHour: 0.1, sevenDay: 0.8 }),
      withQuota({ refresh: 'r1' }, { fiveHour: 0.9, sevenDay: 0.2 }),
      withQuota({ refresh: 'r2' }, { fiveHour: 0.05, sevenDay: 0.6 }),
    ]
    expect(pickLowestQuota(accounts, NOW)).toBe(1)
  })

  test('falls back to five-hour when weekly data is missing', () => {
    const accounts = [
      withQuota({ refresh: 'r0' }, { fiveHour: 0.8 }),
      withQuota({ refresh: 'r1' }, { fiveHour: 0.2 }),
    ]
    expect(pickLowestQuota(accounts, NOW)).toBe(1)
  })

  test('falls back to LRU when no quota data exists', () => {
    const accounts = [
      makeAccount({ lastUsed: 3000 }),
      makeAccount({ lastUsed: 1000 }),
    ]
    expect(pickLowestQuota(accounts, NOW)).toBe(1)
  })
})

describe('pickSmart', () => {
  test('drains the account whose weekly window resets soonest', () => {
    const soon = new Date(NOW + 60 * 60 * 1000).toISOString()
    const later = new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString()
    const accounts = [
      withQuota(
        { refresh: 'r0' },
        { fiveHour: 0.5, sevenDay: 0.5, sevenDayResetsAt: later },
      ),
      withQuota(
        { refresh: 'r1' },
        { fiveHour: 0.5, sevenDay: 0.5, sevenDayResetsAt: soon },
      ),
    ]
    expect(pickSmart(accounts, NOW)).toBe(1)
  })

  test('guardrail avoids accounts with nearly-spent 5h windows', () => {
    const farFiveHour = new Date(NOW + 4 * 60 * 60 * 1000).toISOString()
    const accounts = [
      withQuota(
        { refresh: 'r0' },
        { fiveHour: 0.95, sevenDay: 0.1, fiveHourResetsAt: farFiveHour },
      ),
      withQuota({ refresh: 'r1' }, { fiveHour: 0.5, sevenDay: 0.5 }),
    ]
    expect(pickSmart(accounts, NOW)).toBe(1)
  })

  test('guardrail lifts when the 5h window renews imminently', () => {
    const soonFiveHour = new Date(NOW + 10 * 60 * 1000).toISOString()
    const soonWeekly = new Date(NOW + 60 * 60 * 1000).toISOString()
    const lowSpend = withQuota(
      { refresh: 'r0' },
      {
        fiveHour: 0.95,
        sevenDay: 0.1,
        fiveHourResetsAt: soonFiveHour,
        sevenDayResetsAt: soonWeekly,
      },
    )
    const other = withQuota({ refresh: 'r1' }, { fiveHour: 0.5, sevenDay: 0.5 })
    // No guardrail penalty applies; weekly urgency + low weekly use wins.
    expect(scoreAccount(lowSpend, 0.3, NOW)).toBeGreaterThan(
      scoreAccount(other, 0.3, NOW)!,
    )
  })

  test('fairness penalty prefers the less-used account at equal headroom', () => {
    const accounts = [
      withQuota({ refresh: 'r0' }, { fiveHour: 0.2, sevenDay: 0.9 }),
      withQuota({ refresh: 'r1' }, { fiveHour: 0.2, sevenDay: 0.1 }),
    ]
    expect(pickSmart(accounts, NOW)).toBe(1)
  })

  test('returns null when every account is exhausted', () => {
    const accounts = [makeAccount({ enabled: false })]
    expect(pickSmart(accounts, NOW)).toBeNull()
  })
})
