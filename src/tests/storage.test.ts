import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accountFromOAuthSnapshot,
  addAccount,
  loadAccounts,
  normalizeStorage,
  normalizeUtilization,
  removeAccount,
  resolveStoragePath,
  type StoredAccount,
  saveAccounts,
  setAccountEnabled,
} from '../storage'

function tempPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'anthropic-storage-test-'))
  return { dir, file: join(dir, 'anthropic-accounts.json') }
}

function makeAccount(partial: Partial<StoredAccount> = {}): StoredAccount {
  return {
    refresh: 'refresh-default',
    access: 'access-default',
    expires: Date.now() + 3600_000,
    addedAt: Date.now() - 1000,
    enabled: true,
    ...partial,
  }
}

describe('normalizeUtilization', () => {
  test('accepts 0..1 ratios as-is', () => {
    expect(normalizeUtilization(0.5)).toBe(0.5)
  })

  test('converts 0..100 percentages to ratios', () => {
    expect(normalizeUtilization(50)).toBe(0.5)
  })

  test('rejects non-numbers and negatives', () => {
    expect(normalizeUtilization('50')).toBeNull()
    expect(normalizeUtilization(-1)).toBeNull()
    expect(normalizeUtilization(Number.NaN)).toBeNull()
  })
})

describe('normalizeStorage', () => {
  test('returns empty storage for garbage input', () => {
    expect(normalizeStorage(null)).toEqual({
      version: 1,
      accounts: [],
      cursor: 0,
    })
    expect(normalizeStorage('nope')).toEqual({
      version: 1,
      accounts: [],
      cursor: 0,
    })
  })

  test('drops accounts without a refresh token', () => {
    const storage = normalizeStorage({
      accounts: [{ access: 'x' }, makeAccount()],
    })
    expect(storage.accounts).toHaveLength(1)
  })

  test('drops expired rateLimitedUntil markers', () => {
    const storage = normalizeStorage({
      accounts: [makeAccount({ rateLimitedUntil: Date.now() - 1000 })],
    })
    expect(storage.accounts[0]?.rateLimitedUntil).toBeUndefined()
  })

  test('reads the prototype activeIndex field as cursor', () => {
    const storage = normalizeStorage({
      accounts: [makeAccount(), makeAccount()],
      activeIndex: 1,
    })
    expect(storage.cursor).toBe(1)
  })

  test('clamps an out-of-range cursor', () => {
    const storage = normalizeStorage({ accounts: [makeAccount()], cursor: 9 })
    expect(storage.cursor).toBe(0)
  })
})

describe('storage round-trip', () => {
  test('save then load preserves accounts and cursor', () => {
    const { dir, file } = tempPath()
    try {
      saveAccounts(
        {
          version: 1,
          accounts: [
            makeAccount({ refresh: 'r0' }),
            makeAccount({ refresh: 'r1' }),
          ],
          cursor: 1,
        },
        file,
      )
      const loaded = loadAccounts(file)
      expect(loaded.accounts.map((a) => a.refresh)).toEqual(['r0', 'r1'])
      expect(loaded.cursor).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('saved file has 0600 permissions', () => {
    const { dir, file } = tempPath()
    try {
      saveAccounts({ version: 1, accounts: [makeAccount()], cursor: 0 }, file)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('load returns empty storage for a missing file', () => {
    const { dir, file } = tempPath()
    try {
      expect(loadAccounts(file)).toEqual({
        version: 1,
        accounts: [],
        cursor: 0,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('add/remove/enable', () => {
  test('addAccount appends and moves the cursor to the new account', () => {
    const { dir, file } = tempPath()
    try {
      addAccount(makeAccount({ refresh: 'r0' }), file)
      const data = addAccount(makeAccount({ refresh: 'r1' }), file)
      expect(data.accounts).toHaveLength(2)
      expect(data.cursor).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('removeAccount adjusts the cursor', () => {
    const { dir, file } = tempPath()
    try {
      saveAccounts(
        {
          version: 1,
          accounts: [
            makeAccount({ refresh: 'r0' }),
            makeAccount({ refresh: 'r1' }),
          ],
          cursor: 1,
        },
        file,
      )
      const data = removeAccount(0, file)
      expect(data.accounts.map((a) => a.refresh)).toEqual(['r1'])
      expect(data.cursor).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('setAccountEnabled toggles without touching other accounts', () => {
    const { dir, file } = tempPath()
    try {
      saveAccounts(
        {
          version: 1,
          accounts: [
            makeAccount({ refresh: 'r0' }),
            makeAccount({ refresh: 'r1' }),
          ],
          cursor: 0,
        },
        file,
      )
      const data = setAccountEnabled(1, false, file)
      expect(data.accounts[0]?.enabled).toBe(true)
      expect(data.accounts[1]?.enabled).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('accountFromOAuthSnapshot', () => {
  test('returns null without a refresh token', () => {
    expect(accountFromOAuthSnapshot({ type: 'oauth' })).toBeNull()
  })

  test('seeds an enabled account from an oauth snapshot', () => {
    const account = accountFromOAuthSnapshot({
      refresh: 'r',
      access: 'a',
      expires: 123,
    })
    expect(account).toMatchObject({
      refresh: 'r',
      access: 'a',
      expires: 123,
      enabled: true,
    })
  })
})

describe('resolveStoragePath', () => {
  test('env override wins over the default', () => {
    expect(
      resolveStoragePath(undefined, {
        ANTHROPIC_ACCOUNTS_PATH: ' /tmp/custom.json ',
      }),
    ).toBe('/tmp/custom.json')
  })
})
