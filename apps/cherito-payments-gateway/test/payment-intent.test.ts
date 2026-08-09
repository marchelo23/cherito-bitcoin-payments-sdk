import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  CreateInvoiceInput,
  CreatedInvoice,
  InvoiceState,
  LightningCapabilities,
  LightningInvoice,
  LightningReceiveProvider,
  PublicNodeInfo,
} from '@cherito/bitcoin-sdk'
import type { Config } from '../src/config.js'
import {
  PaymentIntentRepository,
} from '../src/persistence/payment-intent-repository.js'
import { ApiKeyService } from '../src/services/api-key-service.js'
import {
  PaymentIntentService,
  type CreatePaymentIntentInput,
  type PaymentIntentEventSink,
  type PaymentIntentServiceOptions,
} from '../src/services/payment-intent-service.js'
import { TenantService } from '../src/services/tenant-service.js'
import { PaymentIntentSecretCipher } from '../src/security/payment-intent-secret-cipher.js'

const TEST_INTENT_SECRET_KEY = Buffer.alloc(32, 0x42).toString('base64')

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await delay(2)
  }
}

function makeConfig(): Config {
  return {
    NODE_ENV: 'test',
    PORT: 3100,
    HOST: '127.0.0.1',
    LIGHTNING_PROVIDER: 'lnd',
    LND_REST_URL: 'https://127.0.0.1:8080',
    LND_TLS_CERT_PATH: undefined,
    LND_MACAROON_PATH: undefined,
    LND_TLS_CERT_BASE64: 'Y2VydA==',
    LND_MACAROON_HEX: '00',
    BOLT12_PROVIDER: 'none',
    LNDK_GRPC_URL: undefined,
    LNDK_TLS_CERT_PATH: undefined,
    LNDK_MACAROON_PATH: undefined,
    ALLOWED_ORIGINS: 'http://localhost:3000',
    MIN_INVOICE_SATS: 10n,
    MAX_INVOICE_SATS: 1_000_000n,
    DEFAULT_INVOICE_EXPIRY_SECONDS: 60,
    RATE_LIMIT_CREATE_INVOICE: 100,
    DATABASE_URL: ':memory:',
    CHERITO_INTENT_SECRET_KEY: TEST_INTENT_SECRET_KEY,
    CHERITO_INTENT_SECRET_PREVIOUS_KEYS: '',
    LOG_LEVEL: 'silent',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    PAYMENT_INTENT_RECOVERY_CONCURRENCY: 5,
    PAYMENT_INTENT_RECONCILIATION_INTERVAL_MS: 60_000,
    PAYMENT_INTENT_WATCH_RETRY_BASE_MS: 100,
    PAYMENT_INTENT_WATCH_RETRY_MAX_MS: 1_000,
    SQLITE_BUSY_TIMEOUT_MS: 5_000,
    BOOTSTRAP_TENANT_NAME: 'Test Merchant',
    BOOTSTRAP_KEY_PATH: undefined,
  }
}

class FakeProvider implements LightningReceiveProvider {
  readonly providerType = 'lnd' as const
  readonly invoices = new Map<string, LightningInvoice>()
  readonly subscribers = new Map<string, (invoice: LightningInvoice) => void>()
  readonly historicalSubscribers = new Map<string, (invoice: LightningInvoice) => void>()
  createInvoiceCalls = 0
  getInvoiceCalls = 0
  subscribeCalls = 0
  cleanupCalls = 0
  getInvoiceActive = 0
  maxGetInvoiceActive = 0
  getInvoiceDelayMs = 0
  failGetInvoice = false
  failSubscriptions = 0
  mismatchNextAmount = false
  invoiceExpiryOffsetMs = 60_000

  async getCapabilities(): Promise<LightningCapabilities> {
    return {
      provider: 'lnd',
      bolt11Receive: true,
      bolt12Receive: false,
      invoiceStreaming: true,
    }
  }

