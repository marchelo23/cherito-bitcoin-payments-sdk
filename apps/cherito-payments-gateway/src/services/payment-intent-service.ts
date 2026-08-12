import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import type {
  InvoiceState,
  LightningInvoice,
  LightningReceiveProvider,
  PaymentIntentStatus,
} from '@cherito/bitcoin-sdk'
import type { Config } from '../config.js'
import {
  PAYMENT_INTENT_TERMINAL_STATUSES,
  type PaymentIntent,
  type PaymentIntentRepository,
} from '../persistence/payment-intent-repository.js'
import type { PricingRule } from '../persistence/tenant-repository.js'
import type { TenantService } from './tenant-service.js'
import {
  derivePaymentIntentClientSecret,
  hashPaymentIntentClientSecret,
} from '../security/payment-intent-client-capability.js'
import {
  NOOP_SAFE_LOGGER,
  safeLog,
  safeProviderErrorCode,
  type SafeLogger,
} from '../logging/safe-logger.js'

const IDEMPOTENCY_DOMAIN = 'cherito:payment-intent-idempotency:v1'
const MAX_METADATA_BYTES = 4_096
const MAX_DESCRIPTION_BYTES = 500
const MAX_MERCHANT_ORDER_ID_BYTES = 200
const MAX_IDEMPOTENCY_KEY_BYTES = 200

const TERMINAL_STATUSES = new Set<PaymentIntentStatus>(PAYMENT_INTENT_TERMINAL_STATUSES)
const ALLOWED_TRANSITIONS: Readonly<Record<PaymentIntentStatus, ReadonlySet<PaymentIntentStatus>>> = {
  requires_payment: new Set(['processing', 'succeeded', 'expired', 'failed', 'canceled']),
  processing: new Set(['succeeded', 'expired', 'failed', 'canceled']),
  succeeded: new Set(),
  expired: new Set(),
  failed: new Set(),
  canceled: new Set(),
}

interface WatcherEntry {
  cleanup?: () => Promise<void>
  stopRequested: boolean
}

export interface PaymentIntentEventSink {
  enqueuePaymentIntentEvent(
    tenantId: string,
    paymentIntentId: string,
    type: string,
    payload: string,
  ): Promise<void> | void
}

export interface PaymentIntentServiceOptions {
  recoveryConcurrency?: number
  reconciliationIntervalMs?: number
  watcherRetryBaseMs?: number
  watcherRetryMaxMs?: number
  now?: () => number
  random?: () => number
  logger?: SafeLogger
}

export interface CreatePaymentIntentInput {
  tenantId: string
  amountSats?: bigint
  productId?: string
  pricingRuleId?: string
  paymentLinkId?: string
  quantity?: number
  merchantOrderId?: string
  description?: string
  metadata?: Record<string, unknown>
  idempotencyKey?: string
  /** Internal-only preallocated ID used by the Payment Link reservation flow. */
  intentId?: string
  /** Internal-only reservation committed atomically with the Payment Intent. */
  paymentLinkReservationId?: string
}

export interface PaymentIntentMerchantView {
  id: string
  tenantId: string
  merchantOrderId: string | null
  pricingRuleId: string | null
  paymentLinkId: string | null
  amountSats: string
  currency: 'SAT'
  description: string
  metadata: Record<string, unknown> | null
  status: PaymentIntentStatus
  paymentRequest: string
  paymentHash: string
  providerInvoiceId: string
  expiresAt: string
  settledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface PaymentIntentCreateResponse extends PaymentIntentMerchantView {
  clientSecret: string
}

export interface PaymentIntentClientView {
  id: string
  amountSats: string
  currency: 'SAT'
  description: string
  status: PaymentIntentStatus
  paymentRequest: string
  expiresAt: string
  settledAt: string | null
  updatedAt: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedString(value: string | undefined): string | undefined {
  return value?.normalize('NFC')
}

function assertUtf8Bound(value: string, maxBytes: number, field: string): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw paymentIntentError(400, `${field.toUpperCase()}_TOO_LARGE`, `${field} is too large`)
  }
}

