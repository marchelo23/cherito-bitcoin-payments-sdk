import Fastify, { LogController, type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { z } from 'zod'
import { writeFile } from 'node:fs/promises'
import {
  LightningError,
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
import { PaymentLinkService } from './services/payment-link-service.js'
import { ApiKeyService } from './services/api-key-service.js'
import { TenantService } from './services/tenant-service.js'
import { WebhookService } from './services/webhook-service.js'
import { WebhookTransport } from './services/webhook-transport.js'
import { LndkProvider } from './services/lndk-provider.js'
import { PaymentIntentSecretCipher } from './security/payment-intent-secret-cipher.js'
import { createLightningProvider } from './services/lightning-provider-factory.js'
import { BoundedLightningProvider } from './services/bounded-lightning-provider.js'
import {
  InMemoryRateLimiter,
  SseConnectionLimiter,
  type RateLimiter,
} from './services/rate-limiter.js'
import {
  createSafeLoggerOptions,
  safeLog,
  writeSafeProcessEvent,
  type LogDestination,
  type SafeLogger,
} from './logging/safe-logger.js'

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

const paymentLinkMode = z.enum(['fixed', 'open_amount', 'donation'])
const paymentLinkFields = {
  mode: paymentLinkMode,
  pricingRuleId: z.string().min(1).max(100).optional(),
  productId: z.string().regex(PRODUCT_ID).optional(),
  minAmountSats: z.string().regex(/^\d+$/).max(20).optional(),
  maxAmountSats: z.string().regex(/^\d+$/).max(20).optional(),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  maxUses: z.number().int().min(1).max(1_000_000).optional(),
  indexable: z.boolean().optional(),
}
const createPaymentLinkBody = z.object(paymentLinkFields).strict()
const updatePaymentLinkBody = z.object({
  ...paymentLinkFields,
  mode: paymentLinkMode.optional(),
  title: z.string().min(1).max(120).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required')
const invokePaymentLinkBody = z.object({
  amountSats: z.string().regex(/^\d+$/).max(20).optional(),
  payerNote: z.string().max(500).optional(),
}).strict()
const paymentLinkListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).max(100).optional(),
}).strict()
const webhookConfigBody = z.object({
  endpoint: z.string().url().max(2_048),
}).strict()
const boundedListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).max(100).optional(),
}).strict()

const extractBearer = (header: unknown): string =>
  typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : ''

const PUBLIC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  AMOUNT_OUT_OF_RANGE: 'Amount is outside configured limits',
  BOLT12_NOT_CONFIGURED: 'BOLT12 receive is not configured',
  IDEMPOTENCY_CONFLICT: 'Idempotency key payload conflict',
  INVALID_AMOUNT: 'Amount must be a positive integer',
  INVALID_DESCRIPTION: 'Description is invalid',
  DESCRIPTION_TOO_LARGE: 'Description is too large',
  INVALID_IDEMPOTENCY_KEY: 'Idempotency key is invalid',
  IDEMPOTENCYKEY_TOO_LARGE: 'Idempotency key is too large',
  INVALID_AMOUNT_SOURCE: 'Exactly one amount source is required',
  INVALID_MERCHANT_ORDER_ID: 'Merchant order ID is invalid',
  MERCHANTORDERID_TOO_LARGE: 'Merchant order ID is too large',
  MERCHANT_ORDER_CONFLICT: 'Merchant order ID is already in use',
  INVALID_PRICING_RULE: 'Pricing rule configuration is invalid',
  INVALID_QUANTITY: 'Quantity is invalid',
  LNDK_UNAVAILABLE: 'Lightning provider unavailable',
  METADATA_TOO_LARGE: 'Metadata is too large',
  PRICING_RULE_NOT_FOUND: 'Pricing rule is unavailable',
  PRODUCT_NOT_FOUND: 'Product is unavailable',
  PROVIDER_AMOUNT_MISMATCH: 'Lightning provider response was rejected',
  PROVIDER_UNAVAILABLE: 'Lightning provider unavailable',
  SERVICE_UNAVAILABLE: 'Service temporarily unavailable',
  PAYMENT_LINK_EXPIRED: 'Payment Link has expired',
  PAYMENT_LINK_USE_LIMIT_REACHED: 'Payment Link use limit reached',
  FIXED_PRICE_OVERRIDE_DENIED: 'Fixed amount cannot be overridden',
  AMOUNT_BELOW_MINIMUM: 'Amount is below the Payment Link minimum',
  AMOUNT_ABOVE_MAXIMUM: 'Amount is above the Payment Link maximum',
  PAYER_NOTE_NOT_ALLOWED: 'Payer note is only valid for donations',
  INVALID_PAYER_NOTE: 'Payer note is invalid',
  PAYERNOTE_TOO_LARGE: 'Payer note is too large',
  PAYMENT_LINK_SLUG_CONFLICT: 'Payment Link slug is unavailable',
  PAYMENT_LINK_USE_LIMIT_CONFLICT: 'Payment Link use limit conflicts with existing usage',
  PAYMENT_LINK_MODE_IMMUTABLE: 'Payment Link mode cannot change',
  NOT_FOUND: 'Resource not found',
  TOO_MANY_REQUESTS: 'Too many requests',
  INVALID_TITLE: 'Payment Link title is invalid',
  TITLE_TOO_LARGE: 'Payment Link title is too large',
  INVALID_EXPIRATION: 'Payment Link expiration is invalid',
  INVALID_MAX_USES: 'Payment Link use limit is invalid',
  FIXED_PRICE_BOUNDS_DENIED: 'Fixed Payment Links cannot define payer amount bounds',
  PUBLIC_AMOUNT_SOURCE_CONFLICT: 'Open Payment Links cannot use a pricing rule',
  INVALID_AMOUNT_BOUNDS: 'Payment Link amount bounds are invalid',
  PAYMENT_LINK_RESERVATION_INVALID: 'Payment Link capacity reservation is unavailable',
  WEBHOOK_NOT_CONFIGURED: 'Webhook is not configured',
  WEBHOOK_DELIVERY_FAILED: 'Webhook delivery failed',
  WEBHOOK_URL_INVALID: 'Webhook URL is invalid',
  WEBHOOK_SSRF_BLOCKED: 'Webhook destination is forbidden',
  RULE_NOT_FOUND: 'Pricing rule is unavailable',
  TENANT_DISABLED: 'Tenant is disabled',
  TENANT_NOT_FOUND: 'Tenant not found',
}

