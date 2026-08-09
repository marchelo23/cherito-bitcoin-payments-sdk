import { createHash, randomBytes } from 'node:crypto'
import type {
  PaymentIntentCreateResponse,
  PaymentIntentService,
} from './payment-intent-service.js'
import type {
  PaymentIntentRepository,
  PaymentLink,
  PaymentLinkMode,
  PaymentLinkReservation,
} from '../persistence/payment-intent-repository.js'
import type { TenantService } from './tenant-service.js'

const CREATE_ROUTE = 'POST:/v1/payment-links'
const SLUG_PATTERN = /^pl_[A-Za-z0-9_-]{32,64}$/
const MAX_TITLE_BYTES = 120
const MAX_DESCRIPTION_BYTES = 500
const MAX_PAYER_NOTE_BYTES = 500

export interface CreatePaymentLinkInput {
  mode: PaymentLinkMode
  pricingRuleId?: string
  productId?: string
  minAmountSats?: string
  maxAmountSats?: string
  title: string
  description?: string
  expiresAt?: string
  maxUses?: number
  indexable?: boolean
  slug?: string
}

export type UpdatePaymentLinkInput = Partial<CreatePaymentLinkInput>

export interface InvokePaymentLinkInput {
  amountSats?: string
  payerNote?: string
}

export interface PaymentLinkPublicView {
  slug: string
  mode: PaymentLinkMode
  title: string
  description: string | null
  amountSats?: string
  minAmountSats?: string
  maxAmountSats?: string
  expiresAt: string | null
}

export interface PublicPaymentIntentResponse {
  id: string
  tenantId: string
  clientSecret: string
  amountSats: string
  currency: 'SAT'
  description: string
  status: string
  paymentRequest: string
  expiresAt: string
  settledAt: string | null
  updatedAt: string
}

function serviceError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}

function assertUtf8(value: string, maximum: number, field: string): string {
  const normalized = value.normalize('NFC')
  if (Buffer.byteLength(normalized, 'utf8') > maximum) {
    throw serviceError(400, `${field.toUpperCase()}_TOO_LARGE`, `${field} is too large`)
  }
  return normalized
}

function normalizePayerNote(value: string): string {
  const normalized = assertUtf8(value, MAX_PAYER_NOTE_BYTES, 'payerNote')
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0
    const allowedWhitespace = codePoint === 9 || codePoint === 10 || codePoint === 13
    if ((!allowedWhitespace && codePoint < 32) || (codePoint >= 127 && codePoint <= 159)) {
      throw serviceError(400, 'INVALID_PAYER_NOTE', 'payerNote contains control characters')
    }
  }
  return normalized
}

function decimalSats(value: string | undefined, field: string): bigint {
  if (!value || !/^\d+$/.test(value)) {
    throw serviceError(400, 'INVALID_AMOUNT', `${field} must be a decimal integer string`)
  }
  const amount = BigInt(value)
  if (amount <= 0n) throw serviceError(400, 'INVALID_AMOUNT', `${field} must be positive`)
  return amount
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
}

function payloadHash(input: CreatePaymentLinkInput): string {
  const normalized = canonicalJson({
    description: input.description?.normalize('NFC') ?? null,
    expiresAt: input.expiresAt ?? null,
    indexable: input.indexable ?? false,
    maxAmountSats: input.maxAmountSats ?? null,
    maxUses: input.maxUses ?? null,
    minAmountSats: input.minAmountSats ?? null,
    mode: input.mode,
    pricingRuleId: input.pricingRuleId ?? null,
    productId: input.productId ?? null,
    slug: input.slug ?? null,
    title: input.title.normalize('NFC'),
  })
  return createHash('sha256')
    .update(`cherito:merchant-action-idempotency:v1\0${CREATE_ROUTE}\0${normalized}`)
    .digest('hex')
}

function randomSlug(): string {
  return `pl_${randomBytes(24).toString('base64url')}`
}

function randomLinkId(): string {
  return `plink_${randomBytes(18).toString('base64url')}`
}

function randomIntentId(): string {
  return `pi_${randomBytes(18).toString('base64url')}`
}

function randomReservationId(): string {
  return `plr_${randomBytes(18).toString('base64url')}`
}

export class PaymentLinkService {
  constructor(
    private readonly repo: PaymentIntentRepository,
    private readonly tenantService: TenantService,
    private readonly paymentIntentService: PaymentIntentService,
    private readonly now: () => number = Date.now,
    private readonly amountBounds: { minimum: bigint; maximum: bigint } = {
      minimum: 1n,
      maximum: 21_000_000_000_000_000n,
    },
  ) {}

