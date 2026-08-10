import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { api, getMerchantIntent } from '../src/gateway-client.js'
import { state } from '../src/harness.js'
import { listInvoices } from '../src/lnd.js'

interface CreatedLink {
  id: string
  slug: string
  mode: string
}

interface PublicIntent {
  id: string
  tenantId: string
  clientSecret: string
  amountSats: string
  paymentRequest: string
}

async function createFixedLink(title: string): Promise<CreatedLink> {
  const fixtures = await state()
  const created = await api<CreatedLink>('/v1/payment-links', {
    method: 'POST',
    apiKey: fixtures.tenantA.apiKey,
    idempotencyKey: randomUUID(),
    body: { mode: 'fixed', title, productId: 'cherito-coffee-001' },
  })
  assert.equal(created.status, 201, `payment link creation failed: ${created.text}`)
  return created.body
}

test('a fixed payment link refuses a client-supplied amount and never reaches the provider', { timeout: 180_000 }, async () => {
  const link = await createFixedLink('Fixed price coffee')
  const before = await listInvoices('merchant')

  const tampered = await api(`/v1/payment-links/${link.slug}/payment-intents`, {
    method: 'POST',
    body: { amountSats: '1' },
  })

  assert.equal(tampered.status, 400, `expected rejection, got ${tampered.status}: ${tampered.text}`)
  assert.equal(
    (tampered.body as unknown as { code?: string }).code,
    'FIXED_PRICE_OVERRIDE_DENIED',
  )

  const after = await listInvoices('merchant')
  assert.equal(
    after.length,
    before.length,
    'a tampered payment link invocation created an invoice at the merchant node',
  )
  assert.equal(
    after.some((invoice) => invoice.value === '1'),
    false,
    'merchant LND holds an invoice priced by the attacker',
  )
})

test('a fixed payment link honours the server-side price when invoked correctly', { timeout: 180_000 }, async () => {
  const fixtures = await state()
  const link = await createFixedLink('Server priced coffee')

  const invoked = await api<PublicIntent>(`/v1/payment-links/${link.slug}/payment-intents`, {
    method: 'POST',
    body: {},
  })
  assert.equal(invoked.status, 201, `link invocation failed: ${invoked.text}`)
  assert.equal(invoked.body.amountSats, '25000', 'server did not apply the catalog price')

  const merchantView = await getMerchantIntent(fixtures.tenantA.apiKey, invoked.body.id)
  assert.equal(merchantView.status, 200)
  assert.equal(merchantView.body.amountSats, '25000')
  assert.equal(merchantView.body.paymentLinkId ?? null, link.id)
})

test('invoking the same public link twice mints entirely fresh invoices', { timeout: 180_000 }, async () => {
  const fixtures = await state()
  const link = await createFixedLink('Reusable coffee link')

  const first = await api<PublicIntent>(`/v1/payment-links/${link.slug}/payment-intents`, {
    method: 'POST',
    body: {},
  })
  const second = await api<PublicIntent>(`/v1/payment-links/${link.slug}/payment-intents`, {
    method: 'POST',
    body: {},
  })

  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  assert.notEqual(first.body.id, second.body.id, 'the link reused a payment intent id')
  assert.notEqual(
    first.body.paymentRequest,
    second.body.paymentRequest,
    'the link reused a BOLT11 invoice',
  )
  assert.notEqual(
    first.body.clientSecret,
    second.body.clientSecret,
    'the link reused a client capability',
  )

  const firstMerchant = await getMerchantIntent(fixtures.tenantA.apiKey, first.body.id)
  const secondMerchant = await getMerchantIntent(fixtures.tenantA.apiKey, second.body.id)
  assert.notEqual(
    firstMerchant.body.paymentHash,
    secondMerchant.body.paymentHash,
    'the link reused a payment hash',
  )
})

test('the public link resolve route enforces a deterministic rate limit', { timeout: 180_000 }, async () => {
  const link = await createFixedLink('Rate limited link')

  const statuses: number[] = []
  let limitedBody = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await api(`/v1/payment-links/${link.slug}`)
    statuses.push(response.status)
    if (response.status === 429) {
      limitedBody = response.text
      break
    }
  }

  assert.ok(statuses.includes(429), `no 429 within ${statuses.length} requests: ${statuses.join(',')}`)
  assert.equal((JSON.parse(limitedBody) as { code: string }).code, 'RATE_LIMITED')
  assert.ok(
    statuses.every((status) => status === 200 || status === 429),
    `unexpected statuses from the public resolve route: ${statuses.join(',')}`,
  )
})
