import Fastify from 'fastify'
import cors from '@fastify/cors'
import { z } from 'zod'
import { writeFile } from 'node:fs/promises'
import {
  LndRestProvider,
  LightningError,
  loadCredential,
  type Bolt12ReceiveProvider,
} from '@cherito/bitcoin-sdk'
import { loadConfig, type Config } from './config.js'
import { Repository } from './persistence/repository.js'
import { TenantRepository } from './persistence/tenant-repository.js'
import { PaymentService } from './services/payment-service.js'
import { PaymentIntentService } from './services/payment-intent-service.js'
import { ApiKeyService } from './services/api-key-service.js'
import { TenantService } from './services/tenant-service.js'
import { WebhookService } from './services/webhook-service.js'
import { LndkProvider } from './services/lndk-provider.js'
import type { PaymentIntent } from './persistence/repository.js'

// ---------------------------------------------------------------------------
// Request schema validators
// ---------------------------------------------------------------------------

const createIntentBody = z
  .object({
    productId: z.string().regex(/^[a-z0-9_-]{3,80}$/),
    quantity: z.number().int().min(1).max(100).optional().default(1),
    description: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: z.string().uuid().optional(),
  })
  .strict()

const offerBody = z
  .object({ productId: z.string().regex(/^[a-z0-9_-]{3,80}$/) })
  .strict()

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

const extractBearer = (header: unknown): string =>
  typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : ''

// ---------------------------------------------------------------------------
// Server builder
// ---------------------------------------------------------------------------

