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
  event?: DurablePaymentIntentEvent
}

export interface DurablePaymentIntentEvent {
  id: string
  deliveryId: string
  type: string
  payload: string
  createdAt: string
}

interface StoredPaymentIntent extends Omit<PaymentIntent, 'intentSecret'> {
  intentSecretVersion: number
  intentSecretKeyId: string
  intentSecretNonce: string
  intentSecretCiphertext: string
  intentSecretAuthTag: string
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
    backupDirectory?: string,
  ) {
    super(url, { intentSecretCipher, busyTimeoutMs, backupDirectory })
    try {
      this.rewrapIntentSecretsWithActiveKey()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  tenantCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) count FROM tenants WHERE id!='legacy'")
      .get() as { count: number }
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
    this.db.exec('BEGIN IMMEDIATE')
    try {
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
      if (result.changes !== 1) {
        this.db.exec('ROLLBACK')
        return false
      }

      this.synchronizeLegacyPayment(transition, settledAt)
      if (transition.event) this.persistTransitionEvent(transition, transition.event)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
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

  private persistTransitionEvent(
    transition: PaymentIntentTransition,
    event: DurablePaymentIntentEvent,
  ): void {
    const intent = this.db.prepare(`
      SELECT id FROM payment_intents WHERE tenant_id=? AND payment_hash=?
    `).get(transition.tenantId, transition.paymentHash) as { id: string }
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO webhook_events
        (id, tenant_id, payment_intent_id, type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      transition.tenantId,
      intent.id,
      event.type,
      event.payload,
      event.createdAt,
    ) as { changes: number }
    if (inserted.changes !== 1) return

    const webhook = this.db.prepare(`
      SELECT webhook_url webhookUrl, webhook_secret webhookSecret
      FROM tenants WHERE id=?
    `).get(transition.tenantId) as {
      webhookUrl: string | null
      webhookSecret: string | null
    }
    if (!webhook.webhookUrl || !webhook.webhookSecret) return
    this.db.prepare(`
      INSERT INTO webhook_deliveries
        (id, event_id, tenant_id, status, attempt_count, last_attempt_at,
         next_attempt_at, delivered_at, created_at)
      VALUES (?, ?, ?, 'pending', 0, NULL, ?, NULL, ?)
    `).run(
      event.deliveryId,
      event.id,
      transition.tenantId,
      event.createdAt,
      event.createdAt,
    )
  }

  private synchronizeLegacyPayment(
    transition: PaymentIntentTransition,
    settledAt: string | null,
  ): void {
    const mapping = this.db.prepare(`
      SELECT m.checkout_session_id checkoutSessionId, m.order_id orderId
      FROM legacy_checkout_mappings m
      JOIN payment_intents p
        ON p.tenant_id=m.tenant_id AND p.id=m.payment_intent_id
      WHERE p.tenant_id=? AND p.payment_hash=?
    `).get(transition.tenantId, transition.paymentHash) as {
      checkoutSessionId: string
      orderId: string
    } | undefined
    if (!mapping) return

    const legacyState = transition.toStatus === 'succeeded'
      ? 'settled'
      : transition.toStatus === 'processing'
        ? 'accepted'
        : transition.toStatus
    this.db.prepare(`
      UPDATE lightning_invoices SET state=?, settled_at=COALESCE(?, settled_at),
        provider_settle_index=COALESCE(?, provider_settle_index)
      WHERE payment_hash=?
    `).run(
      legacyState,
      settledAt,
      transition.invoice?.providerSettleIndex ?? null,
      transition.paymentHash,
    )
    this.db.prepare('UPDATE checkout_sessions SET state=? WHERE id=?')
      .run(legacyState, mapping.checkoutSessionId)
    if (transition.toStatus === 'succeeded') {
      this.db.prepare(`
        UPDATE orders SET state='confirmed', confirmed_at=COALESCE(confirmed_at, ?)
        WHERE id=? AND state!='confirmed'
      `).run(settledAt ?? transition.updatedAt, mapping.orderId)
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

}
