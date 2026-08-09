import { test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  CreateInvoiceInput,
  LightningInvoice,
  LightningReceiveProvider,
} from '@cherito/bitcoin-sdk'
import { BoundedLightningProvider } from '../src/services/bounded-lightning-provider.js'
import { InMemoryRateLimiter, SseConnectionLimiter } from '../src/services/rate-limiter.js'

test('rate-limit policies are isolated and reset deterministically', () => {
  let now = 1_000
  const limiter = new InMemoryRateLimiter(() => now)
  const publicPolicy = { name: 'public-link', limit: 2, windowMs: 1_000 }
  const authPolicy = { name: 'auth-failure', limit: 1, windowMs: 1_000 }
  assert.equal(limiter.consume(publicPolicy, 'ip-a'), true)
  assert.equal(limiter.consume(publicPolicy, 'ip-a'), true)
  assert.equal(limiter.consume(publicPolicy, 'ip-a'), false)
  assert.equal(limiter.consume(publicPolicy, 'ip-b'), true)
  assert.equal(limiter.consume(authPolicy, 'ip-a'), true)
  assert.equal(limiter.consume(authPolicy, 'ip-a'), false)
  now += 1_001
  assert.equal(limiter.consume(publicPolicy, 'ip-a'), true)
})

test('provider concurrency and queue limits reject excess work without unbounded promises', async () => {
  const releases: Array<() => void> = []
  let active = 0
  let maximumActive = 0
  let sequence = 0
  const provider: LightningReceiveProvider = {
    providerType: 'lnd',
    async getCapabilities() {
      return { provider: 'lnd', bolt11Receive: true, bolt12Receive: false, invoiceStreaming: false }
    },
    async getNodeInfo() { return { network: 'regtest' } },
    async createInvoice(input: CreateInvoiceInput) {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      sequence += 1
      return {
        providerInvoiceId: `invoice_${sequence}`,
        paymentHash: sequence.toString(16).padStart(64, '0'),
        paymentRequest: `lnbcrt_${sequence}`,
        amountSats: input.amountSats,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'pending' as const,
      }
    },
    async getInvoice(): Promise<LightningInvoice> { throw new Error('unused') },
    async subscribeToInvoice() { return async () => {} },
  }
  const bounded = new BoundedLightningProvider(provider, 1, 1)
  const input = { orderId: 'order', amountSats: 1n, memo: 'test', expirySeconds: 60 }
  const first = bounded.createInvoice(input)
  const second = bounded.createInvoice(input)
  await assert.rejects(
    bounded.createInvoice(input),
    (error: unknown) => (error as { statusCode?: number; code?: string }).statusCode === 503
      && (error as { code?: string }).code === 'SERVICE_UNAVAILABLE',
  )
  releases.shift()!()
  await first
  await new Promise((resolve) => setImmediate(resolve))
  releases.shift()!()
  await second
  assert.equal(maximumActive, 1)
})

test('SSE limits are global, per tenant, and always recover capacity on idempotent release', () => {
  const limiter = new SseConnectionLimiter(2, 1)
  const releaseA = limiter.acquire('tenant-a')
  assert.ok(releaseA)
  assert.equal(limiter.acquire('tenant-a'), undefined)
  const releaseB = limiter.acquire('tenant-b')
  assert.ok(releaseB)
  assert.equal(limiter.acquire('tenant-c'), undefined)
  releaseA()
  releaseA()
  assert.ok(limiter.acquire('tenant-c'))
  releaseB()
})
