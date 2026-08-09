import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Domain entities (tenant-scoped)
// ---------------------------------------------------------------------------

export type PricingMode = 'fixed' | 'open_amount' | 'backend_defined'

export interface Tenant {
  id: string
  name: string
  /** If true the tenant is suspended and cannot create new invoices */
  disabled: boolean
  webhookUrl: string | null
  webhookSecret: string | null
  prevWebhookSecret: string | null
  secretRotatedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MerchantApiKey {
  id: string
  tenantId: string
  keyHash: string     // SHA-256 hex of the plaintext key — never store plaintext
  keyPrefix: string   // first 12 chars of key for display/revocation (safe)
  label: string
  createdAt: string
  revokedAt: string | null
}

export interface PricingRule {
  id: string
  tenantId: string
  productId: string     // slug, UNIQUE per tenant (enforced via DB)
  name: string
  description: string | null
  mode: PricingMode
  /**
   * Fixed / base price in satoshis (decimal string).
   * For open_amount: null means no lower bound set.
   */
  priceSats: string | null
  /**
   * Maximum price in satoshis (open_amount mode only).
   * null = no upper bound.
   */
  maxPriceSats: string | null
  active: boolean
  maxQuantity: number
  offerEnabled: boolean
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Minimal tenant schema (self-contained — no dependency on the full repo)
// ---------------------------------------------------------------------------

const TENANT_SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;

  CREATE TABLE IF NOT EXISTS schema_migrations (
    version  INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tenants (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    disabled      INTEGER NOT NULL DEFAULT 0,
    webhook_url   TEXT,
    webhook_secret TEXT,
    prev_webhook_secret TEXT,
    secret_rotated_at TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS merchant_api_keys (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants(id),
    key_hash   TEXT UNIQUE NOT NULL,
    key_prefix TEXT NOT NULL,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS pricing_rules (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL REFERENCES tenants(id),
    product_id    TEXT NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT,
    mode          TEXT NOT NULL DEFAULT 'fixed',
    price_sats    TEXT,
    max_price_sats TEXT,
    active        INTEGER NOT NULL DEFAULT 1,
    max_quantity  INTEGER NOT NULL DEFAULT 10,
    offer_enabled INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE(tenant_id, product_id)
  );
`

// ---------------------------------------------------------------------------
// TenantRepository — all methods require tenantId to enforce isolation
// ---------------------------------------------------------------------------

export class TenantRepository {
  protected db: DatabaseSync

  constructor(url: string) {
    const file = url.replace(/^file:/, '')
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(TENANT_SCHEMA)
    this.db.exec(`INSERT OR IGNORE INTO schema_migrations VALUES (1, '${new Date().toISOString()}')`)
  }

  // ---- Tenants -------------------------------------------------------------

  createTenant(tenant: Tenant): void {
    this.db
      .prepare('INSERT INTO tenants (id, name, disabled, webhook_url, webhook_secret, prev_webhook_secret, secret_rotated_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(tenant.id, tenant.name, tenant.disabled ? 1 : 0, tenant.webhookUrl, tenant.webhookSecret, tenant.prevWebhookSecret, tenant.secretRotatedAt, tenant.createdAt, tenant.updatedAt)
  }

  tenant(id: string): Tenant | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, disabled, webhook_url webhookUrl, webhook_secret webhookSecret, prev_webhook_secret prevWebhookSecret, secret_rotated_at secretRotatedAt, created_at createdAt, updated_at updatedAt
         FROM tenants WHERE id=?`,
      )
      .get(id) as Record<string, unknown> | undefined
    if (!row) return undefined
    return { ...row, disabled: row.disabled === 1 } as Tenant
  }

  disableTenant(id: string): void {
    this.db
      .prepare(`UPDATE tenants SET disabled=1, updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), id)
  }

  enableTenant(id: string): void {
    this.db
      .prepare(`UPDATE tenants SET disabled=0, updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), id)
  }

  updateWebhookConfig(id: string, url: string | null, secret: string | null, prevSecret: string | null, rotatedAt: string | null): void {
    this.db
      .prepare(`UPDATE tenants SET webhook_url=?, webhook_secret=?, prev_webhook_secret=?, secret_rotated_at=?, updated_at=? WHERE id=?`)
      .run(url, secret, prevSecret, rotatedAt, new Date().toISOString(), id)
  }

  // ---- API Keys (tenant-scoped) --------------------------------------------

  createApiKey(key: MerchantApiKey): void {
    this.db
      .prepare('INSERT INTO merchant_api_keys VALUES (?,?,?,?,?,?,?)')
      .run(key.id, key.tenantId, key.keyHash, key.keyPrefix, key.label, key.createdAt, key.revokedAt)
  }

