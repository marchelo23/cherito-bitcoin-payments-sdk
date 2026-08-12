import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CreateInvoiceInput,
  LightningInvoice,
  LightningReceiveProvider,
} from '@cherito/bitcoin-sdk'
import type { Config } from '../src/config.js'
import { PaymentIntentRepository } from '../src/persistence/payment-intent-repository.js'
import { PaymentIntentSecretCipher } from '../src/security/payment-intent-secret-cipher.js'
import { ApiKeyService } from '../src/services/api-key-service.js'
import { TenantService } from '../src/services/tenant-service.js'

const KEY = Buffer.alloc(32, 0x51).toString('base64')

process.env.NODE_ENV = 'test'

class ListingProvider implements LightningReceiveProvider {
  readonly providerType = 'lnd' as const
  private readonly invoices = new Map<string, LightningInvoice>()
  private created = 0

  async getCapabilities() {
    return { provider: 'lnd' as const, bolt11Receive: true, bolt12Receive: false, invoiceStreaming: true }
  }

  async getNodeInfo() {
    return { network: 'regtest' as const, syncedToChain: true, syncedToGraph: true }
  }

  async createInvoice(input: CreateInvoiceInput) {
    this.created += 1
    const paymentHash = `listing_hash_${this.created}`
    const invoice = {
      providerInvoiceId: `listing_invoice_${this.created}`,
      paymentHash,
      paymentRequest: `lnbcrt_listing_${this.created}`,
      amountSats: input.amountSats,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      state: 'pending' as const,
    }
    this.invoices.set(paymentHash, invoice)
    return invoice
  }

  async getInvoice(paymentHash: string) {
    const invoice = this.invoices.get(paymentHash)
    if (!invoice) throw new Error('invoice not found')
    return invoice
  }

  async subscribeToInvoice() {
    return async () => {}
  }
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function configFor(directory: string): Config {
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
    ALLOWED_ORIGINS: 'http://localhost:5173',
    MIN_INVOICE_SATS: 10n,
    MAX_INVOICE_SATS: 1_000_000n,
    DEFAULT_INVOICE_EXPIRY_SECONDS: 600,
    RATE_LIMIT_CREATE_INVOICE: 500,
    RATE_LIMIT_WEBHOOK_MANAGEMENT: 500,
    DATABASE_URL: `file:${join(directory, 'listing.sqlite')}`,
    CHERITO_INTENT_SECRET_KEY: KEY,
    CHERITO_INTENT_SECRET_PREVIOUS_KEYS: '',
    LOG_LEVEL: 'silent',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    PAYMENT_INTENT_RECOVERY_CONCURRENCY: 2,
    PAYMENT_INTENT_RECONCILIATION_INTERVAL_MS: 60_000,
    PAYMENT_INTENT_WATCH_RETRY_BASE_MS: 100,
    PAYMENT_INTENT_WATCH_RETRY_MAX_MS: 1_000,
    SQLITE_BUSY_TIMEOUT_MS: 5_000,
    BOOTSTRAP_TENANT_NAME: 'Listing Merchant',
    BOOTSTRAP_KEY_PATH: join(directory, 'bootstrap.key'),
  } as unknown as Config
}

async function startGateway() {
  const directory = mkdtempSync(join(tmpdir(), 'cherito-merchant-listing-'))
  const { buildServer } = await import('../src/server.js')
  const config = configFor(directory)
  const app = await buildServer(config, { lnd: new ListingProvider(), startBackgroundJobs: false })
  cleanups.push(async () => {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const apiKey = readFileSync(config.BOOTSTRAP_KEY_PATH!, 'utf8').trim()
  return { app, config, apiKey }
}

async function createIntent(
  app: Awaited<ReturnType<typeof startGateway>>['app'],
  apiKey: string,
  order: string,
  amountSats = '1000',
) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': crypto.randomUUID() },
    payload: { amountSats, merchantOrderId: order },
  })
  assert.equal(response.statusCode, 201, response.body)
  return response.json<{ id: string }>()
}

test('payment intent listing requires merchant authentication', async () => {
  const { app } = await startGateway()

  for (const headers of [{}, { authorization: 'Bearer sk_live_not_a_key' }]) {
    const response = await app.inject({ method: 'GET', url: '/v1/payment-intents', headers })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().code, 'UNAUTHORIZED')
  }

  for (const url of ['/v1/payment-intents/summary', '/v1/api-keys']) {
    const response = await app.inject({ method: 'GET', url })
    assert.equal(response.statusCode, 401)
  }
})

test('payment intent listing is empty for a new merchant', async () => {
  const { app, apiKey } = await startGateway()

  const response = await app.inject({
    method: 'GET',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${apiKey}` },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().items, [])
  assert.equal(response.json().next, undefined)

  const summary = await app.inject({
    method: 'GET',
    url: '/v1/payment-intents/summary',
    headers: { authorization: `Bearer ${apiKey}` },
  })
  assert.deepEqual(summary.json(), {
    settledCount: 0,
    settledVolumeSats: '0',
    pendingCount: 0,
    failedCount: 0,
  })
})

test('payment intent listing returns merchant-safe fields for multiple intents', async () => {
  const { app, apiKey } = await startGateway()

  const created = []
  for (let index = 0; index < 3; index += 1) {
    created.push(await createIntent(app, apiKey, `listing-order-${index}`))
  }

  const response = await app.inject({
    method: 'GET',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${apiKey}` },
  })

  assert.equal(response.statusCode, 200)
  const items = response.json<{ items: Array<Record<string, unknown>> }>().items
  assert.equal(items.length, 3)

  const ids = items.map((item) => item.id)
  assert.deepEqual([...ids].sort(), created.map((intent) => intent.id).sort())

  for (const item of items) {
    assert.equal(item.clientSecret, undefined, 'listing leaked a client capability secret')
    assert.ok(item.id && item.status && item.amountSats)
    assert.ok(item.createdAt)
  }

  const summary = await app.inject({
    method: 'GET',
    url: '/v1/payment-intents/summary',
    headers: { authorization: `Bearer ${apiKey}` },
  })
  assert.equal(summary.json().pendingCount, 3)
  assert.equal(summary.json().settledCount, 0)
  assert.equal(summary.json().settledVolumeSats, '0')
})

