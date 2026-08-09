import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CreateInvoiceInput,
  LightningInvoice,
  LightningReceiveProvider,
} from '@cherito/bitcoin-sdk'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from '../src/config.js'
import { PaymentIntentRepository } from '../src/persistence/payment-intent-repository.js'
import { PaymentIntentSecretCipher } from '../src/security/payment-intent-secret-cipher.js'
import { ApiKeyService } from '../src/services/api-key-service.js'
import { TenantService } from '../src/services/tenant-service.js'

process.env.NODE_ENV = 'test'
const KEY = Buffer.alloc(32, 0x40).toString('base64')

class LinkProvider implements LightningReceiveProvider {
  readonly providerType = 'lnd' as const
  creates = 0
  failNext = false
  delayMs = 0
  readonly invoices = new Map<string, LightningInvoice>()

  async getCapabilities() {
    return { provider: 'lnd' as const, bolt11Receive: true, bolt12Receive: false, invoiceStreaming: false }
  }
  async getNodeInfo() { return { network: 'regtest' as const } }
  async createInvoice(input: CreateInvoiceInput) {
    this.creates += 1
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    if (this.failNext) {
      this.failNext = false
      throw new Error('deterministic provider failure')
    }
    const paymentHash = this.creates.toString(16).padStart(64, '0')
    const invoice: LightningInvoice = {
      providerInvoiceId: `provider_${this.creates}`,
      paymentHash,
      paymentRequest: `lnbcrt_test_${this.creates}`,
      amountSats: input.amountSats,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'pending',
    }
    this.invoices.set(paymentHash, invoice)
    return invoice
  }
  async getInvoice(hash: string) { return this.invoices.get(hash)! }
  async subscribeToInvoice() { return async () => {} }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function setup(overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cherito-links-'))
  const provider = new LinkProvider()
  const { buildServer } = await import('../src/server.js')
  const config = loadConfig({
    NODE_ENV: 'test',
    LND_REST_URL: 'https://127.0.0.1:8080',
    LND_TLS_CERT_BASE64: 'Y2VydA==',
    LND_MACAROON_HEX: '00',
    CHERITO_INTENT_SECRET_KEY: KEY,
    DATABASE_URL: `file:${join(directory, 'gateway.sqlite')}`,
    BOOTSTRAP_KEY_PATH: join(directory, 'bootstrap.key'),
    MIN_INVOICE_SATS: '10',
    MAX_INVOICE_SATS: '1000000',
    RATE_LIMIT_CREATE_INVOICE: '1000',
    RATE_LIMIT_PAYMENT_LINK_RESOLVE: '1000',
    RATE_LIMIT_PAYMENT_LINK_CREATE_IP: '1000',
    RATE_LIMIT_PAYMENT_LINK_CREATE_TENANT: '1000',
    RATE_LIMIT_PAYMENT_LINK_CREATE_LINK: '1000',
    LOG_LEVEL: 'silent',
    ...overrides,
  })
  const app = await buildServer(config, { lnd: provider, startBackgroundJobs: false })
  const apiKey = readFileSync(config.BOOTSTRAP_KEY_PATH!, 'utf8').trim()
  cleanups.push(async () => {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { app, apiKey, provider, config }
}

async function createLink(
  app: FastifyInstance,
  apiKey: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/payment-links',
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': crypto.randomUUID() },
    payload,
  })
}

describe('Payment Link public and management flows', () => {
  test('fixed links create a fresh canonical Payment Intent on every invocation', async () => {
    const { app, apiKey, provider } = await setup()
    const created = await createLink(app, apiKey, {
      mode: 'fixed', productId: 'cherito-coffee-001', title: 'Coffee', description: 'One coffee',
    })
    assert.equal(created.statusCode, 201)
    const link = created.json<{ id: string; slug: string }>()
    assert.match(link.slug, /^pl_[A-Za-z0-9_-]{32}$/)

    const resolved = await app.inject({ method: 'GET', url: `/v1/payment-links/${link.slug}` })
    assert.equal(resolved.statusCode, 200)
    assert.deepEqual(resolved.json(), {
      slug: link.slug,
      mode: 'fixed',
      title: 'Coffee',
      description: 'One coffee',
      expiresAt: null,
      amountSats: '25000',
    })
    assert.match(String(resolved.headers['x-robots-tag']), /noindex/)

    const first = await app.inject({ method: 'POST', url: `/v1/payment-links/${link.slug}/payment-intents`, payload: {} })
    const second = await app.inject({ method: 'POST', url: `/v1/payment-links/${link.slug}/payment-intents`, payload: {} })
    assert.equal(first.statusCode, 201)
    assert.equal(second.statusCode, 201)
    assert.notEqual(first.json().id, second.json().id)
    assert.notEqual(first.json().paymentRequest, second.json().paymentRequest)
    assert.equal(provider.creates, 2)
    assert.equal(first.json().paymentHash, undefined)
    assert.equal(first.json().providerInvoiceId, undefined)

    const override = await app.inject({
      method: 'POST', url: `/v1/payment-links/${link.slug}/payment-intents`, payload: { amountSats: '1' },
    })
    assert.equal(override.statusCode, 400)
    assert.equal(override.json().code, 'FIXED_PRICE_OVERRIDE_DENIED')
  })

  test('open amount and donation bounds, note limits, and strict fields are enforced', async () => {
    const { app, apiKey } = await setup()
    const open = (await createLink(app, apiKey, {
      mode: 'open_amount', minAmountSats: '100', maxAmountSats: '500', title: 'Open',
    })).json<{ slug: string }>()
    const valid = await app.inject({
      method: 'POST', url: `/v1/payment-links/${open.slug}/payment-intents`, payload: { amountSats: '250' },
    })
    assert.equal(valid.statusCode, 201)
    assert.equal(valid.json().amountSats, '250')
    for (const [amount, code] of [['99', 'AMOUNT_BELOW_MINIMUM'], ['501', 'AMOUNT_ABOVE_MAXIMUM']]) {
      const response = await app.inject({
        method: 'POST', url: `/v1/payment-links/${open.slug}/payment-intents`, payload: { amountSats: amount },
      })
      assert.equal(response.statusCode, 400)
      assert.equal(response.json().code, code)
    }

    const donation = (await createLink(app, apiKey, {
      mode: 'donation', minAmountSats: '100', maxAmountSats: '500', title: 'Donate',
    })).json<{ slug: string }>()
    const note = '<img src=x onerror=SHOULD_NOT_EXECUTE>'.normalize('NFC')
    const accepted = await app.inject({
      method: 'POST', url: `/v1/payment-links/${donation.slug}/payment-intents`,
      payload: { amountSats: '200', payerNote: note },
    })
    assert.equal(accepted.statusCode, 201)
    const oversized = await app.inject({
      method: 'POST', url: `/v1/payment-links/${donation.slug}/payment-intents`,
      payload: { amountSats: '200', payerNote: 'é'.repeat(251) },
    })
    assert.equal(oversized.statusCode, 400)
    const tamper = await app.inject({
      method: 'POST', url: `/v1/payment-links/${donation.slug}/payment-intents`,
      payload: { amountSats: '200', merchantOrderId: 'attacker', pricingRuleId: 'attacker' },
    })
    assert.equal(tamper.statusCode, 400)
    assert.equal(tamper.json().code, 'INVALID_REQUEST')
  })

  test('disable, expiry, slug rotation, idempotency, and non-enumerating tenant scope', async () => {
    const { app, apiKey, config } = await setup()
    const key = crypto.randomUUID()
    const payload = { mode: 'open_amount', minAmountSats: '10', maxAmountSats: '20', title: 'Limited' }
    const first = await app.inject({ method: 'POST', url: '/v1/payment-links', headers: {
      authorization: `Bearer ${apiKey}`, 'idempotency-key': key,
    }, payload })
    const retry = await app.inject({ method: 'POST', url: '/v1/payment-links', headers: {
      authorization: `Bearer ${apiKey}`, 'idempotency-key': key,
    }, payload })
    assert.equal(retry.json().id, first.json().id)
    const conflict = await app.inject({ method: 'POST', url: '/v1/payment-links', headers: {
      authorization: `Bearer ${apiKey}`, 'idempotency-key': key,
    }, payload: { ...payload, title: 'Changed' } })
    assert.equal(conflict.statusCode, 409)

    const id = first.json().id as string
    const oldSlug = first.json().slug as string
    const rotated = await app.inject({
      method: 'POST', url: `/v1/payment-links/${id}/rotate-slug`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: {},
    })
    assert.equal(rotated.statusCode, 200)
    assert.notEqual(rotated.json().slug, oldSlug)
    assert.equal((await app.inject({ method: 'GET', url: `/v1/payment-links/${oldSlug}` })).statusCode, 404)
    const disabled = await app.inject({
      method: 'POST', url: `/v1/payment-links/${id}/disable`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: {},
    })
    assert.equal(disabled.statusCode, 200)
    assert.equal((await app.inject({
      method: 'POST', url: `/v1/payment-links/${rotated.json().slug}/payment-intents`, payload: { amountSats: '15' },
    })).statusCode, 404)
    const repo = new PaymentIntentRepository(
      config.DATABASE_URL,
      new PaymentIntentSecretCipher(KEY),
    )
    const secondTenantService = new TenantService(repo, new ApiKeyService(repo))
    const second = await secondTenantService.createTenant({ name: 'Second Merchant' })
    repo.close()
    const secondLink = await app.inject({
      method: 'POST', url: '/v1/payment-links',
      headers: { authorization: `Bearer ${second.apiKey}`, 'idempotency-key': key },
      payload,
    })
    assert.equal(secondLink.statusCode, 201)
    assert.notEqual(secondLink.json().id, first.json().id)
    const crossTenantRead = await app.inject({
      method: 'GET', url: `/v1/payment-links/manage/${secondLink.json().id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    })
    assert.equal(crossTenantRead.statusCode, 404)
    const crossTenantMutation = await app.inject({
      method: 'POST', url: `/v1/payment-links/${secondLink.json().id}/disable`,
      headers: { authorization: `Bearer ${apiKey}` }, payload: {},
    })
    assert.equal(crossTenantMutation.statusCode, 404)

    const expired = await createLink(app, apiKey, {
      mode: 'open_amount', minAmountSats: '10', maxAmountSats: '20', title: 'Expired',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
    const expiredResponse = await app.inject({
      method: 'POST', url: `/v1/payment-links/${expired.json().slug}/payment-intents`, payload: { amountSats: '15' },
    })
    assert.equal(expiredResponse.statusCode, 410)
  })

  test('maxUses is concurrency safe and a provider failure releases capacity', async () => {
    const { app, apiKey, provider } = await setup()
    provider.delayMs = 30
    const limited = (await createLink(app, apiKey, {
      mode: 'open_amount', minAmountSats: '10', maxAmountSats: '20', maxUses: 1, title: 'Once',
    })).json<{ slug: string }>()
    const responses = await Promise.all([1, 2].map(() => app.inject({
      method: 'POST', url: `/v1/payment-links/${limited.slug}/payment-intents`, payload: { amountSats: '15' },
    })))
    assert.deepEqual(responses.map(({ statusCode }) => statusCode).sort(), [201, 409])

    provider.delayMs = 0
    provider.failNext = true
    const recoverable = (await createLink(app, apiKey, {
      mode: 'open_amount', minAmountSats: '10', maxAmountSats: '20', maxUses: 1, title: 'Recoverable',
    })).json<{ slug: string }>()
    const failed = await app.inject({
      method: 'POST', url: `/v1/payment-links/${recoverable.slug}/payment-intents`, payload: { amountSats: '15' },
    })
    assert.equal(failed.statusCode, 502)
    const recovered = await app.inject({
      method: 'POST', url: `/v1/payment-links/${recoverable.slug}/payment-intents`, payload: { amountSats: '15' },
    })
    assert.equal(recovered.statusCode, 201)
  })

  test('public creation uses distinct IP/link policies and rejects unknown management fields', async () => {
    const { app, apiKey } = await setup({ RATE_LIMIT_PAYMENT_LINK_CREATE_IP: '1' })
    const link = (await createLink(app, apiKey, {
      mode: 'open_amount', minAmountSats: '10', maxAmountSats: '20', title: 'Rate',
    })).json<{ slug: string }>()
    assert.equal((await app.inject({
      method: 'POST', url: `/v1/payment-links/${link.slug}/payment-intents`, payload: { amountSats: '15' },
    })).statusCode, 201)
    assert.equal((await app.inject({
      method: 'POST', url: `/v1/payment-links/${link.slug}/payment-intents`, payload: { amountSats: '15' },
    })).statusCode, 429)
    const unknown = await createLink(app, apiKey, {
      mode: 'fixed', productId: 'cherito-coffee-001', title: 'Bad', arbitrary: true,
    })
    assert.equal(unknown.statusCode, 400)
  })

  test('forwarded client IP is ignored unless its proxy is explicitly trusted', async () => {
    const untrusted = await setup({ RATE_LIMIT_PAYMENT_LINK_CREATE_IP: '1' })
    const firstLink = (await createLink(untrusted.app, untrusted.apiKey, {
      mode: 'open_amount', minAmountSats: '10', maxAmountSats: '20', title: 'Untrusted proxy',
    })).json<{ slug: string }>()
    const untrustedStatuses = []
    for (const forwarded of ['198.51.100.10', '198.51.100.11']) {
      untrustedStatuses.push((await untrusted.app.inject({
        method: 'POST', url: `/v1/payment-links/${firstLink.slug}/payment-intents`,
        headers: { 'x-forwarded-for': forwarded }, payload: { amountSats: '15' },
      })).statusCode)
    }
    assert.deepEqual(untrustedStatuses, [201, 429])

    const trusted = await setup({
      RATE_LIMIT_PAYMENT_LINK_CREATE_IP: '1',
      TRUST_PROXY: '127.0.0.1',
    })
    const secondLink = (await createLink(trusted.app, trusted.apiKey, {
      mode: 'open_amount', minAmountSats: '10', maxAmountSats: '20', title: 'Trusted proxy',
    })).json<{ slug: string }>()
    const trustedStatuses = []
    for (const forwarded of ['198.51.100.20', '198.51.100.21']) {
      trustedStatuses.push((await trusted.app.inject({
        method: 'POST', url: `/v1/payment-links/${secondLink.slug}/payment-intents`,
        headers: { 'x-forwarded-for': forwarded }, payload: { amountSats: '15' },
      })).statusCode)
    }
    assert.deepEqual(trustedStatuses, [201, 201])
  })

  test('authentication failures and malformed property cases are bounded and rejected', async () => {
    const { app, apiKey } = await setup({ RATE_LIMIT_AUTH_FAILURES: '1' })
    const firstAuth = await app.inject({
      method: 'GET', url: '/v1/payment-links', headers: { authorization: 'Bearer invalid-1' },
    })
    const secondAuth = await app.inject({
      method: 'GET', url: '/v1/payment-links', headers: { authorization: 'Bearer invalid-2' },
    })
    assert.equal(firstAuth.statusCode, 401)
    assert.equal(secondAuth.statusCode, 429)

    const invalidAmounts: unknown[] = [1, 1.5, -1, '', '1.0', '1e3', ' 10', '10 ', null, {}, []]
    for (const [index, amount] of invalidAmounts.entries()) {
      const response = await createLink(app, apiKey, {
        mode: 'open_amount', minAmountSats: amount, maxAmountSats: '100', title: `Fuzz ${index}`,
      })
      assert.equal(response.statusCode, 400, `amount case ${JSON.stringify(amount)}`)
    }
    for (let index = 0; index < 20; index += 1) {
      const unknownField = `unknown_${crypto.randomUUID().replaceAll('-', '')}`
      const response = await createLink(app, apiKey, {
        mode: 'fixed', productId: 'cherito-coffee-001', title: `Unknown ${index}`,
        [unknownField]: 'must be rejected',
      })
      assert.equal(response.statusCode, 400)
    }
    const oversizedBody = await app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': crypto.randomUUID(),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        mode: 'fixed', productId: 'cherito-coffee-001', title: 'Oversized',
        description: 'x'.repeat(20_000),
      }),
    })
    assert.equal(oversizedBody.statusCode, 413)
  })

  test('webhook management returns signing secrets once, rotates, and disables safely', async () => {
    const { app, apiKey } = await setup()
    const authorization = { authorization: `Bearer ${apiKey}` }
    const configured = await app.inject({
      method: 'PUT', url: '/v1/webhooks/config', headers: authorization,
      payload: { endpoint: 'http://127.0.0.1:65534/webhook' },
    })
    assert.equal(configured.statusCode, 200)
    const firstSecret = configured.json().signingSecret as string
    assert.match(firstSecret, /^[a-f0-9]{64}$/)

    const read = await app.inject({ method: 'GET', url: '/v1/webhooks/config', headers: authorization })
    assert.equal(read.statusCode, 200)
    assert.equal(read.json().signingSecret, undefined)
    assert.equal(JSON.stringify(read.json()).includes(firstSecret), false)

    const updated = await app.inject({
      method: 'PUT', url: '/v1/webhooks/config', headers: authorization,
      payload: { endpoint: 'http://127.0.0.1:65533/changed' },
    })
    assert.equal(updated.statusCode, 200)
    assert.equal(updated.json().signingSecret, undefined)

    const rotated = await app.inject({
      method: 'POST', url: '/v1/webhooks/rotate-secret', headers: authorization, payload: {},
    })
    assert.equal(rotated.statusCode, 200)
    assert.notEqual(rotated.json().signingSecret, firstSecret)

    const disabled = await app.inject({
      method: 'POST', url: '/v1/webhooks/disable', headers: authorization, payload: {},
    })
    assert.equal(disabled.statusCode, 200)
    assert.equal(disabled.json().enabled, false)
    const after = await app.inject({ method: 'GET', url: '/v1/webhooks/config', headers: authorization })
    assert.equal(after.json().enabled, false)
    assert.equal(after.json().signingSecret, undefined)
  })
})
