import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as docker from '../src/docker.js'
import {
  failedDeliveries,
  health,
  receiverReset,
  receiverSetMode,
  receiverState,
} from '../src/gateway-client.js'
import { newIntent, payFromPayerNode, state, waitForIntentStatus } from '../src/harness.js'
import { assertRegtestNode, lookupInvoice } from '../src/lnd.js'
import { waitFor } from '../src/wait.js'

async function waitForGatewayHealthy(timeoutMs = 180_000): Promise<void> {
  await waitFor(async () => {
    const result = await health()
    return result.status === 200 ? true : undefined
  }, { description: 'gateway to become healthy again', timeoutMs, intervalMs: 1_000 })
}

test('a payment made while the gateway is down is recovered from provider truth on restart', { timeout: 500_000 }, async () => {
  await receiverReset()
  const intent = await newIntent('17500')

  await docker.stopService('gateway')

  await payFromPayerNode(intent.paymentRequest)

  const providerInvoice = await lookupInvoice('merchant', intent.paymentHash)
  assert.equal(providerInvoice.settled, true, 'the payer did not actually settle the invoice')

  await docker.startService('gateway')
  await waitForGatewayHealthy()

  const recovered = await waitForIntentStatus(intent.id, 'succeeded', 180_000)
  assert.equal(recovered.status, 'succeeded')
  assert.ok(recovered.settledAt, 'recovered intent has no settlement timestamp')

  const fulfilment = await waitFor(async () => {
    const snapshot = await receiverState()
    return snapshot.fulfillments.find((entry) => entry.paymentIntentId === intent.id)
  }, { description: 'webhook fulfilment after recovery', timeoutMs: 180_000 })

  assert.equal(fulfilment.count, 1, 'recovery produced more than one fulfilment')
})

test('a durable pending webhook survives a gateway restart and delivers exactly once', { timeout: 500_000 }, async () => {
  const fixtures = await state()
  await receiverReset()
  await receiverSetMode('outage', { status: 503 })

  const intent = await newIntent('18500')
  await payFromPayerNode(intent.paymentRequest)
  await waitForIntentStatus(intent.id, 'succeeded')

  await waitFor(async () => {
    const snapshot = await receiverState()
    return snapshot.deliveries.some(
      (delivery) => delivery.responseStatus === 503 && delivery.rawBody.includes(intent.id),
    )
  }, { description: 'a failed delivery attempt before restart', timeoutMs: 120_000 })

  const beforeRestart = await failedDeliveries(fixtures.tenantA.apiKey)
  assert.ok(
    beforeRestart.body.items.length >= 1,
    'no durable pending delivery existed before the restart',
  )

  await docker.stopService('gateway')
  await receiverReset()
  await receiverSetMode('ok')
  await docker.startService('gateway')
  await waitForGatewayHealthy()

  const fulfilment = await waitFor(async () => {
    const snapshot = await receiverState()
    return snapshot.fulfillments.find((entry) => entry.paymentIntentId === intent.id)
  }, { description: 'the pending webhook to resume after restart', timeoutMs: 240_000 })

  assert.equal(fulfilment.count, 1, 'the resumed webhook fulfilled more than once')

  const snapshot = await receiverState()
  const accepted = snapshot.deliveries.filter(
    (delivery) => delivery.accepted && delivery.paymentIntentId === intent.id,
  )
  assert.equal(accepted.length, 1, 'more than one accepted delivery after restart')
})

test('the gateway tolerates a provider outage and settles once the node returns', { timeout: 600_000 }, async () => {
  await receiverReset()
  const intent = await newIntent('19500')

  await docker.restartService('lnd-merchant')

  await waitFor(async () => {
    await assertRegtestNode('merchant')
    return true
  }, { description: 'merchant lnd to come back online', timeoutMs: 240_000, intervalMs: 2_000 })

  await waitForGatewayHealthy(240_000)

  const stillPending = await waitForIntentStatus(intent.id, 'requires_payment', 60_000)
  assert.equal(
    stillPending.status,
    'requires_payment',
    'a provider restart wrongly advanced the intent state',
  )

  await payFromPayerNode(intent.paymentRequest)

  const settled = await waitForIntentStatus(intent.id, 'succeeded', 240_000)
  assert.equal(settled.status, 'succeeded')

  const fulfilment = await waitFor(async () => {
    const snapshot = await receiverState()
    return snapshot.fulfillments.find((entry) => entry.paymentIntentId === intent.id)
  }, { description: 'fulfilment after provider recovery', timeoutMs: 180_000 })
  assert.equal(fulfilment.count, 1)
})
