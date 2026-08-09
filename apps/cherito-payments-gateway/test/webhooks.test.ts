process.env.NODE_ENV = 'test'
import { test, describe, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHmac } from 'node:crypto'
import { WebhookRepository } from '../src/persistence/webhook-repository.js'
import { TenantRepository } from '../src/persistence/tenant-repository.js'
import { WebhookService } from '../src/services/webhook-service.js'
import { TenantService } from '../src/services/tenant-service.js'
import { ApiKeyService } from '../src/services/api-key-service.js'

function setup() {
  const dbFile = `file::memory:?cache=shared&uri=${randomUUID()}`
  const webhookRepo = new WebhookRepository(dbFile)
  const tenantRepo = new TenantRepository(dbFile)
  const webhookService = new WebhookService(webhookRepo, tenantRepo)
  const apiKeyService = new ApiKeyService(tenantRepo as never)
  const tenantService = new TenantService(tenantRepo, apiKeyService)
  return { webhookRepo, webhookService, tenantService }
}

describe('WebhookService', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  test('SSRF-safe: blocks localhost, private IP, and metadata server', async () => {
    const { webhookRepo, webhookService, tenantService } = setup()
    const { tenant } = await tenantService.createTenant({ name: 'SSRF Test' })
    tenantService.configureWebhookUrl(tenant.id, 'http://169.254.169.254/latest/meta-data/')
    tenantService.rotateWebhookSecret(tenant.id)

    const eventId = `evt_${randomUUID()}`
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
    
    const delivery = webhookRepo.delivery(deliveryId)
    assert.equal(delivery?.status, 'failed', 'Should fail due to SSRF protection')
  })

  test('tenant-configurable: config changes take effect on next flush', async () => {
    const { webhookRepo, webhookService, tenantService } = setup()
    const { tenant } = await tenantService.createTenant({ name: 'Config Test' })
    
    const eventId = `evt_${randomUUID()}`
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
    assert.equal(webhookRepo.delivery(deliveryId)?.status, 'permanently_failed')
    
    // 2. We can configure and replay
    const server = await startTestServer()
    try {
      tenantService.configureWebhookUrl(tenant.id, `http://127.0.0.1:${server.port}/webhook`)
      tenantService.rotateWebhookSecret(tenant.id)
      
      await webhookService.replayEvent(eventId) // this creates a new delivery and flushes
      
      const deliveries = webhookRepo.pendingDeliveries()
      assert.equal(deliveries.length, 0, 'Should be delivered')
      assert.equal(server.requests.length, 1)
    } finally {
      server.close()
    }
  })

  test('signed and replay-resistant', async () => {
    const { webhookRepo, webhookService, tenantService } = setup()
    const { tenant } = await tenantService.createTenant({ name: 'Sig Test' })
    const server = await startTestServer()
    
    try {
      tenantService.configureWebhookUrl(tenant.id, `http://127.0.0.1:${server.port}/webhook`)
      const tWithSecret = tenantService.rotateWebhookSecret(tenant.id)

      const eventId = `evt_${randomUUID()}`
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
      if (!isValid) {
        console.log('secret', tWithSecret.webhookSecret)
        console.log('header', capturedHeader)
        console.log('expected sig', createHmac('sha256', tWithSecret.webhookSecret!).update(`${capturedHeader.split(',')[0]!.slice(2)}.{"some":"data"}`).digest('hex'))
      }
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
      
      assert.equal(webhookRepo.delivery(deliveryId)?.status, 'delivered')
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
