import { GATEWAY_URL, RECEIVER_URL } from './env.js'

export interface ApiResult<T> {
  status: number
  body: T
  text: string
  headers: Headers
}

export interface ApiOptions {
  method?: string
  apiKey?: string
  clientSecret?: string
  tenantId?: string
  idempotencyKey?: string
  body?: unknown
  rawBody?: string
  contentType?: string
}

export async function api<T = Record<string, unknown>>(
  path: string,
  options: ApiOptions = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {}
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`
  if (options.clientSecret) headers.authorization = `Bearer ${options.clientSecret}`
  if (options.tenantId) headers['x-cherito-tenant-id'] = options.tenantId
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey

  let payload: string | undefined
  if (options.rawBody !== undefined) {
    payload = options.rawBody
    headers['content-type'] = options.contentType ?? 'application/json'
  } else if (options.body !== undefined) {
    payload = JSON.stringify(options.body)
    headers['content-type'] = options.contentType ?? 'application/json'
  }

  const response = await fetch(`${GATEWAY_URL}${path}`, {
    method: options.method ?? (payload ? 'POST' : 'GET'),
    headers,
    body: payload,
  })

  const text = await response.text()
  let body: T
  try {
    body = text ? (JSON.parse(text) as T) : ({} as T)
  } catch {
    body = { raw: text } as unknown as T
  }
  return { status: response.status, body, text, headers: response.headers }
}

export interface PaymentIntentResponse {
  id: string
  tenantId: string
  status: string
  amountSats: string
  paymentHash: string
  paymentRequest: string
  clientSecret?: string
  settledAt?: string | null
  merchantOrderId?: string | null
  paymentLinkId?: string | null
  pricingRuleId?: string | null
  metadata?: Record<string, unknown> | null
  description?: string
  expiresAt?: string
}

export async function createPaymentIntent(
  apiKey: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<ApiResult<PaymentIntentResponse>> {
  return api<PaymentIntentResponse>('/v1/payment-intents', {
    method: 'POST',
    apiKey,
    idempotencyKey,
    body,
  })
}

export async function getMerchantIntent(
  apiKey: string,
  id: string,
): Promise<ApiResult<PaymentIntentResponse>> {
  return api<PaymentIntentResponse>(`/v1/payment-intents/${id}`, { apiKey })
}

export async function getClientStatus(
  tenantId: string,
  clientSecret: string,
  id: string,
): Promise<ApiResult<PaymentIntentResponse>> {
  return api<PaymentIntentResponse>(`/v1/payment-intents/${id}/status`, {
    tenantId,
    clientSecret,
  })
}

export async function configureWebhook(
  apiKey: string,
  endpoint: string,
): Promise<ApiResult<{ enabled: boolean; endpoint: string; signingSecret?: string }>> {
  return api('/v1/webhooks/config', { method: 'PUT', apiKey, body: { endpoint } })
}

export async function rotateWebhookSecret(
  apiKey: string,
): Promise<ApiResult<{ signingSecret: string; secretRotatedAt: string }>> {
  return api('/v1/webhooks/rotate-secret', { method: 'POST', apiKey, body: {} })
}

export async function failedDeliveries(
  apiKey: string,
): Promise<ApiResult<{ items: Array<Record<string, unknown>> }>> {
  return api('/v1/webhooks/deliveries/failed', { apiKey })
}

export async function health(): Promise<ApiResult<{ status: string }>> {
  return api('/health')
}

export interface ReceiverState {
  mode: string
  delayMs: number
  errorStatus: number
  deliveries: Array<{
    receivedAt: string
    eventId?: string
    deliveryId?: string
    headers: Record<string, string>
    rawBody: string
    accepted: boolean
    responseStatus: number
    signatureValid?: boolean
    signatureTimestamp?: number
    rejectionReason?: string
    duplicateEvent?: boolean
    fulfilled?: boolean
    eventType?: string
    paymentIntentId?: string
  }>
  rejections: Array<{ receivedAt: string; eventId?: string; reason: string }>
  fulfillments: Array<{
    paymentIntentId: string
    count: number
    firstFulfilledAt: string
    suppressedDuplicates?: number
    amountSats?: string
    settledAt?: string
  }>
}

export async function receiverState(): Promise<ReceiverState> {
  const response = await fetch(`${RECEIVER_URL}/__test/state`)
  if (!response.ok) throw new Error(`receiver state failed: ${response.status}`)
  return (await response.json()) as ReceiverState
}

export async function receiverPost(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${RECEIVER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw new Error(`receiver ${path} failed: ${response.status}`)
}

export async function receiverReset(): Promise<void> {
  await receiverPost('/__test/reset', {})
}

export async function receiverSetSecret(secret: string): Promise<void> {
  await receiverPost('/__test/secret', { secret })
}

export async function receiverSetMode(
  mode: 'ok' | 'outage',
  extra: { delayMs?: number; status?: number } = {},
): Promise<void> {
  await receiverPost('/__test/mode', { mode, ...extra })
}

export async function postRawWebhook(
  headers: Record<string, string>,
  rawBody: string,
): Promise<number> {
  const response = await fetch(`${RECEIVER_URL}/webhooks/cherito`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  })
  return response.status
}
