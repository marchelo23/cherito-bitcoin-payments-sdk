import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { LogController } from 'fastify'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CreateInvoiceInput,
  LightningInvoice,
  LightningReceiveProvider,
} from '@cherito/bitcoin-sdk'
import { loadConfig, type Config } from '../src/config.js'
import {
  createSafeLoggerOptions,
  safeLog,
  type LogDestination,
} from '../src/logging/safe-logger.js'

const NEVER_LOG = 'SHOULD_NEVER_APPEAR_IN_LOGS_123'
const INTERNAL_URL = 'https://lnd.internal.example:8080/v1/invoices'
const INTENT_KEY = Buffer.alloc(32, 0x45).toString('base64')
process.env.NODE_ENV = 'test'

class MemoryDestination implements LogDestination {
  readonly chunks: string[] = []
  write(message: string): void {
    this.chunks.push(message)
  }
  text(): string {
    return this.chunks.join('')
  }
  events(): Array<Record<string, unknown>> {
    return this.text().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }
}

class LoggingProvider implements LightningReceiveProvider {
  readonly providerType = 'lnd' as const
  readonly invoices = new Map<string, LightningInvoice>()
  failCreate = false
  sequence = 0

  async getCapabilities() {
    return {
      provider: 'lnd' as const,
      bolt11Receive: true,
      bolt12Receive: false,
      invoiceStreaming: true,
    }
  }

  async getNodeInfo() {
    return {
      alias: NEVER_LOG,
      identityPubkey: NEVER_LOG.repeat(2),
      network: 'regtest' as const,
      syncedToChain: true,
      syncedToGraph: true,
    }
  }

  async createInvoice(input: CreateInvoiceInput) {
    if (this.failCreate) {
      const error = new Error(`${NEVER_LOG} ${INTERNAL_URL}`)
      error.stack = `Error: ${NEVER_LOG}\n    at ${INTERNAL_URL}`
      throw error
    }
    this.sequence += 1
    const paymentHash = `${this.sequence}`.padStart(64, '0')
    const invoice: LightningInvoice = {
      providerInvoiceId: `provider_${this.sequence}`,
      paymentHash,
      paymentRequest: `lnbcrt1${NEVER_LOG}`,
      amountSats: input.amountSats,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'pending',
    }
    this.invoices.set(paymentHash, invoice)
    return invoice
  }

  async getInvoice(paymentHash: string) {
    const invoice = this.invoices.get(paymentHash)
    if (!invoice) throw new Error(`${NEVER_LOG} ${INTERNAL_URL}`)
    return invoice
  }

  async subscribeToInvoice() {
    return async () => {}
  }
}

