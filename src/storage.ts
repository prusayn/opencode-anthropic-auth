import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeUtilization } from './quota.ts'

export type QuotaCache = {
  /** Utilization as 0..1 ratio (normalized on write). Null when unknown. */
  fiveHour: number | null
  sevenDay: number | null
  fiveHourResetsAt?: string
  sevenDayResetsAt?: string
  fetchedAt: number
}

export type StoredAccount = {
  refresh: string
  access?: string
  expires?: number
  addedAt: number
  lastUsed?: number
  label?: string
  email?: string
  enabled: boolean
  rateLimitedUntil?: number
  quota?: QuotaCache | null
}

export type AccountStorage = {
  version: 1
  accounts: StoredAccount[]
  /** Last-used account index (round-robin cursor / sticky pointer). */
  cursor: number
}

export const DEFAULT_STORAGE_FILENAME = 'anthropic-accounts.json'
export const ACCOUNTS_PATH_ENV_VAR = 'ANTHROPIC_ACCOUNTS_PATH'

function defaultStoragePath(): string {
  return path.join(
    os.homedir(),
    '.config',
    'opencode',
    DEFAULT_STORAGE_FILENAME,
  )
}

/** Resolve the accounts file path. Never throws. */
export function resolveStoragePath(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = (override ?? env[ACCOUNTS_PATH_ENV_VAR] ?? '').trim()
  return raw || defaultStoragePath()
}

function cloneDefaultStorage(): AccountStorage {
  return { version: 1, accounts: [], cursor: 0 }
}

function normalizeAccount(entry: unknown, now: number): StoredAccount | null {
  if (!entry || typeof entry !== 'object') return null
  const candidate = entry as Partial<StoredAccount>
  if (typeof candidate.refresh !== 'string' || !candidate.refresh) return null

  const account: StoredAccount = {
    refresh: candidate.refresh,
    access: typeof candidate.access === 'string' ? candidate.access : undefined,
    expires:
      typeof candidate.expires === 'number' ? candidate.expires : undefined,
    addedAt: typeof candidate.addedAt === 'number' ? candidate.addedAt : now,
    lastUsed:
      typeof candidate.lastUsed === 'number' ? candidate.lastUsed : undefined,
    label: typeof candidate.label === 'string' ? candidate.label : undefined,
    email: typeof candidate.email === 'string' ? candidate.email : undefined,
    enabled: candidate.enabled ?? true,
  }

  if (
    typeof candidate.rateLimitedUntil === 'number' &&
    candidate.rateLimitedUntil > now
  ) {
    account.rateLimitedUntil = candidate.rateLimitedUntil
  }

  if (candidate.quota && typeof candidate.quota === 'object') {
    const quota = candidate.quota as Partial<QuotaCache>
    const fiveHour = normalizeUtilization(quota.fiveHour)
    const sevenDay = normalizeUtilization(quota.sevenDay)
    if (
      (fiveHour !== null || sevenDay !== null) &&
      typeof quota.fetchedAt === 'number'
    ) {
      account.quota = {
        fiveHour,
        sevenDay,
        ...(typeof quota.fiveHourResetsAt === 'string'
          ? { fiveHourResetsAt: quota.fiveHourResetsAt }
          : {}),
        ...(typeof quota.sevenDayResetsAt === 'string'
          ? { sevenDayResetsAt: quota.sevenDayResetsAt }
          : {}),
        fetchedAt: quota.fetchedAt,
      }
    }
  }

  return account
}

export function normalizeStorage(
  input: unknown,
  now = Date.now(),
): AccountStorage {
  if (!input || typeof input !== 'object') return cloneDefaultStorage()
  const candidate = input as Partial<AccountStorage> & { activeIndex?: unknown }
  const rawAccounts = Array.isArray(candidate.accounts)
    ? candidate.accounts
    : []
  const accounts = rawAccounts
    .map((entry) => normalizeAccount(entry, now))
    .filter((account): account is StoredAccount => account !== null)

  // Back-compat: prototype stored `activeIndex`; current schema uses `cursor`.
  const rawCursor =
    typeof candidate.cursor === 'number'
      ? candidate.cursor
      : typeof candidate.activeIndex === 'number'
        ? candidate.activeIndex
        : 0
  const cursor =
    accounts.length === 0
      ? 0
      : Math.min(Math.max(0, Math.trunc(rawCursor)), accounts.length - 1)

  return { version: 1, accounts, cursor }
}

export function loadAccounts(storagePath?: string): AccountStorage {
  const finalPath = resolveStoragePath(storagePath)
  if (!fs.existsSync(finalPath)) return cloneDefaultStorage()
  try {
    const parsed = JSON.parse(fs.readFileSync(finalPath, 'utf8')) as unknown
    return normalizeStorage(parsed)
  } catch {
    return cloneDefaultStorage()
  }
}

export function saveAccounts(data: AccountStorage, storagePath?: string): void {
  const finalPath = resolveStoragePath(storagePath)
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  const normalized = normalizeStorage(data)
  const content = `${JSON.stringify(normalized, null, 2)}\n`
  // Crash-safe without a lockfile: tmp-write + atomic rename.
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tempPath, finalPath)
  fs.chmodSync(finalPath, 0o600)
}

export function addAccount(
  account: StoredAccount,
  storagePath?: string,
): AccountStorage {
  const data = loadAccounts(storagePath)
  data.accounts.push(normalizeAccount(account, Date.now()) ?? account)
  // New account becomes the cursor so the just-added OAuth flow's token sync matches.
  data.cursor = data.accounts.length - 1
  saveAccounts(data, storagePath)
  return data
}

export function removeAccount(
  index: number,
  storagePath?: string,
): AccountStorage {
  const data = loadAccounts(storagePath)
  if (index < 0 || index >= data.accounts.length) return data
  data.accounts.splice(index, 1)
  if (data.accounts.length === 0) {
    data.cursor = 0
  } else if (index < data.cursor) {
    data.cursor -= 1
  } else if (data.cursor >= data.accounts.length) {
    data.cursor = data.accounts.length - 1
  }
  saveAccounts(data, storagePath)
  return data
}

export function setAccountEnabled(
  index: number,
  enabled: boolean,
  storagePath?: string,
): AccountStorage {
  const data = loadAccounts(storagePath)
  const account = data.accounts[index]
  if (!account) return data
  account.enabled = enabled
  saveAccounts(data, storagePath)
  return data
}

/** Seed data from a single-account OAuth snapshot (zero-config migration). */
export function accountFromOAuthSnapshot(snapshot: {
  type?: string
  refresh?: string
  access?: string
  expires?: number
  email?: string
  label?: string
}): StoredAccount | null {
  if (!snapshot.refresh) return null
  return {
    refresh: snapshot.refresh,
    access: snapshot.access,
    expires: snapshot.expires,
    addedAt: Date.now(),
    enabled: true,
    ...(snapshot.email ? { email: snapshot.email } : {}),
    ...(snapshot.label ? { label: snapshot.label } : {}),
  }
}
