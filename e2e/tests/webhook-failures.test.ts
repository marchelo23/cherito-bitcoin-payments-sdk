import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { failedDeliveries, postRawWebhook, receiverReset, receiverSetMode, receiverState } from '../src/gateway-client.js'
import { newIntent, payFromPayerNode, state, waitForIntentStatus } from '../src/harness.js'
import { waitFor } from '../src/wait.js'

function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(String(timestamp)).update('.').update(body).digest('hex')
}

test('a merchant outage defers delivery, then one logical event is retried and fulfilled once', { timeout: 400_000 }, async () => {
  const fixtures = await state()
  await receiverReset()
  await receiverSetMode('outage', { status: 503 })

  const intent = await newIntent('15500')
  await payFromPayerNode(intent.paymentRequest)
  await waitForIntentStatus(intent.id, 'succeeded')

  const rejectedAttempt = await waitFor(async () => {
    const snapshot = await receiverState()
    return snapshot.deliveries.find(
      (delivery) => delivery.responseStatus === 503 && delivery.rawBody.includes(intent.id),
    )
  }, { description: 'the gateway to attempt delivery during the outage', timeoutMs: 120_000 })

  const pending = await failedDeliveries(fixtures.tenantA.apiKey)
  assert.equal(pending.status, 200)
  assert.ok(
    pending.body.items.length >= 1,
    'the gateway did not retain a failed or pending delivery during the outage',
  )

  await receiverSetMode('ok')

  const fulfilled = await waitFor(async () => {
    const snapshot = await receiverState()
    return snapshot.fulfillments.find((entry) => entry.paymentIntentId === intent.id)
  }, { description: 'delivery retry after the outage was cleared', timeoutMs: 180_000 })

  assert.equal(fulfilled.count, 1, 'merchant fulfilled more than once after retries')

  const snapshot = await receiverState()
  const accepted = snapshot.deliveries.filter(
    (delivery) => delivery.accepted && delivery.paymentIntentId === intent.id,
  )
  assert.equal(accepted.length, 1, 'more than one delivery was accepted for one logical event')
  assert.equal(
    accepted[0]!.eventId,
    rejectedAttempt.eventId,
    'the retry carried a different logical event id',
  )
  assert.equal(accepted[0]!.signatureValid, true)
  assert.ok(
    (accepted[0]!.signatureTimestamp ?? 0) > 0,
    'the retry did not carry a signature timestamp',
  )

  const rejectedSignature = rejectedAttempt.headers['cherito-signature']
  const acceptedSignature = accepted[0]!.headers['cherito-signature']
  assert.notEqual(
    acceptedSignature,
    rejectedSignature,
    'the retry reused the original signature instead of signing freshly',
  )
})

test('a forged webhook signature is rejected by the merchant backend', { timeout: 120_000 }, async () => {
  await receiverReset()
  const body = JSON.stringify({ id: 'pi_forged', status: 'succeeded', amountSats: '999999' })
  const timestamp = Math.floor(Date.now() / 1000)

  const status = await postRawWebhook(
    {
      'cherito-signature': `t=${timestamp},v1=${'a'.repeat(64)}`,
      'x-cherito-event-id': 'we_forged',
    },
    body,
  )

  assert.equal(status, 401, 'the merchant backend accepted a forged signature')

  const snapshot = await receiverState()
  assert.equal(snapshot.fulfillments.length, 0, 'a forged event produced a fulfilment')
  assert.equal(snapshot.rejections.at(-1)?.reason, 'SIGNATURE_MISMATCH')
})

test('a correctly signed webhook outside the timestamp tolerance is rejected', { timeout: 120_000 }, async () => {
  const fixtures = await state()
  await receiverReset()

  const body = JSON.stringify({ id: 'pi_stale', status: 'succeeded', amountSats: '15000' })
  const staleTimestamp = Math.floor(Date.now() / 1000) - 4_000
  const digest = sign(fixtures.tenantA.webhookSecret!, staleTimestamp, body)

  const status = await postRawWebhook(
    {
      'cherito-signature': `t=${staleTimestamp},v1=${digest}`,
      'x-cherito-event-id': 'we_stale',
    },
    body,
  )

  assert.equal(status, 401, 'the merchant backend accepted a stale signature')

  const snapshot = await receiverState()
  assert.equal(snapshot.rejections.at(-1)?.reason, 'TIMESTAMP_OUT_OF_TOLERANCE')
  assert.equal(snapshot.fulfillments.length, 0, 'a stale event produced a fulfilment')
})

test('replaying a valid delivery does not fulfil twice', { timeout: 400_000 }, async () => {
  await receiverReset()

  const intent = await newIntent('16500')
  await payFromPayerNode(intent.paymentRequest)
  await waitForIntentStatus(intent.id, 'succeeded')

  const delivered = await waitFor(async () => {
    const snapshot = await receiverState()
    return snapshot.deliveries.find(
      (delivery) => delivery.accepted && delivery.paymentIntentId === intent.id,
    )
  }, { description: 'the first accepted delivery', timeoutMs: 180_000 })

  assert.equal(await countFulfilments(intent.id), 1)

  const replayStatus = await postRawWebhook(
    {
      'cherito-signature': delivered.headers['cherito-signature']!,
      'x-cherito-event-id': delivered.eventId!,
      'x-cherito-delivery-id': delivered.deliveryId ?? 'wd_replay',
    },
    delivered.rawBody,
  )

  assert.equal(replayStatus, 200, 'an authentic replay should still verify')
  assert.equal(
    await countFulfilments(intent.id),
    1,
    'replaying an authentic delivery caused a second fulfilment',
  )

  const snapshot = await receiverState()
  const record = snapshot.fulfillments.find((entry) => entry.paymentIntentId === intent.id)
  assert.equal(record?.suppressedDuplicates, 1, 'the receiver did not record a suppressed duplicate')
})

async function countFulfilments(intentId: string): Promise<number> {
  const snapshot = await receiverState()
  return snapshot.fulfillments.find((entry) => entry.paymentIntentId === intentId)?.count ?? 0
}