  async getNodeInfo(): Promise<PublicNodeInfo> {
    return { alias: 'fake', network: 'regtest', syncedToChain: true, syncedToGraph: true }
  }

  async createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice> {
    this.createInvoiceCalls += 1
    const paymentHash = `hash_${randomUUID()}`
    const invoice: LightningInvoice = {
      providerInvoiceId: `provider_${randomUUID()}`,
      paymentHash,
      paymentRequest: `lnbcrt_${paymentHash}`,
      amountSats: this.mismatchNextAmount ? input.amountSats + 1n : input.amountSats,
      expiresAt: new Date(
        Date.now() + Math.min(input.expirySeconds * 1_000, this.invoiceExpiryOffsetMs),
      ).toISOString(),
      state: 'pending',
    }
    this.mismatchNextAmount = false
    this.invoices.set(paymentHash, invoice)
    return invoice
  }

  async getInvoice(paymentHash: string): Promise<LightningInvoice> {
    this.getInvoiceCalls += 1
    this.getInvoiceActive += 1
    this.maxGetInvoiceActive = Math.max(this.maxGetInvoiceActive, this.getInvoiceActive)
    try {
      if (this.getInvoiceDelayMs > 0) await delay(this.getInvoiceDelayMs)
      if (this.failGetInvoice) throw new Error('provider unavailable')
      const invoice = this.invoices.get(paymentHash)
      if (!invoice) throw new Error('invoice not found')
      return { ...invoice }
    } finally {
      this.getInvoiceActive -= 1
    }
  }

  async subscribeToInvoice(
    paymentHash: string,
    callback: (invoice: LightningInvoice) => void,
  ): Promise<() => Promise<void>> {
    this.subscribeCalls += 1
    if (this.failSubscriptions > 0) {
      this.failSubscriptions -= 1
      throw new Error('subscription unavailable')
    }
    this.subscribers.set(paymentHash, callback)
    this.historicalSubscribers.set(paymentHash, callback)
    return async () => {
      this.cleanupCalls += 1
      if (this.subscribers.get(paymentHash) === callback) this.subscribers.delete(paymentHash)
    }
  }

  setState(paymentHash: string, state: InvoiceState, emit = true): void {
    const current = this.invoices.get(paymentHash)
    if (!current) throw new Error('invoice not found')
    const updated: LightningInvoice = {
      ...current,
      state,
      settledAt: state === 'settled' ? new Date().toISOString() : undefined,
    }
    this.invoices.set(paymentHash, updated)
    if (emit) this.subscribers.get(paymentHash)?.({ ...updated })
  }

  emitHistorical(paymentHash: string, state: InvoiceState): void {
    const current = this.invoices.get(paymentHash)
    if (!current) throw new Error('invoice not found')
    this.historicalSubscribers.get(paymentHash)?.({ ...current, state })
  }
}

class FakeEventSink implements PaymentIntentEventSink {
  readonly events: Array<{ tenantId: string; intentId: string; type: string; payload: string }> = []

  enqueuePaymentIntentEvent(
    tenantId: string,
    paymentIntentId: string,
    type: string,
    payload: string,
  ): void {
    this.events.push({ tenantId, intentId: paymentIntentId, type, payload })
  }
}

interface Harness {
  directory: string
  config: Config
  repo: PaymentIntentRepository
  tenantService: TenantService
  provider: FakeProvider
  eventSink: FakeEventSink
  service: PaymentIntentService
  tenantId: string
}

const harnesses: Harness[] = []

function newService(
  harness: Harness,
  options: PaymentIntentServiceOptions = {},
): PaymentIntentService {
  const service = new PaymentIntentService(
    harness.provider,
    harness.repo,
    harness.config,
    harness.tenantService,
    harness.eventSink,
    {
      logger: { error() {} },
      watcherRetryBaseMs: 5,
      watcherRetryMaxMs: 20,
      random: () => 0,
      ...options,
    },
  )
  return service
}

