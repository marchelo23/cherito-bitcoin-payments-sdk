import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { invoiceStateToIntentStatus } from '@cherito/bitcoin-sdk'
import type { LightningReceiveProvider, Bolt12ReceiveProvider } from '@cherito/bitcoin-sdk'
import type { Config } from '../config.js'
import type {
  Repository,
  PaymentIntent,
  PricingRule,
} from '../persistence/repository.js'
import type { WebhookService } from './webhook-service.js'
import type { TenantService } from './tenant-service.js'

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex')

/**
 * Derive a scoped browser capability token from the intent ID + a server secret.
 *
 * Design:
 *   clientSecret = "cs_" + HMAC-SHA256(intentSecret, intentId + ":" + tenantId)
 *
 * Where intentSecret = random 32-byte hex stored at intent creation.
 * The hash of this is stored in client_secret_hash.
 *
 * This means:
 * - The plaintext can be re-derived at any time from intentSecret + intentId
 * - The secret is never stored in plaintext in the DB
 * - Idempotent retries can return a usable clientSecret
 * - A lost response can be recovered without creating a second invoice
 */
function deriveClientSecret(intentSecret: string, intentId: string, tenantId: string): string {
  const hmac = createHmac('sha256', intentSecret)
    .update(`${intentId}:${tenantId}`)
    .digest('base64url')
  return `cs_${hmac}`
}

/**
 * Public projection of a PaymentIntent returned to the merchant backend.
 * Never contains the merchant API key or internal node credentials.
 */
export interface PaymentIntentResponse {
  id: string
  tenantId: string
  merchantOrderId: string | null
  amountSats: string
  currency: 'sat'
  description: string
  status: string
  paymentRequest: string
  paymentHash: string
  expiresAt: string
  settledAt: string | null
  createdAt: string
  /**
   * Scoped browser capability token. Present only at creation time and on
   * idempotent retries (re-derived from stored intentSecret). Never empty.
   */
  clientSecret: string
}

/**
 * Public (browser-safe) projection — never contains credentials.
 */
export interface PaymentIntentPublic {
  id: string
  amountSats: string
  currency: 'sat'
  description: string
  status: string
  paymentRequest: string
  expiresAt: string
}

/**
 * Create input allowing either product-backed or backend-defined amounts.
 * A public browser must NEVER reach this service directly.
 */
export interface CreatePaymentIntentInput {
  tenantId: string
  /**
   * Optional merchant order ID (e.g. WooCommerce order ID).
   * Unique per tenant. If supplied, a duplicate reuses the existing intent
   * when combined with idempotencyKey.
   */
  merchantOrderId?: string
  /**
   * Optional product reference for catalog-backed intents.
   * Required when amountSats is not provided.
   */
  productId?: string
  quantity?: number
  /**
   * Explicit amount for backend-defined intents (e.g. WooCommerce).
   * Bypasses catalog pricing. Required when productId is not provided.
   */
  amountSats?: bigint
  description?: string
  /** Bounded merchant metadata: max 4 KB serialized */
  metadata?: Record<string, unknown>
  idempotencyKey?: string
  paymentLinkId?: string
  pricingRuleId?: string
}

/**
 * PaymentIntentService manages the full lifecycle of a Payment Intent:
 * create → watch (subscribe to provider) → settle → webhook
 *
 * Security invariants:
 * - Amount is always server-controlled
 * - Browser clients receive only a scoped clientSecret, never the merchant API key
 * - Settlement derives exclusively from provider callbacks
 * - All queries are scoped by tenantId — cross-tenant access is impossible
 * - Idempotent retries always return a usable clientSecret
 * - Terminal states are never reversed by stale events
 * - Duplicate watchers are prevented via a registry
 */
export class PaymentIntentService {
  private readonly listeners = new Map<string, Set<(s: PaymentIntent) => void>>()
  /** Active watcher cleanup functions, keyed by paymentHash to prevent duplicates */
  private readonly watchers = new Map<string, () => Promise<void>>()

  // Concurrency limiter for recovery
  private readonly RECOVERY_CONCURRENCY = 5