  apiKeyByHash(keyHash: string): MerchantApiKey | undefined {
    return this.db
      .prepare(
        `SELECT id, tenant_id tenantId, key_hash keyHash, key_prefix keyPrefix,
          label, created_at createdAt, revoked_at revokedAt
         FROM merchant_api_keys WHERE key_hash=? AND revoked_at IS NULL`,
      )
      .get(keyHash) as MerchantApiKey | undefined
  }

  revokeApiKey(keyId: string, tenantId: string): void {
    // Tenant-scoped revocation prevents cross-tenant revocation
    this.db
      .prepare(`UPDATE merchant_api_keys SET revoked_at=? WHERE id=? AND tenant_id=?`)
      .run(new Date().toISOString(), keyId, tenantId)
  }

  // ---- Pricing Rules (always scoped to tenantId) ---------------------------

  /**
   * Real tenant-scoped upsert: inserts if no rule exists, updates in-place if
   * the same (tenant_id, product_id) pair already exists.
   * Never fails with a unique-constraint error on duplicate calls.
   */
  upsertPricingRule(rule: PricingRule): PricingRule {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO pricing_rules
           (id, tenant_id, product_id, name, description, mode,
            price_sats, max_price_sats, active, max_quantity, offer_enabled,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, product_id) DO UPDATE SET
           name           = excluded.name,
           description    = excluded.description,
           mode           = excluded.mode,
           price_sats     = excluded.price_sats,
           max_price_sats = excluded.max_price_sats,
           active         = excluded.active,
           max_quantity   = excluded.max_quantity,
           offer_enabled  = excluded.offer_enabled,
           updated_at     = ?`,
      )
      .run(
        rule.id,
        rule.tenantId,
        rule.productId,
        rule.name,
        rule.description,
        rule.mode,
        rule.priceSats,
        rule.maxPriceSats,
        rule.active ? 1 : 0,
        rule.maxQuantity,
        rule.offerEnabled ? 1 : 0,
        rule.createdAt,
        now,
        // extra param for the DO UPDATE SET updated_at = ?
        now,
      )
    // Return the persisted record (may differ from input after an update)
    return this.pricingRule(rule.tenantId, rule.productId)!
  }

  /** Tenant-scoped lookup by productId — cross-tenant lookups always return undefined */
  pricingRule(tenantId: string, productId: string): PricingRule | undefined {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id tenantId, product_id productId, name, description,
          mode, price_sats priceSats, max_price_sats maxPriceSats,
          active, max_quantity maxQuantity, offer_enabled offerEnabled,
          created_at createdAt, updated_at updatedAt
         FROM pricing_rules WHERE tenant_id=? AND product_id=?`,
      )
      .get(tenantId, productId) as Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      ...row,
      active: row.active === 1,
      offerEnabled: row.offerEnabled === 1,
    } as PricingRule
  }

  /** Tenant-scoped lookup by rule ID */
  pricingRuleById(tenantId: string, id: string): PricingRule | undefined {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id tenantId, product_id productId, name, description,
          mode, price_sats priceSats, max_price_sats maxPriceSats,
          active, max_quantity maxQuantity, offer_enabled offerEnabled,
          created_at createdAt, updated_at updatedAt
         FROM pricing_rules WHERE tenant_id=? AND id=?`,
      )
      .get(tenantId, id) as Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      ...row,
      active: row.active === 1,
      offerEnabled: row.offerEnabled === 1,
    } as PricingRule
  }

  listPricingRules(tenantId: string, includeInactive = false): PricingRule[] {
    const sql = includeInactive
      ? `SELECT id, tenant_id tenantId, product_id productId, name, description,
           mode, price_sats priceSats, max_price_sats maxPriceSats,
           active, max_quantity maxQuantity, offer_enabled offerEnabled,
           created_at createdAt, updated_at updatedAt
         FROM pricing_rules WHERE tenant_id=? ORDER BY created_at ASC`
      : `SELECT id, tenant_id tenantId, product_id productId, name, description,
           mode, price_sats priceSats, max_price_sats maxPriceSats,
           active, max_quantity maxQuantity, offer_enabled offerEnabled,
           created_at createdAt, updated_at updatedAt
         FROM pricing_rules WHERE tenant_id=? AND active=1 ORDER BY created_at ASC`
    return (this.db.prepare(sql).all(tenantId) as Record<string, unknown>[]).map((row) => ({
      ...row,
      active: row.active === 1,
      offerEnabled: row.offerEnabled === 1,
    })) as PricingRule[]
  }

  deactivatePricingRule(tenantId: string, productId: string): void {
    this.db
      .prepare(`UPDATE pricing_rules SET active=0, updated_at=? WHERE tenant_id=? AND product_id=?`)
      .run(new Date().toISOString(), tenantId, productId)
  }
}
