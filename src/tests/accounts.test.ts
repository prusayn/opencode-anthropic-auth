import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountManager, modelFromBody, parseModelPins } from '../accounts'
import type { StoredAccount } from '../storage'
import { saveAccounts } from '../storage'

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

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'anthropic-manager-test-'))
  return { dir, file: join(dir, 'anthropic-accounts.json') }
}

describe('AccountManager', () => {
  test('nextRoundRobin rotates and persists the cursor', () => {
    const { dir, file } = tempFile()
    try {
      const manager = new AccountManager(
        [makeAccount({ refresh: 'r0' }), makeAccount({ refresh: 'r1' })],
        0,
        file,
      )
      expect(manager.nextRoundRobin(NOW)?.index).toBe(1)
      expect(manager.nextRoundRobin(NOW)?.index).toBe(0)
      expect(manager.getCursor()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('selectSticky picks the lowest-quota account without refetching fresh caches', async () => {
    const { dir, file } = tempFile()
    try {
      const now = Date.now()
      saveAccounts(
        {
          version: 1,
          cursor: 0,
          accounts: [
            makeAccount({
              refresh: 'r0',
              quota: { fiveHour: 0.9, sevenDay: 0.9, fetchedAt: now },
            }),
            makeAccount({
              refresh: 'r1',
              quota: { fiveHour: 0.1, sevenDay: 0.1, fetchedAt: now },
            }),
          ],
        },
        file,
      )
      const manager = AccountManager.load(file)
      let fetches = 0
      const picked = await manager.selectSticky(
        'lowest_quota',
        60_000,
        async () => {
          fetches++
          return null
        },
      )
      expect(picked?.index).toBe(1)
      expect(fetches).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('failover marks the current account and switches', () => {
    const { dir, file } = tempFile()
    try {
      const manager = new AccountManager(
        [makeAccount({ refresh: 'r0' }), makeAccount({ refresh: 'r1' })],
        0,
        file,
      )
      const next = manager.failover(0, 'round_robin', 30_000, NOW)
      expect(next?.index).toBe(1)
      expect(manager.get(0)?.rateLimitedUntil).toBe(NOW + 30_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('failover returns null when all accounts are exhausted', () => {
    const manager = new AccountManager([makeAccount({ refresh: 'r0' })], 0)
    expect(manager.failover(0, 'round_robin', 60_000, NOW)).toBeNull()
  })

  test('getShortestWait reports the nearest reset', () => {
    const manager = new AccountManager(
      [
        makeAccount({ rateLimitedUntil: NOW + 40_000 }),
        makeAccount({ rateLimitedUntil: NOW + 10_000 }),
        makeAccount(),
      ],
      2,
    )
    expect(manager.getShortestWait(NOW)).toBe(10_000)
    expect(
      new AccountManager([makeAccount()], 0).getShortestWait(NOW),
    ).toBeNull()
  })

  test('resolvePinned sticks pinned model prefixes to their account', () => {
    const { dir, file } = tempFile()
    try {
      const manager = new AccountManager(
        [makeAccount({ refresh: 'r0' }), makeAccount({ refresh: 'r1' })],
        0,
        file,
      )
      const pins = parseModelPins('opus:1')
      const body = JSON.stringify({ model: 'opus-4-1', messages: [] })
      expect(manager.resolvePinned(body, pins, NOW)?.index).toBe(1)
      expect(
        manager.resolvePinned(
          JSON.stringify({ model: 'sonnet-4', messages: [] }),
          pins,
          NOW,
        ),
      ).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('resolvePinned skips rate-limited pinned accounts', () => {
    const manager = new AccountManager(
      [makeAccount({ refresh: 'r0', rateLimitedUntil: NOW + 60_000 })],
      0,
    )
    expect(
      manager.resolvePinned(
        JSON.stringify({ model: 'opus-x' }),
        parseModelPins('opus:0'),
        NOW,
      ),
    ).toBeNull()
  })
})

describe('model pin helpers', () => {
  test('parseModelPins ignores malformed entries', () => {
    const pins = parseModelPins('opus:1, bad, sonnet:0, opus:2')
    expect(pins.get('opus')).toBe(2)
    expect(pins.get('sonnet')).toBe(0)
    expect(pins.size).toBe(2)
  })

  test('modelFromBody returns null for non-JSON or model-less bodies', () => {
    expect(modelFromBody(JSON.stringify({ model: 'opus' }))).toBe('opus')
    expect(modelFromBody('not-json')).toBeNull()
    expect(modelFromBody(JSON.stringify({}))).toBeNull()
    expect(modelFromBody(undefined)).toBeNull()
  })
})
