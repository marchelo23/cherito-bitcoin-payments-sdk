process.env.NODE_ENV = 'test'
import { test, describe, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebhookRepository } from '../src/persistence/webhook-repository.js'
import { PaymentIntentRepository } from '../src/persistence/payment-intent-repository.js'
import { PaymentIntentSecretCipher } from '../src/security/payment-intent-secret-cipher.js'
import { TenantRepository } from '../src/persistence/tenant-repository.js'
import { WebhookService } from '../src/services/webhook-service.js'
import { TenantService } from '../src/services/tenant-service.js'
import { ApiKeyService } from '../src/services/api-key-service.js'
import type { SafeLogger } from '../src/logging/safe-logger.js'

const setupCleanups: Array<() => void> = []

function setup(logger?: SafeLogger) {
  const directory = mkdtempSync(join(tmpdir(), 'cherito-webhook-test-'))
  const dbFile = `file:${join(directory, 'webhooks.sqlite')}`
  const webhookRepo = new WebhookRepository(dbFile)
  const tenantRepo = new TenantRepository(dbFile)
  const paymentIntentRepo = new PaymentIntentRepository(
    dbFile,
    new PaymentIntentSecretCipher(Buffer.alloc(32, 0x77).toString('base64')),
  )
  const webhookService = new WebhookService(webhookRepo, tenantRepo, logger)
  const apiKeyService = new ApiKeyService(tenantRepo as never)
  const tenantService = new TenantService(tenantRepo, apiKeyService)
  setupCleanups.push(() => {
    webhookRepo.close()
    tenantRepo.close()
    paymentIntentRepo.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const createTestIntent = (tenantId: string, id: string) => {
    const now = new Date().toISOString()
    const digest = createHash('sha256').update(id).digest('hex')
    paymentIntentRepo.createPaymentIntent({
      id,
      tenantId,
      merchantOrderId: null,
      pricingRuleId: null,
      paymentLinkId: null,
      amountSats: '1000',
      currency: 'SAT',
      description: 'Webhook test intent',
      metadata: null,
      status: 'requires_payment',
      paymentRequest: `lnbcrt_${digest}`,
      paymentHash: digest,
      providerInvoiceId: `provider_${digest}`,
      intentSecret: digest,
      clientSecretHash: digest,
      idempotencyKey: null,
      idempotencyPayloadHash: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      settledAt: null,
      createdAt: now,
      updatedAt: now,
    })
  }
  return { webhookRepo, webhookService, tenantService, createTestIntent }
}

describe('WebhookService', () => {
  afterEach(() => {
    mock.restoreAll()
    while (setupCleanups.length > 0) setupCleanups.pop()!()
  })

  test('SSRF-safe: blocks localhost, private IP, and metadata server', async () => {
    const { webhookRepo, webhookService, tenantService, createTestIntent } = setup()
    const { tenant } = await tenantService.createTenant({ name: 'SSRF Test' })
    tenantService.configureWebhookUrl(tenant.id, 'http://169.254.169.254/latest/meta-data/')
    tenantService.rotateWebhookSecret(tenant.id)

    const eventId = `evt_${randomUUID()}`
    createTestIntent(tenant.id, 'pi_123')
    webhookRepo.createEvent({
      id: eventId,
      tenantId: tenant.id,
      paymentIntentId: 'pi_123',
      type: 'payment_intent.succeeded',
      payload: '{"status":"ok"}',
      createdAt: new Date().toISOString()
    })

    const deliveryId = `wd_${randomUUID()}`
    webhookRepo.createDelivery({
      id: deliveryId,
      eventId,
      tenantId: tenant.id,
      status: 'pending',
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: new Date().toISOString(),
      deliveredAt: null,
      createdAt: new Date().toISOString()
    })

    // This flush should catch the SSRF error and schedule a retry (mark as failed)
    await webhookService.flush()
    
    const delivery = webhookRepo.delivery(tenant.id, deliveryId)
    assert.equal(delivery?.status, 'failed', 'Should fail due to SSRF protection')
  })

  test('provider failures are logged without webhook secrets, URLs, or exception text', async () => {
    const forbidden = 'SHOULD_NEVER_APPEAR_IN_LOGS_123'
    const records: string[] = []
    const write = (fields: Record<string, unknown>, message?: string) => {
      records.push(JSON.stringify({ fields, message }))
    }
    const logger: SafeLogger = {
      debug: write,
      info: write,
      warn: write,
      error: write,
      fatal: write,
    }
    const { webhookRepo, webhookService, tenantService, createTestIntent } = setup(logger)
    const { tenant } = await tenantService.createTenant({ name: 'Safe Log Test' })
    tenantService.configureWebhookUrl(tenant.id, 'http://127.0.0.1:65534/webhook')
    const withSecret = tenantService.rotateWebhookSecret(tenant.id)
    assert.ok(withSecret.webhookSecret)
    createTestIntent(tenant.id, 'pi_safe_log')
    const eventId = `evt_${randomUUID()}`
    webhookRepo.createEvent({
      id: eventId,
      tenantId: tenant.id,
      paymentIntentId: 'pi_safe_log',
      type: 'payment_intent.succeeded',
      payload: JSON.stringify({ note: forbidden }),
      createdAt: new Date().toISOString(),
    })
    webhookRepo.createDelivery({
      id: `wd_${randomUUID()}`,
      eventId,
      tenantId: tenant.id,
      status: 'pending',
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: new Date().toISOString(),
      deliveredAt: null,
      createdAt: new Date().toISOString(),
    })
    mock.method(globalThis, 'fetch', async () => {
      throw new Error(`${forbidden} http://127.0.0.1:65534/webhook`)
    })

    await webhookService.flush()

    const output = records.join('\n')
    assert.match(output, /WEBHOOK_DELIVERY_FAILED/)
    assert.doesNotMatch(output, new RegExp(forbidden))
    assert.doesNotMatch(output, /127\.0\.0\.1|webhookSecret|whsec_/)
  })

  test('tenant-configurable: config changes take effect on next flush', async () => {
    const { webhookRepo, webhookService, tenantService, createTestIntent } = setup()
    const { tenant } = await tenantService.createTenant({ name: 'Config Test' })
    
    const eventId = `evt_${randomUUID()}`
    createTestIntent(tenant.id, 'pi_abc')
    webhookRepo.createEvent({
      id: eventId,
      tenantId: tenant.id,
      paymentIntentId: 'pi_abc',
      type: 'payment_intent.succeeded',
      payload: '{"status":"ok"}',
      createdAt: new Date().toISOString()
    })

    const deliveryId = `wd_${randomUUID()}`
    webhookRepo.createDelivery({
      id: deliveryId,
      eventId,
      tenantId: tenant.id,
      status: 'pending',
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: new Date().toISOString(),
      deliveredAt: null,
      createdAt: new Date().toISOString()
    })

    // 1. Flush without config should permanently fail it (no URL)
    await webhookService.flush()
    assert.equal(webhookRepo.delivery(tenant.id, deliveryId)?.status, 'permanently_failed')
    
    // 2. We can configure and replay
    const server = await startTestServer()
    try {
      tenantService.configureWebhookUrl(tenant.id, `http://127.0.0.1:${server.port}/webhook`)
      tenantService.rotateWebhookSecret(tenant.id)
      
      await webhookService.replayEvent(tenant.id, eventId) // this creates a new delivery and flushes
      
      const deliveries = webhookRepo.pendingDeliveries()
      assert.equal(deliveries.length, 0, 'Should be delivered')
      assert.equal(server.requests.length, 1)
    } finally {
      server.close()
    }
  })

  test('signed and replay-resistant', async () => {
    const { webhookRepo, webhookService, tenantService, createTestIntent } = setup()
    const { tenant } = await tenantService.createTenant({ name: 'Sig Test' })
    const server = await startTestServer()
    
    try {
      tenantService.configureWebhookUrl(tenant.id, `http://127.0.0.1:${server.port}/webhook`)
      const tWithSecret = tenantService.rotateWebhookSecret(tenant.id)

      const eventId = `evt_${randomUUID()}`
      createTestIntent(tenant.id, 'pi_xyz')
      webhookRepo.createEvent({
        id: eventId,
        tenantId: tenant.id,
        paymentIntentId: 'pi_xyz',
        type: 'payment_intent.succeeded',
        payload: '{"some":"data"}',
        createdAt: new Date().toISOString()
      })

      const deliveryId = `wd_${randomUUID()}`
      webhookRepo.createDelivery({
        id: deliveryId,
        eventId,
        tenantId: tenant.id,
        status: 'pending',
        attemptCount: 0,
        lastAttemptAt: null,
        nextAttemptAt: new Date().toISOString(),
        deliveredAt: null,
        createdAt: new Date().toISOString()
      })

      await webhookService.flush()
      
      assert.equal(server.requests.length, 1)
      const capturedHeader = server.requests[0]!.headers['cherito-signature'] as string
      
      assert.ok(capturedHeader.includes('t='))
      assert.ok(capturedHeader.includes('v1='))
      
      const isValid = WebhookService.verify(tWithSecret.webhookSecret!, capturedHeader, '{"some":"data"}')
      assert.equal(isValid, true, 'Signature should be valid')
      
      const isInvalid = WebhookService.verify(tWithSecret.webhookSecret!, capturedHeader, '{"some":"tampered"}')
      assert.equal(isInvalid, false, 'Tampered payload should fail')
      
      // Test tolerance
      const parts = capturedHeader.split(',')
      const tPart = parts.find(p => p.startsWith('t='))!
      const t = parseInt(tPart.slice(2))
      
      const oldT = t - 600
      const oldV1 = createHmac('sha256', tWithSecret.webhookSecret!).update(`${oldT}.{"some":"data"}`).digest('hex')
      const oldHeader = `t=${oldT},v1=${oldV1}`
      
      const isOldValid = WebhookService.verify(tWithSecret.webhookSecret!, oldHeader, '{"some":"data"}')
      assert.equal(isOldValid, false, 'Replay outside of tolerance should fail')
      
      assert.equal(webhookRepo.delivery(tenant.id, deliveryId)?.status, 'delivered')
    } finally {
      server.close()
    }
  })
})

import * as http from 'node:http'

function startTestServer(): Promise<{ port: number, requests: http.IncomingMessage[], close: () => void }> {
  return new Promise((resolve) => {
    const requests: http.IncomingMessage[] = []
    const server = http.createServer((req, res) => {
      requests.push(req)
      res.writeHead(200)
      res.end('ok')
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as import('net').AddressInfo
      resolve({
        port: addr.port,
        requests,
        close: () => server.close()
      })
    })
  })
}
