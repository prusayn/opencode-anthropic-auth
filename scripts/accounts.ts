/**
 * Account admin CLI for multi-account storage.
 *
 * Usage:
 *   bun scripts/accounts.ts list
 *   bun scripts/accounts.ts remove <n>
 *   bun scripts/accounts.ts enable <n> | disable <n>
 *   bun scripts/accounts.ts add   # interactive OAuth wizard (prints URL, reads code)
 *
 * The plugin host has no stdin, so interactive account management lives here
 * instead of in auth methods.
 */
import readline from 'node:readline'
import { authorize, exchange } from '../src/auth.ts'
import { fetchAccountEmail, fetchQuota, getUtilization } from '../src/quota.ts'
import {
  loadAccounts,
  removeAccount,
  resolveStoragePath,
  saveAccounts,
  setAccountEnabled,
} from '../src/storage.ts'

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()))
  })
}

function mask(refresh: string): string {
  return refresh.length <= 8
    ? '…'
    : `${refresh.slice(0, 4)}…${refresh.slice(-4)}`
}

async function listCommand(showUsage: boolean): Promise<void> {
  const storagePath = resolveStoragePath()
  const data = loadAccounts(storagePath)
  console.log(`Storage: ${storagePath}`)
  if (data.accounts.length === 0) {
    console.log('No accounts configured. Run /connect → Claude Pro/Max first.')
    return
  }
  for (let i = 0; i < data.accounts.length; i++) {
    const account = data.accounts[i]
    if (!account) continue
    const label = account.label || account.email || `Account ${i + 1}`
    const status = account.enabled ? 'enabled' : 'disabled'
    const active = i === data.cursor ? ' (active)' : ''
    let usage = ''
    if (showUsage) {
      const access = account.access
      if (!access || (account.expires ?? 0) < Date.now()) {
        usage = ' (token expired — open OpenCode once to refresh)'
      } else {
        const quota = await fetchQuota(access).catch(() => null)
        const utilization = quota ? getUtilization(quota) : null
        usage =
          utilization === null || utilization === undefined
            ? ' — usage unavailable'
            : ` — ${(utilization * 100).toFixed(1)}% used`
      }
    }
    console.log(
      `  ${i + 1}. ${label} [${status}]${active} refresh=${mask(account.refresh)}${usage}`,
    )
  }
}

async function addCommand(): Promise<void> {
  const storagePath = resolveStoragePath()
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const result = await authorize('max')
    console.log(`\nAuthorize at:\n${result.url}\n`)
    const code = await ask(rl, 'Paste the authorization code here: ')
    const credentials = await exchange(
      code,
      result.verifier,
      result.redirectUri,
      result.state,
    )
    if (credentials.type === 'failed') {
      console.error('Exchange failed. Check the pasted code and try again.')
      process.exitCode = 1
      return
    }
    const email = await fetchAccountEmail(credentials.access).catch(() => null)
    const data = loadAccounts(storagePath)
    data.accounts.push({
      refresh: credentials.refresh,
      access: credentials.access,
      expires: credentials.expires,
      addedAt: Date.now(),
      enabled: true,
      ...(email
        ? { email, label: email }
        : { label: `Account ${data.accounts.length + 1}` }),
    })
    data.cursor = data.accounts.length - 1
    saveAccounts(data, storagePath)
    console.log(
      `Added ${email ?? `account ${data.accounts.length}`} to ${storagePath}`,
    )
  } finally {
    rl.close()
  }
}

const [command, arg] = process.argv.slice(2)

if (command === 'list' || command === 'usage') {
  await listCommand(command === 'usage')
} else if (command === 'add') {
  await addCommand()
} else if (
  (command === 'remove' || command === 'enable' || command === 'disable') &&
  arg
) {
  const storagePath = resolveStoragePath()
  const index = Number.parseInt(arg, 10) - 1
  const data = loadAccounts(storagePath)
  if (!Number.isInteger(index) || index < 0 || index >= data.accounts.length) {
    console.error(`Invalid account number: ${arg}`)
    process.exitCode = 1
  } else if (command === 'remove') {
    removeAccount(index, storagePath)
    console.log(`Removed account ${index + 1}.`)
  } else {
    setAccountEnabled(index, command === 'enable', storagePath)
    console.log(
      `${command === 'enable' ? 'Enabled' : 'Disabled'} account ${index + 1}.`,
    )
  }
} else {
  console.log(
    'Usage: bun scripts/accounts.ts <list|usage|add|remove <n>|enable <n>|disable <n>>',
  )
  process.exitCode = 1
}
