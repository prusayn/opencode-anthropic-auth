import { fetchQuota, type QuotaSnapshot } from './quota.ts'
import { loadAccounts, type StoredAccount, saveAccounts } from './storage.ts'
import {
  eligibleIndexes,
  pickForStrategy,
  pickLeastRecentlyUsed,
  type StrategyName,
} from './strategy.ts'

export type ModelPinMap = Map<string, number>

const DEFAULT_QUOTA_TTL_MS = 60_000

/** Parse `ANTHROPIC_AUTH_MODEL_PIN="opus:0,sonnet:1"`. Never throws. */
export function parseModelPins(raw: string | undefined): ModelPinMap {
  const pins: ModelPinMap = new Map()
  for (const entry of (raw ?? '').split(',')) {
    const [model, indexRaw] = entry.split(':').map((part) => part.trim())
    if (!model || indexRaw === undefined || indexRaw === '') continue
    const index = Number.parseInt(indexRaw, 10)
    if (Number.isInteger(index) && index >= 0)
      pins.set(model.toLowerCase(), index)
  }
  return pins
}

/** Extract a model name from a messages request body (best-effort). */
export function modelFromBody(body: unknown): string | null {
  if (typeof body !== 'string') return null
  try {
    const model = (JSON.parse(body) as { model?: unknown }).model
    return typeof model === 'string' ? model : null
  } catch {
    return null
  }
}

export class AccountManager {
  private accounts: StoredAccount[]
  private cursor: number
  private storagePath?: string

  constructor(accounts: StoredAccount[], cursor: number, storagePath?: string) {
    this.accounts = accounts.map((account) => ({ ...account }))
    this.cursor =
      accounts.length === 0
        ? 0
        : Math.min(Math.max(0, Math.trunc(cursor)), accounts.length - 1)
    this.storagePath = storagePath
  }

  static load(storagePath?: string): AccountManager {
    const data = loadAccounts(storagePath)
    return new AccountManager(data.accounts, data.cursor, storagePath)
  }

  getAccounts(): StoredAccount[] {
    return this.accounts
  }

  getCursor(): number {
    return this.cursor
  }

  count(): number {
    return this.accounts.length
  }

  get(index: number): StoredAccount | undefined {
    return this.accounts[index]
  }

  getActive(): StoredAccount | undefined {
    return this.accounts[this.cursor]
  }

  eligible(now = Date.now()): number[] {
    return eligibleIndexes(this.accounts, now)
  }

  /** Per-request rotation for `round_robin` (synchronous; no I/O). */
  nextRoundRobin(
    now = Date.now(),
  ): { index: number; account: StoredAccount } | null {
    const eligible = eligibleIndexes(this.accounts, now)
    if (eligible.length === 0) return null
    const next = eligible.find((index) => index > this.cursor) ?? eligible[0]
    if (next === undefined) return null
    this.cursor = next
    const account = this.accounts[next]
    if (!account) return null
    account.lastUsed = now
    this.persist()
    return { index: next, account }
  }

  /**
   * Sticky selection for quota-based strategies. Refreshes stale quota caches
   * concurrently, then picks once. Quota failures fall back to LRU — never throws.
   */
  async selectSticky(
    strategy: Exclude<StrategyName, 'round_robin'>,
    quotaTtlMs = DEFAULT_QUOTA_TTL_MS,
    fetcher: (
      accessToken: string,
    ) => Promise<QuotaSnapshot | null> = fetchQuota,
  ): Promise<{ index: number; account: StoredAccount } | null> {
    const now = Date.now()
    const eligible = eligibleIndexes(this.accounts, now)
    if (eligible.length === 0) return null

    await Promise.allSettled(
      eligible.map(async (index) => {
        const account = this.accounts[index]
        if (!account) return
        const stale =
          !account.quota ||
          now - account.quota.fetchedAt > quotaTtlMs ||
          (account.quota.fiveHour === null && account.quota.sevenDay === null)
        if (!stale || !account.access) return
        const snapshot = await fetcher(account.access).catch(() => null)
        if (snapshot) account.quota = snapshot
      }),
    )

    const picked = pickForStrategy(
      strategy,
      this.accounts,
      this.cursor,
      Date.now(),
    )
    const index =
      picked !== null && eligible.includes(picked)
        ? picked
        : pickLeastRecentlyUsed(this.accounts, eligible)
    this.cursor = index
    const account = this.accounts[index]
    if (!account) return null
    account.lastUsed = Date.now()
    this.persist()
    return { index, account }
  }

