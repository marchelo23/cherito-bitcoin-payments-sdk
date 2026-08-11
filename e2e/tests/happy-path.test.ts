import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertAllThreeTruths,
  assertProviderInvoiceCount,
  newIntent,
  payFromPayerNode,
  state,
} from '../src/harness.js'
import { getClientStatus } from '../src/gateway-client.js'
import { base64ToHex, listChannels, lookupInvoice } from '../src/lnd.js'

test('a real lightning payment drives provider, cherito and merchant truth to agreement', { timeout: 300_000 }, async () => {
  const amountSats = '25000'
  const intent = await newIntent(amountSats)

  assert.equal(intent.status, 'requires_payment')
  assert.equal(intent.amountSats, amountSats)
  assert.ok(intent.paymentRequest.startsWith('lnbcrt'), 'invoice is not a regtest BOLT11 invoice')
  assert.ok(intent.clientSecret, 'no scoped client secret was issued')

  const providerBefore = await lookupInvoice('merchant', intent.paymentHash)
  assert.equal(base64ToHex(providerBefore.r_hash), intent.paymentHash)
  assert.equal(providerBefore.value, amountSats)
  assert.equal(providerBefore.settled, false, 'provider invoice was settled before payment')

  const paidHash = await payFromPayerNode(intent.paymentRequest)
  assert.equal(paidHash, intent.paymentHash, 'payer settled a different payment hash')

  await assertAllThreeTruths(intent)
  await assertProviderInvoiceCount(intent.paymentHash, 1)
})

test('the scoped client capability observes the terminal state without merchant credentials', { timeout: 300_000 }, async () => {
  const fixtures = await state()
  const intent = await newIntent('12000')

  const before = await getClientStatus(fixtures.tenantA.tenantId, intent.clientSecret!, intent.id)
  assert.equal(before.status, 200)
  assert.equal(before.body.status, 'requires_payment')
  assert.equal(
    (before.body as unknown as Record<string, unknown>).paymentHash,
    undefined,
    'client view leaked the payment hash',
  )

  await payFromPayerNode(intent.paymentRequest)
  await assertAllThreeTruths(intent)

  const after = await getClientStatus(fixtures.tenantA.tenantId, intent.clientSecret!, intent.id)
  assert.equal(after.status, 200)
  assert.equal(after.body.status, 'succeeded')
  assert.ok(after.body.settledAt, 'client view has no settlement timestamp')
})

test('the regtest channel actually moved liquidity toward the merchant', { timeout: 120_000 }, async () => {
  const fixtures = await state()
  const merchantChannels = await listChannels('merchant')
  const channel = merchantChannels.find((entry) => entry.remote_pubkey === fixtures.payerPubkey)

  assert.ok(channel, 'merchant has no channel with the payer node')
  assert.equal(channel.active, true, 'merchant channel is not active')
  assert.ok(
    BigInt(channel.local_balance) > 0n,
    'merchant local balance is zero, so no real payment was routed',
  )
})
