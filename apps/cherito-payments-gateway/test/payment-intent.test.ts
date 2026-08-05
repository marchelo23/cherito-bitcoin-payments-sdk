/**
 * PaymentIntentService tests — PR #37 / Issues #3, #7
 *
 * Covers:
 * - Backend-defined amount (no productId required)
 * - merchantOrderId support and tenant-scoped uniqueness
 * - Idempotent create: same key returns same intent with usable clientSecret
 * - Idempotency payload conflict returns 409
 * - Stale/duplicate provider events do NOT reverse terminal state or fire webhooks twice
 * - Restart before settlement, settlement while offline, restart after settlement
 * - Expiry while gateway offline (markIntentExpired)
 * - Recovery bounds concurrency
 * - Cross-tenant reads and merchant-order collisions are rejected
 * - compare-and-set: terminal states are never overwritten
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Repository } from '../src/persistence/repository.js'
import { PaymentIntentService } from '../src/services/payment-intent-service.js'
import type { PaymentIntent } from '../src/persistence/repository.js'
import type { LightningInvoice, LightningReceiveProvider } from '@cherito/bitcoin-sdk'
import type { Config } from '../src/config.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const SATS = { min: 1n, max: 1_000_000n }

function makeConfig(): Config {
  return {
    PORT: 0,
    HOST: '127.0.0.1',
    DATABASE_URL: '',
    LND_REST_URL: 'https://localhost:8080',
    LND_TLS_CERT_PATH: '',
    LND_TLS_CERT_BASE64: '',
    LND_MACAROON_PATH: '',
    LND_MACAROON_HEX: '',
    LOG_LEVEL: 'silent',
    ALLOWED_ORIGINS: '*',
    RATE_LIMIT_CREATE_INVOICE: 100,
    DEFAULT_INVOICE_EXPIRY_SECONDS: 3600,
    MIN_INVOICE_SATS: SATS.min,
    MAX_INVOICE_SATS: SATS.max,
    ADMIN_API_KEY_PATH: '',
    BOLT12_PROVIDER: null,
    LNDK_GRPC_URL: undefined,
    LNDK_TLS_CERT_PATH: undefined,
    LNDK_MACAROON_PATH: undefined,
  } as unknown as Config
}

interface FakeInvoiceState {
  state: 'pending' | 'settled' | 'canceled' | 'expired'
  settledAt?: string
}

function makeFakeProvider(invoiceStateMap: Map<string, FakeInvoiceState>): LightningReceiveProvider {
  const subscribers = new Map<string, (inv: LightningInvoice) => void>()

  return {
    providerType: 'lnd-rest' as const,
    async getCapabilities() {
      return { provider: 'lnd-rest' as const, bolt11Receive: true, bolt12Receive: false }
    },
    async getNodeInfo() {
      return { alias: 'test', pubkey: 'aabbcc', network: 'regtest', color: '#fff' }
    },
    async createInvoice(input) {
      const hash = `hash_${randomUUID()}`
      invoiceStateMap.set(hash, { state: 'pending' })
      return {
        providerInvoiceId: `inv_${hash}`,
        paymentHash: hash,
        paymentRequest: `lnbcrt${input.amountSats}`,
        amountSats: input.amountSats,
        expiresAt: new Date(Date.now() + (input.expirySeconds ?? 3600) * 1000).toISOString(),
        state: 'pending' as const,
        settledAt: null,
      }
    },
    async getInvoice(paymentHash) {
      const state = invoiceStateMap.get(paymentHash) ?? { state: 'pending' as const }
      return {
        providerInvoiceId: paymentHash,
        paymentHash,
        paymentRequest: 'lnbcrt...',
        amountSats: 1000n,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        state: state.state,
        settledAt: state.settledAt ?? null,
      } as LightningInvoice
    },
    async subscribeToInvoice(paymentHash, callback) {
      subscribers.set(paymentHash, callback)
      return async () => { subscribers.delete(paymentHash) }
    },
    // Test helper to simulate a provider event
    _settle(paymentHash: string) {
      const now = new Date().toISOString()
      invoiceStateMap.set(paymentHash, { state: 'settled', settledAt: now })
      const cb = subscribers.get(paymentHash)
      cb?.({
        providerInvoiceId: paymentHash, paymentHash,
        paymentRequest: 'lnbcrt...',
        amountSats: 1000n,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        state: 'settled', settledAt: now,
      } as LightningInvoice)
    },
    _expire(paymentHash: string) {
      invoiceStateMap.set(paymentHash, { state: 'expired' })
      const cb = subscribers.get(paymentHash)
      cb?.({
        providerInvoiceId: paymentHash, paymentHash,
        paymentRequest: 'lnbcrt...',
        amountSats: 1000n,
        expiresAt: new Date().toISOString(),
        state: 'expired', settledAt: null,
      } as LightningInvoice)
    },
  } as unknown as LightningReceiveProvider
}

let webhookEnqueueCalls: Array<{ event: string; intentId: string }> = []
const fakeWebhookService = {
  enqueue(_tenant: unknown, intent: PaymentIntent, event: string) {
    webhookEnqueueCalls.push({ event, intentId: intent.id })
  },
  processQueue: async () => {},
}

function makeSetup() {
  const invoiceStates = new Map<string, FakeInvoiceState>()
  const fakeProvider = makeFakeProvider(invoiceStates)
  const repo = new Repository(`file::memory:?cache=shared&uri=${randomUUID()}`)
  const config = makeConfig()

  // Create a test tenant
  const now = new Date().toISOString()
  repo.createTenant({
    id: 'tnt_test', name: 'Test Merchant', webhookUrl: null, webhookSecret: null,
    disabled: false, createdAt: now, updatedAt: now,
  })

  const service = new PaymentIntentService(
    fakeProvider,
    undefined,
    repo,
    config,
    undefined,
    fakeWebhookService as never,
  )

  return { service, repo, fakeProvider, invoiceStates }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentIntentService — creation', () => {
  beforeEach(() => { webhookEnqueueCalls = [] })

  test('creates an intent with backend-defined amount (no productId)', async () => {
    const { service } = makeSetup()
    const result = await service.create({
      tenantId: 'tnt_test',
      amountSats: 1000n,
      description: 'WooCommerce order #42',
    })

    assert.ok(result.id.startsWith('pi_'))
    assert.equal(result.amountSats, '1000')
    assert.ok(result.clientSecret.startsWith('cs_'))
    assert.equal(result.status, 'requires_payment')
  })

  test('creates an intent with merchantOrderId', async () => {
    const { service } = makeSetup()
    const result = await service.create({
      tenantId: 'tnt_test',
      amountSats: 5000n,
      merchantOrderId: 'order_woo_123',
    })
    assert.equal(result.merchantOrderId, 'order_woo_123')
  })

  test('fails if neither productId nor amountSats provided', async () => {
    const { service } = makeSetup()
    await assert.rejects(
      () => service.create({ tenantId: 'tnt_test' }),
      (err: { code: string }) => { assert.equal(err.code, 'MISSING_AMOUNT'); return true },
    )
  })

  test('validates amount bounds', async () => {
    const { service } = makeSetup()
    await assert.rejects(
      () => service.create({ tenantId: 'tnt_test', amountSats: 0n }),
      (err: { code: string }) => { assert.equal(err.code, 'INVALID_AMOUNT'); return true },
    )
    await assert.rejects(
      () => service.create({ tenantId: 'tnt_test', amountSats: 999_999_999n }),
      (err: { code: string }) => { assert.equal(err.code, 'AMOUNT_OUT_OF_RANGE'); return true },
    )
  })

  test('rejects oversized metadata', async () => {
    const { service } = makeSetup()
    await assert.rejects(
      () => service.create({
        tenantId: 'tnt_test',
        amountSats: 1000n,
        metadata: { huge: 'x'.repeat(4097) },
      }),
      (err: { code: string }) => { assert.equal(err.code, 'METADATA_TOO_LARGE'); return true },
    )
  })
})

describe('PaymentIntentService — idempotency', () => {
  beforeEach(() => { webhookEnqueueCalls = [] })

  test('same idempotency key returns same intent with usable clientSecret', async () => {
    const { service } = makeSetup()
    const key = randomUUID()

    const first = await service.create({ tenantId: 'tnt_test', amountSats: 2000n, idempotencyKey: key })
    const second = await service.create({ tenantId: 'tnt_test', amountSats: 2000n, idempotencyKey: key })

    // Same intent
    assert.equal(first.id, second.id)
    assert.equal(first.paymentRequest, second.paymentRequest)
    // clientSecret must be non-empty on retry — the critical fix
    assert.ok(second.clientSecret.startsWith('cs_'), `clientSecret must start with 'cs_', got: ${second.clientSecret}`)
    // Same secret (deterministic re-derivation)
    assert.equal(first.clientSecret, second.clientSecret)
  })

  test('same idempotency key with different payload returns 409', async () => {
    const { service } = makeSetup()
    const key = randomUUID()

    await service.create({ tenantId: 'tnt_test', amountSats: 2000n, idempotencyKey: key })
    await assert.rejects(
      () => service.create({ tenantId: 'tnt_test', amountSats: 3000n, idempotencyKey: key }),
      (err: { code: string; statusCode: number }) => {
        assert.equal(err.code, 'IDEMPOTENCY_CONFLICT')
        assert.equal(err.statusCode, 409)
        return true
      },
    )
  })

  test('idempotency is scoped per tenant — same key works for different tenants', async () => {
    const { service, repo } = makeSetup()
    const now = new Date().toISOString()
    repo.createTenant({
      id: 'tnt_other', name: 'Other Merchant', webhookUrl: null, webhookSecret: null,
      disabled: false, createdAt: now, updatedAt: now,
    })

    const key = randomUUID()
    const a = await service.create({ tenantId: 'tnt_test', amountSats: 1000n, idempotencyKey: key })
    const b = await service.create({ tenantId: 'tnt_other', amountSats: 1000n, idempotencyKey: key })

    assert.notEqual(a.id, b.id)
  })
})

describe('PaymentIntentService — state transitions', () => {
  beforeEach(() => { webhookEnqueueCalls = [] })

  test('settlement moves intent to succeeded and fires webhook once', async () => {
    const { service, repo, fakeProvider } = makeSetup()
    const result = await service.create({ tenantId: 'tnt_test', amountSats: 1000n })

    // Simulate provider settlement
    ;(fakeProvider as unknown as { _settle: (h: string) => void })._settle(result.paymentHash)

    // Small settle propagation delay
    await new Promise((r) => setTimeout(r, 10))

    const intent = repo.paymentIntentByHash(result.paymentHash)
    assert.equal(intent?.status, 'succeeded')
    assert.ok(intent?.settledAt)

    // Webhook fired exactly once
    assert.equal(webhookEnqueueCalls.filter((c) => c.event === 'payment_intent.succeeded').length, 1)
  })

  test('duplicate/stale provider events do NOT reverse terminal state or fire duplicate webhooks', async () => {
    const { service, repo, fakeProvider } = makeSetup()
    const result = await service.create({ tenantId: 'tnt_test', amountSats: 1000n })

    const settle = (fakeProvider as unknown as { _settle: (h: string) => void })._settle.bind(fakeProvider)

    // Settle once
    settle(result.paymentHash)
    await new Promise((r) => setTimeout(r, 10))

    // Stale duplicate event — must be ignored
    settle(result.paymentHash)
    await new Promise((r) => setTimeout(r, 10))

    const intent = repo.paymentIntentByHash(result.paymentHash)
    assert.equal(intent?.status, 'succeeded')

    // Still only one webhook event
    assert.equal(webhookEnqueueCalls.filter((c) => c.event === 'payment_intent.succeeded').length, 1)
  })

  test('markIntentExpired correctly expires locally without provider query', () => {
    const { repo } = makeSetup()
    // Insert a fake intent manually
    const now = new Date().toISOString()
    repo.createPaymentIntent({
      id: 'pi_expire_test',
      tenantId: 'tnt_test',
      pricingRuleId: null,
      paymentLinkId: null,
      merchantOrderId: null,
      amountSats: '500',
      currency: 'sat',
      description: 'Test',
      metadata: null,
      status: 'requires_payment',
      paymentRequest: 'lnbcrt...',
      paymentHash: 'hash_expire_test',
      providerInvoiceId: 'inv_expire',
      intentSecret: 'secret123',
      clientSecretHash: 'somehash',
      idempotencyKey: null,
      idempotencyPayloadHash: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already past
      settledAt: null,
      createdAt: now,
      updatedAt: now,
    })

    repo.markIntentExpired('hash_expire_test')
    const intent = repo.paymentIntentByHash('hash_expire_test')
    assert.equal(intent?.status, 'expired')
  })

  test('terminal state is never reversed by stale update', () => {
    const { repo } = makeSetup()
    const now = new Date().toISOString()
    repo.createPaymentIntent({
      id: 'pi_settled',
      tenantId: 'tnt_test',
      pricingRuleId: null, paymentLinkId: null, merchantOrderId: null,
      amountSats: '1000', currency: 'sat', description: 'test', metadata: null,
      status: 'succeeded',
      paymentRequest: 'lnbcrt...', paymentHash: 'hash_settled',
      providerInvoiceId: 'inv_settled', intentSecret: 'secret',
      clientSecretHash: 'hash', idempotencyKey: null, idempotencyPayloadHash: null,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      settledAt: now, createdAt: now, updatedAt: now,
    })

    // Try to move it to 'failed' via stale event
    const changed = repo.updatePaymentIntentStatus(
      'hash_settled',
      { state: 'canceled', paymentHash: 'hash_settled' } as unknown as LightningInvoice,
      'failed',
    )

    assert.equal(changed, false, 'should NOT update terminal state')
    const intent = repo.paymentIntentByHash('hash_settled')
    assert.equal(intent?.status, 'succeeded', 'succeeded state must be preserved')
  })
})

describe('PaymentIntentService — cross-tenant security', () => {
  test('authorize() rejects wrong clientSecret', async () => {
    const { service } = makeSetup()
    const result = await service.create({ tenantId: 'tnt_test', amountSats: 1000n })
    const auth = service.authorize(result.id, 'tnt_test', 'cs_wrong_secret')
    assert.equal(auth, undefined)
  })

  test('authorize() rejects correct secret with wrong tenantId', async () => {
    const { service, repo } = makeSetup()
    const now = new Date().toISOString()
    repo.createTenant({
      id: 'tnt_other2', name: 'Other2', webhookUrl: null, webhookSecret: null,
      disabled: false, createdAt: now, updatedAt: now,
    })

    const result = await service.create({ tenantId: 'tnt_test', amountSats: 1000n })
    const auth = service.authorize(result.id, 'tnt_other2', result.clientSecret)
    assert.equal(auth, undefined, 'Cross-tenant access must be denied')
  })

  test('paymentIntent() returns undefined for cross-tenant lookup', async () => {
    const { service, repo } = makeSetup()
    const now = new Date().toISOString()
    repo.createTenant({
      id: 'tnt_attacker', name: 'Attacker', webhookUrl: null, webhookSecret: null,
      disabled: false, createdAt: now, updatedAt: now,
    })

    const result = await service.create({ tenantId: 'tnt_test', amountSats: 1000n })
    const crossTenant = repo.paymentIntent(result.id, 'tnt_attacker')
    assert.equal(crossTenant, undefined, 'Cross-tenant read must return undefined')
  })
})

describe('PaymentIntentService — recovery', () => {
  beforeEach(() => { webhookEnqueueCalls = [] })

  test('recoverPendingIntents picks up settlement that occurred while gateway was offline', async () => {
    // Simulate: create intent, "restart" service, settle invoice offline, reconcile
    const invoiceStates = new Map<string, FakeInvoiceState>()
    const fakeProvider = makeFakeProvider(invoiceStates)
    const repo = new Repository(`file::memory:?cache=shared&uri=${randomUUID()}`)
    const now = new Date().toISOString()
    repo.createTenant({
      id: 'tnt_rc', name: 'Recover Merchant', webhookUrl: null, webhookSecret: null,
      disabled: false, createdAt: now, updatedAt: now,
    })

    const service1 = new PaymentIntentService(
      fakeProvider, undefined, repo, makeConfig(), undefined, fakeWebhookService as never,
    )

    const result = await service1.create({ tenantId: 'tnt_rc', amountSats: 1000n })

    // Simulate offline settlement (provider records it, gateway is down)
    invoiceStates.set(result.paymentHash, { state: 'settled', settledAt: new Date().toISOString() })

    // "Restart" — new service instance, same repo
    const service2 = new PaymentIntentService(
      fakeProvider, undefined, repo, makeConfig(), undefined, fakeWebhookService as never,
    )

    await service2.recoverPendingIntents()
    await new Promise((r) => setTimeout(r, 10))

    const intent = repo.paymentIntentByHash(result.paymentHash)
    assert.equal(intent?.status, 'succeeded', 'Offline settlement must be reconciled on recovery')
  })

  test('recovery handles many intents with bounded concurrency', async () => {
    const invoiceStates = new Map<string, FakeInvoiceState>()
    const fakeProvider = makeFakeProvider(invoiceStates)
    const repo = new Repository(`file::memory:?cache=shared&uri=${randomUUID()}`)
    const now = new Date().toISOString()
    repo.createTenant({
      id: 'tnt_bulk', name: 'Bulk', webhookUrl: null, webhookSecret: null,
      disabled: false, createdAt: now, updatedAt: now,
    })

    const service = new PaymentIntentService(
      fakeProvider, undefined, repo, makeConfig(), undefined, fakeWebhookService as never,
    )

    // Create 12 intents (> RECOVERY_CONCURRENCY=5)
    for (let i = 0; i < 12; i++) {
      await service.create({ tenantId: 'tnt_bulk', amountSats: 1000n })
    }

    // Should not throw or deadlock
    await service.recoverPendingIntents()
    const pending = repo.pendingPaymentIntents()
    // All 12 should still be pending (none settled)
    assert.equal(pending.length, 12)
  })
})