function configFor(directory: string, logLevel: Config['LOG_LEVEL'] = 'info'): Config {
  return {
    NODE_ENV: 'test',
    PORT: 3100,
    HOST: '127.0.0.1',
    LIGHTNING_PROVIDER: 'lnd',
    LND_REST_URL: INTERNAL_URL,
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
    DATABASE_URL: `file:${join(directory, 'safe-logging.sqlite')}`,
    CHERITO_INTENT_SECRET_KEY: INTENT_KEY,
    CHERITO_INTENT_SECRET_PREVIOUS_KEYS: '',
    LOG_LEVEL: logLevel,
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    PAYMENT_INTENT_RECOVERY_CONCURRENCY: 2,
    PAYMENT_INTENT_RECONCILIATION_INTERVAL_MS: 60_000,
    PAYMENT_INTENT_WATCH_RETRY_BASE_MS: 100,
    PAYMENT_INTENT_WATCH_RETRY_MAX_MS: 1_000,
    SQLITE_BUSY_TIMEOUT_MS: 5_000,
    BOOTSTRAP_TENANT_NAME: 'Logging Test Merchant',
    BOOTSTRAP_KEY_PATH: join(directory, 'bootstrap.key'),
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

test('structured redaction protects nested credentials and logging failure is non-fatal', async () => {
  const output = new MemoryDestination()
  const app = Fastify({
    logger: createSafeLoggerOptions('info', output),
    logController: new LogController({ disableRequestLogging: true }),
  })
  cleanups.push(() => app.close())

  app.log.info({
    authorization: `Bearer ${NEVER_LOG}`,
    apiKey: NEVER_LOG,
    nested: {
      clientSecret: NEVER_LOG,
      webhookSecret: NEVER_LOG,
      credentials: {
        macaroon: NEVER_LOG,
        rune: NEVER_LOG,
        lnbitsApiKey: NEVER_LOG,
      },
    },
    request: {
      headers: { cookie: NEVER_LOG },
      body: { password: NEVER_LOG, metadata: NEVER_LOG },
    },
    providerResponse: { bolt11: NEVER_LOG, paymentHash: NEVER_LOG },
    err: Object.assign(new Error(NEVER_LOG), { cause: INTERNAL_URL }),
  }, 'defense in depth')

  safeLog(app.log, 'info', {
    event: 'safe.event\nforged-log-line',
    status: 'ok\u0000forged-status',
  }, 'one structured event')

  assert.doesNotMatch(output.text(), new RegExp(NEVER_LOG))
  assert.doesNotMatch(output.text(), /lnd\.internal\.example/)
  assert.match(output.text(), /\[REDACTED\]/)
  assert.doesNotThrow(() => safeLog({
    debug() { throw new Error('logger failed') },
    info() { throw new Error('logger failed') },
    warn() { throw new Error('logger failed') },
    error() { throw new Error('logger failed') },
    fatal() { throw new Error('logger failed') },
  }, 'error', { event: 'payment.failed' }, 'payment failed'))
  assert.ok(output.events().length >= 2, 'newline input must not forge extra log events')
})

test('credential and payment routes emit allowlisted summaries without secrets or bodies', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cherito-safe-logging-'))
  const provider = new LoggingProvider()
  const output = new MemoryDestination()
  const { buildServer } = await import('../src/server.js')
  const config = configFor(directory)
  const app = await buildServer(config, {
    lnd: provider,
    startBackgroundJobs: false,
    logStream: output,
  })
  cleanups.push(async () => {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const apiKey = readFileSync(config.BOOTSTRAP_KEY_PATH!, 'utf8').trim()
  const create = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'idempotency-key': crypto.randomUUID(),
    },
    payload: {
      amountSats: '1200',
      description: `${NEVER_LOG}\nforged-log-line`,
      metadata: { customerNote: NEVER_LOG, clientSecret: NEVER_LOG },
    },
  })
  assert.equal(create.statusCode, 201)
  const created = create.json<{ id: string; tenantId: string; clientSecret: string }>()

  const invalidBody = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: {
      amountSats: '1200',
      clientSecret: NEVER_LOG,
      webhookSecret: NEVER_LOG,
      macaroon: NEVER_LOG,
    },
  })
  assert.equal(invalidBody.statusCode, 400)
  assert.equal(invalidBody.json().code, 'INVALID_REQUEST')

  const invalidCapability = await app.inject({
    method: 'GET',
    url: `/v1/payment-intents/${created.id}/status`,
    headers: {
      authorization: `Bearer ${NEVER_LOG}`,
      'x-cherito-tenant-id': created.tenantId,
    },
  })
  assert.equal(invalidCapability.statusCode, 404)

  const health = await app.inject({ method: 'GET', url: '/health' })
  assert.deepEqual(health.json(), { status: 'ok', lightning: 'connected' })

  const publicNode = await app.inject({ method: 'GET', url: '/v1/node' })
  assert.equal(publicNode.statusCode, 401)
  assert.doesNotMatch(publicNode.body, new RegExp(NEVER_LOG))

  const privateNode = await app.inject({
    method: 'GET',
    url: '/v1/node',
    headers: { authorization: `Bearer ${apiKey}` },
  })
  assert.equal(privateNode.statusCode, 200)
  assert.equal(privateNode.json().alias, NEVER_LOG)

  const capabilities = await app.inject({ method: 'GET', url: '/v1/capabilities' })
  assert.equal(capabilities.statusCode, 200)
  assert.equal(capabilities.json().provider, undefined)

  provider.failCreate = true
  const providerFailure = await app.inject({
    method: 'POST',
    url: '/v1/payment-intents',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { amountSats: '1300' },
  })
  assert.equal(providerFailure.statusCode, 502)
  assert.deepEqual(
    { code: providerFailure.json().code, message: providerFailure.json().message },
    { code: 'PROVIDER_UNAVAILABLE', message: 'Lightning provider unavailable' },
  )
  assert.doesNotMatch(providerFailure.body, new RegExp(NEVER_LOG))
  assert.doesNotMatch(providerFailure.body, /lnd\.internal\.example|Error:|\bat\s/)

  const logs = output.text()
  assert.doesNotMatch(logs, new RegExp(NEVER_LOG))
  assert.doesNotMatch(logs, /lnd\.internal\.example/)
  assert.doesNotMatch(logs, new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(logs, new RegExp(created.clientSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(logs, /lnbcrt1/)
  for (const event of output.events()) {
    assert.equal(event.body, undefined)
    assert.equal(event.headers, undefined)
    assert.equal(event.req, undefined)
    assert.equal(event.res, undefined)
    assert.equal(event.err, undefined)
  }
})

test('configuration rejects ambiguous and malformed credential sources', () => {
  const base = {
    NODE_ENV: 'test',
    LND_REST_URL: 'https://localhost:8080',
    LND_TLS_CERT_BASE64: 'Y2VydA==',
    LND_MACAROON_HEX: '00',
    CHERITO_INTENT_SECRET_KEY: INTENT_KEY,
  }
  assert.throws(() => loadConfig({ ...base, LND_TLS_CERT_PATH: '/cert' }), /ambiguous/)
  assert.throws(() => loadConfig({ ...base, LND_MACAROON_PATH: '/macaroon' }), /ambiguous/)
  assert.throws(() => loadConfig({ ...base, LND_TLS_CERT_BASE64: 'not-base64' }))
  assert.throws(() => loadConfig({ ...base, LND_MACAROON_HEX: 'abc' }))
  for (const name of ['SEED_PHRASE', 'WALLET_SEED', 'MNEMONIC', 'XPRIV'] as const) {
    assert.throws(() => loadConfig({ ...base, [name]: NEVER_LOG }), /forbidden/)
  }
})
