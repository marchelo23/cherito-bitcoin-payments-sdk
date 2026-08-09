import type { LightningInvoice, PaymentIntentStatus } from '@cherito/bitcoin-sdk'
import { TenantRepository } from './tenant-repository.js'
import {
  type EncryptedIntentSecret,
  PaymentIntentSecretCipher,
} from '../security/payment-intent-secret-cipher.js'

export const PAYMENT_INTENT_TERMINAL_STATUSES = [
  'succeeded',
  'expired',
  'failed',
  'canceled',
] as const satisfies readonly PaymentIntentStatus[]

export interface PaymentIntent {
  id: string
  tenantId: string
  merchantOrderId: string | null
  pricingRuleId: string | null
  paymentLinkId: string | null
  amountSats: string
  currency: 'SAT'
  description: string
  metadata: string | null
  status: PaymentIntentStatus
  paymentRequest: string
  paymentHash: string
  providerInvoiceId: string
  intentSecret: string
  clientSecretHash: string
  idempotencyKey: string | null
  idempotencyPayloadHash: string | null
  expiresAt: string
  settledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface PaymentIntentTransition {
  tenantId: string
  paymentHash: string
  fromStatus: PaymentIntentStatus
  toStatus: PaymentIntentStatus
  invoice?: LightningInvoice
  settledAt?: string | null
  updatedAt: string
}

interface StoredPaymentIntent extends Omit<PaymentIntent, 'intentSecret'> {
  intentSecretVersion: number
  intentSecretKeyId: string
  intentSecretNonce: string
  intentSecretCiphertext: string
  intentSecretAuthTag: string
}

interface LegacyStoredPaymentIntent {
  id: string
  tenant_id: string
  merchant_order_id: string | null
  pricing_rule_id: string | null
  payment_link_id: string | null
  amount_sats: string
  currency: string
  description: string
  metadata: string | null
  status: string
  payment_request: string
  payment_hash: string
  provider_invoice_id: string
  intent_secret: string
  client_secret_hash: string
  idempotency_key: string | null
  idempotency_payload_hash: string | null
  expires_at: string
  settled_at: string | null
  created_at: string
  updated_at: string
}

const PAYMENT_INTENT_COLUMNS = `
  id,
  tenant_id tenantId,
  merchant_order_id merchantOrderId,
  pricing_rule_id pricingRuleId,
  payment_link_id paymentLinkId,
  amount_sats amountSats,
  currency,
  description,
  metadata,
  status,
  payment_request paymentRequest,
  payment_hash paymentHash,
  provider_invoice_id providerInvoiceId,
  intent_secret_version intentSecretVersion,
  intent_secret_key_id intentSecretKeyId,
  intent_secret_nonce intentSecretNonce,
  intent_secret_ciphertext intentSecretCiphertext,
  intent_secret_auth_tag intentSecretAuthTag,
  client_secret_hash clientSecretHash,
  idempotency_key idempotencyKey,
  idempotency_payload_hash idempotencyPayloadHash,
  expires_at expiresAt,
  settled_at settledAt,
  created_at createdAt,
  updated_at updatedAt
`

const PAYMENT_INTENT_MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS payment_intents (
        id                       TEXT PRIMARY KEY,
        tenant_id                TEXT NOT NULL REFERENCES tenants(id),
        merchant_order_id        TEXT,
        pricing_rule_id          TEXT REFERENCES pricing_rules(id),
        payment_link_id          TEXT,
        amount_sats              TEXT NOT NULL,
        currency                 TEXT NOT NULL DEFAULT 'SAT' CHECK (currency = 'SAT'),
        description              TEXT NOT NULL,
        metadata                 TEXT,
        status                   TEXT NOT NULL,
        payment_request          TEXT NOT NULL,
        payment_hash             TEXT NOT NULL UNIQUE,
        provider_invoice_id      TEXT NOT NULL UNIQUE,
        intent_secret_version    INTEGER NOT NULL,
        intent_secret_key_id     TEXT NOT NULL,
        intent_secret_nonce      TEXT NOT NULL,
        intent_secret_ciphertext TEXT NOT NULL,
        intent_secret_auth_tag   TEXT NOT NULL,
        client_secret_hash       TEXT NOT NULL,
        idempotency_key          TEXT,
        idempotency_payload_hash TEXT,
        expires_at               TEXT NOT NULL,
        settled_at               TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_tenant_idempotency
        ON payment_intents(tenant_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_tenant_order
        ON payment_intents(tenant_id, merchant_order_id)
        WHERE merchant_order_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_payment_intents_recovery
        ON payment_intents(status, expires_at);

      CREATE INDEX IF NOT EXISTS idx_payment_intents_tenant_created
        ON payment_intents(tenant_id, created_at);
    `,
  },
] as const

/**
 * Payment Intent persistence extends the existing tenant repository so tenant,
 * pricing-rule and intent writes share one SQLite connection and transaction
 * boundary. No raw database handle is exposed to services or routes.
 */
export class PaymentIntentRepository extends TenantRepository {
  constructor(
    url: string,
    private readonly intentSecretCipher: PaymentIntentSecretCipher,
    busyTimeoutMs = 5_000,
  ) {
    super(url)
    try {
      this.db.exec(`
        PRAGMA busy_timeout=${Math.max(0, Math.trunc(busyTimeoutMs))};
        PRAGMA secure_delete=ON;
      `)
      this.applyPaymentIntentMigrations()
      this.rewrapIntentSecretsWithActiveKey()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  tenantCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) count FROM tenants').get() as { count: number }
    return row.count
  }

  createPaymentIntent(intent: PaymentIntent): void {
    const encrypted = this.intentSecretCipher.encrypt(
      intent.intentSecret,
      intent.tenantId,
      intent.id,
    )
    this.db
      .prepare(
        `INSERT INTO payment_intents (
          id, tenant_id, merchant_order_id, pricing_rule_id, payment_link_id,
          amount_sats, currency, description, metadata, status,
          payment_request, payment_hash, provider_invoice_id,
          intent_secret_version, intent_secret_key_id, intent_secret_nonce,
          intent_secret_ciphertext, intent_secret_auth_tag,
          client_secret_hash, idempotency_key, idempotency_payload_hash,
          expires_at, settled_at, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        intent.id,
        intent.tenantId,
        intent.merchantOrderId,
        intent.pricingRuleId,
        intent.paymentLinkId,
        intent.amountSats,
        intent.currency,
        intent.description,
        intent.metadata,
        intent.status,
        intent.paymentRequest,
        intent.paymentHash,
        intent.providerInvoiceId,
        encrypted.version,
        encrypted.keyId,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authTag,
        intent.clientSecretHash,
        intent.idempotencyKey,
        intent.idempotencyPayloadHash,
        intent.expiresAt,
        intent.settledAt,
        intent.createdAt,
        intent.updatedAt,
      )
  }

  paymentIntent(tenantId: string, id: string): PaymentIntent | undefined {
    const row = this.db
      .prepare(`SELECT ${PAYMENT_INTENT_COLUMNS} FROM payment_intents WHERE tenant_id=? AND id=?`)
      .get(tenantId, id) as StoredPaymentIntent | undefined
    return row ? this.materialize(row) : undefined
  }

  paymentIntentByHash(tenantId: string, paymentHash: string): PaymentIntent | undefined {
    const row = this.db
      .prepare(
        `SELECT ${PAYMENT_INTENT_COLUMNS}
         FROM payment_intents WHERE tenant_id=? AND payment_hash=?`,
      )
      .get(tenantId, paymentHash) as StoredPaymentIntent | undefined
    return row ? this.materialize(row) : undefined
  }

  paymentIntentByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): PaymentIntent | undefined {
    const row = this.db
      .prepare(
        `SELECT ${PAYMENT_INTENT_COLUMNS}
         FROM payment_intents WHERE tenant_id=? AND idempotency_key=?`,
      )
      .get(tenantId, idempotencyKey) as StoredPaymentIntent | undefined
    return row ? this.materialize(row) : undefined
  }

