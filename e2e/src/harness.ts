import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { loadState, type E2EState } from './bootstrap.js'
import { TIMEOUTS } from './env.js'
import {
  createPaymentIntent,
  getMerchantIntent,
  receiverState,
  type PaymentIntentResponse,
} from './gateway-client.js'
import { base64ToHex, listChannels, listInvoices, lookupInvoice, payInvoice } from './lnd.js'
import { waitFor } from './wait.js'

let cachedState: E2EState | undefined

export async function state(): Promise<E2EState> {
  cachedState ??= await loadState()
  return cachedState
}

export function orderId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

export async function newIntent(
  amountSats: string,
  extra: Record<string, unknown> = {},
): Promise<PaymentIntentResponse> {
  const fixtures = await state()
  const result = await createPaymentIntent(fixtures.tenantA.apiKey, {
    amountSats,
    merchantOrderId: orderId('e2e'),
    ...extra,
  })
  assert.equal(result.status, 201, `intent creation failed: ${result.text}`)
  assert.ok(result.body.paymentRequest, 'gateway returned no BOLT11 invoice')
  assert.ok(result.body.paymentHash, 'gateway returned no payment hash')
  return result.body
}

export async function waitForIntentStatus(
  intentId: string,
  expected: string,
  timeoutMs: number = TIMEOUTS.settlement,
): Promise<PaymentIntentResponse> {
  const fixtures = await state()
  return waitFor(async () => {
    const result = await getMerchantIntent(fixtures.tenantA.apiKey, intentId)
    if (result.status !== 200) return undefined
    return result.body.status === expected ? result.body : undefined
  }, {
    description: `payment intent ${intentId} to reach status "${expected}"`,
    timeoutMs,
    intervalMs: 1_000,
  })
}

export async function waitForIntentStatusIn(
  intentId: string,
  expected: string[],
  timeoutMs: number = TIMEOUTS.settlement,
): Promise<PaymentIntentResponse> {
  const fixtures = await state()
  return waitFor(async () => {
    const result = await getMerchantIntent(fixtures.tenantA.apiKey, intentId)
    if (result.status !== 200) return undefined
    return expected.includes(result.body.status) ? result.body : undefined
  }, {
    description: `payment intent ${intentId} to reach one of [${expected.join(', ')}]`,
    timeoutMs,
    intervalMs: 1_000,
  })
}

export async function assertProviderInvoiceSettled(
  paymentHashHex: string,
  amountSats: string,
): Promise<void> {
  const invoice = await waitFor(async () => {
    const found = await lookupInvoice('merchant', paymentHashHex)
    return found.settled ? found : undefined
  }, {
    description: `merchant LND invoice ${paymentHashHex.slice(0, 12)} to report settled`,
    timeoutMs: TIMEOUTS.settlement,
    intervalMs: 1_000,
  })

  assert.equal(base64ToHex(invoice.r_hash), paymentHashHex, 'provider payment hash mismatch')
  assert.equal(invoice.value, amountSats, 'provider invoice amount mismatch')
  assert.equal(invoice.settled, true, 'provider invoice is not settled')
  assert.equal(invoice.state, 'SETTLED', 'provider invoice state is not SETTLED')
  assert.equal(invoice.amt_paid_sat, amountSats, 'provider amount paid mismatch')
}

export async function assertProviderInvoiceCount(
  paymentHashHex: string,
  expected: number,
): Promise<void> {
  const invoices = await listInvoices('merchant')
  const matching = invoices.filter((invoice) => base64ToHex(invoice.r_hash) === paymentHashHex)
  assert.equal(
    matching.length,
    expected,
    `merchant LND holds ${matching.length} invoices for hash ${paymentHashHex.slice(0, 12)}, expected ${expected}`,
  )
}

export async function ensureChannelReady(minimumSendableSats = 100_000): Promise<void> {
  const fixtures = await state()
  await waitFor(async () => {
    const channels = await listChannels('payer')
    const usable = channels.find(
      (channel) => channel.remote_pubkey === fixtures.merchantPubkey
        && channel.active
        && BigInt(channel.local_balance) >= BigInt(minimumSendableSats),
    )
    return usable ?? undefined
  }, {
    description: `an active payer channel with at least ${minimumSendableSats} sendable sats`,
    timeoutMs: TIMEOUTS.channel,
    intervalMs: 2_000,
  })
}

export async function payFromPayerNode(paymentRequest: string): Promise<string> {
  await ensureChannelReady()
  const result = await payInvoice('payer', paymentRequest)
  assert.ok(result.payment_preimage, 'payer node returned no preimage')
  return base64ToHex(result.payment_hash)
}

export async function waitForFulfillment(
  intentId: string,
  timeoutMs: number = TIMEOUTS.webhook,
): Promise<{ count: number; suppressedDuplicates?: number }> {
  return waitFor(async () => {
    const snapshot = await receiverState()
    return snapshot.fulfillments.find((entry) => entry.paymentIntentId === intentId)
  }, {
    description: `merchant backend to fulfil payment intent ${intentId}`,
    timeoutMs,
    intervalMs: 1_000,
  })
}

export async function fulfillmentCount(intentId: string): Promise<number> {
  const snapshot = await receiverState()
  return snapshot.fulfillments.find((entry) => entry.paymentIntentId === intentId)?.count ?? 0
}

export async function acceptedDeliveriesFor(intentId: string): Promise<number> {
  const snapshot = await receiverState()
  return snapshot.deliveries.filter(
    (delivery) => delivery.accepted && delivery.paymentIntentId === intentId,
  ).length
}

export async function assertAllThreeTruths(
  intent: PaymentIntentResponse,
): Promise<void> {
  await assertProviderInvoiceSettled(intent.paymentHash, intent.amountSats)

  const settled = await waitForIntentStatus(intent.id, 'succeeded')
  assert.equal(settled.amountSats, intent.amountSats, 'cherito amount drifted from creation')
  assert.equal(settled.paymentHash, intent.paymentHash, 'cherito payment hash drifted from provider')
  assert.equal(settled.status, 'succeeded', 'cherito status is not succeeded')
  assert.ok(settled.settledAt, 'cherito did not record settledAt')

  const fulfillment = await waitForFulfillment(intent.id)
  assert.equal(fulfillment.count, 1, 'merchant backend did not fulfil exactly once')

  const snapshot = await receiverState()
  const delivered = snapshot.deliveries.filter(
    (delivery) => delivery.paymentIntentId === intent.id && delivery.accepted,
  )
  assert.ok(delivered.length >= 1, 'no accepted webhook delivery recorded')
  for (const delivery of delivered) {
    assert.equal(delivery.signatureValid, true, 'merchant backend accepted an unsigned delivery')
  }
}