  recoverAbandonedReservations(): number {
    return this.repo.releaseAllPaymentLinkReservations()
  }

  create(
    tenantId: string,
    input: CreatePaymentLinkInput,
    idempotencyKey: string,
  ): PaymentLink {
    this.tenantService.assertActive(tenantId)
    const normalized = this.normalize(input, tenantId)
    const hash = payloadHash(normalized)
    const existing = this.repo.merchantActionIdempotency(tenantId, CREATE_ROUTE, idempotencyKey)
    if (existing) {
      if (existing.payloadHash !== hash) {
        throw serviceError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key payload conflict')
      }
      const link = this.repo.paymentLink(tenantId, existing.resourceId)
      if (!link) throw serviceError(500, 'IDEMPOTENCY_RESULT_MISSING', 'Idempotent result is missing')
      return link
    }

    const timestamp = new Date(this.now()).toISOString()
    const link: PaymentLink = {
      id: randomLinkId(),
      tenantId,
      slug: normalized.slug ?? randomSlug(),
      mode: normalized.mode,
      pricingRuleId: normalized.pricingRuleId ?? null,
      minAmountSats: normalized.minAmountSats ?? null,
      maxAmountSats: normalized.maxAmountSats ?? null,
      title: normalized.title,
      description: normalized.description ?? null,
      expiresAt: normalized.expiresAt ?? null,
      maxUses: normalized.maxUses ?? null,
      useCount: 0,
      reservedUses: 0,
      active: true,
      indexable: normalized.indexable ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    try {
      const result = this.repo.createPaymentLink(link, {
        tenantId,
        route: CREATE_ROUTE,
        idempotencyKey,
        payloadHash: hash,
        resourceId: link.id,
        createdAt: timestamp,
      })
      if (!result.created) {
        if (result.payloadHash !== hash) {
          throw serviceError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key payload conflict')
        }
        return this.repo.paymentLink(tenantId, result.resourceId)!
      }
      return link
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw serviceError(409, 'PAYMENT_LINK_SLUG_CONFLICT', 'Payment Link slug is unavailable')
      }
      throw error
    }
  }

  get(tenantId: string, id: string): PaymentLink | undefined {
    return this.repo.paymentLink(tenantId, id)
  }

  list(tenantId: string, limit: number, afterId?: string): PaymentLink[] {
    this.tenantService.assertActive(tenantId)
    return this.repo.listPaymentLinks(tenantId, limit, afterId)
  }