async function makeHarness(options: PaymentIntentServiceOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'cherito-payment-intent-'))
  const config = makeConfig()
  config.DATABASE_URL = `file:${join(directory, 'gateway.sqlite')}`
  const repo = new PaymentIntentRepository(
    config.DATABASE_URL,
    new PaymentIntentSecretCipher(config.CHERITO_INTENT_SECRET_KEY),
  )
  const apiKeyService = new ApiKeyService(repo)
  const tenantService = new TenantService(repo, apiKeyService)
  const provider = new FakeProvider()
  const eventSink = new FakeEventSink()
  const { tenant } = await tenantService.createTenant({ name: 'Primary Merchant' })
  const partial = { directory, config, repo, tenantService, provider, eventSink } as Omit<Harness, 'service' | 'tenantId'>
  const harness = {
    ...partial,
    tenantId: tenant.id,
  } as Harness
  harness.service = newService(harness, options)
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!
    await harness.service.shutdown()
    harness.repo.close()
    rmSync(harness.directory, { recursive: true, force: true })
  }
})

describe('Payment Intent creation and persistence', () => {
  test('1. creates a backend-defined amount without productId', async () => {
    const harness = await makeHarness()
    const created = await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 2_100n,
      description: 'Backend order',
    })
    assert.equal(created.amountSats, '2100')
    assert.equal(created.currency, 'SAT')
    assert.equal(created.description, 'Backend order')
    assert.equal(created.pricingRuleId, null)
  })

  test('2. creates from productId and pricingRuleId using server-owned prices', async () => {
    const harness = await makeHarness()
    const rule = harness.tenantService.upsertPricingRule(harness.tenantId, {
      productId: 'coffee-bag',
      name: 'Coffee bag',
      mode: 'fixed',
      priceSats: '1500',
      maxQuantity: 5,
    })
    const byProduct = await harness.service.create({
      tenantId: harness.tenantId,
      productId: 'coffee-bag',
      quantity: 2,
    })
    const byRule = await harness.service.create({
      tenantId: harness.tenantId,
      pricingRuleId: rule.id,
      quantity: 3,
    })
    assert.equal(byProduct.amountSats, '3000')
    assert.equal(byRule.amountSats, '4500')
    assert.equal(byProduct.pricingRuleId, rule.id)
    assert.equal(byRule.pricingRuleId, rule.id)
  })

  test('3. persists merchantOrderId as a first-class field', async () => {
    const harness = await makeHarness()
    const created = await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 1_000n,
      merchantOrderId: 'wc-order-42',
    })
    assert.equal(created.merchantOrderId, 'wc-order-42')
    assert.equal(
      harness.repo.paymentIntentByMerchantOrderId(harness.tenantId, 'wc-order-42')?.id,
      created.id,
    )
  })

  test('4. rejects duplicate merchantOrderId in one tenant before creating an invoice', async () => {
    const harness = await makeHarness()
    await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 1_000n,
      merchantOrderId: 'same-order',
    })
    await assert.rejects(
      harness.service.create({
        tenantId: harness.tenantId,
        amountSats: 2_000n,
        merchantOrderId: 'same-order',
      }),
      (error: Error & { code?: string }) => error.code === 'MERCHANT_ORDER_CONFLICT',
    )
    assert.equal(harness.provider.createInvoiceCalls, 1)
  })

  test('5. permits the same merchantOrderId in different tenants', async () => {
    const harness = await makeHarness()
    const { tenant: other } = await harness.tenantService.createTenant({ name: 'Other Merchant' })
    const first = await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 1_000n,
      merchantOrderId: 'shared-order',
    })
    const second = await harness.service.create({
      tenantId: other.id,
      amountSats: 1_000n,
      merchantOrderId: 'shared-order',
    })
    assert.notEqual(first.id, second.id)
  })

  test('6. accepts exactly 4096 metadata bytes and rejects larger metadata', async () => {
    const harness = await makeHarness()
    const exact = { value: 'x'.repeat(4_084) }
    assert.equal(Buffer.byteLength(JSON.stringify(exact)), 4_096)
    await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 1_000n,
      metadata: exact,
    })
    await assert.rejects(
      harness.service.create({
        tenantId: harness.tenantId,
        amountSats: 1_000n,
        metadata: { value: 'x'.repeat(4_085) },
      }),
      (error: Error & { code?: string }) => error.code === 'METADATA_TOO_LARGE',
    )
  })

  test('7. rejects non-bigint, below-minimum, and above-maximum amounts', async () => {
    const harness = await makeHarness()
    await assert.rejects(
      harness.service.create({ tenantId: harness.tenantId, amountSats: 1.5 as unknown as bigint }),
      (error: Error & { code?: string }) => error.code === 'INVALID_AMOUNT',
    )
    await assert.rejects(
      harness.service.create({ tenantId: harness.tenantId, amountSats: 9n }),
      (error: Error & { code?: string }) => error.code === 'AMOUNT_OUT_OF_RANGE',
    )
    await assert.rejects(
      harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000_001n }),
      (error: Error & { code?: string }) => error.code === 'AMOUNT_OUT_OF_RANGE',
    )
    assert.equal(harness.provider.createInvoiceCalls, 0)
  })
})