test('payment intent listing paginates deterministically', async () => {
  const { app, apiKey } = await startGateway()

  for (let index = 0; index < 5; index += 1) {
    await createIntent(app, apiKey, `page-order-${index}`)
  }

  const firstPage = await app.inject({
    method: 'GET',
    url: '/v1/payment-intents?limit=2',
    headers: { authorization: `Bearer ${apiKey}` },
  })
  assert.equal(firstPage.statusCode, 200)
  const first = firstPage.json<{ items: Array<{ id: string }>; next?: string }>()
  assert.equal(first.items.length, 2)
  assert.equal(first.next, first.items[1]!.id)

  const secondPage = await app.inject({
    method: 'GET',
    url: `/v1/payment-intents?limit=2&after=${first.next}`,
    headers: { authorization: `Bearer ${apiKey}` },
  })
  const second = secondPage.json<{ items: Array<{ id: string }> }>()
  assert.equal(second.items.length, 2)

  const firstIds = first.items.map((item) => item.id)
  const secondIds = second.items.map((item) => item.id)
  assert.equal(firstIds.some((id) => secondIds.includes(id)), false, 'pages overlapped')

  const repeated = await app.inject({
    method: 'GET',
    url: '/v1/payment-intents?limit=2',
    headers: { authorization: `Bearer ${apiKey}` },
  })
  assert.deepEqual(repeated.json().items.map((item: { id: string }) => item.id), firstIds)
})

test('payment intent listing validates the limit bounds', async () => {
  const { app, apiKey } = await startGateway()
  const headers = { authorization: `Bearer ${apiKey}` }

  for (const limit of ['101', '0', '-1', 'abc']) {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/payment-intents?limit=${limit}`,
      headers,
    })
    assert.equal(response.statusCode, 400, `limit=${limit} was accepted`)
  }

  const accepted = await app.inject({ method: 'GET', url: '/v1/payment-intents?limit=100', headers })
  assert.equal(accepted.statusCode, 200)

  const rejectedField = await app.inject({
    method: 'GET',
    url: '/v1/payment-intents?tenantId=tnt_someone_else',
    headers,
  })
  assert.equal(rejectedField.statusCode, 400, 'listing accepted a caller-supplied tenant id')
})

test('payment intent listing is isolated per tenant', async () => {
  const { app, config, apiKey } = await startGateway()

  await createIntent(app, apiKey, 'tenant-a-order')

  const repo = new PaymentIntentRepository(config.DATABASE_URL, new PaymentIntentSecretCipher(KEY))
  const tenantService = new TenantService(repo, new ApiKeyService(repo))
  const second = await tenantService.createTenant({ name: 'Second Merchant' })
  repo.close()

  const otherListing = await app.inject({
    method: 'GET',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${second.apiKey}` },
  })
  assert.equal(otherListing.statusCode, 200)
  assert.deepEqual(otherListing.json().items, [], 'tenant B saw tenant A payment intents')

  const otherSummary = await app.inject({
    method: 'GET',
    url: '/v1/payment-intents/summary',
    headers: { authorization: `Bearer ${second.apiKey}` },
  })
  assert.equal(otherSummary.json().pendingCount, 0)

  const ownListing = await app.inject({
    method: 'GET',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${apiKey}` },
  })
  assert.equal(ownListing.json().items.length, 1)
})

test('api key listing exposes metadata only and stays tenant scoped', async () => {
  const { app, config, apiKey } = await startGateway()

  const response = await app.inject({
    method: 'GET',
    url: '/v1/api-keys',
    headers: { authorization: `Bearer ${apiKey}` },
  })
  assert.equal(response.statusCode, 200)

  const items = response.json<{ items: Array<Record<string, unknown>> }>().items
  assert.equal(items.length, 1)
  const [key] = items
  assert.ok(key!.id && key!.keyPrefix && key!.label && key!.createdAt)
  assert.equal(key!.revokedAt, null)
  assert.equal(key!.keyHash, undefined, 'api key listing leaked the stored hash')
  assert.equal(response.body.includes(apiKey), false, 'api key listing leaked the raw key')

  const repo = new PaymentIntentRepository(config.DATABASE_URL, new PaymentIntentSecretCipher(KEY))
  const tenantService = new TenantService(repo, new ApiKeyService(repo))
  const second = await tenantService.createTenant({ name: 'Second Merchant' })
  repo.close()

  const otherKeys = await app.inject({
    method: 'GET',
    url: '/v1/api-keys',
    headers: { authorization: `Bearer ${second.apiKey}` },
  })
  const otherItems = otherKeys.json<{ items: Array<{ id: string }> }>().items
  assert.equal(otherItems.length, 1)
  assert.notEqual(otherItems[0]!.id, key!.id, 'tenant B saw tenant A api keys')
})
