<<<<<<< HEAD
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  LightningInvoice,
  InvoiceState,
  CreatedOffer,
} from "@cherito/bitcoin-sdk";
export interface Session {
  id: string;
  orderId: string;
  productId: string;
  quantity: number;
  amountSats: string;
  paymentRequest: string;
  paymentHash: string;
  expiresAt: string;
  state: InvoiceState;
  tokenHash: string;
}
export class Repository {
  private db: DatabaseSync;
  constructor(url: string) {
    const file = url.replace(/^file:/, "");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      `PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,name TEXT NOT NULL,price_sats TEXT NOT NULL,active INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,product_id TEXT NOT NULL,quantity INTEGER NOT NULL,amount_sats TEXT NOT NULL,state TEXT NOT NULL,confirmed_at TEXT);CREATE TABLE IF NOT EXISTS lightning_invoices(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,provider TEXT NOT NULL,payment_hash TEXT UNIQUE NOT NULL,payment_request TEXT NOT NULL,amount_sats TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,settled_at TEXT,provider_add_index TEXT,provider_settle_index TEXT);CREATE TABLE IF NOT EXISTS checkout_sessions(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,product_id TEXT NOT NULL,quantity INTEGER NOT NULL,amount_sats TEXT NOT NULL,payment_request TEXT NOT NULL,payment_hash TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL,token_hash TEXT NOT NULL);CREATE TABLE IF NOT EXISTS idempotency_records(key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,session_id TEXT NOT NULL,status_token TEXT NOT NULL,expires_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS bolt12_offers(id TEXT PRIMARY KEY,product_id TEXT NOT NULL,offer TEXT NOT NULL,amount_sats TEXT NOT NULL,created_at TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, payment_intent_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tenant_id, payment_intent_id, type));
       CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES webhook_events(id), tenant_id TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, next_attempt_at TEXT, delivered_at TEXT, created_at TEXT NOT NULL);`,
    );
  }
  createCheckout(
    s: Session,
    i: LightningInvoice,
    x: { key: string; payloadHash: string; token: string; expiresAt: string },
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO orders VALUES(?,?,?,?,?,NULL)")
        .run(s.orderId, s.productId, s.quantity, s.amountSats, "pending");
      this.db
        .prepare(
          "INSERT INTO lightning_invoices VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          i.providerInvoiceId,
          s.orderId,
          "lnd",
          s.paymentHash,
          s.paymentRequest,
          s.amountSats,
          s.state,
          new Date().toISOString(),
          s.expiresAt,
          null,
          i.providerAddIndex ?? null,
          i.providerSettleIndex ?? null,
        );
      this.db
        .prepare("INSERT INTO checkout_sessions VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(
          s.id,
          s.orderId,
          s.productId,
          s.quantity,
          s.amountSats,
          s.paymentRequest,
          s.paymentHash,
          s.expiresAt,
          s.state,
          s.tokenHash,
        );
      this.db
        .prepare("INSERT INTO idempotency_records VALUES(?,?,?,?,?)")
        .run(x.key, x.payloadHash, s.id, x.token, x.expiresAt);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  session(id: string) {
    return this.db
      .prepare(
        "SELECT id,order_id orderId,product_id productId,quantity,amount_sats amountSats,payment_request paymentRequest,payment_hash paymentHash,expires_at expiresAt,state,token_hash tokenHash FROM checkout_sessions WHERE id=?",
      )
      .get(id) as unknown as Session | undefined;
  }
  idempotency(key: string) {
    return this.db
      .prepare(
        "SELECT payload_hash payloadHash,session_id sessionId,status_token token,expires_at expiresAt FROM idempotency_records WHERE key=?",
      )
      .get(key) as
      | {
          payloadHash: string;
          sessionId: string;
          token: string;
          expiresAt: string;
        }
      | undefined;
  }
  settle(hash: string, i: LightningInvoice, webhookEvent?: { id: string; tenantId: string; paymentIntentId: string; type: string; payload: string; createdAt: string }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE lightning_invoices SET state=?,settled_at=?,provider_settle_index=? WHERE payment_hash=?",
        )
        .run(i.state, i.settledAt ?? null, i.providerSettleIndex ?? null, hash);
      this.db
        .prepare("UPDATE checkout_sessions SET state=? WHERE payment_hash=?")
        .run(i.state, hash);
      if (i.state === "settled")
        this.db
          .prepare(
            "UPDATE orders SET state='confirmed',confirmed_at=COALESCE(confirmed_at,?) WHERE id=(SELECT order_id FROM lightning_invoices WHERE payment_hash=?) AND state!='confirmed'",
          )
          .run(i.settledAt ?? new Date().toISOString(), hash);
          
      if (webhookEvent) {
        this.db
          .prepare('INSERT INTO webhook_events (id, tenant_id, payment_intent_id, type, payload, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING')
          .run(webhookEvent.id, webhookEvent.tenantId, webhookEvent.paymentIntentId, webhookEvent.type, webhookEvent.payload, webhookEvent.createdAt);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  saveOffer(productId: string, o: CreatedOffer) {
    this.db
      .prepare("INSERT INTO bolt12_offers VALUES(?,?,?,?,?)")
      .run(
        o.offerId,
        productId,
        o.offer,
        o.amountSats.toString(),
        new Date().toISOString(),
      );
=======
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { invoiceStateToIntentStatus } from '@cherito/bitcoin-sdk'
import type { LightningInvoice, PaymentIntentStatus, CreatedOffer } from '@cherito/bitcoin-sdk'

// ---------------------------------------------------------------------------
// Domain entities
// ---------------------------------------------------------------------------

export interface Tenant {
  id: string
  name: string
  webhookUrl: string | null
  webhookSecret: string | null
  disabled: boolean
  createdAt: string
  updatedAt: string
}

export interface MerchantApiKey {
  id: string
  tenantId: string
  keyHash: string
  keyPrefix: string
  label: string
  createdAt: string
  revokedAt: string | null
}

/**
 * PaymentIntent is the canonical payment record. All money fields are bigint
 * serialized as decimal strings at API boundaries.
 *
 * Status lifecycle:
 *   requires_payment → processing → succeeded
 *                    ↓            ↓
 *                  expired     failed/canceled
 *
 * Terminal states (succeeded, expired, failed, canceled) are never reversed
 * by stale events — enforced by the SQL WHERE clause in updatePaymentIntentStatus.
 */
export interface PaymentIntent {
  id: string
  tenantId: string
  pricingRuleId: string | null
  paymentLinkId: string | null
  /** Optional merchant order reference (e.g. WooCommerce order ID), unique per tenant */
  merchantOrderId: string | null
  amountSats: string
  currency: 'sat'
  description: string
  metadata: string | null
  status: PaymentIntentStatus
  paymentRequest: string
  paymentHash: string
  providerInvoiceId: string
  /**
   * Random 32-byte hex stored with the intent.
   * clientSecret = HMAC-SHA256(intentSecret, intentId + ":" + tenantId)
   * Allows deterministic re-derivation of the clientSecret on idempotent retries.
   */
  intentSecret: string
  clientSecretHash: string
  idempotencyKey: string | null
  idempotencyPayloadHash: string | null
  expiresAt: string
  settledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface PaymentLink {
  id: string
  slug: string
  tenantId: string
  pricingRuleId: string | null
  /** Mode: fixed | open_amount | donation */
  mode: 'fixed' | 'open_amount' | 'donation'
  amountSats: string | null
  minAmountSats: string | null
  maxAmountSats: string | null
  label: string
  description: string | null
  maxUses: number | null
  useCount: number
  active: boolean
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export interface PricingRule {
  id: string
  tenantId: string
  productId: string
  name: string
  description: string | null
  mode: 'fixed' | 'open_amount' | 'backend_defined'
  priceSats: string | null
  maxPriceSats: string | null
  active: boolean
  maxQuantity: number
  offerEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface WebhookDelivery {
  id: string
  tenantId: string
  paymentIntentId: string
  event: string
  payload: string
  signature: string
  status: 'pending' | 'delivered' | 'failed'
  attemptCount: number
  lastAttemptAt: string | null
  nextAttemptAt: string | null
  deliveredAt: string | null
  createdAt: string
}

/** @deprecated Use PaymentIntent instead */
export interface Session {
  id: string
  orderId: string
  productId: string
  quantity: number
  amountSats: string
  paymentRequest: string
  paymentHash: string
  expiresAt: string
  status: PaymentIntentStatus
  state: PaymentIntentStatus
  tokenHash: string
}

// ---------------------------------------------------------------------------
// Migration system
// ---------------------------------------------------------------------------

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenants (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        webhook_url TEXT,
        webhook_secret TEXT,
        disabled    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
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
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        product_id      TEXT NOT NULL,
        name            TEXT NOT NULL,
        description     TEXT,
        mode            TEXT NOT NULL DEFAULT 'fixed',
        price_sats      TEXT,
        max_price_sats  TEXT,
        active          INTEGER NOT NULL DEFAULT 1,
        max_quantity    INTEGER NOT NULL DEFAULT 10,
        offer_enabled   INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE(tenant_id, product_id)
      );

      CREATE TABLE IF NOT EXISTS payment_links (
        id              TEXT PRIMARY KEY,
        slug            TEXT UNIQUE NOT NULL,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        pricing_rule_id TEXT REFERENCES pricing_rules(id),
        mode            TEXT NOT NULL DEFAULT 'fixed',
        amount_sats     TEXT,
        min_amount_sats TEXT,
        max_amount_sats TEXT,
        label           TEXT NOT NULL,
        description     TEXT,
        max_uses        INTEGER,
        use_count       INTEGER NOT NULL DEFAULT 0,
        active          INTEGER NOT NULL DEFAULT 1,
        expires_at      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payment_intents (
        id                       TEXT PRIMARY KEY,
        tenant_id                TEXT NOT NULL REFERENCES tenants(id),
        pricing_rule_id          TEXT REFERENCES pricing_rules(id),
        payment_link_id          TEXT REFERENCES payment_links(id),
        merchant_order_id        TEXT,
        amount_sats              TEXT NOT NULL,
        currency                 TEXT NOT NULL DEFAULT 'sat',
        description              TEXT NOT NULL DEFAULT '',
        metadata                 TEXT,
        status                   TEXT NOT NULL DEFAULT 'requires_payment',
        payment_request          TEXT NOT NULL,
        payment_hash             TEXT UNIQUE NOT NULL,
        provider_invoice_id      TEXT NOT NULL,
        intent_secret            TEXT NOT NULL,
        client_secret_hash       TEXT NOT NULL,
        idempotency_key          TEXT,
        idempotency_payload_hash TEXT,
        expires_at               TEXT NOT NULL,
        settled_at               TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_merchant_order
        ON payment_intents(tenant_id, merchant_order_id)
        WHERE merchant_order_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_payment_intents_tenant ON payment_intents(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_payment_intents_hash ON payment_intents(payment_hash);
      CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_idem ON payment_intents(tenant_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id                TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL REFERENCES tenants(id),
        payment_intent_id TEXT NOT NULL REFERENCES payment_intents(id),
        event             TEXT NOT NULL,
        payload           TEXT NOT NULL,
        signature         TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending',
        attempt_count     INTEGER NOT NULL DEFAULT 0,
        last_attempt_at   TEXT,
        next_attempt_at   TEXT,
        delivered_at      TEXT,
        created_at        TEXT NOT NULL,
        UNIQUE(tenant_id, payment_intent_id, event)
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_next ON webhook_deliveries(next_attempt_at)
        WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS bolt12_offers (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        product_id  TEXT NOT NULL,
        offer       TEXT NOT NULL,
        amount_sats TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      -- System/legacy tenant for backward-compatible checkout-sessions API
      INSERT OR IGNORE INTO tenants (id, name, webhook_url, webhook_secret, disabled, created_at, updated_at)
      VALUES ('legacy', 'Legacy Checkout', NULL, NULL, 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
    `,
  },
]

// ---------------------------------------------------------------------------
// PI SELECT columns (reused everywhere)
// ---------------------------------------------------------------------------

const PI_COLS = `
  id, tenant_id tenantId, pricing_rule_id pricingRuleId,
  payment_link_id paymentLinkId, merchant_order_id merchantOrderId,
  amount_sats amountSats, currency, description, metadata, status,
  payment_request paymentRequest, payment_hash paymentHash,
  provider_invoice_id providerInvoiceId, intent_secret intentSecret,
  client_secret_hash clientSecretHash, idempotency_key idempotencyKey,
  idempotency_payload_hash idempotencyPayloadHash,
  expires_at expiresAt, settled_at settledAt,
  created_at createdAt, updated_at updatedAt
`

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class Repository {
  private db: DatabaseSync

  constructor(url: string) {
    const file = url.replace(/^file:/, '')
    if (file.startsWith(':memory:')) {
      this.db = new DatabaseSync(':memory:')
    } else {
      mkdirSync(dirname(file), { recursive: true })
      this.db = new DatabaseSync(file)
    }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
    this.applyMigrations()
  }

  // ---- Migrations ----------------------------------------------------------

  private applyMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `)
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
        .map((r) => r.version),
    )
    for (const migration of MIGRATIONS) {
      if (!applied.has(migration.version)) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.db.exec(migration.sql)
          this.db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(
            migration.version,
            new Date().toISOString(),
          )
          this.db.exec('COMMIT')
        } catch (e) {
          this.db.exec('ROLLBACK')
          throw e
        }
      }
    }
  }

  // ---- Tenants -------------------------------------------------------------

  createTenant(tenant: Tenant): void {
    this.db
      .prepare('INSERT INTO tenants VALUES (?,?,?,?,?,?,?)')
      .run(tenant.id, tenant.name, tenant.webhookUrl, tenant.webhookSecret,
          tenant.disabled ? 1 : 0, tenant.createdAt, tenant.updatedAt)
  }

  tenant(id: string): Tenant | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, webhook_url webhookUrl, webhook_secret webhookSecret,
          disabled, created_at createdAt, updated_at updatedAt
         FROM tenants WHERE id=?`,
      )
      .get(id) as Record<string, unknown> | undefined
    if (!row) return undefined
    return { ...row, disabled: row.disabled === 1 } as Tenant
  }

  // ---- API Keys ------------------------------------------------------------

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
    this.db
      .prepare('UPDATE merchant_api_keys SET revoked_at=? WHERE id=? AND tenant_id=?')
      .run(new Date().toISOString(), keyId, tenantId)
  }

  // ---- Pricing Rules -------------------------------------------------------

  upsertPricingRule(rule: PricingRule): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO pricing_rules
           (id, tenant_id, product_id, name, description, mode,
            price_sats, max_price_sats, active, max_quantity, offer_enabled,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, product_id) DO UPDATE SET
           name=excluded.name, description=excluded.description,
           mode=excluded.mode, price_sats=excluded.price_sats,
           max_price_sats=excluded.max_price_sats, active=excluded.active,
           max_quantity=excluded.max_quantity, offer_enabled=excluded.offer_enabled,
           updated_at=?`,
      )
      .run(rule.id, rule.tenantId, rule.productId, rule.name, rule.description,
           rule.mode, rule.priceSats, rule.maxPriceSats,
           rule.active ? 1 : 0, rule.maxQuantity, rule.offerEnabled ? 1 : 0,
           rule.createdAt, now, now)
  }

  pricingRule(tenantId: string, productId: string): PricingRule | undefined {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id tenantId, product_id productId, name, description,
          mode, price_sats priceSats, max_price_sats maxPriceSats,
          active, max_quantity maxQuantity, offer_enabled offerEnabled,
          created_at createdAt, updated_at updatedAt
         FROM pricing_rules WHERE tenant_id=? AND product_id=? AND active=1`,
      )
      .get(tenantId, productId) as Record<string, unknown> | undefined
    if (!row) return undefined
    return { ...row, active: row.active === 1, offerEnabled: row.offerEnabled === 1 } as PricingRule
  }

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
    return { ...row, active: row.active === 1, offerEnabled: row.offerEnabled === 1 } as PricingRule
  }

  // ---- Payment Links -------------------------------------------------------

  createPaymentLink(link: PaymentLink): void {
    this.db
      .prepare(
        `INSERT INTO payment_links VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(link.id, link.slug, link.tenantId, link.pricingRuleId,
           link.mode, link.amountSats, link.minAmountSats, link.maxAmountSats,
           link.label, link.description, link.maxUses, link.useCount,
           link.active ? 1 : 0, link.expiresAt, link.createdAt, link.updatedAt)
  }

  paymentLinkBySlug(slug: string): PaymentLink | undefined {
    const row = this.db
      .prepare(
        `SELECT id, slug, tenant_id tenantId, pricing_rule_id pricingRuleId,
          mode, amount_sats amountSats, min_amount_sats minAmountSats,
          max_amount_sats maxAmountSats, label, description,
          max_uses maxUses, use_count useCount, active, expires_at expiresAt,
          created_at createdAt, updated_at updatedAt
         FROM payment_links WHERE slug=? AND active=1`,
      )
      .get(slug) as Record<string, unknown> | undefined
    if (!row) return undefined
    return { ...row, active: row.active === 1 } as PaymentLink
  }

  /**
   * Atomically check and increment use count.
   * Returns true if the increment succeeded (i.e., limit not reached),
   * false if the link is exhausted or expired.
   */
  incrementPaymentLinkUseCountAtomic(id: string, maxUses: number | null): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const link = this.db
        .prepare('SELECT use_count useCount FROM payment_links WHERE id=?')
        .get(id) as { useCount: number } | undefined
      if (!link) { this.db.exec('ROLLBACK'); return false }
      if (maxUses !== null && link.useCount >= maxUses) { this.db.exec('ROLLBACK'); return false }
      this.db.prepare('UPDATE payment_links SET use_count=use_count+1, updated_at=? WHERE id=?')
        .run(new Date().toISOString(), id)
      this.db.exec('COMMIT')
      return true
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // ---- Payment Intents -----------------------------------------------------

  createPaymentIntent(intent: PaymentIntent): void {
    this.db
      .prepare(
        `INSERT INTO payment_intents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        intent.id, intent.tenantId, intent.pricingRuleId, intent.paymentLinkId,
        intent.merchantOrderId, intent.amountSats, intent.currency, intent.description,
        intent.metadata, intent.status, intent.paymentRequest, intent.paymentHash,
        intent.providerInvoiceId, intent.intentSecret, intent.clientSecretHash,
        intent.idempotencyKey, intent.idempotencyPayloadHash,
        intent.expiresAt, intent.settledAt, intent.createdAt, intent.updatedAt,
      )
  }

  paymentIntent(id: string, tenantId: string): PaymentIntent | undefined {
    return this.db
      .prepare(`SELECT ${PI_COLS} FROM payment_intents WHERE id=? AND tenant_id=?`)
      .get(id, tenantId) as PaymentIntent | undefined
  }

  paymentIntentByHash(paymentHash: string): PaymentIntent | undefined {
    return this.db
      .prepare(`SELECT ${PI_COLS} FROM payment_intents WHERE payment_hash=?`)
      .get(paymentHash) as PaymentIntent | undefined
  }

  paymentIntentByIdempotencyKey(tenantId: string, key: string): PaymentIntent | undefined {
    return this.db
      .prepare(
        `SELECT ${PI_COLS} FROM payment_intents
         WHERE tenant_id=? AND idempotency_key=? AND expires_at > ?`,
      )
      .get(tenantId, key, new Date().toISOString()) as PaymentIntent | undefined
  }

  pendingPaymentIntents(): PaymentIntent[] {
    return this.db
      .prepare(
        `SELECT ${PI_COLS} FROM payment_intents
         WHERE status IN ('requires_payment','processing')
           AND expires_at > ?`,
      )
      .all(new Date().toISOString()) as unknown as PaymentIntent[]
  }

  /**
   * Compare-and-set status update.
   * Only updates if the current status is NOT already a terminal state.
   * Returns true if the row was actually updated (transition occurred).
   */
  updatePaymentIntentStatus(
    paymentHash: string,
    invoice: LightningInvoice,
    newStatus: PaymentIntentStatus,
  ): boolean {
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db
        .prepare(
          `UPDATE payment_intents
           SET status=?, settled_at=?, updated_at=?
           WHERE payment_hash=?
             AND status NOT IN ('succeeded','canceled','failed','expired')`,
        )
        .run(
          newStatus,
          newStatus === 'succeeded' ? (invoice.settledAt ?? now) : null,
          now,
          paymentHash,
        )
      this.db.exec('COMMIT')
      return (result as { changes: number }).changes > 0
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** Mark a locally-expired intent without querying the provider */
  markIntentExpired(paymentHash: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE payment_intents SET status='expired', updated_at=?
         WHERE payment_hash=? AND status NOT IN ('succeeded','canceled','failed','expired')`,
      )
      .run(now, paymentHash)
  }

  // ---- Webhooks ------------------------------------------------------------

  createWebhookDelivery(delivery: WebhookDelivery): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_deliveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        delivery.id, delivery.tenantId, delivery.paymentIntentId,
        delivery.event, delivery.payload, delivery.signature,
        delivery.status, delivery.attemptCount, delivery.lastAttemptAt,
        delivery.nextAttemptAt, delivery.deliveredAt, delivery.createdAt,
      )
  }

  pendingWebhookDeliveries(): WebhookDelivery[] {
    return this.db
      .prepare(
        `SELECT id, tenant_id tenantId, payment_intent_id paymentIntentId,
          event, payload, signature, status, attempt_count attemptCount,
          last_attempt_at lastAttemptAt, next_attempt_at nextAttemptAt,
          delivered_at deliveredAt, created_at createdAt
         FROM webhook_deliveries
         WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC LIMIT 50`,
      )
      .all(new Date().toISOString()) as unknown as WebhookDelivery[]
  }

  markWebhookDelivered(id: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status='delivered', delivered_at=?, last_attempt_at=?, attempt_count=attempt_count+1
         WHERE id=?`,
      )
      .run(now, now, id)
  }

  markWebhookFailed(id: string, nextAttemptAt: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET attempt_count=attempt_count+1, last_attempt_at=?, next_attempt_at=?
         WHERE id=?`,
      )
      .run(now, nextAttemptAt, id)
  }

  markWebhookPermanentlyFailed(id: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status='failed', last_attempt_at=?, attempt_count=attempt_count+1
         WHERE id=?`,
      )
      .run(now, id)
  }

  // ---- BOLT12 Offers -------------------------------------------------------

  saveOffer(tenantId: string, productId: string, o: CreatedOffer): void {
    this.db
      .prepare('INSERT INTO bolt12_offers VALUES (?,?,?,?,?,?)')
      .run(o.offerId, tenantId, productId, o.offer, o.amountSats.toString(), new Date().toISOString())
  }

  // ---- Legacy compatibility (for backward-compatible tests) ----------------

  /** @deprecated Use createPaymentIntent instead. */
  createCheckout(
    s: Session,
    _i: LightningInvoice,
    x: { key: string; payloadHash: string; token: string; expiresAt: string },
  ): void {
    const now = new Date().toISOString()
    const intent: PaymentIntent = {
      id: s.id,
      tenantId: 'legacy',
      pricingRuleId: null,
      paymentLinkId: null,
      merchantOrderId: null,
      amountSats: s.amountSats,
      currency: 'sat',
      description: `Order ${s.orderId}`,
      metadata: JSON.stringify({ orderId: s.orderId, productId: s.productId, quantity: s.quantity, _legacyToken: x.token }),
      status: 'requires_payment',
      paymentRequest: s.paymentRequest,
      paymentHash: s.paymentHash,
      providerInvoiceId: _i.providerInvoiceId,
      intentSecret: x.token,  // store legacy token as intentSecret for re-derivation compat
      clientSecretHash: s.tokenHash,
      idempotencyKey: x.key,
      idempotencyPayloadHash: x.payloadHash,
      expiresAt: s.expiresAt,
      settledAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.createPaymentIntent(intent)
  }

  /** @deprecated Use paymentIntent() instead. */
  session(id: string): Session | undefined {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id tenantId, pricing_rule_id pricingRuleId,
          metadata, amount_sats amountSats, payment_request paymentRequest,
          payment_hash paymentHash, expires_at expiresAt, status,
          client_secret_hash clientSecretHash
         FROM payment_intents WHERE id=?`,
      )
      .get(id) as (PaymentIntent & { clientSecretHash: string }) | undefined
    if (!row) return undefined
    const meta = row.metadata ? (JSON.parse(row.metadata) as { orderId?: string; productId?: string; quantity?: number }) : {}
    return {
      id: row.id,
      orderId: meta.orderId ?? row.id,
      productId: meta.productId ?? row.pricingRuleId ?? '',
      quantity: meta.quantity ?? 1,
      amountSats: row.amountSats,
      paymentRequest: row.paymentRequest,
      paymentHash: row.paymentHash,
      expiresAt: row.expiresAt,
      status: row.status as PaymentIntentStatus,
      state: row.status as PaymentIntentStatus,
      tokenHash: row.clientSecretHash,
    }
  }

  /** @deprecated */
  idempotency(key: string): { payloadHash: string; sessionId: string; token: string; expiresAt: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, idempotency_payload_hash payloadHash, intent_secret intentSecret,
          client_secret_hash token, expires_at expiresAt, metadata meta
         FROM payment_intents WHERE idempotency_key=? AND expires_at > ?`,
      )
      .get(key, new Date().toISOString()) as
      | { id: string; payloadHash: string; intentSecret: string; token: string; expiresAt: string; meta: string | null }
      | undefined
    if (!row) return undefined
    let token = row.intentSecret  // use intentSecret as legacy plaintext token
    try {
      const metaParsed = row.meta ? (JSON.parse(row.meta) as { _legacyToken?: string }) : null
      if (metaParsed?._legacyToken) token = metaParsed._legacyToken
    } catch { /* ignore */ }
    return { payloadHash: row.payloadHash, sessionId: row.id, token, expiresAt: row.expiresAt }
  }

  /** @deprecated Use updatePaymentIntentStatus() instead. */
  settle(hash: string, invoice: LightningInvoice): void {
    const newStatus = invoiceStateToIntentStatus(invoice.state)
    this.updatePaymentIntentStatus(hash, invoice, newStatus)
>>>>>>> 9fb749e (feat: Payment Intent domain model (#3, #7))
  }
}
