import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as docker from '../src/docker.js'
import { GATEWAY_URL } from '../src/env.js'
import { api, createPaymentIntent, health, receiverReset, receiverState } from '../src/gateway-client.js'
import {
  ensureChannelReady,
  newIntent,
  orderId,
  payFromPayerNode,
  state,
  waitForIntentStatus,
} from '../src/harness.js'
import { assertRegtestNode, lookupInvoice } from '../src/lnd.js'
import { delay, waitFor } from '../src/wait.js'

const LOCK_HOLD_MS = 20_000

function holdDatabaseLock(): Promise<docker.RunResult> {
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    "const db = new DatabaseSync('/app/data/cherito-e2e.db');",
    "db.exec('PRAGMA busy_timeout=0');",
    "db.exec('BEGIN EXCLUSIVE');",
    `setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, ${LOCK_HOLD_MS});`,
  ].join('')
  return docker.exec('gateway', ['node', '-e', script])
}

test('a temporarily unavailable database fails closed and never invents a settled payment', { timeout: 400_000 }, async () => {
  const fixtures = await state()
  await receiverReset()

  const lock = holdDatabaseLock()
  await delay(2_000)

  const duringOutage = await createPaymentIntent(fixtures.tenantA.apiKey, {
    amountSats: '20500',
    merchantOrderId: orderId('dbfail'),
  })

  assert.notEqual(duringOutage.status, 201, 'the gateway created an intent while the database was locked')
  assert.ok(
    duringOutage.status >= 400,
    `expected a stable error status, got ${duringOutage.status}`,
  )
  assert.ok(
    !duringOutage.text.toLowerCase().includes('sqlite_busy')
    && !duringOutage.text.includes('/app/'),
    `database failure leaked internals: ${duringOutage.text.slice(0, 200)}`,
  )

  await lock

  await waitFor(async () => {
    const result = await health()
    return result.status === 200 ? true : undefined
  }, { description: 'gateway health after the database lock cleared', timeoutMs: 120_000 })

  const afterRecovery = await createPaymentIntent(fixtures.tenantA.apiKey, {
    amountSats: '20500',
    merchantOrderId: orderId('dbok'),
  })
  assert.equal(afterRecovery.status, 201, `gateway did not recover: ${afterRecovery.text}`)

  const settledCheck = await api<{ status: string }>(
    `/v1/payment-intents/${afterRecovery.body.id}`,
    { apiKey: fixtures.tenantA.apiKey },
  )
  assert.equal(settledCheck.body.status, 'requires_payment', 'a fresh intent was not in the expected state')
})

test('a provider outage produces a bounded failure rather than a phantom settlement', { timeout: 600_000 }, async () => {
  const fixtures = await state()
  await receiverReset()

  await docker.stopService('lnd-merchant')

  const startedAt = Date.now()
  const duringOutage = await createPaymentIntent(fixtures.tenantA.apiKey, {
    amountSats: '21500',
    merchantOrderId: orderId('provider-down'),
  })
  const elapsed = Date.now() - startedAt

  assert.notEqual(duringOutage.status, 201, 'an intent was created without a reachable provider')
  assert.ok(elapsed < 120_000, `provider failure was not bounded, took ${elapsed}ms`)
  assert.ok(
    !duringOutage.text.includes('macaroon') && !duringOutage.text.includes('/run/secrets'),
    'provider failure leaked credential details',
  )

  await docker.startService('lnd-merchant')
  await waitFor(async () => {
    await assertRegtestNode('merchant')
    return true
  }, { description: 'merchant lnd to return', timeoutMs: 240_000, intervalMs: 2_000 })

  await waitFor(async () => {
    const result = await health()
    return result.status === 200 ? true : undefined
  }, { description: 'gateway health after provider recovery', timeoutMs: 240_000, intervalMs: 2_000 })

  const recovered = await createPaymentIntent(fixtures.tenantA.apiKey, {
    amountSats: '21500',
    merchantOrderId: orderId('provider-up'),
  })
  assert.equal(recovered.status, 201, `gateway did not recover after provider restart: ${recovered.text}`)

  const providerInvoice = await lookupInvoice('merchant', recovered.body.paymentHash)
  assert.equal(providerInvoice.value, '21500', 'recovered invoice does not match the provider record')

  await ensureChannelReady()
})

test('an interrupted SSE stream can be resumed and still observes the terminal state once', { timeout: 500_000 }, async () => {
  const fixtures = await state()
  await receiverReset()
  const intent = await newIntent('22500')

  const firstEvents = await readSseEvents(
    fixtures.tenantA.tenantId,
    intent.clientSecret!,
    intent.id,
    1,
    30_000,
  )
  assert.ok(
    firstEvents.some((event) => event.includes('payment_intent.requires_payment')),
    'the initial SSE snapshot was not delivered',
  )

  await payFromPayerNode(intent.paymentRequest)
  await waitForIntentStatus(intent.id, 'succeeded')

  const resumed = await readSseEvents(
    fixtures.tenantA.tenantId,
    intent.clientSecret!,
    intent.id,
    1,
    60_000,
  )
  assert.ok(
    resumed.some((event) => event.includes('payment_intent.succeeded')),
    'a reconnected client did not observe the terminal state',
  )

  const snapshotAfter = await api<{ status: string }>(
    `/v1/payment-intents/${intent.id}`,
    { apiKey: fixtures.tenantA.apiKey },
  )
  assert.equal(snapshotAfter.body.status, 'succeeded')

  const receiver = await receiverState()
  const fulfilments = receiver.fulfillments.filter((entry) => entry.paymentIntentId === intent.id)
  assert.ok(fulfilments.length <= 1, 'SSE reconnection produced duplicate fulfilment records')
})

async function readSseEvents(
  tenantId: string,
  clientSecret: string,
  intentId: string,
  minEvents: number,
  timeoutMs: number,
): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const events: string[] = []

  try {
    const response = await fetch(`${GATEWAY_URL}/v1/payment-intents/${intentId}/events`, {
      headers: {
        authorization: `Bearer ${clientSecret}`,
        'x-cherito-tenant-id': tenantId,
        accept: 'text/event-stream',
      },
      signal: controller.signal,
    })

    assert.equal(response.status, 200, 'SSE stream was not accepted')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (events.length < minEvents) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (part.trim().startsWith('event:')) events.push(part)
      }
    }
    await reader.cancel()
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }

  return events
}
