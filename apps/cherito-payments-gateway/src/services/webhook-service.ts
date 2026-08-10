import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { TenantRepository } from '../persistence/tenant-repository.js'
import type { WebhookRepository, WebhookDelivery } from '../persistence/webhook-repository.js'
import { NOOP_SAFE_LOGGER, safeLog, type SafeLogger } from '../logging/safe-logger.js'
import { WebhookTransport } from './webhook-transport.js'

/** Maximum delivery attempts before a webhook is marked permanently failed */
const MAX_ATTEMPTS = 7
/** Exponential backoff delays in milliseconds */
const BACKOFF_DELAYS_MS = [1_000, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000]

export class WebhookService {
  private deliveryTimer: NodeJS.Timeout | undefined
  private lastSignatureTimestamp = 0

  constructor(
    private readonly webhookRepo: WebhookRepository,
    private readonly tenantRepo: TenantRepository,
    private readonly logger: SafeLogger = NOOP_SAFE_LOGGER,
    private readonly transport: WebhookTransport = new WebhookTransport(),
  ) {}

  async validateEndpoint(url: string): Promise<void> {
    await this.transport.validate(url)
  }

  /**
   * Minimal Payment Intent outbox integration. Configuration management stays
   * in the existing tenant/webhook services; this only records a deduplicated
   * terminal event and its first durable delivery.
   */
  enqueuePaymentIntentEvent(
    tenantId: string,
    paymentIntentId: string,
    type: string,
    payload: string,
  ): void {
    const tenant = this.tenantRepo.tenant(tenantId)
    if (!tenant?.webhookUrl || !tenant.webhookSecret) return
    const now = new Date().toISOString()
    const eventId = `we_${randomUUID()}`
    this.webhookRepo.createEventAndDeliveryIfAbsent(
      {
        id: eventId,
        tenantId,
        paymentIntentId,
        type,
        payload,
        createdAt: now,
      },
      {
        id: `wd_${randomUUID()}`,
        eventId,
        tenantId,
        status: 'pending',
        attemptCount: 0,
        lastAttemptAt: null,
        nextAttemptAt: now,
        deliveredAt: null,
        createdAt: now,
      },
    )
  }

  /**
   * Process all pending webhook deliveries that are due.
   */
  async flush(): Promise<void> {
    const deliveries = this.webhookRepo.pendingDeliveries()
    for (const delivery of deliveries) {
      await this.processDelivery(delivery)
    }
  }

  private async processDelivery(delivery: WebhookDelivery): Promise<void> {
    const tenant = this.tenantRepo.tenant(delivery.tenantId)
    const event = this.webhookRepo.event(delivery.tenantId, delivery.eventId)
    
    if (!tenant?.webhookUrl || !event) {
      this.webhookRepo.markPermanentlyFailed(delivery.tenantId, delivery.id)
      return
    }

    try {
      const timestamp = this.nextSignatureTimestamp()
      
      // Try the current secret first
      const secret = tenant.webhookSecret
      if (!secret) {
        this.webhookRepo.markPermanentlyFailed(delivery.tenantId, delivery.id)
        return
      }

      const signature = this.sign(secret, timestamp, event.payload)
      const headerValue = `t=${timestamp},v1=${signature}`

      const response = await this.transport.deliver(tenant.webhookUrl, event.payload, {
          'content-type': 'application/json',
          'cherito-signature': headerValue,
          'x-cherito-event-id': event.id,
          'x-cherito-delivery-id': delivery.id,
          'user-agent': 'Cherito-Webhook/1.0',
      })

      if (response.ok) {
        this.webhookRepo.markDelivered(delivery.tenantId, delivery.id)
      } else {
        this.scheduleRetry(delivery)
      }
    } catch {
      safeLog(this.logger, 'error', {
        event: 'webhook.delivery_failed',
        outcome: 'failure',
        errorCode: 'WEBHOOK_DELIVERY_FAILED',
        attemptCount: delivery.attemptCount + 1,
      }, 'webhook delivery failed')
      this.scheduleRetry(delivery)
    }
  }

