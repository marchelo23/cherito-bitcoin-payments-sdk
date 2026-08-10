import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPaymentIntent, getMerchantIntent } from '../src/gateway-client.js'
import {
  assertProviderInvoiceCount,
  fulfillmentCount,
  newIntent,
  orderId,
  payFromPayerNode,
  state,
  waitForIntentStatus,
  waitForIntentStatusIn,
} from '../src/harness.js'
import { base64ToHex, listInvoices, lookupInvoice } from '../src/lnd.js'
import { waitFor } from '../src/wait.js'

test('an unpaid invoice expires at the provider and in cherito without any fulfilment', { timeout: 400_000 }, async () => {
  const intent = await newIntent('11000')

  const created = await lookupInvoice('merchant', intent.paymentHash)
  assert.equal(created.settled, false)
  assert.equal(created.expiry, '60', 'test environment did not apply the short invoice expiry')

  const expired = await waitForIntentStatusIn(intent.id, ['expired', 'canceled'], 300_000)
  assert.ok(
    ['expired', 'canceled'].includes(expired.status),
    `unpaid intent settled on an unexpected status: ${expired.status}`,
  )
  assert.equal(expired.settledAt, null, 'an unpaid intent must not carry a settlement timestamp')

  const providerInvoice = await lookupInvoice('merchant', intent.paymentHash)
  assert.equal(providerInvoice.settled, false, 'provider settled an invoice nobody paid')
  assert.ok(
    ['CANCELED', 'OPEN'].includes(providerInvoice.state),
    `provider invoice is not in a terminal unpaid state: ${providerInvoice.state}`,
  )
  assert.equal(providerInvoice.amt_paid_sat, '0', 'provider recorded a payment for an unpaid invoice')

  assert.equal(await fulfillmentCount(intent.id), 0, 'merchant fulfilled an unpaid order')
})

test('repeating an idempotent create returns the same intent and creates one provider invoice', { timeout: 200_000 }, async () => {
  const fixtures = await state()
  const key = randomUUID()
  const body = { amountSats: '13000', merchantOrderId: orderId('idem') }

  const first = await createPaymentIntent(fixtures.tenantA.apiKey, body, key)
  assert.equal(first.status, 201)

  const second = await createPaymentIntent(fixtures.tenantA.apiKey, body, key)
  assert.equal(second.status, 201)

  assert.equal(second.body.id, first.body.id, 'idempotent replay produced a different intent')
  assert.equal(
    second.body.paymentRequest,
    first.body.paymentRequest,
    'idempotent replay produced a different BOLT11 invoice',
  )
  assert.equal(second.body.paymentHash, first.body.paymentHash)

  await assertProviderInvoiceCount(first.body.paymentHash, 1)

  const invoices = await listInvoices('merchant')
  const matching = invoices.filter(
    (invoice) => invoice.memo.includes(body.merchantOrderId) || base64ToHex(invoice.r_hash) === first.body.paymentHash,
  )
  assert.equal(matching.length, 1, 'merchant LND holds more than one invoice for one idempotency key')
})

test('reusing an idempotency key with a different payload is rejected with 409', { timeout: 120_000 }, async () => {
  const fixtures = await state()
  const key = randomUUID()

  const first = await createPaymentIntent(
    fixtures.tenantA.apiKey,
    { amountSats: '14000', merchantOrderId: orderId('conflict') },
    key,
  )
  assert.equal(first.status, 201)

  const conflicting = await createPaymentIntent(
    fixtures.tenantA.apiKey,
    { amountSats: '99000', merchantOrderId: orderId('conflict') },
    key,
  )

  assert.equal(conflicting.status, 409, `expected 409 got ${conflicting.status}: ${conflicting.text}`)
  assert.equal(
    (conflicting.body as unknown as { code?: string }).code,
    'IDEMPOTENCY_CONFLICT',
  )
})

test('a settled intent never leaves its terminal state', { timeout: 300_000 }, async () => {
  const fixtures = await state()
  const intent = await newIntent('10500')
  await payFromPayerNode(intent.paymentRequest)
  await waitForIntentStatus(intent.id, 'succeeded')

  await waitFor(async () => {
    const invoice = await lookupInvoice('merchant', intent.paymentHash)
    return invoice.settled ? true : undefined
  }, { description: 'provider settlement to persist', timeoutMs: 60_000 })

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await getMerchantIntent(fixtures.tenantA.apiKey, intent.id)
    assert.equal(current.body.status, 'succeeded', 'terminal state regressed after reconciliation')
    await new Promise((done) => setTimeout(done, 2_000))
  }
})
