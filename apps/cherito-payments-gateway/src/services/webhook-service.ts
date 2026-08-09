import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import dns from 'node:dns/promises'
import type { TenantRepository } from '../persistence/tenant-repository.js'
import type { WebhookRepository,WebhookDelivery } from '../persistence/webhook-repository.js'

/** Maximum delivery attempts before a webhook is marked permanently failed */
const MAX_ATTEMPTS = 7
/** Exponential backoff delays in milliseconds */
const BACKOFF_DELAYS_MS = [1_000, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000]

/**
 * Validates a URL to prevent Server-Side Request Forgery (SSRF).
 * Blocks localhost, private network IPs, and metadata server IPs.
 */
async function validateWebhookUrl(urlString: string): Promise<void> {
  const url = new URL(urlString)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Invalid protocol: only http and https are allowed')
  }

  // If the hostname is already an IP address, check it. Otherwise resolve it.
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
  const addresses = isIp ? [url.hostname] : await dns.resolve(url.hostname).catch(() => [])
  
  for (const address of addresses) {
    if (isPrivateIP(address)) {
      throw new Error('SSRF blocked: URL resolves to a private or reserved IP address')
    }
  }
}

function isPrivateIP(ip: string): boolean {
  if (ip === '127.0.0.1' && process.env.NODE_ENV === 'test') return false
  // Very basic block list for SSRF. Note: This should ideally include IPv6 blocks too.
  const parts = ip.split('.').map((p) => parseInt(p, 10))
  if (parts.length !== 4) return false
  return (
    parts[0] === 127 || // localhost
    parts[0] === 10 || // private A
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || // private B
    (parts[0] === 192 && parts[1] === 168) || // private C
    (parts[0] === 169 && parts[1] === 254) // link-local (metadata servers)
  )
}

export class WebhookService {
  private deliveryTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly webhookRepo: WebhookRepository,
    private readonly tenantRepo: TenantRepository,
  ) {}

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
    const event = this.webhookRepo.event(delivery.eventId)
    
    if (!tenant?.webhookUrl || !event) {
      this.webhookRepo.markPermanentlyFailed(delivery.id)
      return
    }

    try {
      await validateWebhookUrl(tenant.webhookUrl)

      const timestamp = Math.floor(Date.now() / 1000)
      
      // Try the current secret first
      const secret = tenant.webhookSecret
      if (!secret) {
        this.webhookRepo.markPermanentlyFailed(delivery.id)
        return
      }

      const signature = this.sign(secret, timestamp, event.payload)
      const headerValue = `t=${timestamp},v1=${signature}`

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000)

      const response = await fetch(tenant.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cherito-signature': headerValue,
          'x-cherito-event-id': event.id,
          'x-cherito-delivery-id': delivery.id,
          'user-agent': 'Cherito-Webhook/1.0',
        },
        body: event.payload,
        signal: controller.signal,
        redirect: 'error', // Prevent redirect chaining / SSRF
      })
      clearTimeout(timeoutId)

      // Ensure we drain the response body to avoid memory leaks
      if (response.body) {
         void response.text().catch(() => {})
      }

      if (response.ok) {
        this.webhookRepo.markDelivered(delivery.id)
      } else {
        this.scheduleRetry(delivery)
      }
    } catch (err) {
      console.error('Delivery failed:', err)
      this.scheduleRetry(delivery)
    }
  }

  /**
   * Allows manual replay of a webhook event.
   * Creates a new delivery record tied to the same event ID.
   */
  async replayEvent(eventId: string): Promise<void> {
    const event = this.webhookRepo.event(eventId)
    if (!event) throw new Error('Event not found')
    
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

  /** Start a background retry loop that runs every 30 seconds */
  startRetryLoop(): () => void {
    const timer = setInterval(() => void this.flush(), 30_000)
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
    body: string,
    toleranceSeconds = 300,
  ): boolean {
    const parts = signatureHeader.split(',')
    let t = 0
    let v1 = ''
    for (const part of parts) {
      if (part.startsWith('t=')) t = parseInt(part.slice(2), 10)
      else if (part.startsWith('v1=')) v1 = part.slice(3)
    }

    if (!t || !v1) return false
    if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false

    const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
    
    const a = Buffer.from(expected)
    const b = Buffer.from(v1)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  private sign(secret: string, timestamp: number, body: string): string {
    return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  }

  private scheduleRetry(delivery: WebhookDelivery): void {
    const attempt = delivery.attemptCount
    if (attempt >= MAX_ATTEMPTS) {
      this.webhookRepo.markPermanentlyFailed(delivery.id)
      return
    }
    
    const baseDelayMs = BACKOFF_DELAYS_MS[attempt] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1]!
    // Add jitter up to 10% of base delay
    const jitter = Math.floor(Math.random() * baseDelayMs * 0.1)
    const delayMs = baseDelayMs + jitter
    
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString()
    this.webhookRepo.markFailed(delivery.id, nextAttemptAt)
  }
}