describe('Payment Intent idempotency and tenant isolation', () => {
  test('8. an idempotent retry returns the exact same intent and invoice', async () => {
    const harness = await makeHarness()
    const idempotencyKey = randomUUID()
    const first = await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 2_000n,
      metadata: { nested: { b: 2, a: 1 } },
      idempotencyKey,
    })
    const retry = await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 2_000n,
      metadata: { nested: { a: 1, b: 2 } },
      idempotencyKey,
    })
    assert.equal(retry.id, first.id)
    assert.equal(retry.paymentRequest, first.paymentRequest)
    assert.equal(retry.paymentHash, first.paymentHash)
  })

  test('9. an idempotent retry returns the same usable client capability', async () => {
    const harness = await makeHarness()
    const idempotencyKey = randomUUID()
    const first = await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 2_000n,
      idempotencyKey,
    })
    const retry = await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 2_000n,
      idempotencyKey,
    })
    assert.equal(retry.clientSecret, first.clientSecret)
    assert.ok(retry.clientSecret.startsWith('cs_v1_'))
    assert.equal(
      harness.service.authorizeClient(harness.tenantId, retry.id, retry.clientSecret)?.id,
      retry.id,
    )
  })

  test('intent secrets are encrypted at rest and survive safe application-key rotation', async () => {
    const harness = await makeHarness()
    const idempotencyKey = randomUUID()
    const created = await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 2_000n,
      idempotencyKey,
    })
    const inMemory = harness.repo.paymentIntent(harness.tenantId, created.id)!
    const databasePath = harness.config.DATABASE_URL.replace(/^file:/, '')
    const raw = new DatabaseSync(databasePath, { readOnly: true })
    const columns = raw.prepare('PRAGMA table_info(payment_intents)').all() as Array<{
      name: string
    }>
    const encryptedBefore = raw.prepare(`
      SELECT intent_secret_key_id keyId, intent_secret_ciphertext ciphertext
      FROM payment_intents WHERE id=?
    `).get(created.id) as { keyId: string; ciphertext: string }
    raw.close()

    assert.equal(columns.some(({ name }) => name === 'intent_secret'), false)
    assert.notEqual(encryptedBefore.ciphertext, inMemory.intentSecret)
    const databaseBytes = readFileSync(databasePath)
    assert.equal(databaseBytes.includes(Buffer.from(inMemory.intentSecret, 'utf8')), false)
    assert.equal(databaseBytes.includes(Buffer.from(created.clientSecret, 'utf8')), false)
    assert.equal(databaseBytes.includes(Buffer.from(TEST_INTENT_SECRET_KEY, 'utf8')), false)

    await harness.service.shutdown()
    harness.repo.close()

    const rotatedKey = Buffer.alloc(32, 0x77).toString('base64')
    harness.config.CHERITO_INTENT_SECRET_KEY = rotatedKey
    harness.config.CHERITO_INTENT_SECRET_PREVIOUS_KEYS = TEST_INTENT_SECRET_KEY
    const rotatedRepo = new PaymentIntentRepository(
      harness.config.DATABASE_URL,
      new PaymentIntentSecretCipher(rotatedKey, TEST_INTENT_SECRET_KEY),
    )
    const rawAfterRotation = new DatabaseSync(databasePath, { readOnly: true })
    const encryptedAfter = rawAfterRotation.prepare(`
      SELECT intent_secret_key_id keyId FROM payment_intents WHERE id=?
    `).get(created.id) as { keyId: string }
    rawAfterRotation.close()
    assert.notEqual(encryptedAfter.keyId, encryptedBefore.keyId)

    rotatedRepo.close()
    harness.config.CHERITO_INTENT_SECRET_PREVIOUS_KEYS = ''
    harness.repo = new PaymentIntentRepository(
      harness.config.DATABASE_URL,
      new PaymentIntentSecretCipher(rotatedKey),
    )
    const apiKeyService = new ApiKeyService(harness.repo)
    harness.tenantService = new TenantService(harness.repo, apiKeyService)
    harness.service = newService(harness)
    const retry = await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 2_000n,
      idempotencyKey,
    })
    assert.equal(retry.id, created.id)
    assert.equal(retry.clientSecret, created.clientSecret)
    assert.equal(harness.provider.createInvoiceCalls, 1)
  })

  test('10. concurrent idempotent retries create exactly one provider invoice', async () => {
    const harness = await makeHarness()
    const idempotencyKey = randomUUID()
    const [first, second] = await Promise.all([
      harness.service.create({ tenantId: harness.tenantId, amountSats: 2_000n, idempotencyKey }),
      harness.service.create({ tenantId: harness.tenantId, amountSats: 2_000n, idempotencyKey }),
    ])
    assert.equal(first.id, second.id)
    assert.equal(harness.provider.createInvoiceCalls, 1)
  })

  test('11. changed behavior under the same key returns IDEMPOTENCY_CONFLICT', async () => {
    const harness = await makeHarness()
    const idempotencyKey = randomUUID()
    await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 2_000n,
      description: 'original',
      metadata: { version: 1 },
      idempotencyKey,
    })
    await assert.rejects(
      harness.service.create({
        tenantId: harness.tenantId,
        amountSats: 2_000n,
        description: 'changed',
        metadata: { version: 1 },
        idempotencyKey,
      }),
      (error: Error & { code?: string; statusCode?: number }) =>
        error.code === 'IDEMPOTENCY_CONFLICT' && error.statusCode === 409,
    )
  })

  test('idempotency hashing covers every behavior-affecting input', async () => {
    const harness = await makeHarness()
    const firstRule = harness.tenantService.upsertPricingRule(harness.tenantId, {
      productId: 'first-product', name: 'First', mode: 'fixed', priceSats: '1000', maxQuantity: 5,
    })
    const secondRule = harness.tenantService.upsertPricingRule(harness.tenantId, {
      productId: 'second-product', name: 'Second', mode: 'fixed', priceSats: '1000', maxQuantity: 5,
    })
    const linkTimestamp = new Date().toISOString()
    for (const id of ['link-a', 'link-b']) {
      harness.repo.createPaymentLink({
        id,
        tenantId: harness.tenantId,
        slug: `pl_${id.replace('-', '').padEnd(32, 'x')}`,
        mode: 'open_amount',
        pricingRuleId: null,
        minAmountSats: '10',
        maxAmountSats: '10000',
        title: id,
        description: null,
        expiresAt: null,
        maxUses: null,
        useCount: 0,
        reservedUses: 0,
        active: true,
        indexable: false,
        createdAt: linkTimestamp,
        updatedAt: linkTimestamp,
      })
    }
    const cases: Array<[CreatePaymentIntentInput, CreatePaymentIntentInput]> = [
      [
        { tenantId: harness.tenantId, productId: 'first-product' },
        { tenantId: harness.tenantId, productId: 'second-product' },
      ],
      [
        { tenantId: harness.tenantId, pricingRuleId: firstRule.id },
        { tenantId: harness.tenantId, pricingRuleId: secondRule.id },
      ],
      [
        { tenantId: harness.tenantId, productId: 'first-product', quantity: 1 },
        { tenantId: harness.tenantId, productId: 'first-product', quantity: 2 },
      ],
      [
        { tenantId: harness.tenantId, amountSats: 1_000n },
        { tenantId: harness.tenantId, amountSats: 1_001n },
      ],
      [
        { tenantId: harness.tenantId, amountSats: 1_000n, merchantOrderId: 'order-a' },
        { tenantId: harness.tenantId, amountSats: 1_000n, merchantOrderId: 'order-b' },
      ],
      [
        { tenantId: harness.tenantId, amountSats: 1_000n, description: 'a' },
        { tenantId: harness.tenantId, amountSats: 1_000n, description: 'b' },
      ],
      [
        { tenantId: harness.tenantId, amountSats: 1_000n, metadata: { version: 1 } },
        { tenantId: harness.tenantId, amountSats: 1_000n, metadata: { version: 2 } },
      ],
      [
        { tenantId: harness.tenantId, amountSats: 1_000n, paymentLinkId: 'link-a' },
        { tenantId: harness.tenantId, amountSats: 1_000n, paymentLinkId: 'link-b' },
      ],
    ]

    for (const [original, changed] of cases) {
      const idempotencyKey = randomUUID()
      await harness.service.create({ ...original, idempotencyKey })
      await assert.rejects(
        harness.service.create({ ...changed, idempotencyKey }),
        (error: Error & { code?: string }) => error.code === 'IDEMPOTENCY_CONFLICT',
      )
    }
  })

  test('12. idempotency keys are scoped to a tenant', async () => {
    const harness = await makeHarness()
    const { tenant: other } = await harness.tenantService.createTenant({ name: 'Second Merchant' })
    const idempotencyKey = randomUUID()
    const first = await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 2_000n,
      idempotencyKey,
    })
    const second = await harness.service.create({
      tenantId: other.id,
      amountSats: 2_000n,
      idempotencyKey,
    })
    assert.notEqual(first.id, second.id)
    assert.equal(harness.provider.createInvoiceCalls, 2)
  })

  test('13. cross-tenant reads and client capabilities are denied', async () => {
    const harness = await makeHarness()
    const { tenant: other } = await harness.tenantService.createTenant({ name: 'Attacker Merchant' })
    const created = await harness.service.create({
      tenantId: harness.tenantId,
      amountSats: 2_000n,
    })
    assert.equal(harness.service.getMerchantIntent(other.id, created.id), undefined)
    assert.equal(
      harness.service.authorizeClient(other.id, created.id, created.clientSecret),
      undefined,
    )
    assert.equal(harness.repo.paymentIntent(other.id, created.id), undefined)
    const current = harness.repo.paymentIntent(harness.tenantId, created.id)!
    assert.equal(harness.repo.transitionPaymentIntent({
      tenantId: other.id,
      paymentHash: current.paymentHash,
      fromStatus: 'requires_payment',
      toStatus: 'canceled',
      updatedAt: new Date().toISOString(),
    }), false)
    assert.equal(harness.repo.paymentIntent(harness.tenantId, created.id)?.status, 'requires_payment')
  })
})

