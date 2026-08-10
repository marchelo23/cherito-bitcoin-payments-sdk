import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { api, createPaymentIntent, getClientStatus, getMerchantIntent } from '../src/gateway-client.js'
import { newIntent, orderId, state } from '../src/harness.js'

test('a fabricated client capability cannot read intent status and does not leak existence', { timeout: 120_000 }, async () => {
  const fixtures = await state()
  const intent = await newIntent('10200')

  const forged = `cs_${randomBytes(32).toString('base64url')}`
  const denied = await getClientStatus(fixtures.tenantA.tenantId, forged, intent.id)

  assert.equal(denied.status, 404, 'a forged client secret was not rejected')
  assert.equal((denied.body as unknown as { code?: string }).code, 'NOT_FOUND')
  assert.ok(!denied.text.includes(intent.paymentHash), 'denial leaked the payment hash')
  assert.ok(!denied.text.includes(intent.paymentRequest), 'denial leaked the BOLT11 invoice')

  const unknownIntent = await getClientStatus(fixtures.tenantA.tenantId, forged, 'pi_does-not-exist')
  assert.equal(
    unknownIntent.status,
    denied.status,
    'existing and non-existing intents produce different statuses, which enumerates',
  )
  assert.equal(unknownIntent.text, denied.text, 'denial bodies differ between real and fake intents')
})

test('a client capability is scoped to its own tenant', { timeout: 120_000 }, async () => {
  const fixtures = await state()
  const intent = await newIntent('10300')

  const wrongTenant = await getClientStatus(
    fixtures.tenantB.tenantId,
    intent.clientSecret!,
    intent.id,
  )
  assert.equal(wrongTenant.status, 404, 'a client secret worked against the wrong tenant id')
})

test('tenant B cannot read a payment intent owned by tenant A', { timeout: 120_000 }, async () => {
  const fixtures = await state()
  const intent = await newIntent('10400')

  const crossRead = await getMerchantIntent(fixtures.tenantB.apiKey, intent.id)
  assert.equal(crossRead.status, 404, 'cross-tenant read was not denied')
  assert.equal((crossRead.body as unknown as { code?: string }).code, 'NOT_FOUND')
  assert.ok(!crossRead.text.includes(intent.paymentHash), 'cross-tenant denial leaked provider data')

  const ownRead = await getMerchantIntent(fixtures.tenantA.apiKey, intent.id)
  assert.equal(ownRead.status, 200, 'the owning tenant lost access to its own intent')
})

test('tenant B cannot mutate tenant A payment links', { timeout: 120_000 }, async () => {
  const fixtures = await state()

  const created = await api<{ id: string; slug: string }>('/v1/payment-links', {
    method: 'POST',
    apiKey: fixtures.tenantA.apiKey,
    idempotencyKey: randomUUID(),
    body: { mode: 'fixed', title: 'Cross tenant target', productId: 'cherito-coffee-001' },
  })
  assert.equal(created.status, 201, `link creation failed: ${created.text}`)

  const crossDisable = await api(`/v1/payment-links/${created.body.id}/disable`, {
    method: 'POST',
    apiKey: fixtures.tenantB.apiKey,
    body: {},
  })
  assert.ok(
    crossDisable.status === 404 || crossDisable.status === 403,
    `cross-tenant disable returned ${crossDisable.status}`,
  )

  const crossPatch = await api(`/v1/payment-links/${created.body.id}`, {
    method: 'PATCH',
    apiKey: fixtures.tenantB.apiKey,
    body: { title: 'hijacked' },
  })
  assert.ok(
    crossPatch.status === 404 || crossPatch.status === 403,
    `cross-tenant patch returned ${crossPatch.status}`,
  )

  const stillOwned = await api<{ title: string; disabled?: boolean }>(
    `/v1/payment-links/manage/${created.body.id}`,
    { apiKey: fixtures.tenantA.apiKey },
  )
  assert.equal(stillOwned.status, 200)
  assert.equal(stillOwned.body.title, 'Cross tenant target', 'tenant B mutated tenant A data')
})

test('an unauthenticated or malformed merchant credential is rejected', { timeout: 120_000 }, async () => {
  const missing = await api('/v1/payment-intents', {
    method: 'POST',
    body: { amountSats: '10000', merchantOrderId: orderId('noauth') },
  })
  assert.equal(missing.status, 401)

  const garbage = await createPaymentIntent('sk_live_not-a-real-key', {
    amountSats: '10000',
    merchantOrderId: orderId('badauth'),
  })
  assert.equal(garbage.status, 401)
  assert.equal((garbage.body as unknown as { code?: string }).code, 'UNAUTHORIZED')
})
