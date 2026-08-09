import { randomUUID, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { TenantRepository, Tenant, PricingRule, MerchantApiKey } from '../persistence/tenant-repository.js'
import type { ApiKeyService } from './api-key-service.js'

// ---------------------------------------------------------------------------
// Input validation schemas
// ---------------------------------------------------------------------------

const TENANT_NAME_RE = /^[\w\s'.-]{2,80}$/

const tenantCreateSchema = z
  .object({
    name: z
      .string()
      .min(2, 'Tenant name must be at least 2 characters')
      .max(80, 'Tenant name must be at most 80 characters')
      .regex(TENANT_NAME_RE, 'Tenant name contains invalid characters'),
    apiKeyLabel: z.string().min(1).max(50).default('default'),
  })
  .strict()

const PRODUCT_ID_RE = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/

const pricingRuleSchema = z
  .object({
    productId: z
      .string()
      .regex(PRODUCT_ID_RE, 'productId must be 3-80 lowercase alphanumeric/hyphen chars'),
    name: z
      .string()
      .min(1, 'name is required')
      .max(120, 'name must be at most 120 characters'),
    description: z.string().max(500, 'description must be at most 500 characters').optional(),
    mode: z.enum(['fixed', 'open_amount', 'backend_defined']),
    /** Required for fixed mode. Min amount for open_amount. Ignored for backend_defined. */
    priceSats: z
      .string()
      .regex(/^\d+$/, 'priceSats must be a decimal integer string')
      .optional(),
    /** Upper bound for open_amount mode. */
    maxPriceSats: z
      .string()
      .regex(/^\d+$/, 'maxPriceSats must be a decimal integer string')
      .optional(),
    maxQuantity: z.number().int().min(1).max(100).default(10),
    offerEnabled: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.mode === 'fixed') {
      if (!val.priceSats) {
        ctx.addIssue({ code: 'custom', message: 'priceSats is required for fixed mode', path: ['priceSats'] })
        return
      }
      const sats = BigInt(val.priceSats)
      if (sats <= 0n) {
        ctx.addIssue({ code: 'custom', message: 'priceSats must be > 0', path: ['priceSats'] })
      }
      if (sats > 21_000_000_000_000_000n) {
        ctx.addIssue({ code: 'custom', message: 'priceSats exceeds maximum supply', path: ['priceSats'] })
      }
    }
    if (val.mode === 'open_amount' && val.priceSats && val.maxPriceSats) {
      if (BigInt(val.maxPriceSats) <= BigInt(val.priceSats)) {
        ctx.addIssue({
          code: 'custom',
          message: 'maxPriceSats must be greater than priceSats (min amount)',
          path: ['maxPriceSats'],
        })
      }
    }
  })

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CreateTenantInput {
  name: string
  /** Label for the first API key (defaults to "default") */
  apiKeyLabel?: string
}

export interface CreateTenantResult {
  tenant: Tenant
  /** Plaintext API key — shown ONCE, never recoverable */
  apiKey: string
  apiKeyRecord: MerchantApiKey
}

export type UpsertPricingRuleInput = z.input<typeof pricingRuleSchema>

// ---------------------------------------------------------------------------
// TenantService
// ---------------------------------------------------------------------------

/**
 * TenantService handles merchant account lifecycle and pricing-rule management.
 *
 * Design invariants:
 * - Every pricing-rule query is scoped by tenantId at the repository level.
 * - Webhook secrets are NOT auto-generated here; that belongs to a dedicated
 *   WebhookConfigService once per-tenant webhook configuration is implemented.
 * - Tenant creation and pricing-rule management are intentionally separate
 *   from webhook and provider configuration.
 * - A disabled tenant cannot create new invoices (checked by callers via
 *   assertActive()).
 */
export class TenantService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  // ---- Tenant lifecycle ----------------------------------------------------

  /**
   * Create a new tenant and issue its first API key.
   * The plaintext API key is returned exactly once and is not stored anywhere.
   */
  async createTenant(input: CreateTenantInput): Promise<CreateTenantResult> {
    const parsed = tenantCreateSchema.parse(input)
    const now = new Date().toISOString()

    const tenant: Tenant = {
      id: `tnt_${randomUUID()}`,
      name: parsed.name,
      disabled: false,
      webhookUrl: null,
      webhookSecret: null,
      prevWebhookSecret: null,
      secretRotatedAt: null,
      createdAt: now,
      updatedAt: now,
    }

    this.repo.createTenant(tenant)
    const { key, record } = await this.apiKeyService.generate(tenant.id, parsed.apiKeyLabel)

    return { tenant, apiKey: key, apiKeyRecord: record }
  }

  /** Disable a tenant, preventing new invoice creation. Idempotent. */
  disableTenant(tenantId: string): void {
    const t = this.repo.tenant(tenantId)
    if (!t) throw Object.assign(new Error('Tenant not found'), { statusCode: 404, code: 'TENANT_NOT_FOUND' })
    this.repo.disableTenant(tenantId)
  }

  /** Re-enable a previously disabled tenant. */
  enableTenant(tenantId: string): void {
    const t = this.repo.tenant(tenantId)
    if (!t) throw Object.assign(new Error('Tenant not found'), { statusCode: 404, code: 'TENANT_NOT_FOUND' })
    this.repo.enableTenant(tenantId)
  }

  /**
   * Assert that the tenant exists and is not disabled.
   * Callers (e.g. PaymentIntentService) must invoke this before creating invoices.
   * Returns the tenant if valid.
   */
  assertActive(tenantId: string): Tenant {
    const t = this.repo.tenant(tenantId)
    if (!t) {
      throw Object.assign(new Error('Tenant not found'), { statusCode: 404, code: 'TENANT_NOT_FOUND' })
    }
    if (t.disabled) {
      throw Object.assign(
        new Error('Tenant is disabled and cannot create new invoices'),
        { statusCode: 403, code: 'TENANT_DISABLED' },
      )
    }
    return t
  }

  // ---- Pricing rules -------------------------------------------------------

  /**
   * Idempotent upsert for a pricing rule.
   * Multiple calls with the same (tenantId, productId) update the existing record.
   * A different tenantId for the same productId creates a separate, isolated rule.
   */
  upsertPricingRule(tenantId: string, input: UpsertPricingRuleInput): PricingRule {
    // Validate tenant exists and is active
    const t = this.repo.tenant(tenantId)
    if (!t) throw Object.assign(new Error('Tenant not found'), { statusCode: 404, code: 'TENANT_NOT_FOUND' })

    const parsed = pricingRuleSchema.parse(input)
    const now = new Date().toISOString()

    // We pass a generated id; ON CONFLICT DO UPDATE will discard it if the rule
    // already exists (the existing id is preserved in that case)
    const rule: PricingRule = {
      id: `pr_${randomUUID()}`,
      tenantId,
      productId: parsed.productId,
      name: parsed.name,
      description: parsed.description ?? null,
      mode: parsed.mode,
      priceSats: parsed.priceSats ?? null,
      maxPriceSats: parsed.maxPriceSats ?? null,
      active: parsed.active,
      maxQuantity: parsed.maxQuantity,
      offerEnabled: parsed.offerEnabled,
      createdAt: now,
      updatedAt: now,
    }

    return this.repo.upsertPricingRule(rule)
  }

  /** Deactivate a pricing rule (soft delete). Tenant-scoped. */
  deactivatePricingRule(tenantId: string, productId: string): void {
    const t = this.repo.tenant(tenantId)
    if (!t) throw Object.assign(new Error('Tenant not found'), { statusCode: 404, code: 'TENANT_NOT_FOUND' })
    const rule = this.repo.pricingRule(tenantId, productId)
    if (!rule) {
      throw Object.assign(new Error('Pricing rule not found'), { statusCode: 404, code: 'RULE_NOT_FOUND' })
    }
    this.repo.deactivatePricingRule(tenantId, productId)
  }

  /** List all active pricing rules for a tenant. Cross-tenant access is impossible. */
  listPricingRules(tenantId: string, includeInactive = false): PricingRule[] {
    const t = this.repo.tenant(tenantId)
    if (!t) throw Object.assign(new Error('Tenant not found'), { statusCode: 404, code: 'TENANT_NOT_FOUND' })
    return this.repo.listPricingRules(tenantId, includeInactive)
  }

  /** Tenant-scoped lookup by productId */
  getPricingRule(tenantId: string, productId: string): PricingRule | undefined {
    return this.repo.pricingRule(tenantId, productId)
  }

  /** Tenant-scoped lookup by pricing rule ID */
  getPricingRuleById(tenantId: string, id: string): PricingRule | undefined {
    return this.repo.pricingRuleById(tenantId, id)
  }

  // ---- API key revocation (tenant-scoped) ----------------------------------

  revokeApiKey(tenantId: string, keyId: string): void {
    this.repo.revokeApiKey(keyId, tenantId)
  }

  // ---- Webhook Configuration -----------------------------------------------

  configureWebhookUrl(tenantId: string, url: string | null): Tenant {
    const t = this.assertActive(tenantId)
    this.repo.updateWebhookConfig(tenantId, url, t.webhookSecret, t.prevWebhookSecret, t.secretRotatedAt)
    return this.repo.tenant(tenantId)!
  }

  rotateWebhookSecret(tenantId: string): Tenant {
    const t = this.assertActive(tenantId)
    const newSecret = randomBytes(32).toString('hex')
    this.repo.updateWebhookConfig(tenantId, t.webhookUrl, newSecret, t.webhookSecret, new Date().toISOString())
    return this.repo.tenant(tenantId)!
  }
}
