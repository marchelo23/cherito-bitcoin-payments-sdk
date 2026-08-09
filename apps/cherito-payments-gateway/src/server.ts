import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { z } from 'zod'
import { writeFile } from 'node:fs/promises'
import {
  LndRestProvider,
  LightningError,
  loadCredential,
  type Bolt12ReceiveProvider,
  type LightningReceiveProvider,
} from '@cherito/bitcoin-sdk'
import { loadConfig, type Config } from './config.js'
import { Repository } from './persistence/repository.js'
import {
  PaymentIntentRepository,
  type PaymentIntent,
} from './persistence/payment-intent-repository.js'
import { WebhookRepository } from './persistence/webhook-repository.js'
import { PaymentService } from './services/payment-service.js'
import { PaymentIntentService } from './services/payment-intent-service.js'
import { ApiKeyService } from './services/api-key-service.js'
import { TenantService } from './services/tenant-service.js'
import { WebhookService } from './services/webhook-service.js'
import { LndkProvider } from './services/lndk-provider.js'
import { PaymentIntentSecretCipher } from './security/payment-intent-secret-cipher.js'

const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/
const TENANT_ID = /^tnt_[0-9a-f-]{36}$/

const createIntentBody = z
  .object({
    amountSats: z.string().regex(/^\d+$/, 'amountSats must be a decimal integer string').optional(),
    productId: z.string().regex(PRODUCT_ID).optional(),
    pricingRuleId: z.string().min(1).max(100).optional(),
    quantity: z.number().int().min(1).max(100).optional(),
    merchantOrderId: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const sources = Number(value.amountSats !== undefined)
      + Number(value.productId !== undefined)
      + Number(value.pricingRuleId !== undefined)
    if (sources !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Provide exactly one of amountSats, productId, or pricingRuleId',
      })
    }
  })

const checkoutBody = z
  .object({
    productId: z.string().regex(/^[a-z0-9-]{3,80}$/),
    quantity: z.number().int().min(1).max(10),
  })
  .strict()

const offerBody = z.object({ productId: z.string().regex(/^[a-z0-9-]{3,80}$/) }).strict()

const extractBearer = (header: unknown): string =>
  typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : ''

export interface BuildServerDependencies {
  lnd?: LightningReceiveProvider
  bolt12?: Bolt12ReceiveProvider
  startBackgroundJobs?: boolean
}