  /**
   * Mark the current account rate-limited and fail over to the next eligible
   * account per `strategy`. Returns null when every account is exhausted.
   */
  failover(
    currentIndex: number,
    strategy: StrategyName,
    retryAfterMs: number,
    now = Date.now(),
  ): { index: number; account: StoredAccount } | null {
    const current = this.accounts[currentIndex]
    if (!current) return null
    current.rateLimitedUntil = now + Math.max(0, retryAfterMs)
    const picked = pickForStrategy(strategy, this.accounts, currentIndex, now)
    if (picked === null || picked === currentIndex) {
      this.persist()
      return null
    }
    this.cursor = picked
    const account = this.accounts[picked]
    if (!account) {
      this.persist()
      return null
    }
    account.lastUsed = now
    this.persist()
    return { index: picked, account }
  }

  /**
   * §9 per-model routing: when the request model matches a pin prefix and the
   * pinned account is eligible, stick to it for this request.
   */
  resolvePinned(
    body: unknown,
    pins: ModelPinMap,
    now = Date.now(),
  ): { index: number; account: StoredAccount } | null {
    if (pins.size === 0) return null
    const model = modelFromBody(body)?.toLowerCase()
    if (!model) return null
    for (const [prefix, index] of pins) {
      if (!model.startsWith(prefix)) continue
      const account = this.accounts[index]
      if (!account || account.enabled === false || !account.refresh) return null
      if (
        typeof account.rateLimitedUntil === 'number' &&
        account.rateLimitedUntil > now
      ) {
        return null
      }
      this.cursor = index
      account.lastUsed = now
      this.persist()
      return { index, account }
    }
    return null
  }

  updateTokens(
    index: number,
    tokens: { refresh: string; access: string; expires: number },
  ): void {
    const account = this.accounts[index]
    if (!account) return
    account.refresh = tokens.refresh
    account.access = tokens.access
    account.expires = tokens.expires
    this.persist()
  }

  updateEmail(index: number, email: string): void {
    const account = this.accounts[index]
    if (!account || account.email) return
    account.email = email
    this.persist()
  }

  /**
   * Adopt a rotated refresh token observed out-of-band (native slot or disk).
   * Refresh-only: never touches access/expiry pairing.
   */
  adoptRefresh(index: number, refresh: string): void {
    const account = this.accounts[index]
    if (!account || !refresh || account.refresh === refresh) return
    account.refresh = refresh
    this.persist()
  }

  markUsed(index: number, now = Date.now()): void {
    const account = this.accounts[index]
    if (!account) return
    account.lastUsed = now
    this.persist()
  }

  getShortestWait(now = Date.now()): number | null {
    let shortest = Number.POSITIVE_INFINITY
    for (const account of this.accounts) {
      if (typeof account.rateLimitedUntil !== 'number') continue
      if (account.rateLimitedUntil <= now) continue
      shortest = Math.min(shortest, account.rateLimitedUntil - now)
    }
    return Number.isFinite(shortest) ? shortest : null
  }

  private persist(): void {
    try {
      saveAccounts(
        { version: 1, accounts: this.accounts, cursor: this.cursor },
        this.storagePath,
      )
    } catch {
      // Persistence is best-effort on the request path; in-memory state still applies.
    }
  }
}