  paymentIntentByMerchantOrderId(
    tenantId: string,
    merchantOrderId: string,
  ): PaymentIntent | undefined {
    const row = this.db
      .prepare(
        `SELECT ${PAYMENT_INTENT_COLUMNS}
         FROM payment_intents WHERE tenant_id=? AND merchant_order_id=?`,
      )
      .get(tenantId, merchantOrderId) as StoredPaymentIntent | undefined
    return row ? this.materialize(row) : undefined
  }

  nonTerminalPaymentIntents(limit?: number): PaymentIntent[] {
    const sql = `SELECT ${PAYMENT_INTENT_COLUMNS}
      FROM payment_intents
      WHERE status IN ('requires_payment', 'processing')
      ORDER BY created_at ASC${limit === undefined ? '' : ' LIMIT ?'}`
    const rows = limit === undefined
      ? this.db.prepare(sql).all()
      : this.db.prepare(sql).all(Math.max(1, Math.trunc(limit)))
    return (rows as unknown as StoredPaymentIntent[]).map((row) => this.materialize(row))
  }

  transitionPaymentIntent(transition: PaymentIntentTransition): boolean {
    const settledAt = transition.toStatus === 'succeeded'
      ? (transition.invoice?.settledAt ?? transition.settledAt ?? transition.updatedAt)
      : null
    const result = this.db
      .prepare(
        `UPDATE payment_intents
         SET status=?, settled_at=?, updated_at=?
         WHERE tenant_id=? AND payment_hash=? AND status=?`,
      )
      .run(
        transition.toStatus,
        settledAt,
        transition.updatedAt,
        transition.tenantId,
        transition.paymentHash,
        transition.fromStatus,
      ) as { changes: number }
    return result.changes === 1
  }

