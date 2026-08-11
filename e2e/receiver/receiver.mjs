import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'

const PORT = Number(process.env.PORT ?? 4000)
const TOLERANCE_SECONDS = 300
const TERMINAL_FULFILLMENT_TYPE = 'payment_intent.succeeded'

const state = {
  secret: '',
  mode: 'ok',
  delayMs: 0,
  errorStatus: 503,
  deliveries: [],
  rejections: [],
  fulfillments: new Map(),
  seenEventIds: new Set(),
}

function reset() {
  state.mode = 'ok'
  state.delayMs = 0
  state.errorStatus = 503
  state.deliveries = []
  state.rejections = []
  state.fulfillments = new Map()
  state.seenEventIds = new Set()
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function parseSignature(header) {
  if (typeof header !== 'string') return undefined
  let timestamp = 0
  let digest = ''
  for (const part of header.split(',')) {
    const trimmed = part.trim()
    if (trimmed.startsWith('t=')) timestamp = Number.parseInt(trimmed.slice(2), 10)
    else if (trimmed.startsWith('v1=')) digest = trimmed.slice(3)
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined
  if (!/^[a-f0-9]{64}$/i.test(digest)) return undefined
  return { timestamp, digest }
}

function verifySignature(secret, header, rawBody) {
  const parsed = parseSignature(header)
  if (!parsed) return { valid: false, reason: 'MALFORMED_SIGNATURE' }
  if (!secret) return { valid: false, reason: 'NO_SECRET_CONFIGURED' }

  const skew = Math.abs(Date.now() / 1000 - parsed.timestamp)
  if (skew > TOLERANCE_SECONDS) {
    return { valid: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE', skew }
  }

  const expected = createHmac('sha256', secret)
    .update(String(parsed.timestamp))
    .update('.')
    .update(rawBody)
    .digest('hex')

  const a = Buffer.from(expected)
  const b = Buffer.from(parsed.digest)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'SIGNATURE_MISMATCH' }
  }
  return { valid: true, timestamp: parsed.timestamp }
}

function json(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function snapshot() {
  return {
    mode: state.mode,
    delayMs: state.delayMs,
    errorStatus: state.errorStatus,
    deliveries: state.deliveries,
    rejections: state.rejections,
    fulfillments: [...state.fulfillments.entries()].map(([paymentIntentId, record]) => ({
      paymentIntentId,
      ...record,
    })),
  }
}

async function handleWebhook(request, response) {
  const rawBody = await readBody(request)
  const headers = { ...request.headers }
  delete headers.authorization
  const eventId = request.headers['x-cherito-event-id']
  const deliveryId = request.headers['x-cherito-delivery-id']
  const receivedAt = new Date().toISOString()

  if (state.delayMs > 0) {
    await new Promise((done) => setTimeout(done, state.delayMs))
  }

  if (state.mode === 'outage') {
    state.deliveries.push({
      receivedAt,
      eventId,
      deliveryId,
      headers,
      rawBody: rawBody.toString('utf8'),
      accepted: false,
      responseStatus: state.errorStatus,
      signatureValid: undefined,
    })
    return json(response, state.errorStatus, { error: 'simulated outage' })
  }

  const verification = verifySignature(state.secret, request.headers['cherito-signature'], rawBody)

  if (!verification.valid) {
    state.rejections.push({ receivedAt, eventId, deliveryId, reason: verification.reason })
    state.deliveries.push({
      receivedAt,
      eventId,
      deliveryId,
      headers,
      rawBody: rawBody.toString('utf8'),
      accepted: false,
      responseStatus: 401,
      signatureValid: false,
      rejectionReason: verification.reason,
    })
    return json(response, 401, { code: 'INVALID_SIGNATURE', reason: verification.reason })
  }

  let parsed
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    state.rejections.push({ receivedAt, eventId, deliveryId, reason: 'MALFORMED_JSON' })
    return json(response, 400, { code: 'MALFORMED_JSON' })
  }

  const duplicateEvent = typeof eventId === 'string' && state.seenEventIds.has(eventId)
  if (typeof eventId === 'string') state.seenEventIds.add(eventId)

  const eventType = request.headers['x-cherito-event-type'] ?? `payment_intent.${parsed.status}`
  const paymentIntentId = parsed.id

  let fulfilled = false
  if (
    !duplicateEvent
    && eventType === TERMINAL_FULFILLMENT_TYPE
    && typeof paymentIntentId === 'string'
    && !state.fulfillments.has(paymentIntentId)
  ) {
    state.fulfillments.set(paymentIntentId, {
      count: 1,
      firstFulfilledAt: receivedAt,
      eventId,
      amountSats: parsed.amountSats,
      settledAt: parsed.settledAt,
      tenantId: parsed.tenantId,
    })
    fulfilled = true
  } else if (
    eventType === TERMINAL_FULFILLMENT_TYPE
    && typeof paymentIntentId === 'string'
    && state.fulfillments.has(paymentIntentId)
  ) {
    const record = state.fulfillments.get(paymentIntentId)
    record.suppressedDuplicates = (record.suppressedDuplicates ?? 0) + 1
  }

  state.deliveries.push({
    receivedAt,
    eventId,
    deliveryId,
    headers,
    rawBody: rawBody.toString('utf8'),
    accepted: true,
    responseStatus: 200,
    signatureValid: true,
    signatureTimestamp: verification.timestamp,
    duplicateEvent,
    fulfilled,
    eventType,
    paymentIntentId,
  })

  return json(response, 200, { received: true })
}

async function handleTestRoute(request, response, path) {
  if (path === '/__test/health' && request.method === 'GET') {
    return json(response, 200, { status: 'ok' })
  }

  if (path === '/__test/state' && request.method === 'GET') {
    return json(response, 200, snapshot())
  }

  if (path === '/__test/reset' && request.method === 'POST') {
    await readBody(request)
    reset()
    return json(response, 200, { reset: true })
  }

  if (path === '/__test/secret' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
    state.secret = typeof body.secret === 'string' ? body.secret : ''
    return json(response, 200, { configured: state.secret.length > 0 })
  }

  if (path === '/__test/mode' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
    if (['ok', 'outage'].includes(body.mode)) state.mode = body.mode
    if (Number.isFinite(body.delayMs)) state.delayMs = Math.max(0, Math.trunc(body.delayMs))
    if (Number.isFinite(body.status)) state.errorStatus = Math.trunc(body.status)
    return json(response, 200, { mode: state.mode, delayMs: state.delayMs, errorStatus: state.errorStatus })
  }

  return json(response, 404, { code: 'NOT_FOUND' })
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname

  const handler = path === '/webhooks/cherito' && request.method === 'POST'
    ? handleWebhook(request, response)
    : handleTestRoute(request, response, path)

  Promise.resolve(handler).catch(() => {
    if (!response.headersSent) json(response, 500, { code: 'RECEIVER_ERROR' })
  })
})

server.listen(PORT, '0.0.0.0')
