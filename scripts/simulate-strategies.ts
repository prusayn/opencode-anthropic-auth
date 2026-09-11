/**
 * §9 minimal strategy simulator: compares round_robin vs lowest_quota vs smart
 * on synthetic 5h/7d quota scenarios. Deterministic (seeded) and dependency-free.
 *
 * Usage: bun scripts/simulate-strategies.ts [--trials 200] [--seed 42]
 */

import type { StoredAccount } from '../src/storage.ts'
import { pickLowestQuota, pickRoundRobin, pickSmart } from '../src/strategy.ts'

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeAccounts(
  rng: () => number,
  count: number,
  staggered: boolean,
  now: number,
): StoredAccount[] {
  return Array.from({ length: count }, (_, i) => {
    const fiveCap = 120 + Math.floor(rng() * 140)
    const sevenCap = fiveCap * (13 + Math.floor(rng() * 17))
    const fiveUsed = Math.floor(rng() * fiveCap * 0.9)
    const sevenUsed = Math.floor(rng() * sevenCap * 0.9)
    const weekOffset = staggered ? (i * 7 * 24 * 60 * 60 * 1000) / count : 0
    return {
      refresh: `refresh-${i}`,
      access: `access-${i}`,
      expires: now + 3600_000,
      addedAt: now - 1_000,
      enabled: true,
      quota: {
        fiveHour: fiveUsed / fiveCap,
        sevenDay: sevenUsed / sevenCap,
        fiveHourResetsAt: new Date(
          now + 5 * 3600_000 - rng() * 5 * 3600_000,
        ).toISOString(),
        sevenDayResetsAt: new Date(
          now + 7 * 24 * 3600_000 - weekOffset - rng() * 24 * 3600_000,
        ).toISOString(),
        fetchedAt: now,
      },
    }
  })
}

const args = process.argv.slice(2)
const trials =
  Number.parseInt(args[args.indexOf('--trials') + 1] ?? '200', 10) || 200
const seed = Number.parseInt(args[args.indexOf('--seed') + 1] ?? '42', 10) || 42

const policies = {
  round_robin: (accounts: StoredAccount[], cursor: number, now: number) =>
    pickRoundRobin(accounts, cursor, now),
  lowest_quota: (accounts: StoredAccount[], _cursor: number, now: number) =>
    pickLowestQuota(accounts, now),
  smart: (accounts: StoredAccount[], _cursor: number, now: number) =>
    pickSmart(accounts, now),
} as const

type Totals = { served: number; demand: number }
const totals: Record<keyof typeof policies, Totals> = {
  round_robin: { served: 0, demand: 0 },
  lowest_quota: { served: 0, demand: 0 },
  smart: { served: 0, demand: 0 },
}

for (let trial = 0; trial < trials; trial++) {
  const rng = mulberry32(seed + trial)
  const now = Date.now()
  const staggered = trial % 2 === 1
  const count = 2 + Math.floor(rng() * 2)
  // One shared scenario per trial so policies are directly comparable.
  const base = makeAccounts(rng, count, staggered, now)
  const demand = 60 + Math.floor(rng() * 120)
  for (const [name, pick] of Object.entries(policies)) {
    const accounts = structuredClone(base)
    // Model each request as consuming 1 unit of the picked account's remaining quota.
    let cursor = 0
    let served = 0
    for (let r = 0; r < demand; r++) {
      const index = pick(accounts, cursor, now)
      if (index === null) break
      cursor = index
      const account = accounts[index]
      const quota = account?.quota
      if (!account || !quota) break
      const fiveHour = quota.fiveHour ?? 0
      const sevenDay = quota.sevenDay ?? 0
      if (fiveHour >= 1 || sevenDay >= 1) {
        account.rateLimitedUntil = now + 60_000
        continue
      }
      quota.fiveHour = Math.min(1, fiveHour + 1 / 200)
      quota.sevenDay = Math.min(1, sevenDay + 1 / 3000)
      account.lastUsed = now + r
      served++
    }
    totals[name as keyof typeof policies].served += served
    totals[name as keyof typeof policies].demand += demand
  }
}

console.log(`trials=${trials} seed=${seed}`)
for (const [name, total] of Object.entries(totals)) {
  console.log(
    `${name}: served ${(total.served / Math.max(1, total.demand)) * 100}% (${total.served}/${total.demand})`,
  )
}