  update(tenantId: string, id: string, input: UpdatePaymentLinkInput): PaymentLink {
    const current = this.repo.paymentLink(tenantId, id)
    if (!current) throw serviceError(404, 'NOT_FOUND', 'Payment Link not found')
    if (input.mode !== undefined && input.mode !== current.mode) {
      throw serviceError(409, 'PAYMENT_LINK_MODE_IMMUTABLE', 'Payment Link mode cannot change')
    }
    const normalized = this.normalize({
      mode: input.mode ?? current.mode,
      pricingRuleId: input.pricingRuleId ?? current.pricingRuleId ?? undefined,
      productId: input.productId,
      minAmountSats: input.minAmountSats ?? current.minAmountSats ?? undefined,
      maxAmountSats: input.maxAmountSats ?? current.maxAmountSats ?? undefined,
      title: input.title ?? current.title,
      description: input.description ?? current.description ?? undefined,
      expiresAt: input.expiresAt ?? current.expiresAt ?? undefined,
      maxUses: input.maxUses ?? current.maxUses ?? undefined,
      indexable: input.indexable ?? current.indexable,
      slug: input.slug ?? current.slug,
    }, tenantId)
    if (normalized.maxUses !== undefined
      && normalized.maxUses < current.useCount + current.reservedUses) {
      throw serviceError(409, 'PAYMENT_LINK_USE_LIMIT_CONFLICT', 'maxUses is below existing usage')
    }
    const updated: PaymentLink = {
      ...current,
      ...normalized,
      pricingRuleId: normalized.pricingRuleId ?? null,
      minAmountSats: normalized.minAmountSats ?? null,
      maxAmountSats: normalized.maxAmountSats ?? null,
      description: normalized.description ?? null,
      expiresAt: normalized.expiresAt ?? null,
      maxUses: normalized.maxUses ?? null,
      updatedAt: new Date(this.now()).toISOString(),
    }
    try {
      this.repo.updatePaymentLink(updated)
      return updated
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw serviceError(409, 'PAYMENT_LINK_SLUG_CONFLICT', 'Payment Link slug is unavailable')
      }
      throw error
    }
  }

  disable(tenantId: string, id: string): PaymentLink {
    const current = this.repo.paymentLink(tenantId, id)
    if (!current) throw serviceError(404, 'NOT_FOUND', 'Payment Link not found')
    const updated = { ...current, active: false, updatedAt: new Date(this.now()).toISOString() }
    this.repo.updatePaymentLink(updated)
    return updated
  }

  rotateSlug(tenantId: string, id: string): PaymentLink {
    const current = this.repo.paymentLink(tenantId, id)
    if (!current) throw serviceError(404, 'NOT_FOUND', 'Payment Link not found')
    const updated = { ...current, slug: randomSlug(), updatedAt: new Date(this.now()).toISOString() }
    this.repo.updatePaymentLink(updated)
    return updated
  }

  resolve(slug: string): PaymentLinkPublicView | undefined {
    const link = this.availableBySlug(slug)
    if (!link) return undefined
    const view: PaymentLinkPublicView = {
      slug: link.slug,
      mode: link.mode,
      title: link.title,
      description: link.description,
      expiresAt: link.expiresAt,
    }
    if (link.mode === 'fixed') {
      const rule = this.repo.pricingRuleById(link.tenantId, link.pricingRuleId!)
      if (!rule?.active || rule.mode !== 'fixed' || rule.priceSats === null) return undefined
      view.amountSats = rule.priceSats
    } else {
      view.minAmountSats = link.minAmountSats!
      view.maxAmountSats = link.maxAmountSats!
    }
    return view
  }

  isIndexable(slug: string): boolean {
    return this.availableBySlug(slug)?.indexable === true
  }

  rateContext(slug: string): { tenantId: string; paymentLinkId: string } | undefined {
    const link = this.availableBySlug(slug)
    return link ? { tenantId: link.tenantId, paymentLinkId: link.id } : undefined
  }

  async createPaymentIntent(
    slug: string,
    input: InvokePaymentLinkInput,
  ): Promise<PublicPaymentIntentResponse> {
    if (!SLUG_PATTERN.test(slug)) throw serviceError(404, 'NOT_FOUND', 'Payment Link not found')
    const link = this.repo.paymentLinkBySlug(slug)
    if (!link?.active) throw serviceError(404, 'NOT_FOUND', 'Payment Link not found')
    if (link.expiresAt && Date.parse(link.expiresAt) <= this.now()) {
      throw serviceError(410, 'PAYMENT_LINK_EXPIRED', 'Payment Link has expired')
    }
    if (link.maxUses !== null && link.useCount + link.reservedUses >= link.maxUses) {
      throw serviceError(409, 'PAYMENT_LINK_USE_LIMIT_REACHED', 'Payment Link use limit reached')
    }
    const amount = this.invocationAmount(link, input)
    const payerNote = input.payerNote === undefined ? undefined : normalizePayerNote(input.payerNote)
    if (link.mode !== 'donation' && payerNote !== undefined) {
      throw serviceError(400, 'PAYER_NOTE_NOT_ALLOWED', 'payerNote is only valid for donations')
    }

    const timestamp = new Date(this.now()).toISOString()
    const reservation: PaymentLinkReservation = {
      id: randomReservationId(),
      tenantId: link.tenantId,
      paymentLinkId: link.id,
      paymentIntentId: randomIntentId(),
      createdAt: timestamp,
    }
    if (!this.repo.reservePaymentLinkUse(reservation, timestamp)) {
      const current = this.repo.paymentLinkBySlug(slug)
      if (!current?.active) throw serviceError(404, 'NOT_FOUND', 'Payment Link not found')
      if (current.expiresAt && Date.parse(current.expiresAt) <= this.now()) {
        throw serviceError(410, 'PAYMENT_LINK_EXPIRED', 'Payment Link has expired')
      }
      throw serviceError(409, 'PAYMENT_LINK_USE_LIMIT_REACHED', 'Payment Link use limit reached')
    }

    let committed = false
    try {
      const intent = await this.paymentIntentService.createForPaymentLink({
        tenantId: link.tenantId,
        intentId: reservation.paymentIntentId,
        paymentLinkId: link.id,
        paymentLinkReservationId: reservation.id,
        pricingRuleId: link.mode === 'fixed' ? link.pricingRuleId! : undefined,
        amountSats: link.mode === 'fixed' ? undefined : amount,
        description: link.description ?? link.title,
        metadata: payerNote === undefined ? undefined : { payerNote },
      })
      committed = true
      return this.publicIntent(intent)
    } finally {
      if (!committed) this.repo.releasePaymentLinkReservation(reservation.id)
    }
  }

  private normalize(input: CreatePaymentLinkInput, tenantId: string): CreatePaymentLinkInput {
    const title = assertUtf8(input.title, MAX_TITLE_BYTES, 'title')
    if (title.length === 0) throw serviceError(400, 'INVALID_TITLE', 'title is required')
    const description = input.description === undefined
      ? undefined
      : assertUtf8(input.description, MAX_DESCRIPTION_BYTES, 'description')
    const slug = input.slug
    if (slug !== undefined && !SLUG_PATTERN.test(slug)) {
      throw serviceError(400, 'INVALID_PAYMENT_LINK_SLUG', 'slug must contain at least 192 bits')
    }
    if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) {
      throw serviceError(400, 'INVALID_EXPIRATION', 'expiresAt must be an ISO timestamp')
    }
    const expiresAt = input.expiresAt === undefined
      ? undefined
      : new Date(Date.parse(input.expiresAt)).toISOString()
    if (input.maxUses !== undefined
      && (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 1_000_000)) {
      throw serviceError(400, 'INVALID_MAX_USES', 'maxUses is invalid')
    }

    if (input.mode === 'fixed') {
      if (input.minAmountSats !== undefined || input.maxAmountSats !== undefined) {
        throw serviceError(400, 'FIXED_PRICE_BOUNDS_DENIED', 'fixed links cannot define payer bounds')
      }
      const rule = input.pricingRuleId
        ? this.repo.pricingRuleById(tenantId, input.pricingRuleId)
        : input.productId
          ? this.repo.pricingRule(tenantId, input.productId)
          : undefined
      if (!rule?.active || rule.mode !== 'fixed' || rule.priceSats === null) {
        throw serviceError(404, 'PRICING_RULE_NOT_FOUND', 'Pricing rule is unavailable')
      }
      const fixedAmount = decimalSats(rule.priceSats, 'pricingRule.amountSats')
      if (fixedAmount < this.amountBounds.minimum || fixedAmount > this.amountBounds.maximum) {
        throw serviceError(400, 'AMOUNT_OUT_OF_RANGE', 'Pricing rule amount is outside gateway limits')
      }
      return {
        ...input,
        title,
        description,
        slug,
        expiresAt,
        pricingRuleId: rule.id,
        productId: undefined,
        minAmountSats: undefined,
        maxAmountSats: undefined,
      }
    }

    if (input.pricingRuleId !== undefined || input.productId !== undefined) {
      throw serviceError(400, 'PUBLIC_AMOUNT_SOURCE_CONFLICT', 'open links cannot use a pricing rule')
    }
    const minimum = decimalSats(input.minAmountSats, 'minAmountSats')
    const maximum = decimalSats(input.maxAmountSats, 'maxAmountSats')
    if (minimum > maximum) {
      throw serviceError(400, 'INVALID_AMOUNT_BOUNDS', 'minimum exceeds maximum')
    }
    if (minimum < this.amountBounds.minimum || maximum > this.amountBounds.maximum) {
      throw serviceError(400, 'AMOUNT_OUT_OF_RANGE', 'Payment Link bounds exceed gateway limits')
    }
    return {
      ...input,
      title,
      description,
      slug,
      expiresAt,
      pricingRuleId: undefined,
      productId: undefined,
      minAmountSats: minimum.toString(),
      maxAmountSats: maximum.toString(),
    }
  }

  private availableBySlug(slug: string): PaymentLink | undefined {
    if (!SLUG_PATTERN.test(slug)) return undefined
    const link = this.repo.paymentLinkBySlug(slug)
    if (!link?.active) return undefined
    if (link.expiresAt && Date.parse(link.expiresAt) <= this.now()) return undefined
    if (link.maxUses !== null && link.useCount + link.reservedUses >= link.maxUses) return undefined
    return link
  }

  private invocationAmount(link: PaymentLink, input: InvokePaymentLinkInput): bigint | undefined {
    if (link.mode === 'fixed') {
      if (input.amountSats !== undefined) {
        throw serviceError(400, 'FIXED_PRICE_OVERRIDE_DENIED', 'fixed amount cannot be overridden')
      }
      return undefined
    }
    const amount = decimalSats(input.amountSats, 'amountSats')
    const minimum = BigInt(link.minAmountSats!)
    const maximum = BigInt(link.maxAmountSats!)
    if (amount < minimum) throw serviceError(400, 'AMOUNT_BELOW_MINIMUM', 'amount is below minimum')
    if (amount > maximum) throw serviceError(400, 'AMOUNT_ABOVE_MAXIMUM', 'amount is above maximum')
    return amount
  }

  private publicIntent(intent: PaymentIntentCreateResponse): PublicPaymentIntentResponse {
    return {
      id: intent.id,
      tenantId: intent.tenantId,
      clientSecret: intent.clientSecret,
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
}