export async function buildServer(
  config: Config = loadConfig(),
  dependencies: BuildServerDependencies = {},
): Promise<FastifyInstance> {
  let lnd = dependencies.lnd
  if (!lnd) {
    const [certificate, macaroon] = await Promise.all([
      loadCredential(config.LND_TLS_CERT_PATH, config.LND_TLS_CERT_BASE64, 'base64'),
      loadCredential(config.LND_MACAROON_PATH, config.LND_MACAROON_HEX, 'hex'),
    ])
    lnd = new LndRestProvider({
      url: config.LND_REST_URL,
      tlsCertificate: certificate,
      macaroon,
      timeoutMs: 8_000,
    })
  }

  let bolt12 = dependencies.bolt12
  if (!bolt12 && config.BOLT12_PROVIDER === 'lndk') {
    try {
      bolt12 = await LndkProvider.connect({
        url: config.LNDK_GRPC_URL!,
        certificatePath: config.LNDK_TLS_CERT_PATH!,
        macaroonPath: config.LNDK_MACAROON_PATH!,
      })
    } catch (error) {
      console.warn(JSON.stringify({
        level: 'warn',
        code: 'LNDK_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'LNDK unavailable',
      }))
    }
  }

  const intentSecretCipher = new PaymentIntentSecretCipher(
    config.CHERITO_INTENT_SECRET_KEY,
    config.CHERITO_INTENT_SECRET_PREVIOUS_KEYS,
  )
  const paymentIntentRepo = new PaymentIntentRepository(
    config.DATABASE_URL,
    intentSecretCipher,
    config.SQLITE_BUSY_TIMEOUT_MS,
    config.DATABASE_BACKUP_DIR,
  )
  if (paymentIntentRepo.tenantCount() === 0 && !config.BOOTSTRAP_KEY_PATH) {
    paymentIntentRepo.close()
    throw new Error(
      'BOOTSTRAP_KEY_PATH is required when initializing an empty merchant database',
    )
  }
  const databaseOptions = {
    busyTimeoutMs: config.SQLITE_BUSY_TIMEOUT_MS,
    backupDirectory: config.DATABASE_BACKUP_DIR,
    intentSecretCipher,
  }
  const legacyRepo = new Repository(config.DATABASE_URL, databaseOptions)
  const webhookRepo = new WebhookRepository(config.DATABASE_URL, databaseOptions)
  const apiKeyService = new ApiKeyService(paymentIntentRepo)
  const tenantService = new TenantService(paymentIntentRepo, apiKeyService)
  const webhookService = new WebhookService(webhookRepo, paymentIntentRepo)
  const paymentIntentService = new PaymentIntentService(
    lnd,
    paymentIntentRepo,
    config,
    tenantService,
    webhookService,
    {
      recoveryConcurrency: config.PAYMENT_INTENT_RECOVERY_CONCURRENCY,
      reconciliationIntervalMs: config.PAYMENT_INTENT_RECONCILIATION_INTERVAL_MS,
      watcherRetryBaseMs: config.PAYMENT_INTENT_WATCH_RETRY_BASE_MS,
      watcherRetryMaxMs: config.PAYMENT_INTENT_WATCH_RETRY_MAX_MS,
    },
  )
  const legacyPaymentService = new PaymentService(lnd, bolt12, legacyRepo, config)

  if (paymentIntentRepo.tenantCount() === 0) {
    const { tenant, apiKey } = await tenantService.createTenant({
      name: config.BOOTSTRAP_TENANT_NAME,
      apiKeyLabel: 'bootstrap',
    })
    await writeFile(config.BOOTSTRAP_KEY_PATH!, `${apiKey}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    console.info(JSON.stringify({
      level: 'info',
      code: 'BOOTSTRAP_KEY_WRITTEN',
      path: config.BOOTSTRAP_KEY_PATH,
      tenantId: tenant.id,
    }))
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

  await paymentIntentService.recoverPendingIntents()

  let stopReconciliation = () => {}
  let stopWebhookRetry = () => {}
  if (dependencies.startBackgroundJobs !== false) {
    stopReconciliation = paymentIntentService.startReconciliationLoop()
    stopWebhookRetry = webhookService.startRetryLoop()
  }

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: [
        'req.headers.authorization',
        'req.headers.grpc-metadata-macaroon',
        '*.macaroon',
        '*.certificate',
        '*.clientSecret',
        '*.clientSecretHash',
        '*.intentSecret',
        '*.CHERITO_INTENT_SECRET_KEY',
        '*.CHERITO_INTENT_SECRET_PREVIOUS_KEYS',
        '*.webhookSecret',
        '*.keyHash',
      ],
    },
    bodyLimit: 16_384,
    requestTimeout: 15_000,
  })

  app.addHook('onClose', async () => {
    stopWebhookRetry()
    stopReconciliation()
    await paymentIntentService.shutdown()
    paymentIntentRepo.close()
    webhookRepo.close()
    legacyRepo.close()
  })

  await app.register(cors, {
    origin: (origin, callback) => {
      const allowed = config.ALLOWED_ORIGINS.split(',').map((value) => value.trim())
      callback(null, !origin || allowed.includes(origin))
    },
    methods: ['GET', 'POST'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'idempotency-key',
      'x-cherito-tenant-id',
    ],
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    })
    return payload
  })

  type RateBucket = { start: number; count: number }
  const ipRates = new Map<string, RateBucket>()
  const checkRateLimit = (ip: string): boolean => {
    const now = Date.now()
    const bucket = ipRates.get(ip)
    if (!bucket || now - bucket.start >= 60_000) {
      ipRates.set(ip, { start: now, count: 1 })
      return true
    }
    bucket.count += 1
    return bucket.count <= config.RATE_LIMIT_CREATE_INVOICE
  }

  const requireMerchantAuth = (
    authorization: string | undefined,
  ): { tenantId: string } | undefined => apiKeyService.verify(extractBearer(authorization))

  const requireClientIntent = (
    headers: Record<string, string | string[] | undefined>,
    intentId: string,
  ): PaymentIntent | undefined => {
    const tenantHeader = headers['x-cherito-tenant-id']
    const tenantId = typeof tenantHeader === 'string' ? tenantHeader : ''
    if (!TENANT_ID.test(tenantId)) return undefined
    return paymentIntentService.authorizeClient(
      tenantId,
      intentId,
      extractBearer(headers.authorization),
    )
  }

  app.get('/health', async (_request, reply) => {
    try {
      await lnd.getNodeInfo()
      return { status: 'ok', lightning: 'connected', provider: lnd.providerType }
    } catch {
      return reply.code(503).send({
        status: 'degraded',
        lightning: 'disconnected',
        provider: lnd.providerType,
      })
    }
  })

  app.get('/v1/node', () => lnd.getNodeInfo())
  app.get('/v1/capabilities', async () => {
    const base = await lnd.getCapabilities()
    const extra = bolt12 ? await bolt12.getCapabilities().catch(() => undefined) : undefined
    return { ...base, bolt12Receive: extra?.bolt12Receive === true }
  })

  app.post('/v1/payment-intents', async (request, reply) => {
    const auth = requireMerchantAuth(request.headers.authorization)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    if (!checkRateLimit(request.ip)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
    }
    const body = createIntentBody.parse(request.body)
    const idempotencyHeader = request.headers['idempotency-key']
    const idempotencyKey = typeof idempotencyHeader === 'string' ? idempotencyHeader : undefined
    if (idempotencyKey && !z.string().uuid().safeParse(idempotencyKey).success) {
      return reply.code(400).send({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must be a UUID',
      })
    }
    const result = await paymentIntentService.create({
      tenantId: auth.tenantId,
      amountSats: body.amountSats === undefined ? undefined : BigInt(body.amountSats),
      productId: body.productId,
      pricingRuleId: body.pricingRuleId,
      quantity: body.quantity,
      merchantOrderId: body.merchantOrderId,
      description: body.description,
      metadata: body.metadata,
      idempotencyKey,
    })
    return reply.code(201).send(result)
  })

  app.get<{ Params: { id: string } }>('/v1/payment-intents/:id', async (request, reply) => {
    const auth = requireMerchantAuth(request.headers.authorization)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    const intent = paymentIntentService.getMerchantIntent(auth.tenantId, request.params.id)
    return intent ?? reply.code(404).send({ code: 'NOT_FOUND', message: 'Payment intent not found' })
  })

  app.get<{ Params: { id: string } }>(
    '/v1/payment-intents/:id/status',
    async (request, reply) => {
      const intent = requireClientIntent(request.headers, request.params.id)
      if (!intent) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Payment intent not found' })
      }
      return paymentIntentService.toClient(intent)
    },
  )

  app.get<{ Params: { id: string } }>(
    '/v1/payment-intents/:id/events',
    async (request, reply) => {
      const intent = requireClientIntent(request.headers, request.params.id)
      if (!intent) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Payment intent not found' })
      }
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
      })
      const send = (value: PaymentIntent) => reply.raw.write(
        `event: payment_intent.${value.status}\ndata: ${JSON.stringify(paymentIntentService.toClient(value))}\n\n`,
      )
      send(intent)
      const remove = paymentIntentService.listen(intent.id, send)
      const ping = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000)
      request.raw.on('close', () => {
        remove()
        clearInterval(ping)
      })
    },
  )

  // Existing APIs remain deliberately unchanged while callers migrate.
  app.post('/v1/checkout-sessions', async (request, reply) => {
    if (!checkRateLimit(request.ip)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many checkout requests' })
    }
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || !z.string().uuid().safeParse(key).success) {
      return reply.code(400).send({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'A UUID Idempotency-Key is required',
      })
    }
    const input = checkoutBody.parse(request.body)
    return reply.code(201).send(await legacyPaymentService.create(input.productId, input.quantity, key))
  })

  app.get<{ Params: { id: string } }>('/v1/checkout-sessions/:id', async (request, reply) => {
    const session = legacyPaymentService.authorize(
      request.params.id,
      extractBearer(request.headers.authorization),
    )
    return session
      ? legacyPaymentService.public(session)
      : reply.code(401).send({ code: 'INVALID_STATUS_TOKEN', message: 'Invalid status token' })
  })

  app.get<{ Params: { id: string } }>(
    '/v1/checkout-sessions/:id/events',
    async (request, reply) => {
      const session = legacyPaymentService.authorize(
        request.params.id,
        extractBearer(request.headers.authorization),
      )
      if (!session) {
        return reply.code(401).send({
          code: 'INVALID_STATUS_TOKEN',
          message: 'Invalid status token',
        })
      }
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
      })
      const send = (value: typeof session) => reply.raw.write(
        `event: invoice.${value.state}\ndata: ${JSON.stringify({
          checkoutSessionId: value.id,
          orderId: value.orderId,
          state: value.state,
          expiresAt: value.expiresAt,
        })}\n\n`,
      )
      send(session)
      const remove = legacyPaymentService.listen(session.id, send)
      const ping = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000)
      request.raw.on('close', () => {
        remove()
        clearInterval(ping)
      })
    },
  )

  app.post('/v1/offers', async (request) => {
    const input = offerBody.parse(request.body)
    return legacyPaymentService.createOffer(input.productId)
  })

  app.setErrorHandler((error, request, reply) => {
    const typed = error as Error & { statusCode?: number; code?: string }
    const status = typed.statusCode
      ?? (error instanceof z.ZodError ? 400 : error instanceof LightningError ? 502 : 500)
    request.log.error(
      { code: typed.code ?? 'INTERNAL_ERROR', message: typed.message },
      'request failed',
    )
    reply.code(status).send({
      code: typed.code ?? 'INTERNAL_ERROR',
      message: status === 500 ? 'Internal server error' : typed.message,
      requestId: request.id,
    })
  })

  return app
}

if (process.env.NODE_ENV !== 'test') {
  const config = loadConfig()
  buildServer(config)
    .then((app) => app.listen({ port: config.PORT, host: config.HOST }))
    .catch((error: unknown) => {
      console.error(JSON.stringify({
        level: 'fatal',
        message: error instanceof Error ? error.message : 'Startup failed',
      }))
      process.exitCode = 1
    })
}
