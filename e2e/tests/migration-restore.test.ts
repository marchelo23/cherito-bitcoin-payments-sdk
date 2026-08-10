import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as docker from '../src/docker.js'
import { getMerchantIntent, health, receiverReset } from '../src/gateway-client.js'
import { newIntent, payFromPayerNode, state, waitForIntentStatus } from '../src/harness.js'
import { lookupInvoice } from '../src/lnd.js'
import { waitFor } from '../src/wait.js'

const BACKUP_PATH = '/app/data/backups/e2e-rehearsal.cherito-backup'

test('a restored backup cannot override real lightning state', { timeout: 700_000 }, async () => {
  const fixtures = await state()
  await receiverReset()

  const intent = await newIntent('23500')
  assert.equal(intent.status, 'requires_payment')

  await docker.execOrThrow('gateway', ['rm', '-f', BACKUP_PATH])
  await docker.execOrThrow('gateway', [
    'node',
    'dist/database-cli.js',
    'backup',
    '--output',
    BACKUP_PATH,
    '--reason',
    'e2e restore rehearsal',
  ])

  const listed = await docker.execOrThrow('gateway', ['ls', '-l', BACKUP_PATH])
  assert.ok(listed.includes('e2e-rehearsal'), 'the backup artefact was not produced')

  await payFromPayerNode(intent.paymentRequest)
  const settled = await waitForIntentStatus(intent.id, 'succeeded')
  assert.equal(settled.status, 'succeeded')

  const providerInvoice = await lookupInvoice('merchant', intent.paymentHash)
  assert.equal(providerInvoice.settled, true, 'the provider does not consider the invoice paid')

  await docker.stopService('gateway')
  await docker.execOrThrow('gateway', ['ls', '/app/data'], true).catch(() => '')

  const restore = await docker.compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'gateway',
    'node',
    'dist/database-cli.js',
    'restore',
    '--input',
    BACKUP_PATH,
  ], { quiet: true })
  assert.equal(restore.code, 0, `restore command failed: ${restore.stderr.slice(-400)}`)

  await docker.startService('gateway')
  await waitFor(async () => {
    const result = await health()
    return result.status === 200 ? true : undefined
  }, { description: 'gateway health after restore', timeoutMs: 240_000, intervalMs: 2_000 })

  const reconciled = await waitForIntentStatus(intent.id, 'succeeded', 240_000)
  assert.equal(
    reconciled.status,
    'succeeded',
    'a stale restored database overrode real lightning settlement',
  )
  assert.ok(reconciled.settledAt, 'reconciliation did not restore the settlement timestamp')

  const merchantView = await getMerchantIntent(fixtures.tenantA.apiKey, intent.id)
  assert.equal(merchantView.body.paymentHash, intent.paymentHash, 'payment hash drifted after restore')
  assert.equal(merchantView.body.amountSats, '23500', 'amount drifted after restore')
})