  close(): void {
    this.db.close()
  }

  private applyPaymentIntentMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payment_intent_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `)
    const applied = new Set(
      (this.db
        .prepare('SELECT version FROM payment_intent_schema_migrations')
        .all() as Array<{ version: number }>).map(({ version }) => version),
    )

    for (const migration of PAYMENT_INTENT_MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(migration.sql)
        this.db
          .prepare('INSERT INTO payment_intent_schema_migrations VALUES (?, ?)')
          .run(migration.version, new Date().toISOString())
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }

    if (!applied.has(2)) this.migratePlaintextIntentSecrets()
    if (!applied.has(3)) this.secureEraseLegacyPages()
  }

  private materialize(row: StoredPaymentIntent): PaymentIntent {
    const encrypted: EncryptedIntentSecret = {
      version: row.intentSecretVersion,
      keyId: row.intentSecretKeyId,
      nonce: row.intentSecretNonce,
      ciphertext: row.intentSecretCiphertext,
      authTag: row.intentSecretAuthTag,
    }
    return {
      id: row.id,
      tenantId: row.tenantId,
      merchantOrderId: row.merchantOrderId,
      pricingRuleId: row.pricingRuleId,
      paymentLinkId: row.paymentLinkId,
      amountSats: row.amountSats,
      currency: row.currency,
      description: row.description,
      metadata: row.metadata,
      status: row.status,
      paymentRequest: row.paymentRequest,
      paymentHash: row.paymentHash,
      providerInvoiceId: row.providerInvoiceId,
      intentSecret: this.intentSecretCipher.decrypt(encrypted, row.tenantId, row.id),
      clientSecretHash: row.clientSecretHash,
      idempotencyKey: row.idempotencyKey,
      idempotencyPayloadHash: row.idempotencyPayloadHash,
      expiresAt: row.expiresAt,
      settledAt: row.settledAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  private migratePlaintextIntentSecrets(): void {
    const columns = this.db.prepare('PRAGMA table_info(payment_intents)').all() as Array<{
      name: string
    }>
    if (!columns.some(({ name }) => name === 'intent_secret')) {
      this.db
        .prepare('INSERT INTO payment_intent_schema_migrations VALUES (?, ?)')
        .run(2, new Date().toISOString())
      return
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec(`
        CREATE TABLE payment_intents_encrypted (
          id                       TEXT PRIMARY KEY,
          tenant_id                TEXT NOT NULL REFERENCES tenants(id),
          merchant_order_id        TEXT,
          pricing_rule_id          TEXT REFERENCES pricing_rules(id),
          payment_link_id          TEXT,
          amount_sats              TEXT NOT NULL,
          currency                 TEXT NOT NULL DEFAULT 'SAT' CHECK (currency = 'SAT'),
          description              TEXT NOT NULL,
          metadata                 TEXT,
          status                   TEXT NOT NULL,
          payment_request          TEXT NOT NULL,
          payment_hash             TEXT NOT NULL UNIQUE,
          provider_invoice_id      TEXT NOT NULL UNIQUE,
          intent_secret_version    INTEGER NOT NULL,
          intent_secret_key_id     TEXT NOT NULL,
          intent_secret_nonce      TEXT NOT NULL,
          intent_secret_ciphertext TEXT NOT NULL,
          intent_secret_auth_tag   TEXT NOT NULL,
          client_secret_hash       TEXT NOT NULL,
          idempotency_key          TEXT,
          idempotency_payload_hash TEXT,
          expires_at               TEXT NOT NULL,
          settled_at               TEXT,
          created_at               TEXT NOT NULL,
          updated_at               TEXT NOT NULL
        )
      `)

      const legacyRows = this.db
        .prepare('SELECT * FROM payment_intents')
        .all() as unknown as LegacyStoredPaymentIntent[]
      const insert = this.db.prepare(`
        INSERT INTO payment_intents_encrypted (
          id, tenant_id, merchant_order_id, pricing_rule_id, payment_link_id,
          amount_sats, currency, description, metadata, status,
          payment_request, payment_hash, provider_invoice_id,
          intent_secret_version, intent_secret_key_id, intent_secret_nonce,
          intent_secret_ciphertext, intent_secret_auth_tag,
          client_secret_hash, idempotency_key, idempotency_payload_hash,
          expires_at, settled_at, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      for (const row of legacyRows) {
        const encrypted = this.intentSecretCipher.encrypt(row.intent_secret, row.tenant_id, row.id)
        insert.run(
          row.id,
          row.tenant_id,
          row.merchant_order_id,
          row.pricing_rule_id,
          row.payment_link_id,
          row.amount_sats,
          row.currency,
          row.description,
          row.metadata,
          row.status,
          row.payment_request,
          row.payment_hash,
          row.provider_invoice_id,
          encrypted.version,
          encrypted.keyId,
          encrypted.nonce,
          encrypted.ciphertext,
          encrypted.authTag,
          row.client_secret_hash,
          row.idempotency_key,
          row.idempotency_payload_hash,
          row.expires_at,
          row.settled_at,
          row.created_at,
          row.updated_at,
        )
      }

      this.db.exec(`
        DROP TABLE payment_intents;
        ALTER TABLE payment_intents_encrypted RENAME TO payment_intents;

        CREATE UNIQUE INDEX idx_payment_intents_tenant_idempotency
          ON payment_intents(tenant_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL;

        CREATE UNIQUE INDEX idx_payment_intents_tenant_order
          ON payment_intents(tenant_id, merchant_order_id)
          WHERE merchant_order_id IS NOT NULL;

        CREATE INDEX idx_payment_intents_recovery
          ON payment_intents(status, expires_at);

        CREATE INDEX idx_payment_intents_tenant_created
          ON payment_intents(tenant_id, created_at);
      `)
      this.db
        .prepare('INSERT INTO payment_intent_schema_migrations VALUES (?, ?)')
        .run(2, new Date().toISOString())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private rewrapIntentSecretsWithActiveKey(): void {
    const rows = this.db.prepare(`
      SELECT id, tenant_id tenantId,
        intent_secret_version version,
        intent_secret_key_id keyId,
        intent_secret_nonce nonce,
        intent_secret_ciphertext ciphertext,
        intent_secret_auth_tag authTag
      FROM payment_intents
    `).all() as unknown as Array<EncryptedIntentSecret & { id: string; tenantId: string }>

    const stale = rows.filter((row) => !this.intentSecretCipher.usesActiveKey(row))
    if (stale.length === 0) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const update = this.db.prepare(`
        UPDATE payment_intents SET
          intent_secret_version=?, intent_secret_key_id=?, intent_secret_nonce=?,
          intent_secret_ciphertext=?, intent_secret_auth_tag=?
        WHERE tenant_id=? AND id=? AND intent_secret_key_id=?
      `)
      for (const row of stale) {
        const plaintext = this.intentSecretCipher.decrypt(row, row.tenantId, row.id)
        const encrypted = this.intentSecretCipher.encrypt(plaintext, row.tenantId, row.id)
        const result = update.run(
          encrypted.version,
          encrypted.keyId,
          encrypted.nonce,
          encrypted.ciphertext,
          encrypted.authTag,
          row.tenantId,
          row.id,
          row.keyId,
        ) as { changes: number }
        if (result.changes !== 1) throw new Error('Payment Intent key rotation lost its CAS race')
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private secureEraseLegacyPages(): void {
    // Dropping a SQLite column does not itself guarantee that its old bytes are
    // absent from free pages or the WAL. Scrub both before recording completion.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.exec('VACUUM')
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db
      .prepare('INSERT INTO payment_intent_schema_migrations VALUES (?, ?)')
      .run(3, new Date().toISOString())
  }
}