  /**
   * Allows manual replay of a webhook event.
   * Creates a new delivery record tied to the same event ID.
   */
  async replayEvent(tenantId: string, eventId: string): Promise<void> {
    const event = this.webhookRepo.event(tenantId, eventId)
    if (!event) {
      throw Object.assign(new Error('Event not found'), { statusCode: 404, code: 'NOT_FOUND' })
    }
    
    const now = new Date().toISOString()
    const delivery: WebhookDelivery = {
      id: `wd_${randomUUID()}`,
      eventId: event.id,
      tenantId: event.tenantId,
      status: 'pending',
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: now,
      deliveredAt: null,
      createdAt: now,
    }
    
    this.webhookRepo.createDelivery(delivery)
    await this.flush()
  }

  async sendTestEvent(tenantId: string): Promise<void> {
    const tenant = this.tenantRepo.tenant(tenantId)
    if (!tenant?.webhookUrl || !tenant.webhookSecret) {
      throw Object.assign(new Error('Webhook is not configured'), {
        statusCode: 409,
        code: 'WEBHOOK_NOT_CONFIGURED',
      })
    }
    const timestamp = this.nextSignatureTimestamp()
    const eventId = `we_test_${randomUUID()}`
    const payload = JSON.stringify({ id: eventId, type: 'webhook.test', createdAt: new Date().toISOString() })
    const signature = this.sign(tenant.webhookSecret, timestamp, payload)
    const response = await this.transport.deliver(tenant.webhookUrl, payload, {
      'content-type': 'application/json',
      'cherito-signature': `t=${timestamp},v1=${signature}`,
      'x-cherito-event-id': eventId,
      'x-cherito-delivery-id': `wd_test_${randomUUID()}`,
      'user-agent': 'Cherito-Webhook/1.0',
    }).catch(() => {
      throw Object.assign(new Error('Webhook test delivery failed'), {
        statusCode: 502,
        code: 'WEBHOOK_DELIVERY_FAILED',
      })
    })
    if (!response.ok) {
      throw Object.assign(new Error('Webhook test delivery failed'), {
        statusCode: 502,
        code: 'WEBHOOK_DELIVERY_FAILED',
      })
    }
  }

  /** Start a background retry loop that runs every 30 seconds by default */
  startRetryLoop(intervalMs = 30_000): () => void {
    const timer = setInterval(() => void this.flush(), Math.max(100, intervalMs))
    this.deliveryTimer = timer
    return () => clearInterval(timer)
  }

  /**
   * Verify an incoming webhook signature (for use by SDK consumers).
   * Supports signature format: Cherito-Signature: t=<unix>,v1=<hex>
   */
  static verify(
    secret: string,
    signatureHeader: string,
    body: string | Buffer,
    toleranceSeconds = 300,
  ): boolean {
    const parts = signatureHeader.split(',')
    let t = 0
    let v1 = ''
    for (const part of parts) {
      if (part.startsWith('t=')) t = parseInt(part.slice(2), 10)
      else if (part.startsWith('v1=')) v1 = part.slice(3)
    }

    if (!t || !/^[a-f0-9]{64}$/i.test(v1)) return false
    if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false

    const expected = createHmac('sha256', secret)
      .update(String(t))
      .update('.')
      .update(body)
      .digest('hex')
    
    const a = Buffer.from(expected)
    const b = Buffer.from(v1)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  private sign(secret: string, timestamp: number, body: string): string {
    return createHmac('sha256', secret)
      .update(String(timestamp))
      .update('.')
      .update(body)
      .digest('hex')
  }

  private nextSignatureTimestamp(): number {
    const current = Math.floor(Date.now() / 1_000)
    this.lastSignatureTimestamp = Math.max(current, this.lastSignatureTimestamp + 1)
    return this.lastSignatureTimestamp
  }

  private scheduleRetry(delivery: WebhookDelivery): void {
    const attempt = delivery.attemptCount
    if (attempt >= MAX_ATTEMPTS) {
      this.webhookRepo.markPermanentlyFailed(delivery.tenantId, delivery.id)
      return
    }
    
    const baseDelayMs = BACKOFF_DELAYS_MS[attempt] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1]!
    // Add jitter up to 10% of base delay
    const jitter = Math.floor(Math.random() * baseDelayMs * 0.1)
    const delayMs = baseDelayMs + jitter
    
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString()
    this.webhookRepo.markFailed(delivery.tenantId, delivery.id, nextAttemptAt)
  }
}