export async function buildServer(config: Config = loadConfig()): Promise<ReturnType<typeof Fastify>> {
  // ---- Credentials ---------------------------------------------------------
  const [cert, macaroon] = await Promise.all([
    loadCredential(config.LND_TLS_CERT_PATH, config.LND_TLS_CERT_BASE64, 'base64'),
    loadCredential(config.LND_MACAROON_PATH, config.LND_MACAROON_HEX, 'hex'),
  ])

  const lnd = new LndRestProvider({
    url: config.LND_REST_URL,
    tlsCertificate: cert,
    macaroon,
    timeoutMs: 8000,
  })

  let bolt12: Bolt12ReceiveProvider | undefined
  if (config.BOLT12_PROVIDER === 'lndk') {
    try {
      bolt12 = await LndkProvider.connect({
        url: config.LNDK_GRPC_URL!,
        certificatePath: config.LNDK_TLS_CERT_PATH!,
        macaroonPath: config.LNDK_MACAROON_PATH!,
      })
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          code: 'LNDK_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'LNDK unavailable',
        }),
      )
    }
  }

  // ---- Services ------------------------------------------------------------
  const repo = new Repository(config.DATABASE_URL)
  const tenantRepo = new TenantRepository(config.DATABASE_URL)
  const apiKeyService = new ApiKeyService(tenantRepo)
  const tenantService = new TenantService(tenantRepo, apiKeyService)
  const webhookService = new WebhookService(repo)

  const paymentIntentService = new PaymentIntentService(
    lnd,
    bolt12,
    repo,
    config,
    tenantService,
    webhookService,
  )

  // Legacy service (for backward-compatible /v1/checkout-sessions routes)
  const legacyPaymentService = new PaymentService(lnd, bolt12, repo, config)

  // ---- Bootstrap (first-run) -----------------------------------------------
  // If no tenants exist, create a default tenant and emit the API key.
  // This key is the only way to access the Payment Intent API.
  const tenants = repo['db'].prepare('SELECT COUNT(*) as count FROM tenants').get() as { count: number }
  if (tenants.count === 0) {
    const { tenant, apiKey } = await tenantService.createTenant({
      name: config.BOOTSTRAP_TENANT_NAME,
      apiKeyLabel: 'bootstrap',
    })
    const keyMessage = [
      '='.repeat(70),
      'CHERITO FIRST-RUN: Merchant API key (shown once — store securely)',
      `Tenant ID : ${tenant.id}`,
      `API Key   : ${apiKey}`,
      '='.repeat(70),
    ].join('\n')

    if (config.BOOTSTRAP_KEY_PATH) {
      await writeFile(config.BOOTSTRAP_KEY_PATH, `${apiKey}\n`, { mode: 0o600 })
      console.info(
        JSON.stringify({
          level: 'info',
          code: 'BOOTSTRAP_KEY_WRITTEN',
          path: config.BOOTSTRAP_KEY_PATH,
          tenantId: tenant.id,
          keyPrefix: apiKey.slice(0, 12),
        }),
      )
    } else {
      console.log(keyMessage)
    }

    // Seed the legacy "cherito-coffee-001" catalog entry for the default tenant
    tenantService.upsertPricingRule(tenant.id, {
      productId: 'cherito-coffee-001',
      mode: 'fixed',
      name: 'Cherito Specialty Coffee',
      description: 'A delightful specialty coffee',
      priceSats: '25000',
      maxQuantity: 10,
      offerEnabled: true,
    })
  }

  // ---- Recovery after restart ----------------------------------------------
  await paymentIntentService.recoverPendingIntents()

  // ---- Start background jobs ----------------------------------------------
  const stopReconciliation = paymentIntentService.startReconciliationLoop(60_000)
  const stopRetry = webhookService.startRetryLoop()

  // ---- Fastify setup -------------------------------------------------------
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: [
        'req.headers.authorization',
        'req.headers.grpc-metadata-macaroon',
        '*.macaroon',
        '*.certificate',
        '*.clientSecretHash',
        '*.client_secret_hash',
        '*.webhookSecret',
        '*.webhook_secret',
        '*.keyHash',
        '*.key_hash',
      ],
    },
    bodyLimit: 16_384,
    requestTimeout: 15_000,
  })

  app.addHook('onClose', async () => {
    stopRetry()
    stopReconciliation()
  })

  await app.register(cors, {
    origin: (origin, callback) => {
      const allowed = config.ALLOWED_ORIGINS.split(',').map((x) => x.trim())
      callback(null, !origin || allowed.includes(origin))
    },
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key'],
  })

  // Security headers on every response
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.headers({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    })
    return payload
  })

  // ---- Rate limiter (simple in-process) ------------------------------------
  type RateBucket = { start: number; count: number }
  const ipRates = new Map<string, RateBucket>()

  function checkRateLimit(ip: string): boolean {
    const now = Date.now()
    const bucket = ipRates.get(ip)
    if (!bucket || now - bucket.start >= 60_000) {
      ipRates.set(ip, { start: now, count: 1 })
      return true
    }
    if (++bucket.count > config.RATE_LIMIT_CREATE_INVOICE) return false
    return true
  }

  // ---- Middleware: Merchant API key auth -----------------------------------
  async function requireMerchantAuth(
    req: { headers: { authorization?: string } },
    reply: { code: (n: number) => { send: (body: unknown) => unknown } },
  ): Promise<{ tenantId: string } | undefined> {
    const raw = extractBearer(req.headers.authorization)
    const auth = apiKeyService.verify(raw)
    if (!auth) {
      reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
      return undefined
    }
    return auth
  }

  // =========================================================================
  // Routes
  // =========================================================================

  // ---- Health & info -------------------------------------------------------
  app.get('/health', async (_req, reply) => {
    try {
      await lnd.getNodeInfo()
      return { status: 'ok', lightning: 'connected', provider: 'lnd' }
    } catch {
      return reply.code(503).send({ status: 'degraded', lightning: 'disconnected', provider: 'lnd' })
    }
  })

  app.get('/v1/node', () => lnd.getNodeInfo())

  app.get('/v1/capabilities', async () => {
    const base = await lnd.getCapabilities()
    const extra = bolt12
      ? await bolt12.getCapabilities().catch(() => undefined)
      : undefined
    return { ...base, bolt12Receive: extra?.bolt12Receive === true }
  })

  // =========================================================================
  // Payment Intent API (v2 — merchant-authenticated)
  // =========================================================================

  /**
   * Create a Payment Intent.
   * Requires: Authorization: Bearer sk_live_...
   * The returned clientSecret is for the browser only — it cannot be reused
   * to create new intents.
   */
  app.post('/v1/payment-intents', async (req, reply) => {
    const auth = await requireMerchantAuth(req, reply)
    if (!auth) return

    if (!checkRateLimit(req.ip)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
    }

    const body = createIntentBody.parse(req.body)
    const idempotencyKey = (req.headers as Record<string, string>)['idempotency-key'] ?? body.idempotencyKey

    if (idempotencyKey && !z.string().uuid().safeParse(idempotencyKey).success) {
      return reply.code(400).send({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must be a UUID',
      })
    }

    const result = await paymentIntentService.create({
      tenantId: auth.tenantId,
      productId: body.productId,
      quantity: body.quantity,
      description: body.description,
      metadata: body.metadata as Record<string, unknown> | undefined,
      idempotencyKey,
    })

    return reply.code(201).send(result)
  })

  /**
   * Retrieve a Payment Intent (merchant view — includes full details).
   * Requires: Authorization: Bearer sk_live_...
   */
  app.get<{ Params: { id: string } }>(
    '/v1/payment-intents/:id',
    async (req, reply) => {
      const auth = await requireMerchantAuth(req, reply)
      if (!auth) return

      const intent = repo.paymentIntent(req.params.id, auth.tenantId)
      if (!intent) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Payment intent not found' })
      }
      return paymentIntentService.toPublic(intent)
    },
  )

  /**
   * SSE event stream for a Payment Intent.
   * Requires: Authorization: Bearer cs_... (client secret, scoped read-only token)
   * This endpoint is safe to call from the browser.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/payment-intents/:id/events',
    async (req, reply) => {
      // Client secret auth — browser-safe
      const clientSecret = extractBearer(req.headers.authorization)

      // We need the tenantId; read it from the intent record using a hash lookup
      // The intent exists if the payment hash exists; use a hash-agnostic lookup
      const allIntentRow = repo['db']
        .prepare('SELECT id, tenant_id FROM payment_intents WHERE id=?')
        .get(req.params.id) as { id: string; tenant_id: string } | undefined

      if (!allIntentRow) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Payment intent not found' })
      }

      const intent = paymentIntentService.authorize(
        req.params.id,
        allIntentRow.tenant_id,
        clientSecret,
      )
      if (!intent) {
        return reply.code(401).send({ code: 'INVALID_CLIENT_SECRET', message: 'Invalid client secret' })
      }

      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
      })

      const send = (value: PaymentIntent) =>
        reply.raw.write(
          `event: payment_intent.${value.status}\ndata: ${JSON.stringify(paymentIntentService.toPublic(value))}\n\n`,
        )

      send(intent)

      const remove = paymentIntentService.listen(intent.id, send)
      const ping = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000)
      req.raw.on('close', () => {
        remove()
        clearInterval(ping)
      })
    },
  )

  /**
   * Get the public view of a Payment Intent using a client secret.
   * Safe for browser polling (no SSE).
   */
  app.get<{ Params: { id: string } }>(
    '/v1/payment-intents/:id/status',
    async (req, reply) => {
      const clientSecret = extractBearer(req.headers.authorization)

      const allIntentRow = repo['db']
        .prepare('SELECT id, tenant_id FROM payment_intents WHERE id=?')
        .get(req.params.id) as { id: string; tenant_id: string } | undefined

      if (!allIntentRow) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Payment intent not found' })
      }

      const intent = paymentIntentService.authorize(
        req.params.id,
        allIntentRow.tenant_id,
        clientSecret,
      )
      if (!intent) {
        return reply.code(401).send({ code: 'INVALID_CLIENT_SECRET', message: 'Invalid client secret' })
      }

      return paymentIntentService.toPublic(intent)
    },
  )

  // =========================================================================
  // BOLT12 Offers
  // =========================================================================

  app.post('/v1/offers', async (req, reply) => {
    const auth = await requireMerchantAuth(req, reply)
    if (!auth) return

    const body = offerBody.parse(req.body)
    const rule = repo.pricingRule(auth.tenantId, body.productId)
    if (!rule?.active || !rule.offerEnabled) {
      return reply.code(404).send({ code: 'PRODUCT_NOT_FOUND', message: 'Product is not approved for Offers' })
    }
    if (!bolt12) {
      return reply.code(501).send({ code: 'BOLT12_NOT_CONFIGURED', message: 'BOLT12 is not configured' })
    }
    const caps = await bolt12.getCapabilities()
    if (!caps.bolt12Receive) {
      return reply.code(503).send({ code: 'LNDK_UNAVAILABLE', message: 'LNDK is unavailable' })
    }
    const offer = await bolt12.createOffer({
      productId: rule.productId,
      amountSats: BigInt(rule.priceSats!),
      description: rule.name,
    })
    repo.saveOffer(auth.tenantId, rule.productId, offer)
    return { offerId: offer.offerId, offer: offer.offer, amountSats: offer.amountSats.toString() }
  })

  // =========================================================================
  // Legacy: /v1/checkout-sessions (backward compatibility)
  // =========================================================================

  app.post('/v1/checkout-sessions', async (req, reply) => {
    if (!checkRateLimit(req.ip)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many checkout requests' })
    }

    const key = (req.headers as Record<string, string>)['idempotency-key']
    if (typeof key !== 'string' || !z.string().uuid().safeParse(key).success) {
      return reply.code(400).send({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'A UUID Idempotency-Key is required',
      })
    }

    const checkoutBody = z
      .object({
        productId: z.string().regex(/^[a-z0-9-]{3,80}$/),
        quantity: z.number().int().min(1).max(10),
      })
      .strict()

    const input = checkoutBody.parse(req.body)

    // Map to the legacy service for backward compatibility
    const result = await legacyPaymentService.create(input.productId, input.quantity, key)
    return reply.code(201).send(result)
  })

  app.get<{ Params: { id: string } }>(
    '/v1/checkout-sessions/:id',
    async (req, reply) => {
      const s = legacyPaymentService.authorize(
        req.params.id,
        extractBearer(req.headers.authorization),
      )
      return s
        ? legacyPaymentService.public(s)
        : reply.code(401).send({ code: 'INVALID_STATUS_TOKEN', message: 'Invalid status token' })
    },
  )

  app.get<{ Params: { id: string } }>(
    '/v1/checkout-sessions/:id/events',
    async (req, reply) => {
      const s = legacyPaymentService.authorize(
        req.params.id,
        extractBearer(req.headers.authorization),
      )
      if (!s) {
        return reply.code(401).send({ code: 'INVALID_STATUS_TOKEN', message: 'Invalid status token' })
      }

      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
      })

      const send = (value: typeof s) =>
        reply.raw.write(
          `event: invoice.${value.state}\ndata: ${JSON.stringify({
            checkoutSessionId: value.id,
            orderId: value.orderId,
            state: value.state,
            expiresAt: value.expiresAt,
          })}\n\n`,
        )

      send(s)
      const remove = legacyPaymentService.listen(s.id, send)
      const ping = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000)
      req.raw.on('close', () => {
        remove()
        clearInterval(ping)
      })
    },
  )

  // =========================================================================
  // Error handler
  // =========================================================================

  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number; code?: string }
    const status =
      e.statusCode ??
      (error instanceof z.ZodError ? 400 : error instanceof LightningError ? 502 : 500)

    req.log.error({ code: e.code ?? 'INTERNAL_ERROR', message: e.message }, 'request failed')

    reply.code(status).send({
      code: e.code ?? 'INTERNAL_ERROR',
      message: status === 500 ? 'Internal server error' : e.message,
      requestId: req.id,
    })
  })

  return app
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV !== 'test') {
  const config = loadConfig()
  buildServer(config)
    .then((app) => app.listen({ port: config.PORT, host: config.HOST }))
    .catch((error) => {
      console.error(
        JSON.stringify({
          level: 'fatal',
          message: error instanceof Error ? error.message : 'Startup failed',
        }),
      )
      process.exitCode = 1
    })
}
