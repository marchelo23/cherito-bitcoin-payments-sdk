import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import * as docker from '../src/docker.js'
import { LOG_CANARY, SECRETS_DIR } from '../src/env.js'
import { getMerchantIntent, receiverReset } from '../src/gateway-client.js'
import { newIntent, orderId, payFromPayerNode, state, waitForIntentStatus } from '../src/harness.js'

test('no credential or canary value ever reaches the gateway logs', { timeout: 500_000 }, async () => {
  const fixtures = await state()
  await receiverReset()

  const intent = await newIntent('24500', {
    description: `order ${LOG_CANARY}`,
    metadata: { canary: LOG_CANARY, note: `nested ${LOG_CANARY}` },
    merchantOrderId: orderId('canary'),
  })
  await payFromPayerNode(intent.paymentRequest)
  await waitForIntentStatus(intent.id, 'succeeded')

  const logs = await docker.serviceLogs('gateway')
  assert.ok(logs.length > 0, 'no gateway logs were captured')

  const macaroon = await readFile(resolve(SECRETS_DIR, 'cherito-invoice.macaroon'))
  const macaroonHex = macaroon.toString('hex')
  const macaroonBase64 = macaroon.toString('base64')
  const intentKeyLine = (await readFile(resolve(SECRETS_DIR, '..', 'gateway.env'), 'utf8'))
    .split('\n')
    .find((line) => line.startsWith('CHERITO_INTENT_SECRET_KEY='))
  const intentKey = intentKeyLine?.split('=')[1] ?? ''

  const forbidden: Array<{ label: string; value: string }> = [
    { label: 'merchant API key (tenant A)', value: fixtures.tenantA.apiKey },
    { label: 'merchant API key (tenant B)', value: fixtures.tenantB.apiKey },
    { label: 'webhook signing secret', value: fixtures.tenantA.webhookSecret! },
    { label: 'payment intent client secret', value: intent.clientSecret! },
    { label: 'lnd macaroon (hex)', value: macaroonHex },
    { label: 'lnd macaroon (base64)', value: macaroonBase64 },
    { label: 'intent encryption key', value: intentKey },
  ]

  for (const secret of forbidden) {
    assert.ok(secret.value.length > 8, `${secret.label} fixture is missing, the assertion would be vacuous`)
    assert.equal(
      logs.includes(secret.value),
      false,
      `gateway logs contain the ${secret.label}`,
    )
  }

  assert.equal(
    logs.includes(LOG_CANARY),
    false,
    'gateway logs contain merchant-supplied description or metadata content',
  )
})

test('the payment intent canary is retrievable through the API but absent from logs', { timeout: 200_000 }, async () => {
  const fixtures = await state()

  const intent = await newIntent('10800', {
    metadata: { canary: LOG_CANARY },
    merchantOrderId: orderId('canary-api'),
  })

  const stored = await getMerchantIntent(fixtures.tenantA.apiKey, intent.id)
  assert.equal(stored.status, 200)
  assert.equal(
    (stored.body as unknown as { metadata?: Record<string, unknown> }).metadata?.canary,
    LOG_CANARY,
    'metadata did not round-trip through the API',
  )

  const logs = await docker.serviceLogs('gateway')
  assert.equal(logs.includes(LOG_CANARY), false, 'metadata leaked into the gateway logs')
})