function normalizedPublicError(error: unknown): {
  status: number
  code: string
  message: string
} {
  if (error instanceof z.ZodError) {
    return { status: 400, code: 'INVALID_REQUEST', message: 'Request validation failed' }
  }
  if (error instanceof LightningError) {
    return { status: 502, code: 'PROVIDER_UNAVAILABLE', message: 'Lightning provider unavailable' }
  }
  const candidate = error as { statusCode?: unknown; code?: unknown } | null
  const code = typeof candidate?.code === 'string' ? candidate.code : ''
  const message = PUBLIC_ERROR_MESSAGES[code]
  const status = typeof candidate?.statusCode === 'number' ? candidate.statusCode : 500
  if (message && status >= 400 && status <= 599) return { status, code, message }
  if (status >= 400 && status < 500) {
    return { status, code: 'INVALID_REQUEST', message: 'Request rejected' }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' }
}

export interface BuildServerDependencies {
  lnd?: LightningReceiveProvider
  bolt12?: Bolt12ReceiveProvider
  startBackgroundJobs?: boolean
  logStream?: LogDestination
  rateLimiter?: RateLimiter
}

export async function buildServer(
  config: Config = loadConfig(),
  dependencies: BuildServerDependencies = {},
): Promise<FastifyInstance> {
  const trustProxyConfig = config.TRUST_PROXY ?? ''
  const trustProxy = trustProxyConfig.trim().length === 0
    ? false
    : trustProxyConfig.split(',').map((value) => value.trim()).filter(Boolean)
  const app = Fastify({
    logger: createSafeLoggerOptions(config.LOG_LEVEL, dependencies.logStream),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16_384,
    requestTimeout: 15_000,
    trustProxy,
  })
  const logger = app.log as SafeLogger

  const rawLightning = dependencies.lnd ?? await createLightningProvider(config)
  const lnd = new BoundedLightningProvider(
    rawLightning,
    config.PROVIDER_MAX_CONCURRENCY ?? 10,
    config.PROVIDER_MAX_QUEUE ?? 100,
  )

  let bolt12 = dependencies.bolt12
  if (!bolt12 && config.BOLT12_PROVIDER === 'lndk') {
    try {
      bolt12 = await LndkProvider.connect({
        url: config.LNDK_GRPC_URL!,
        certificatePath: config.LNDK_TLS_CERT_PATH!,
        macaroonPath: config.LNDK_MACAROON_PATH!,
      })
    } catch {
      safeLog(logger, 'warn', {
        event: 'provider.connection_failed',
        providerType: 'lndk',
        outcome: 'failure',
        errorCode: 'PROVIDER_UNAVAILABLE',
      }, 'optional Lightning provider unavailable')
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
  const webhookService = new WebhookService(
    webhookRepo,
    paymentIntentRepo,
    logger,
    new WebhookTransport({
      allowPrivateAddresses: config.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS,
    }),
  )
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
      logger,
    },
  )
  const paymentLinkService = new PaymentLinkService(
    paymentIntentRepo,
    tenantService,
    paymentIntentService,
    Date.now,
    { minimum: config.MIN_INVOICE_SATS, maximum: config.MAX_INVOICE_SATS },
  )
  paymentLinkService.recoverAbandonedReservations()
  const legacyPaymentService = new PaymentService(lnd, bolt12, legacyRepo, config, logger)

  if (paymentIntentRepo.tenantCount() === 0) {
    const { tenant, apiKey } = await tenantService.createTenant({
      name: config.BOOTSTRAP_TENANT_NAME,
      apiKeyLabel: 'bootstrap',
    })
    await writeFile(config.BOOTSTRAP_KEY_PATH!, `${apiKey}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    safeLog(logger, 'info', {
      event: 'bootstrap.key_written',
      outcome: 'success',
    }, 'bootstrap credential written to configured destination')
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
    stopWebhookRetry = webhookService.startRetryLoop(config.WEBHOOK_RETRY_INTERVAL_MS)
  }

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
    methods: ['GET', 'POST', 'PATCH', 'PUT'],
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

  const requestTenants = new WeakMap<object, string>()
  app.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode
    safeLog(logger, status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', {
      event: 'http.request_completed',
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      outcome: status >= 400 ? 'failure' : 'success',
      tenantId: requestTenants.get(request),
      httpStatus: status,
    }, 'request completed')
  })

  const rateLimiter = dependencies.rateLimiter ?? new InMemoryRateLimiter()
  const rateWindow = config.RATE_LIMIT_WINDOW_MS ?? 60_000
  const policies = {
    authFailure: { name: 'auth-failure', limit: config.RATE_LIMIT_AUTH_FAILURES ?? 10, windowMs: rateWindow },
    merchantIntent: { name: 'merchant-intent', limit: config.RATE_LIMIT_CREATE_INVOICE, windowMs: rateWindow },
    legacyCheckout: { name: 'legacy-checkout', limit: config.RATE_LIMIT_CREATE_INVOICE, windowMs: rateWindow },
    linkResolve: { name: 'payment-link-resolve', limit: config.RATE_LIMIT_PAYMENT_LINK_RESOLVE ?? 120, windowMs: rateWindow },
    linkCreateIp: { name: 'payment-link-create-ip', limit: config.RATE_LIMIT_PAYMENT_LINK_CREATE_IP ?? 20, windowMs: rateWindow },
    linkCreateTenant: { name: 'payment-link-create-tenant', limit: config.RATE_LIMIT_PAYMENT_LINK_CREATE_TENANT ?? 100, windowMs: rateWindow },
    linkCreateLink: { name: 'payment-link-create-link', limit: config.RATE_LIMIT_PAYMENT_LINK_CREATE_LINK ?? 30, windowMs: rateWindow },
    webhookManagement: { name: 'webhook-management', limit: config.RATE_LIMIT_WEBHOOK_MANAGEMENT ?? 30, windowMs: rateWindow },
    sseConnections: { name: 'sse-connections', limit: config.RATE_LIMIT_SSE_CONNECTIONS ?? 60, windowMs: rateWindow },
  } as const
  const sseLimiter = new SseConnectionLimiter(config.SSE_MAX_GLOBAL ?? 1_000, config.SSE_MAX_PER_TENANT ?? 20)
  const rateLimited = (policy: typeof policies[keyof typeof policies], identity: string): boolean =>
    !rateLimiter.consume(policy, identity)

  const requireMerchantAuth = (
    authorization: string | undefined,
  ): { tenantId: string } | undefined => apiKeyService.verify(extractBearer(authorization))

  const merchantAuth = (
    request: { headers: { authorization?: string }; ip: string },
  ): { tenantId: string } | undefined => {
    const auth = requireMerchantAuth(request.headers.authorization)
    if (!auth && !rateLimiter.consume(policies.authFailure, request.ip)) {
      throw Object.assign(new Error('Authentication attempts are rate limited'), {
        statusCode: 429,
        code: 'TOO_MANY_REQUESTS',
      })
    }
    return auth
  }

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
      return { status: 'ok', lightning: 'connected' }
    } catch {
      return reply.code(503).send({
        status: 'degraded',
        lightning: 'disconnected',
      })
    }
  })

  app.get('/v1/node', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required' })
    }
    requestTenants.set(request, auth.tenantId)
    return lnd.getNodeInfo()
  })
  app.get('/v1/capabilities', async () => {
    const base = await lnd.getCapabilities()
    const extra = bolt12 ? await bolt12.getCapabilities().catch(() => undefined) : undefined
    return {
      bolt11Receive: base.bolt11Receive,
      bolt12Receive: extra?.bolt12Receive === true,
      invoiceStreaming: base.invoiceStreaming,
    }
  })

  app.post('/v1/payment-links', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || !z.string().uuid().safeParse(key).success) {
      return reply.code(400).send({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'A UUID Idempotency-Key is required',
      })
    }
    const link = paymentLinkService.create(
      auth.tenantId,
      createPaymentLinkBody.parse(request.body),
      key,
    )
    return reply.code(201).send(link)
  })

  app.get('/v1/payment-links', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    const query = paymentLinkListQuery.parse(request.query)
    const items = paymentLinkService.list(auth.tenantId, query.limit, query.after)
    return { items, next: items.length === query.limit ? items.at(-1)?.id : undefined }
  })

  app.get<{ Params: { id: string } }>('/v1/payment-links/manage/:id', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    const link = paymentLinkService.get(auth.tenantId, request.params.id)
    return link ?? reply.code(404).send({ code: 'NOT_FOUND', message: 'Payment Link not found' })
  })

  app.patch<{ Params: { id: string } }>('/v1/payment-links/:id', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    return paymentLinkService.update(
      auth.tenantId,
      request.params.id,
      updatePaymentLinkBody.parse(request.body),
    )
  })

  app.post<{ Params: { id: string } }>('/v1/payment-links/:id/disable', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    z.object({}).strict().parse(request.body ?? {})
    return paymentLinkService.disable(auth.tenantId, request.params.id)
  })

  app.post<{ Params: { id: string } }>('/v1/payment-links/:id/rotate-slug', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    z.object({}).strict().parse(request.body ?? {})
    return paymentLinkService.rotateSlug(auth.tenantId, request.params.id)
  })

  app.get<{ Params: { slug: string } }>('/v1/payment-links/:slug', async (request, reply) => {
    if (rateLimited(policies.linkResolve, request.ip)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
    }
    const link = paymentLinkService.resolve(request.params.slug)
    if (!link) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Payment Link not found' })
    if (!paymentLinkService.isIndexable(request.params.slug)) {
      reply.header('x-robots-tag', 'noindex, nofollow, noarchive')
    }
    return link
  })

  app.post<{ Params: { slug: string } }>(
    '/v1/payment-links/:slug/payment-intents',
    async (request, reply) => {
      if (rateLimited(policies.linkCreateIp, request.ip)) {
        return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
      }
      const context = paymentLinkService.rateContext(request.params.slug)
      if (context && (
        rateLimited(policies.linkCreateTenant, context.tenantId)
        || rateLimited(policies.linkCreateLink, context.paymentLinkId)
      )) {
        return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
      }
      const body = invokePaymentLinkBody.parse(request.body ?? {})
      return reply.code(201).send(
        await paymentLinkService.createPaymentIntent(request.params.slug, body),
      )
    },
  )

  app.get('/v1/webhooks/config', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    if (rateLimited(policies.webhookManagement, `${auth.tenantId}:${request.ip}`)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
    }
    const tenant = paymentIntentRepo.tenant(auth.tenantId)!
    return {
      enabled: tenant.webhookUrl !== null,
      endpoint: tenant.webhookUrl,
      signingSecretConfigured: tenant.webhookSecret !== null,
      secretRotatedAt: tenant.secretRotatedAt,
    }
  })

  app.put('/v1/webhooks/config', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    if (rateLimited(policies.webhookManagement, `${auth.tenantId}:${request.ip}`)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
    }
    const { endpoint } = webhookConfigBody.parse(request.body)
    await webhookService.validateEndpoint(endpoint)
    const current = paymentIntentRepo.tenant(auth.tenantId)!
    const rotated = current.webhookSecret ? undefined : tenantService.rotateWebhookSecret(auth.tenantId)
    const tenant = tenantService.configureWebhookUrl(auth.tenantId, endpoint)
    return {
      enabled: true,
      endpoint: tenant.webhookUrl,
      signingSecret: rotated?.webhookSecret,
    }
  })

  app.post('/v1/webhooks/disable', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    if (rateLimited(policies.webhookManagement, `${auth.tenantId}:${request.ip}`)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
    }
    z.object({}).strict().parse(request.body ?? {})
    tenantService.configureWebhookUrl(auth.tenantId, null)
    return { enabled: false }
  })

  app.post('/v1/webhooks/rotate-secret', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    if (rateLimited(policies.webhookManagement, `${auth.tenantId}:${request.ip}`)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
    }
    z.object({}).strict().parse(request.body ?? {})
    const tenant = tenantService.rotateWebhookSecret(auth.tenantId)
    return {
      signingSecret: tenant.webhookSecret,
      secretRotatedAt: tenant.secretRotatedAt,
    }
  })

  app.get('/v1/webhooks/deliveries/failed', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    if (rateLimited(policies.webhookManagement, `${auth.tenantId}:${request.ip}`)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
    }
    const query = boundedListQuery.parse(request.query)
    const rows = webhookRepo.failedDeliveries(auth.tenantId, query.limit, query.after)
    const items = rows.map((delivery) => ({
      id: delivery.id,
      eventId: delivery.eventId,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      lastAttemptAt: delivery.lastAttemptAt,
      nextAttemptAt: delivery.nextAttemptAt,
      deliveredAt: delivery.deliveredAt,
      createdAt: delivery.createdAt,
    }))
    return { items, next: items.length === query.limit ? items.at(-1)?.id : undefined }
  })

  app.post<{ Params: { eventId: string } }>('/v1/webhooks/events/:eventId/replay', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    if (rateLimited(policies.webhookManagement, `${auth.tenantId}:${request.ip}`)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
    }
    z.object({}).strict().parse(request.body ?? {})
    await webhookService.replayEvent(auth.tenantId, request.params.eventId)
    return reply.code(202).send({ eventId: request.params.eventId, replayQueued: true })
  })

  app.post('/v1/webhooks/test', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    if (rateLimited(policies.webhookManagement, `${auth.tenantId}:${request.ip}`)) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests' })
    }
    z.object({}).strict().parse(request.body ?? {})
    await webhookService.sendTestEvent(auth.tenantId)
    return reply.code(202).send({ delivered: true })
  })

  app.post('/v1/payment-intents', async (request, reply) => {
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
    if (rateLimited(policies.merchantIntent, `${auth.tenantId}:${request.ip}`)) {
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
    const auth = merchantAuth(request)
    if (!auth) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid merchant API key required' })
    }
    requestTenants.set(request, auth.tenantId)
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
      requestTenants.set(request, intent.tenantId)
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
      requestTenants.set(request, intent.tenantId)
      if (rateLimited(policies.sseConnections, `${intent.tenantId}:${request.ip}`)) {
        return reply.code(429).send({ code: 'TOO_MANY_REQUESTS', message: 'Too many streams' })
      }
      const releaseConnection = sseLimiter.acquire(intent.tenantId)
      if (!releaseConnection) {
        return reply.code(429).send({ code: 'TOO_MANY_REQUESTS', message: 'Too many streams' })
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
      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        remove()
        clearInterval(ping)
        releaseConnection()
      }
      request.raw.on('close', () => {
        cleanup()
      })
      reply.raw.on('error', cleanup)
    },
  )

  // Existing APIs remain deliberately unchanged while callers migrate.
  app.post('/v1/checkout-sessions', async (request, reply) => {
    if (rateLimited(policies.legacyCheckout, request.ip)) {
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
    const normalized = normalizedPublicError(error)
    safeLog(logger, normalized.status >= 500 ? 'error' : 'warn', {
      event: 'http.request_failed',
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      outcome: 'failure',
      tenantId: requestTenants.get(request),
      errorCode: normalized.code,
      httpStatus: normalized.status,
    }, 'request failed')
    reply.code(normalized.status).send({
      code: normalized.code,
      message: normalized.message,
      requestId: request.id,
    })
  })

  return app
}

async function startGateway(): Promise<void> {
  const config = loadConfig()
  const app = await buildServer(config)
  await app.listen({ port: config.PORT, host: config.HOST })
}

if (process.env.NODE_ENV !== 'test') {
  void startGateway().catch(() => {
    writeSafeProcessEvent(process.stderr, 'fatal', 'STARTUP_FAILED')
    process.exitCode = 1
  })
}