function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()

  const encode = (item: unknown): string => {
    if (item === null) return 'null'
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('metadata contains a non-finite number')
      return JSON.stringify(item)
    }
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`
    if (typeof item !== 'object') throw new Error('metadata must contain only JSON values')
    if (seen.has(item)) throw new Error('metadata must not contain cycles')
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('metadata must contain only plain JSON objects')
    }
    seen.add(item)
    const record = item as Record<string, unknown>
    const result = `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
      .join(',')}}`
    seen.delete(item)
    return result
  }

  return encode(value)
}

function paymentIntentError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}

function providerStatus(state: InvoiceState): PaymentIntentStatus | undefined {
  switch (state) {
    case 'pending':
      return 'requires_payment'
    case 'accepted':
      return 'processing'
    case 'settled':
      return 'succeeded'
    case 'expired':
      return 'expired'
    case 'canceled':
      return 'canceled'
    case 'unknown':
      return undefined
  }
}

export class PaymentIntentService {
  private readonly listeners = new Map<string, Set<(intent: PaymentIntent) => void>>()
  private readonly watchers = new Map<string, WatcherEntry>()
  private readonly watcherRetryTimers = new Map<string, NodeJS.Timeout>()
  private readonly watcherRetryAttempts = new Map<string, number>()
  private readonly creationLocks = new Map<string, Promise<void>>()
  private readonly recoveryConcurrency: number
  private readonly reconciliationIntervalMs: number
  private readonly watcherRetryBaseMs: number
  private readonly watcherRetryMaxMs: number
  private readonly now: () => number
  private readonly random: () => number
  private readonly logger: SafeLogger
  private reconciliationTimer: NodeJS.Timeout | undefined
  private reconciliationInFlight: Promise<void> | undefined
  private shuttingDown = false

  constructor(
    private readonly provider: LightningReceiveProvider,
    private readonly repo: PaymentIntentRepository,
    private readonly config: Config,
    private readonly tenantService: TenantService,
    private readonly eventSink?: PaymentIntentEventSink,
    options: PaymentIntentServiceOptions = {},
  ) {
    this.recoveryConcurrency = Math.max(1, Math.trunc(options.recoveryConcurrency ?? 5))
    this.reconciliationIntervalMs = Math.max(1, options.reconciliationIntervalMs ?? 60_000)
    this.watcherRetryBaseMs = Math.max(1, options.watcherRetryBaseMs ?? 1_000)
    this.watcherRetryMaxMs = Math.max(
      this.watcherRetryBaseMs,
      options.watcherRetryMaxMs ?? 60_000,
    )
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.logger = options.logger ?? NOOP_SAFE_LOGGER
  }

  async create(input: CreatePaymentIntentInput): Promise<PaymentIntentCreateResponse> {
    return this.withTenantCreationLock(input.tenantId, () => this.createLocked(input))
  }

  async createForPaymentLink(
    input: CreatePaymentIntentInput & {
      paymentLinkId: string
      intentId: string
      paymentLinkReservationId: string
    },
  ): Promise<PaymentIntentCreateResponse> {
    return this.withTenantCreationLock(input.tenantId, () => this.createLocked(input))
  }

  getMerchantIntent(tenantId: string, intentId: string): PaymentIntentMerchantView | undefined {
    const intent = this.repo.paymentIntent(tenantId, intentId)
    return intent ? this.toMerchant(intent) : undefined
  }

  listMerchantIntents(
    tenantId: string,
    limit: number,
    afterId?: string,
  ): PaymentIntentMerchantView[] {
    return this.repo
      .listPaymentIntents(tenantId, limit, afterId)
      .map((intent) => this.toMerchant(intent))
  }

  merchantTotals(tenantId: string): {
    settledCount: number
    settledVolumeSats: string
    pendingCount: number
    failedCount: number
  } {
    return this.repo.paymentIntentTotals(tenantId)
  }

  authorizeClient(
    tenantId: string,
    intentId: string,
    clientSecret: string,
  ): PaymentIntent | undefined {
    const intent = this.repo.paymentIntent(tenantId, intentId)
    if (!intent) return undefined
    const actual = Buffer.from(hashPaymentIntentClientSecret(clientSecret), 'hex')
    const expected = Buffer.from(intent.clientSecretHash, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
    return intent
  }

  listen(intentId: string, callback: (intent: PaymentIntent) => void): () => void {
    const listeners = this.listeners.get(intentId) ?? new Set()
    listeners.add(callback)
    this.listeners.set(intentId, listeners)
    return () => {
      listeners.delete(callback)
      if (listeners.size === 0) this.listeners.delete(intentId)
    }
  }

  async recoverPendingIntents(): Promise<void> {
    await this.reconcile()
  }

  async reconcile(): Promise<void> {
    if (this.shuttingDown) return
    if (this.reconciliationInFlight) return this.reconciliationInFlight
    this.reconciliationInFlight = this.reconcileNonTerminalIntents().finally(() => {
      this.reconciliationInFlight = undefined
    })
    return this.reconciliationInFlight
  }

  startReconciliationLoop(intervalMs = this.reconciliationIntervalMs): () => void {
    this.stopReconciliationLoop()
    this.reconciliationTimer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.logProviderFailure('payment_intent.reconciliation_failed', error)
      })
    }, Math.max(1, intervalMs))
    this.reconciliationTimer.unref?.()
    return () => this.stopReconciliationLoop()
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.stopReconciliationLoop()
    for (const timer of this.watcherRetryTimers.values()) clearTimeout(timer)
    this.watcherRetryTimers.clear()
    this.watcherRetryAttempts.clear()
    await this.reconciliationInFlight?.catch((error: unknown) => {
      this.logProviderFailure('payment_intent.reconciliation_shutdown_failed', error)
    })
    await Promise.allSettled([...this.watchers.keys()].map((hash) => this.stopWatcher(hash)))
    this.listeners.clear()
  }

  toClient(intent: PaymentIntent): PaymentIntentClientView {
    return {
      id: intent.id,
      amountSats: intent.amountSats,
      currency: intent.currency,
      description: intent.description,
      status: intent.status,
      paymentRequest: intent.paymentRequest,
      expiresAt: intent.expiresAt,
      settledAt: intent.settledAt,
      updatedAt: intent.updatedAt,
    }
  }

  private async createLocked(
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentCreateResponse> {
    const tenantId = input.tenantId

    const merchantOrderId = normalizedString(input.merchantOrderId)
    if (merchantOrderId !== undefined) {
      if (merchantOrderId.length === 0) {
        throw paymentIntentError(400, 'INVALID_MERCHANT_ORDER_ID', 'merchantOrderId is empty')
      }
      assertUtf8Bound(merchantOrderId, MAX_MERCHANT_ORDER_ID_BYTES, 'merchantOrderId')
    }

    const descriptionInput = normalizedString(input.description)
    if (descriptionInput !== undefined) {
      assertUtf8Bound(descriptionInput, MAX_DESCRIPTION_BYTES, 'description')
    }

    const metadata = input.metadata === undefined ? null : canonicalJson(input.metadata)
    if (metadata !== null && Buffer.byteLength(metadata, 'utf8') > MAX_METADATA_BYTES) {
      throw paymentIntentError(400, 'METADATA_TOO_LARGE', 'metadata exceeds 4096 bytes')
    }

    const idempotencyKey = normalizedString(input.idempotencyKey)
    if (idempotencyKey !== undefined) {
      if (idempotencyKey.length === 0) {
        throw paymentIntentError(400, 'INVALID_IDEMPOTENCY_KEY', 'idempotencyKey is empty')
      }
      assertUtf8Bound(idempotencyKey, MAX_IDEMPOTENCY_KEY_BYTES, 'idempotencyKey')
    }

    const quantity = input.quantity ?? 1
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw paymentIntentError(400, 'INVALID_QUANTITY', 'quantity is invalid')
    }

    const payloadHash = this.idempotencyPayloadHash({
      productId: input.productId ?? null,
      pricingRuleId: input.pricingRuleId ?? null,
      paymentLinkId: input.paymentLinkId ?? null,
      amountSats: input.amountSats,
      quantity,
      merchantOrderId: merchantOrderId ?? null,
      description: descriptionInput ?? null,
      metadata,
    })

    if (idempotencyKey) {
      const existing = this.repo.paymentIntentByIdempotencyKey(tenantId, idempotencyKey)
      if (existing) {
        if (existing.idempotencyPayloadHash !== payloadHash) {
          throw paymentIntentError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key payload conflict')
        }
        return this.createResponse(existing)
      }
    }

    // Existing idempotent results remain recoverable even if a tenant is later
    // disabled. Only creation of a new provider invoice requires an active tenant.
    this.tenantService.assertActive(tenantId)

    if (merchantOrderId) {
      const existingOrder = this.repo.paymentIntentByMerchantOrderId(tenantId, merchantOrderId)
      if (existingOrder) {
        throw paymentIntentError(
          409,
          'MERCHANT_ORDER_CONFLICT',
          'merchantOrderId already belongs to another Payment Intent',
        )
      }
    }

    const pricing = this.resolvePricing(input, quantity)
    this.validateAmount(pricing.amountSats)

    const intentId = input.intentId ?? `pi_${randomUUID()}`
    const description = descriptionInput ?? pricing.description ?? `Payment ${intentId}`
    assertUtf8Bound(description, MAX_DESCRIPTION_BYTES, 'description')

    let invoice: LightningInvoice
    try {
      invoice = await this.provider.createInvoice({
        orderId: intentId,
        amountSats: pricing.amountSats,
        memo: description.slice(0, 120),
        expirySeconds: this.config.DEFAULT_INVOICE_EXPIRY_SECONDS,
      })
    } catch (error) {
      this.logProviderFailure('payment_intent.invoice_creation_failed', error)
      throw paymentIntentError(502, 'PROVIDER_UNAVAILABLE', 'Lightning provider unavailable')
    }
    if (invoice.amountSats !== pricing.amountSats) {
      throw paymentIntentError(502, 'PROVIDER_AMOUNT_MISMATCH', 'Provider returned a different amount')
    }

    const intentSecret = randomBytes(32).toString('hex')
    const clientSecret = derivePaymentIntentClientSecret(intentSecret, intentId, tenantId)
    const now = new Date(this.now()).toISOString()
    const intent: PaymentIntent = {
      id: intentId,
      tenantId,
      merchantOrderId: merchantOrderId ?? null,
      pricingRuleId: pricing.pricingRuleId,
      paymentLinkId: input.paymentLinkId ?? null,
      amountSats: pricing.amountSats.toString(),
      currency: 'SAT',
      description,
      metadata,
      status: 'requires_payment',
      paymentRequest: invoice.paymentRequest,
      paymentHash: invoice.paymentHash,
      providerInvoiceId: invoice.providerInvoiceId,
      intentSecret,
      clientSecretHash: hashPaymentIntentClientSecret(clientSecret),
      idempotencyKey: idempotencyKey ?? null,
      idempotencyPayloadHash: idempotencyKey ? payloadHash : null,
      expiresAt: invoice.expiresAt,
      settledAt: null,
      createdAt: now,
      updatedAt: now,
    }
    if (input.paymentLinkReservationId) {
      this.repo.createPaymentIntentForReservedLink(intent, input.paymentLinkReservationId)
    } else {
      this.repo.createPaymentIntent(intent)
    }
    void this.ensureWatcher(intent)
    return { ...this.toMerchant(intent), clientSecret }
  }

  private resolvePricing(
    input: CreatePaymentIntentInput,
    quantity: number,
  ): { amountSats: bigint; pricingRuleId: string | null; description: string | null } {
    const references = Number(input.amountSats !== undefined)
      + Number(input.productId !== undefined)
      + Number(input.pricingRuleId !== undefined)
    if (references !== 1) {
      throw paymentIntentError(
        400,
        'INVALID_AMOUNT_SOURCE',
        'Provide exactly one of amountSats, productId, or pricingRuleId',
      )
    }

    if (input.amountSats !== undefined) {
      if (typeof input.amountSats !== 'bigint') {
        throw paymentIntentError(400, 'INVALID_AMOUNT', 'amountSats must be an integer')
      }
      if (input.quantity !== undefined && quantity !== 1) {
        throw paymentIntentError(400, 'INVALID_QUANTITY', 'quantity is only valid for pricing rules')
      }
      return { amountSats: input.amountSats, pricingRuleId: null, description: null }
    }

    const rule = input.pricingRuleId
      ? this.repo.pricingRuleById(input.tenantId, input.pricingRuleId)
      : this.repo.pricingRule(input.tenantId, input.productId!)
    return this.pricingFromRule(rule, quantity)
  }

  private pricingFromRule(
    rule: PricingRule | undefined,
    quantity: number,
  ): { amountSats: bigint; pricingRuleId: string; description: string | null } {
    if (!rule?.active || rule.mode !== 'fixed' || rule.priceSats === null) {
      throw paymentIntentError(404, 'PRICING_RULE_NOT_FOUND', 'Pricing rule is unavailable')
    }
    if (quantity > rule.maxQuantity) {
      throw paymentIntentError(400, 'INVALID_QUANTITY', 'quantity exceeds the pricing-rule limit')
    }
    if (!/^\d+$/.test(rule.priceSats)) {
      throw paymentIntentError(500, 'INVALID_PRICING_RULE', 'Pricing rule amount is invalid')
    }
    return {
      amountSats: BigInt(rule.priceSats) * BigInt(quantity),
      pricingRuleId: rule.id,
      description: rule.description ?? rule.name,
    }
  }

  private validateAmount(amountSats: bigint): void {
    if (amountSats <= 0n) {
      throw paymentIntentError(400, 'INVALID_AMOUNT', 'amountSats must be positive')
    }
    if (amountSats < this.config.MIN_INVOICE_SATS || amountSats > this.config.MAX_INVOICE_SATS) {
      throw paymentIntentError(400, 'AMOUNT_OUT_OF_RANGE', 'amountSats is outside configured limits')
    }
  }

  private idempotencyPayloadHash(input: {
    productId: string | null
    pricingRuleId: string | null
    paymentLinkId: string | null
    amountSats: bigint | undefined
    quantity: number
    merchantOrderId: string | null
    description: string | null
    metadata: string | null
  }): string {
    const normalized = canonicalJson({
      amountSats: input.amountSats?.toString() ?? null,
      description: input.description,
      merchantOrderId: input.merchantOrderId,
      metadata: input.metadata,
      paymentLinkId: input.paymentLinkId,
      pricingRuleId: input.pricingRuleId,
      productId: input.productId,
      quantity: input.quantity,
    })
    return sha256(`${IDEMPOTENCY_DOMAIN}\0${normalized}`)
  }

  private createResponse(intent: PaymentIntent): PaymentIntentCreateResponse {
    return {
      ...this.toMerchant(intent),
      clientSecret: derivePaymentIntentClientSecret(
        intent.intentSecret,
        intent.id,
        intent.tenantId,
      ),
    }
  }

  private toMerchant(intent: PaymentIntent): PaymentIntentMerchantView {
    return {
      id: intent.id,
      tenantId: intent.tenantId,
      merchantOrderId: intent.merchantOrderId,
      pricingRuleId: intent.pricingRuleId,
      paymentLinkId: intent.paymentLinkId,
      amountSats: intent.amountSats,
      currency: intent.currency,
      description: intent.description,
      metadata: intent.metadata ? JSON.parse(intent.metadata) as Record<string, unknown> : null,
      status: intent.status,
      paymentRequest: intent.paymentRequest,
      paymentHash: intent.paymentHash,
      providerInvoiceId: intent.providerInvoiceId,
      expiresAt: intent.expiresAt,
      settledAt: intent.settledAt,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
    }
  }

  private async reconcileNonTerminalIntents(): Promise<void> {
    const intents = this.repo.nonTerminalPaymentIntents()
    let nextIndex = 0
    const workers = Array.from(
      { length: Math.min(this.recoveryConcurrency, intents.length) },
      async () => {
        while (!this.shuttingDown) {
          const index = nextIndex++
          const intent = intents[index]
          if (!intent) return
          await this.reconcileIntent(intent)
        }
      },
    )
    await Promise.allSettled(workers)
  }

  private async reconcileIntent(intent: PaymentIntent): Promise<void> {
    let providerInvoice: LightningInvoice | undefined
    try {
      providerInvoice = await this.provider.getInvoice(intent.paymentHash)
      await this.applyProviderInvoice(intent.tenantId, intent.paymentHash, providerInvoice)
    } catch (error) {
      this.logProviderFailure('payment_intent.provider_reconciliation_failed', error)
    }

    const current = this.repo.paymentIntentByHash(intent.tenantId, intent.paymentHash)
    if (!current || TERMINAL_STATUSES.has(current.status)) {
      await this.stopWatcher(intent.paymentHash)
      return
    }

    if (Date.parse(current.expiresAt) <= this.now()) {
      await this.transition(current, 'expired', providerInvoice)
      return
    }

    await this.ensureWatcher(current)
  }

  private async applyProviderInvoice(
    tenantId: string,
    paymentHash: string,
    invoice: LightningInvoice,
  ): Promise<void> {
    if (invoice.paymentHash !== paymentHash) {
      throw new Error('Provider returned an invoice with an unexpected payment hash')
    }
    const nextStatus = providerStatus(invoice.state)
    if (!nextStatus) return
    const current = this.repo.paymentIntentByHash(tenantId, paymentHash)
    if (!current) return
    await this.transition(current, nextStatus, invoice)
  }

  private async transition(
    current: PaymentIntent,
    nextStatus: PaymentIntentStatus,
    invoice?: LightningInvoice,
  ): Promise<boolean> {
    if (!ALLOWED_TRANSITIONS[current.status].has(nextStatus)) return false
    const updatedAt = new Date(this.now()).toISOString()
    const settledAt = nextStatus === 'succeeded'
      ? (invoice?.settledAt ?? updatedAt)
      : current.settledAt
    const event = TERMINAL_STATUSES.has(nextStatus)
      ? {
          id: `we_${randomUUID()}`,
          deliveryId: `wd_${randomUUID()}`,
          type: `payment_intent.${nextStatus}`,
          payload: canonicalJson({
            amountSats: current.amountSats,
            createdAt: current.createdAt,
            currency: current.currency,
            id: current.id,
            merchantOrderId: current.merchantOrderId,
            status: nextStatus,
            settledAt,
            tenantId: current.tenantId,
            updatedAt,
          }),
          createdAt: updatedAt,
        }
      : undefined
    const changed = this.repo.transitionPaymentIntent({
      tenantId: current.tenantId,
      paymentHash: current.paymentHash,
      fromStatus: current.status,
      toStatus: nextStatus,
      invoice,
      updatedAt,
      event,
    })
    if (!changed) return false

    const updated = this.repo.paymentIntentByHash(current.tenantId, current.paymentHash)
    if (!updated) return false
    for (const listener of this.listeners.get(updated.id) ?? []) listener(updated)

    if (TERMINAL_STATUSES.has(updated.status)) {
      await this.stopWatcher(updated.paymentHash)
      this.clearWatcherRetry(updated.paymentHash)
      await this.emitTerminalEvent(updated)
    }
    return true
  }

  private async emitTerminalEvent(intent: PaymentIntent): Promise<void> {
    if (!this.eventSink) return
    const payload = canonicalJson({
      amountSats: intent.amountSats,
      createdAt: intent.createdAt,
      currency: intent.currency,
      id: intent.id,
      merchantOrderId: intent.merchantOrderId,
      status: intent.status,
      settledAt: intent.settledAt,
      tenantId: intent.tenantId,
      updatedAt: intent.updatedAt,
    })
    await this.eventSink.enqueuePaymentIntentEvent(
      intent.tenantId,
      intent.id,
      `payment_intent.${intent.status}`,
      payload,
    )
  }

  private async ensureWatcher(intent: PaymentIntent): Promise<void> {
    if (this.shuttingDown || TERMINAL_STATUSES.has(intent.status)) return
    if (this.watchers.has(intent.paymentHash) || this.watcherRetryTimers.has(intent.paymentHash)) {
      return
    }

    const entry: WatcherEntry = { stopRequested: false }
    this.watchers.set(intent.paymentHash, entry)
    try {
      const cleanup = await this.provider.subscribeToInvoice(intent.paymentHash, (invoice) => {
        void this.applyProviderInvoice(intent.tenantId, intent.paymentHash, invoice).catch(
          (error: unknown) => this.logProviderFailure('payment_intent.watcher_callback_failed', error),
        )
      })
      entry.cleanup = cleanup
      this.watcherRetryAttempts.delete(intent.paymentHash)
      if (entry.stopRequested || this.shuttingDown || !this.watchers.has(intent.paymentHash)) {
        await cleanup().catch((error: unknown) => {
          this.logProviderFailure('payment_intent.watcher_cleanup_failed', error)
        })
        this.watchers.delete(intent.paymentHash)
      }
    } catch (error) {
      if (this.watchers.get(intent.paymentHash) === entry) {
        this.watchers.delete(intent.paymentHash)
      }
      this.logProviderFailure('payment_intent.watcher_subscription_failed', error)
      this.scheduleWatcherRetry(intent)
    }
  }

  private async stopWatcher(paymentHash: string): Promise<void> {
    const watcher = this.watchers.get(paymentHash)
    if (!watcher) return
    watcher.stopRequested = true
    this.watchers.delete(paymentHash)
    if (watcher.cleanup) {
      await watcher.cleanup().catch((error: unknown) => {
        this.logProviderFailure('payment_intent.watcher_cleanup_failed', error)
      })
    }
  }

  private scheduleWatcherRetry(intent: PaymentIntent): void {
    if (this.shuttingDown || this.watcherRetryTimers.has(intent.paymentHash)) return
    const attempt = this.watcherRetryAttempts.get(intent.paymentHash) ?? 0
    this.watcherRetryAttempts.set(intent.paymentHash, attempt + 1)
    const exponential = Math.min(
      this.watcherRetryMaxMs,
      this.watcherRetryBaseMs * (2 ** Math.min(attempt, 16)),
    )
    const delay = Math.min(
      this.watcherRetryMaxMs,
      exponential + Math.floor(exponential * 0.2 * this.random()),
    )
    const timer = setTimeout(() => {
      this.watcherRetryTimers.delete(intent.paymentHash)
      const current = this.repo.paymentIntentByHash(intent.tenantId, intent.paymentHash)
      if (current && !TERMINAL_STATUSES.has(current.status)) void this.ensureWatcher(current)
    }, delay)
    timer.unref?.()
    this.watcherRetryTimers.set(intent.paymentHash, timer)
  }

  private logProviderFailure(event: string, error: unknown): void {
    safeLog(this.logger, 'error', {
      event,
      providerType: this.provider.providerType,
      outcome: 'failure',
      errorCode: safeProviderErrorCode(error),
    }, 'Lightning operation failed')
  }

  private clearWatcherRetry(paymentHash: string): void {
    const timer = this.watcherRetryTimers.get(paymentHash)
    if (timer) clearTimeout(timer)
    this.watcherRetryTimers.delete(paymentHash)
    this.watcherRetryAttempts.delete(paymentHash)
  }

  private stopReconciliationLoop(): void {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer)
    this.reconciliationTimer = undefined
  }

  private async withTenantCreationLock<T>(tenantId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.creationLocks.get(tenantId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.creationLocks.set(tenantId, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.creationLocks.get(tenantId) === tail) this.creationLocks.delete(tenantId)
    }
  }
}
