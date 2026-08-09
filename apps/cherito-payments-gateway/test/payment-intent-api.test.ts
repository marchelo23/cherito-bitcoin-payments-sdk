import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CreateInvoiceInput,
  LightningInvoice,
  LightningReceiveProvider,
} from '@cherito/bitcoin-sdk'
import type { Config } from '../src/config.js'

const TEST_INTENT_SECRET_KEY = Buffer.alloc(32, 0x24).toString('base64')

process.env.NODE_ENV = 'test'

class ApiProvider implements LightningReceiveProvider {
  readonly providerType = 'lnd' as const
  readonly invoices = new Map<string, LightningInvoice>()
  creates = 0

  async getCapabilities() {
    return {
      provider: 'lnd' as const,
      bolt11Receive: true,
      bolt12Receive: false,
      invoiceStreaming: true,
    }
  }

  async getNodeInfo() {
    return { network: 'regtest' as const, syncedToChain: true, syncedToGraph: true }
  }

  async createInvoice(input: CreateInvoiceInput) {
    this.creates += 1
    const paymentHash = `api_hash_${this.creates}`
    const invoice = {
      providerInvoiceId: `api_invoice_${this.creates}`,
      paymentHash,
      paymentRequest: `lnbcrt_${this.creates}`,
      amountSats: input.amountSats,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
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
    ALLOWED_ORIGINS: 'http://localhost:3000',
    MIN_INVOICE_SATS: 10n,
    MAX_INVOICE_SATS: 1_000_000n,
    DEFAULT_INVOICE_EXPIRY_SECONDS: 60,
    RATE_LIMIT_CREATE_INVOICE: 100,
    DATABASE_URL: `file:${join(directory, 'api.sqlite')}`,
    CHERITO_INTENT_SECRET_KEY: TEST_INTENT_SECRET_KEY,
    CHERITO_INTENT_SECRET_PREVIOUS_KEYS: '',
    LOG_LEVEL: 'silent',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    PAYMENT_INTENT_RECOVERY_CONCURRENCY: 2,
    PAYMENT_INTENT_RECONCILIATION_INTERVAL_MS: 60_000,
    PAYMENT_INTENT_WATCH_RETRY_BASE_MS: 100,
    PAYMENT_INTENT_WATCH_RETRY_MAX_MS: 1_000,
    SQLITE_BUSY_TIMEOUT_MS: 5_000,
    BOOTSTRAP_TENANT_NAME: 'API Merchant',
    BOOTSTRAP_KEY_PATH: join(directory, 'bootstrap.key'),
  }
}

test('merchant and client routes enforce authority boundaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cherito-payment-intent-api-'))
  const provider = new ApiProvider()
  const { buildServer } = await import('../src/server.js')
  const config = configFor(directory)
  const app = await buildServer(config, {
    lnd: provider,
    startBackgroundJobs: false,
  })
  cleanups.push(async () => {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const apiKey = readFileSync(config.BOOTSTRAP_KEY_PATH!, 'utf8').trim()
  assert.equal(statSync(config.BOOTSTRAP_KEY_PATH!).mode & 0o777, 0o600)
  const idempotencyKey = crypto.randomUUID()
  const create = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'idempotency-key': idempotencyKey,
    },
    payload: {
      amountSats: '2500',
      merchantOrderId: 'api-order-1',
      metadata: { checkout: 'server' },
    },
  })
  assert.equal(create.statusCode, 201)
  const created = create.json<{
    id: string
    tenantId: string
    clientSecret: string
    paymentHash: string
  }>()

  const retry = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'idempotency-key': idempotencyKey,
    },
    payload: {
      amountSats: '2500',
      merchantOrderId: 'api-order-1',
      metadata: { checkout: 'server' },
    },
  })
  assert.equal(retry.statusCode, 201)
  assert.equal(retry.json().id, created.id)
  assert.equal(retry.json().clientSecret, created.clientSecret)
  assert.equal(provider.creates, 1)

  const merchantRead = await app.inject({
    method: 'GET',
    url: `/v1/payment-intents/${created.id}`,
    headers: { authorization: `Bearer ${apiKey}` },
  })
  assert.equal(merchantRead.statusCode, 200)
  assert.equal(merchantRead.json().clientSecret, undefined)

  const clientRead = await app.inject({
    method: 'GET',
    url: `/v1/payment-intents/${created.id}/status`,
    headers: {
      authorization: `Bearer ${created.clientSecret}`,
      'x-cherito-tenant-id': created.tenantId,
    },
  })
  assert.equal(clientRead.statusCode, 200)
  const clientBody = clientRead.json()
  assert.equal(clientBody.status, 'requires_payment')
  assert.equal(clientBody.paymentHash, undefined)
  assert.equal(clientBody.providerInvoiceId, undefined)
  assert.equal(clientBody.tenantId, undefined)
  assert.equal(clientBody.metadata, undefined)

  const wrongTenant = await app.inject({
    method: 'GET',
    url: `/v1/payment-intents/${created.id}/status`,
    headers: {
      authorization: `Bearer ${created.clientSecret}`,
      'x-cherito-tenant-id': `tnt_${crypto.randomUUID()}`,
    },
  })
  assert.equal(wrongTenant.statusCode, 404)

  const browserCreate = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${created.clientSecret}` },
    payload: { amountSats: '999999' },
  })
  assert.equal(browserCreate.statusCode, 401)
})

test('production and development bootstrap require an explicit protected destination', async () => {
  const { buildServer } = await import('../src/server.js')
  for (const environment of ['production', 'development'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'cherito-payment-intent-bootstrap-'))
    const config = configFor(directory)
    config.NODE_ENV = environment
    config.BOOTSTRAP_KEY_PATH = undefined
    const output: string[] = []
    const originals = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    }
    const capture = (...values: unknown[]) => output.push(values.map(String).join(' '))
    console.log = capture
    console.info = capture
    console.warn = capture
    console.error = capture
    try {
      await assert.rejects(
        buildServer(config, { lnd: new ApiProvider(), startBackgroundJobs: false }),
        /BOOTSTRAP_KEY_PATH is required/,
      )
    } finally {
      Object.assign(console, originals)
      rmSync(directory, { recursive: true, force: true })
    }
    assert.deepEqual(output, [])
  }
})

test('API accepts pricing rules, rejects floating-point amounts, and reports idempotency conflicts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cherito-payment-intent-api-'))
  const provider = new ApiProvider()
  const { buildServer } = await import('../src/server.js')
  const config = configFor(directory)
  const app = await buildServer(config, { lnd: provider, startBackgroundJobs: false })
  cleanups.push(async () => {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const apiKey = readFileSync(config.BOOTSTRAP_KEY_PATH!, 'utf8').trim()

  const pricing = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { productId: 'cherito-coffee-001', quantity: 2 },
  })
  assert.equal(pricing.statusCode, 201)
  assert.equal(pricing.json().amountSats, '50000')

  const floatingPoint = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { amountSats: 1.5 },
  })
  assert.equal(floatingPoint.statusCode, 400)

  const key = crypto.randomUUID()
  const first = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': key },
    payload: { amountSats: '1000', description: 'first' },
  })
  assert.equal(first.statusCode, 201)
  const conflict = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': key },
    payload: { amountSats: '1000', description: 'changed' },
  })
  assert.equal(conflict.statusCode, 409)
  assert.equal(conflict.json().code, 'IDEMPOTENCY_CONFLICT')
})
