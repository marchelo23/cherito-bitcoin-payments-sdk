import assert from 'node:assert/strict'
import { test } from 'node:test'
import { api } from '../src/gateway-client.js'
import { orderId, state } from '../src/harness.js'

function isBoundedError(text: string): boolean {
  return text.length < 2_000
}

test('malformed and hostile payment intent payloads produce bounded, stable errors', { timeout: 180_000 }, async () => {
  const fixtures = await state()
  const key = fixtures.tenantA.apiKey

  const cases: Array<{ name: string; options: Parameters<typeof api>[1]; expected: number[] }> = [
    {
      name: 'unknown field',
      options: { method: 'POST', apiKey: key, body: { amountSats: '10000', surprise: true } },
      expected: [400],
    },
    {
      name: 'malformed JSON',
      options: { method: 'POST', apiKey: key, rawBody: '{"amountSats": "10000"' },
      expected: [400],
    },
    {
      name: 'oversized body',
      options: {
        method: 'POST',
        apiKey: key,
        rawBody: JSON.stringify({ amountSats: '10000', description: 'x'.repeat(40_000) }),
      },
      expected: [400, 413],
    },
    {
      name: 'oversized metadata',
      options: {
        method: 'POST',
        apiKey: key,
        body: { amountSats: '10000', metadata: { blob: 'y'.repeat(9_000) } },
      },
      expected: [400, 413],
    },
    {
      name: 'no amount source',
      options: { method: 'POST', apiKey: key, body: { merchantOrderId: orderId('noamount') } },
      expected: [400],
    },
    {
      name: 'two amount sources',
      options: {
        method: 'POST',
        apiKey: key,
        body: { amountSats: '10000', productId: 'cherito-coffee-001' },
      },
      expected: [400],
    },
    {
      name: 'negative sats',
      options: { method: 'POST', apiKey: key, body: { amountSats: '-5000' } },
      expected: [400],
    },
    {
      name: 'fractional sats',
      options: { method: 'POST', apiKey: key, body: { amountSats: '1000.5' } },
      expected: [400],
    },
    {
      name: 'zero sats',
      options: { method: 'POST', apiKey: key, body: { amountSats: '0' } },
      expected: [400],
    },
    {
      name: 'absurdly large sats',
      options: { method: 'POST', apiKey: key, body: { amountSats: '2100000000000000000000' } },
      expected: [400],
    },
    {
      name: 'numeric instead of string amount',
      options: { method: 'POST', apiKey: key, body: { amountSats: 10000 } },
      expected: [400],
    },
    {
      name: 'invalid quantity',
      options: {
        method: 'POST',
        apiKey: key,
        body: { productId: 'cherito-coffee-001', quantity: 0 },
      },
      expected: [400],
    },
  ]

  for (const scenario of cases) {
    const response = await api('/v1/payment-intents', scenario.options)
    assert.ok(
      scenario.expected.includes(response.status),
      `${scenario.name}: expected one of ${scenario.expected.join('/')} got ${response.status} (${response.text.slice(0, 200)})`,
    )
    assert.ok(isBoundedError(response.text), `${scenario.name}: error response was not bounded`)
    assert.ok(
      !response.text.toLowerCase().includes('stack'),
      `${scenario.name}: error response leaked a stack trace`,
    )
    assert.ok(
      !response.text.includes('/app/'),
      `${scenario.name}: error response leaked a server path`,
    )
  }
})

test('invalid identifiers are rejected without enumerating resources', { timeout: 120_000 }, async () => {
  const fixtures = await state()

  const badIntent = await api('/v1/payment-intents/not-a-valid-id', { apiKey: fixtures.tenantA.apiKey })
  assert.equal(badIntent.status, 404)

  const badLink = await api('/v1/payment-links/NOT..A..SLUG')
  assert.ok([400, 404].includes(badLink.status), `unexpected status ${badLink.status}`)

  const badManage = await api('/v1/payment-links/manage/pl_missing', { apiKey: fixtures.tenantA.apiKey })
  assert.equal(badManage.status, 404)
})

test('security response headers are present on API responses', { timeout: 60_000 }, async () => {
  const response = await api('/v1/capabilities')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('cache-control'), 'no-store')
})