  constructor(
    private readonly lnd: LightningReceiveProvider,
    private readonly bolt12: Bolt12ReceiveProvider | undefined,
    private readonly repo: Repository,
    private readonly config: Config,
    private readonly tenantService?: TenantService,
    private readonly webhookService?: WebhookService,
  ) {}

  // ---- Creation ------------------------------------------------------------

  async create(input: CreatePaymentIntentInput): Promise<PaymentIntentResponse> {
    const {
      tenantId,
      productId,
      quantity = 1,
      idempotencyKey,
      paymentLinkId = null,
      merchantOrderId = null,
    } = input

    // --- Validate metadata size (max 4 KB serialized) -----------------------
    if (input.metadata) {
      const serialized = JSON.stringify(input.metadata)
      if (serialized.length > 4096) {
        throw Object.assign(
          new Error('metadata exceeds 4 KB serialized limit'),
          { statusCode: 400, code: 'METADATA_TOO_LARGE' },
        )
      }
    }

    // --- Validate tenant is active ------------------------------------------
    if (this.tenantService) {
      this.tenantService.assertActive(tenantId)
    }

    // --- Idempotency check --------------------------------------------------
    const payloadHash = this.buildPayloadHash(input)
    if (idempotencyKey) {
      const existing = this.repo.paymentIntentByIdempotencyKey(tenantId, idempotencyKey)
      if (existing) {
        if (existing.idempotencyPayloadHash !== payloadHash) {
          throw Object.assign(
            new Error('Idempotency key payload conflict'),
            { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' },
          )
        }
        // Re-derive client secret from stored intentSecret — never empty on retry
        const clientSecret = deriveClientSecret(
          existing.intentSecret,
          existing.id,
          existing.tenantId,
        )
        return { ...this.toMerchantResponse(existing), clientSecret }
      }
    }

    // --- Pricing (server-controlled) ----------------------------------------
    let amountSats: bigint
    let pricingRuleId: string | null = input.pricingRuleId ?? null

    if (input.amountSats !== undefined) {
      // Backend-defined amount (e.g. WooCommerce order total)
      amountSats = input.amountSats
    } else if (productId) {
      // Catalog-backed pricing
      const rule: PricingRule | undefined = this.repo.pricingRule(tenantId, productId)
      if (!rule?.active) {
        throw Object.assign(new Error('Product unavailable'), { statusCode: 404, code: 'PRODUCT_NOT_FOUND' })
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > rule.maxQuantity) {
        throw Object.assign(new Error('Quantity is invalid'), { statusCode: 400, code: 'INVALID_QUANTITY' })
      }
      amountSats = BigInt(rule.priceSats!) * BigInt(quantity)
      pricingRuleId = rule.id
    } else {
      throw Object.assign(
        new Error('Either productId or amountSats must be provided'),
        { statusCode: 400, code: 'MISSING_AMOUNT' },
      )
    }

    if (amountSats <= 0n) {
      throw Object.assign(new Error('Amount must be positive'), { statusCode: 400, code: 'INVALID_AMOUNT' })
    }
    if (amountSats < this.config.MIN_INVOICE_SATS || amountSats > this.config.MAX_INVOICE_SATS) {
      throw Object.assign(
        new Error('Amount is outside merchant limits'),
        { statusCode: 400, code: 'AMOUNT_OUT_OF_RANGE' },
      )
    }

    // --- Create invoice with Lightning provider ----------------------------
    const intentId = `pi_${randomUUID()}`
    const description = (input.description ?? `Payment ${intentId}`).slice(0, 255)
    const invoice = await this.lnd.createInvoice({
      orderId: intentId,
      amountSats,
      memo: description.slice(0, 120),
      expirySeconds: this.config.DEFAULT_INVOICE_EXPIRY_SECONDS,
    })

    // --- Generate and hash client secret ------------------------------------
    // intentSecret is a random 32-byte hex stored with the intent.
    // The clientSecret is derived from it deterministically, so idempotent
    // retries can return the same clientSecret without storing plaintext.
    const intentSecret = randomBytes(32).toString('hex')
    const clientSecret = deriveClientSecret(intentSecret, intentId, tenantId)
    const now = new Date().toISOString()

    const intent: PaymentIntent = {
      id: intentId,
      tenantId,
      pricingRuleId,
      paymentLinkId,
      merchantOrderId,
      amountSats: amountSats.toString(),
      currency: 'sat',
      description,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      status: 'requires_payment',
      paymentRequest: invoice.paymentRequest,
      paymentHash: invoice.paymentHash,
      providerInvoiceId: invoice.providerInvoiceId,
      intentSecret,
      clientSecretHash: sha256(clientSecret),
      idempotencyKey: idempotencyKey ?? null,
      idempotencyPayloadHash: idempotencyKey ? payloadHash : null,
      expiresAt: invoice.expiresAt,
      settledAt: null,
      createdAt: now,
      updatedAt: now,
    }

    this.repo.createPaymentIntent(intent)

    // Start watching for settlement (non-blocking)
    void this.watch(intent)

    return { ...this.toMerchantResponse(intent), clientSecret }
  }

  // ---- Authorization (browser) --------------------------------------------

  /**
   * Verify a client_secret and return the intent if valid.
   * Scopes the lookup to intentId + tenantId — prevents cross-intent enumeration.
   * Uses timing-safe comparison.
   */
  authorize(
    intentId: string,
    tenantId: string,
    clientSecret: string,
  ): PaymentIntent | undefined {
    const intent = this.repo.paymentIntent(intentId, tenantId)
    if (!intent) return undefined

    const expected = sha256(clientSecret)
    const a = Buffer.from(intent.clientSecretHash, 'hex')
    const b = Buffer.from(expected, 'hex')
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined

    return intent
  }

  // ---- SSE listeners -------------------------------------------------------

  listen(id: string, callback: (s: PaymentIntent) => void): () => void {
    const set = this.listeners.get(id) ?? new Set()
    set.add(callback)
    this.listeners.set(id, set)
    return () => {
      set.delete(callback)
      if (set.size === 0) this.listeners.delete(id)
    }
  }

  // ---- Recovery (restart) --------------------------------------------------

  /**
   * Called at startup. For each non-terminal intent:
   * 1. Query provider for current authoritative state (detects offline settlements)
   * 2. Mark locally expired intents
   * 3. Subscribe to live updates for intents still pending
   *
   * Uses bounded concurrency to avoid thundering herd on large datasets.
   */
  async recoverPendingIntents(): Promise<void> {
    const pending = this.repo.pendingPaymentIntents()
    const now = new Date()

    // Process in batches of RECOVERY_CONCURRENCY
    for (let i = 0; i < pending.length; i += this.RECOVERY_CONCURRENCY) {
      const batch = pending.slice(i, i + this.RECOVERY_CONCURRENCY)
      await Promise.allSettled(
        batch.map(async (intent) => {
          // Skip if already watching
          if (this.watchers.has(intent.paymentHash)) return

          // Check if locally expired
          if (new Date(intent.expiresAt) <= now) {
            this.repo.markIntentExpired(intent.paymentHash)
            return
          }

          try {
            // Query provider for authoritative current state
            const current = await this.lnd.getInvoice(intent.paymentHash).catch(() => undefined)
            if (current) {
              const newStatus = invoiceStateToIntentStatus(current.state)
              // Apply state update via compare-and-set — preserves terminal states
              const changed = this.repo.updatePaymentIntentStatus(
                intent.paymentHash,
                current,
                newStatus,
              )
              if (changed && this.webhookService && (newStatus === 'succeeded' || newStatus === 'failed')) {
                const tenant = this.repo.tenant(intent.tenantId)
                if (tenant) {
                  const updated = this.repo.paymentIntentByHash(intent.paymentHash)
                  if (updated) {
                    void this.webhookService.enqueue(
                      tenant,
                      updated,
                      newStatus === 'succeeded'
                        ? 'payment_intent.succeeded'
                        : 'payment_intent.failed',
                    )
                  }
                }
              }
              // Only subscribe to still-pending intents
              if (newStatus === 'requires_payment' || newStatus === 'processing') {
                void this.watch(intent)
              }
            } else {
              void this.watch(intent)
            }
          } catch {
            // Non-fatal: log and continue; the intent remains in DB and will
            // be reconciled on next periodic reconciliation pass
            void this.watch(intent).catch(() => {/* ignore */})
          }
        }),
      )
    }
  }

  // ---- Periodic reconciliation (call on interval e.g. every 5 min) ---------

  async reconcile(): Promise<void> {
    await this.recoverPendingIntents()
  }

  startReconciliationLoop(intervalMs = 300_000): () => void {
    const timer = setInterval(() => {
      void this.reconcile().catch((err) => {
        console.error('Periodic reconciliation failed:', err)
      })
    }, intervalMs)
    return () => clearInterval(timer)
  }

  // ---- Public projections --------------------------------------------------

  toPublic(intent: PaymentIntent): PaymentIntentPublic {
    return {
      id: intent.id,
      amountSats: intent.amountSats,
      currency: intent.currency,
      description: intent.description,
      status: intent.status,
      paymentRequest: intent.paymentRequest,
      expiresAt: intent.expiresAt,
    }
  }

  private toMerchantResponse(intent: PaymentIntent): Omit<PaymentIntentResponse, 'clientSecret'> {
    return {
      id: intent.id,
      tenantId: intent.tenantId,
      merchantOrderId: intent.merchantOrderId ?? null,
      amountSats: intent.amountSats,
      currency: intent.currency,
      description: intent.description,
      status: intent.status,
      paymentRequest: intent.paymentRequest,
      paymentHash: intent.paymentHash,
      expiresAt: intent.expiresAt,
      settledAt: intent.settledAt,
      createdAt: intent.createdAt,
    }
  }

  // ---- Provider subscription -----------------------------------------------

  /**
   * Subscribe to invoice updates from the Lightning provider.
   * Prevents duplicate subscriptions via the watchers registry.
   * Compare-and-set state transition ensures terminal states are preserved.
   */
  private async watch(intent: PaymentIntent): Promise<void> {
    if (this.watchers.has(intent.paymentHash)) return

    // Register a placeholder immediately to prevent concurrent duplicate calls
    this.watchers.set(intent.paymentHash, () => Promise.resolve())

    const cleanup = await this.lnd.subscribeToInvoice(intent.paymentHash, (lndInvoice) => {
      const newStatus = invoiceStateToIntentStatus(lndInvoice.state)

      // Compare-and-set: only update if the transition is valid
      const changed = this.repo.updatePaymentIntentStatus(intent.paymentHash, lndInvoice, newStatus)
      if (!changed) return  // Stale event for already-terminal intent — ignore

      const updated = this.repo.paymentIntentByHash(intent.paymentHash)
      if (!updated) return

      // Notify SSE listeners
      for (const listener of this.listeners.get(intent.id) ?? []) {
        listener(updated)
      }

      // Trigger webhook exactly once per terminal state change
      if (newStatus === 'succeeded' || newStatus === 'failed' || newStatus === 'expired') {
        const tenant = this.repo.tenant(intent.tenantId)
        if (tenant && this.webhookService) {
          void this.webhookService.enqueue(
            tenant,
            updated,
            newStatus === 'succeeded'
              ? 'payment_intent.succeeded'
              : newStatus === 'expired'
                ? 'payment_intent.expired'
                : 'payment_intent.failed',
          )
        }
        // Clean up watcher once in terminal state
        const cleanupFn = this.watchers.get(intent.paymentHash)
        if (cleanupFn) { void cleanupFn(); this.watchers.delete(intent.paymentHash) }
      }
    })

    // Store the real cleanup function returned by the provider
    this.watchers.set(intent.paymentHash, cleanup)
  }

  // ---- Idempotency helpers ------------------------------------------------

  /**
   * Build a canonical payload hash that covers all behavior-affecting fields.
   * Must include: product, quantity, amount, merchant order, description, metadata.
   */
  private buildPayloadHash(input: CreatePaymentIntentInput): string {
    return sha256(
      JSON.stringify({
        productId: input.productId ?? null,
        quantity: input.quantity ?? 1,
        amountSats: input.amountSats?.toString() ?? null,
        merchantOrderId: input.merchantOrderId ?? null,
        description: input.description ?? null,
        metadata: input.metadata ?? null,
        pricingRuleId: input.pricingRuleId ?? null,
        paymentLinkId: input.paymentLinkId ?? null,
      }),
    )
  }
}
