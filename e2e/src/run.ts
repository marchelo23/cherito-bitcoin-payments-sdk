import { resolve } from 'node:path'
import { bootstrapEnvironment } from './bootstrap.js'
import * as docker from './docker.js'
import { E2E_ROOT } from './env.js'

const SUITES: Record<string, string[]> = {
  smoke: [
    'tests/happy-path.test.ts',
    'tests/malformed-input.test.ts',
  ],
  full: [
    'tests/happy-path.test.ts',
    'tests/lifecycle.test.ts',
    'tests/authorization.test.ts',
    'tests/payment-links.test.ts',
    'tests/malformed-input.test.ts',
    'tests/webhook-failures.test.ts',
    'tests/restart.test.ts',
    'tests/failure-injection.test.ts',
    'tests/migration-restore.test.ts',
    'tests/log-secrets.test.ts',
  ],
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function teardown(): Promise<void> {
  process.stdout.write('\n[e2e] tearing down regtest environment\n')
  await docker.down()
}

async function main(): Promise<void> {
  if (flag('only-down')) {
    await teardown()
    return
  }

  const suiteName = option('suite') ?? 'full'
  const files = SUITES[suiteName]
  if (!files) {
    throw new Error(`Unknown suite "${suiteName}". Available: ${Object.keys(SUITES).join(', ')}`)
  }

  const startedAt = Date.now()
  process.stdout.write('[e2e] removing any previous regtest environment\n')
  await docker.down()

  process.stdout.write('[e2e] bootstrapping bitcoin regtest, lnd nodes, gateway and receiver\n')
  const state = await bootstrapEnvironment()
  const bootMs = Date.now() - startedAt
  process.stdout.write(
    `[e2e] environment ready in ${Math.round(bootMs / 1000)}s`
    + ` merchant=${state.merchantPubkey.slice(0, 12)} payer=${state.payerPubkey.slice(0, 12)}\n`,
  )

  if (flag('only-up')) {
    process.stdout.write('[e2e] --only-up requested, leaving environment running\n')
    return
  }

  process.stdout.write(`[e2e] running "${suiteName}" suite\n`)
  const testsStartedAt = Date.now()
  const result = await docker.run(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', ...files.map((file) => resolve(E2E_ROOT, file))],
    { cwd: E2E_ROOT, timeoutMs: 3_600_000 },
  )
  const testMs = Date.now() - testsStartedAt

  process.stdout.write(
    `\n[e2e] suite finished in ${Math.round(testMs / 1000)}s`
    + ` (total ${Math.round((Date.now() - startedAt) / 1000)}s) exit=${result.code}\n`,
  )

  if (result.code !== 0) {
    const dir = await docker.collectLogs('failure')
    process.stdout.write(`[e2e] container logs written to ${dir}\n`)
  }

  if (!flag('keep')) await teardown()

  if (result.code !== 0) process.exitCode = result.code
}

main().catch(async (error: unknown) => {
  process.stderr.write(`\n[e2e] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  try {
    const dir = await docker.collectLogs('fatal')
    process.stderr.write(`[e2e] container logs written to ${dir}\n`)
  } catch {
    process.stderr.write('[e2e] container logs were not collectable\n')
  }
  if (!flag('keep')) await teardown()
  process.exitCode = 1
})