describe('Authoritative and monotonic payment lifecycle', () => {
  test('14. provider settlement is the only path to succeeded', async () => {
    const harness = await makeHarness()
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    assert.equal(harness.repo.paymentIntent(harness.tenantId, created.id)?.status, 'requires_payment')
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    harness.provider.setState(created.paymentHash, 'settled')
    await waitFor(
      () => harness.repo.paymentIntent(harness.tenantId, created.id)?.status === 'succeeded',
    )
  })

  test('15. duplicate provider settlement emits one logical downstream event', async () => {
    const harness = await makeHarness()
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    harness.provider.setState(created.paymentHash, 'settled')
    await waitFor(() => harness.eventSink.events.length === 1)
    harness.provider.emitHistorical(created.paymentHash, 'settled')
    await delay(10)
    assert.equal(harness.eventSink.events.length, 1)
  })

  test('16. out-of-order provider events cannot reverse succeeded', async () => {
    const harness = await makeHarness()
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    harness.provider.setState(created.paymentHash, 'settled')
    await waitFor(
      () => harness.repo.paymentIntent(harness.tenantId, created.id)?.status === 'succeeded',
    )
    harness.provider.emitHistorical(created.paymentHash, 'accepted')
    harness.provider.emitHistorical(created.paymentHash, 'pending')
    await delay(10)
    assert.equal(harness.repo.paymentIntent(harness.tenantId, created.id)?.status, 'succeeded')
  })

  test('17. every terminal state is monotonic under compare-and-set', async () => {
    const harness = await makeHarness()
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    const current = harness.repo.paymentIntent(harness.tenantId, created.id)!
    const changed = harness.repo.transitionPaymentIntent({
      tenantId: harness.tenantId,
      paymentHash: current.paymentHash,
      fromStatus: 'requires_payment',
      toStatus: 'canceled',
      updatedAt: new Date().toISOString(),
    })
    assert.equal(changed, true)
    assert.equal(harness.repo.transitionPaymentIntent({
      tenantId: harness.tenantId,
      paymentHash: current.paymentHash,
      fromStatus: 'requires_payment',
      toStatus: 'processing',
      updatedAt: new Date().toISOString(),
    }), false)
    harness.provider.emitHistorical(current.paymentHash, 'settled')
    await delay(10)
    assert.equal(harness.repo.paymentIntent(harness.tenantId, created.id)?.status, 'canceled')
  })

  test('18. authoritative expiration becomes terminal and cleans the watcher', async () => {
    const harness = await makeHarness()
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    harness.provider.setState(created.paymentHash, 'expired')
    await waitFor(
      () => harness.repo.paymentIntent(harness.tenantId, created.id)?.status === 'expired',
    )
    await waitFor(() => !harness.provider.subscribers.has(created.paymentHash))
  })
})

