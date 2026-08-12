import { ApiError, kindForStatus } from './errors'
import type {
  ApiKeyMetadata,
  CreatePaymentLinkInput,
  GatewayCapabilities,
  GatewayHealth,
  MerchantPaymentIntent,
  NodeInfo,
  Page,
  PaymentIntentSummary,
  PaymentLink,
  WebhookConfig,
} from './types'

export interface Credentials {
  gatewayUrl: string
  apiKey: string
}

interface RequestOptions {
  method?: string
  body?: unknown
  authenticated?: boolean
  idempotencyKey?: string
}

export function normalizeGatewayUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Gateway URL must use http or https')
  }
  return trimmed
}

export class CheritoClient {
  constructor(private readonly credentials: Credentials) {}

  get gatewayUrl(): string {
    return this.credentials.gatewayUrl
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {}
    if (options.authenticated !== false) {
      headers.authorization = `Bearer ${this.credentials.apiKey}`
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey

    let response: Response
    try {
      response = await fetch(`${this.credentials.gatewayUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch {
      throw new ApiError('network')
    }

    const text = await response.text()
    let payload: unknown
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      payload = {}
    }

    if (!response.ok) {
      const code = (payload as { code?: string } | null)?.code
      throw new ApiError(kindForStatus(response.status, code), response.status)
    }
    return payload as T
  }

  async health(): Promise<GatewayHealth> {
    return this.request<GatewayHealth>('/health', { authenticated: false })
  }

  async capabilities(): Promise<GatewayCapabilities> {
    return this.request<GatewayCapabilities>('/v1/capabilities', { authenticated: false })
  }

  async node(): Promise<NodeInfo> {
    return this.request<NodeInfo>('/v1/node')
  }

  async paymentIntentSummary(): Promise<PaymentIntentSummary> {
    return this.request<PaymentIntentSummary>('/v1/payment-intents/summary')
  }

  async listPaymentIntents(options: { limit?: number; after?: string } = {}): Promise<Page<MerchantPaymentIntent>> {
    const query = new URLSearchParams()
    query.set('limit', String(options.limit ?? 25))
    if (options.after) query.set('after', options.after)
    return this.request<Page<MerchantPaymentIntent>>(`/v1/payment-intents?${query.toString()}`)
  }

  async listPaymentLinks(options: { limit?: number; after?: string } = {}): Promise<Page<PaymentLink>> {
    const query = new URLSearchParams()
    query.set('limit', String(options.limit ?? 25))
    if (options.after) query.set('after', options.after)
    return this.request<Page<PaymentLink>>(`/v1/payment-links?${query.toString()}`)
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink> {
    return this.request<PaymentLink>('/v1/payment-links', {
      method: 'POST',
      body: input,
      idempotencyKey: crypto.randomUUID(),
    })
  }

  async disablePaymentLink(id: string): Promise<PaymentLink> {
    return this.request<PaymentLink>(`/v1/payment-links/${encodeURIComponent(id)}/disable`, {
      method: 'POST',
      body: {},
    })
  }

  async rotatePaymentLinkSlug(id: string): Promise<PaymentLink> {
    return this.request<PaymentLink>(`/v1/payment-links/${encodeURIComponent(id)}/rotate-slug`, {
      method: 'POST',
      body: {},
    })
  }

  async webhookConfig(): Promise<WebhookConfig> {
    return this.request<WebhookConfig>('/v1/webhooks/config')
  }

  async setWebhookEndpoint(endpoint: string): Promise<{ enabled: boolean; endpoint: string; signingSecret?: string }> {
    return this.request('/v1/webhooks/config', { method: 'PUT', body: { endpoint } })
  }

  async disableWebhook(): Promise<{ enabled: boolean }> {
    return this.request('/v1/webhooks/disable', { method: 'POST', body: {} })
  }

  async rotateWebhookSecret(): Promise<{ signingSecret: string; secretRotatedAt: string }> {
    return this.request('/v1/webhooks/rotate-secret', { method: 'POST', body: {} })
  }

  async listApiKeys(): Promise<Page<ApiKeyMetadata>> {
    return this.request<Page<ApiKeyMetadata>>('/v1/api-keys?limit=100')
  }
}