describe('Restart recovery, watcher safety, and periodic reconciliation', () => {
  test('19. restart before settlement re-subscribes the pending intent', async () => {
    const harness = await makeHarness()
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    await harness.service.shutdown()
    const restarted = newService(harness)
    harness.service = restarted
    await restarted.recoverPendingIntents()
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    harness.provider.setState(created.paymentHash, 'settled')
    await waitFor(
      () => harness.repo.paymentIntent(harness.tenantId, created.id)?.status === 'succeeded',
    )
  })

  test('20. settlement while offline is detected before re-subscribing', async () => {
    const harness = await makeHarness()
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    await harness.service.shutdown()
    harness.provider.setState(created.paymentHash, 'settled', false)
    const subscribeCount = harness.provider.subscribeCalls
    const restarted = newService(harness)
    harness.service = restarted
    await restarted.recoverPendingIntents()
    assert.equal(harness.repo.paymentIntent(harness.tenantId, created.id)?.status, 'succeeded')
    assert.equal(harness.provider.subscribeCalls, subscribeCount)
  })

  test('21. pending state survives restart and later provider callback settles it', async () => {
    const harness = await makeHarness()
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    await harness.service.shutdown()
    const restarted = newService(harness)
    harness.service = restarted
    await restarted.recoverPendingIntents()
    assert.equal(harness.repo.paymentIntent(harness.tenantId, created.id)?.status, 'requires_payment')
    harness.provider.setState(created.paymentHash, 'accepted')
    await waitFor(
      () => harness.repo.paymentIntent(harness.tenantId, created.id)?.status === 'processing',
    )
    harness.provider.setState(created.paymentHash, 'settled')
    await waitFor(
      () => harness.repo.paymentIntent(harness.tenantId, created.id)?.status === 'succeeded',
    )
  })

  test('expiry while offline is applied only after attempting provider reconciliation', async () => {
    const harness = await makeHarness()
    harness.provider.invoiceExpiryOffsetMs = -1
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    await harness.service.shutdown()
    harness.provider.failGetInvoice = true
    const restarted = newService(harness)
    harness.service = restarted
    const callsBefore = harness.provider.getInvoiceCalls
    await restarted.recoverPendingIntents()
    assert.ok(harness.provider.getInvoiceCalls > callsBefore)
    assert.equal(harness.repo.paymentIntent(harness.tenantId, created.id)?.status, 'expired')
  })

  test('22. startup recovery enforces its configured concurrency bound', async () => {
    const harness = await makeHarness()
    for (let index = 0; index < 12; index += 1) {
      await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    }
    await waitFor(() => harness.provider.subscribers.size === 12)
    await harness.service.shutdown()
    harness.provider.getInvoiceDelayMs = 10
    harness.provider.maxGetInvoiceActive = 0
    const restarted = newService(harness, { recoveryConcurrency: 3 })
    harness.service = restarted
    await restarted.recoverPendingIntents()
    assert.ok(harness.provider.maxGetInvoiceActive <= 3)
    assert.ok(harness.provider.maxGetInvoiceActive > 1)
  })

  test('23. concurrent recovery never starts duplicate watchers', async () => {
    const harness = await makeHarness()
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    await Promise.all([
      harness.service.recoverPendingIntents(),
      harness.service.recoverPendingIntents(),
      harness.service.recoverPendingIntents(),
    ])
    assert.equal(harness.provider.subscribeCalls, 1)
    assert.equal(harness.provider.subscribers.size, 1)
  })

  test('24. periodic reconciliation catches a settlement missed by the watcher', async () => {
    const harness = await makeHarness({ reconciliationIntervalMs: 5 })
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    harness.service.startReconciliationLoop(5)
    harness.provider.setState(created.paymentHash, 'settled', false)
    await waitFor(
      () => harness.repo.paymentIntent(harness.tenantId, created.id)?.status === 'succeeded',
    )
  })

  test('25. shutdown clears reconciliation timers, retry timers, and watchers', async () => {
    const harness = await makeHarness({ reconciliationIntervalMs: 5 })
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    harness.service.startReconciliationLoop(5)
    await waitFor(() => harness.provider.getInvoiceCalls > 0)
    await harness.service.shutdown()
    assert.equal(harness.provider.subscribers.size, 0)
    const callsAfterShutdown = harness.provider.getInvoiceCalls
    await delay(20)
    assert.equal(harness.provider.getInvoiceCalls, callsAfterShutdown)
  })

  test('subscription failures retry with bounded backoff and no duplicate placeholder', async () => {
    const harness = await makeHarness()
    harness.provider.failSubscriptions = 1
    const created = await harness.service.create({ tenantId: harness.tenantId, amountSats: 1_000n })
    await waitFor(() => harness.provider.subscribers.has(created.paymentHash))
    assert.equal(harness.provider.subscribeCalls, 2)
    assert.equal(harness.provider.subscribers.size, 1)
  })
})
