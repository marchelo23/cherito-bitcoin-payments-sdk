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

export type PaymentLinkMode = 'fixed' | 'open_amount' | 'donation'

export interface PaymentLink {
  id: string
  tenantId: string
  slug: string
  mode: PaymentLinkMode
  pricingRuleId: string | null
  minAmountSats: string | null
  maxAmountSats: string | null
  title: string
  description: string | null
  expiresAt: string | null
  maxUses: number | null
  useCount: number
  reservedUses: number
  active: boolean
  indexable: boolean
  createdAt: string
  updatedAt: string
}

export interface PaymentLinkReservation {
  id: string
  tenantId: string
  paymentLinkId: string
  paymentIntentId: string
  createdAt: string
}

export interface MerchantActionIdempotency {
  tenantId: string
  route: string
  idempotencyKey: string
  payloadHash: string
  resourceId: string
  createdAt: string
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

const PAYMENT_LINK_COLUMNS = `
  id,
  tenant_id tenantId,
  slug,
  mode,
  pricing_rule_id pricingRuleId,
  min_amount_sats minAmountSats,
  max_amount_sats maxAmountSats,
  title,
  description,
  expires_at expiresAt,
  max_uses maxUses,
  use_count useCount,
  reserved_uses reservedUses,
  active,
  indexable,
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
    this.insertPaymentIntent(intent, encrypted)
  }

  createPaymentIntentForReservedLink(
    intent: PaymentIntent,
    reservationId: string,
  ): void {
    if (!intent.paymentLinkId) throw new Error('Reserved Payment Intent requires a Payment Link')
    const encrypted = this.intentSecretCipher.encrypt(
      intent.intentSecret,
      intent.tenantId,
      intent.id,
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const reservation = this.db.prepare(`
        SELECT id FROM payment_link_use_reservations
        WHERE id=? AND tenant_id=? AND payment_link_id=? AND payment_intent_id=?
      `).get(reservationId, intent.tenantId, intent.paymentLinkId, intent.id)
      if (!reservation) {
        throw Object.assign(new Error('Payment Link reservation is unavailable'), {
          statusCode: 409,
          code: 'PAYMENT_LINK_RESERVATION_INVALID',
        })
      }
      this.insertPaymentIntent(intent, encrypted)
      const committed = this.db.prepare(`
        UPDATE payment_links
        SET reserved_uses=reserved_uses-1, use_count=use_count+1, updated_at=?
        WHERE tenant_id=? AND id=? AND reserved_uses>0
      `).run(intent.createdAt, intent.tenantId, intent.paymentLinkId) as { changes: number }
      if (committed.changes !== 1) throw new Error('Payment Link reservation counter is invalid')
      this.db.prepare('DELETE FROM payment_link_use_reservations WHERE id=?')
        .run(reservationId)
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  createPaymentLink(
    link: PaymentLink,
    idempotency?: MerchantActionIdempotency,
  ): { created: boolean; resourceId: string; payloadHash: string | null } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (idempotency) {
        const existing = this.merchantActionIdempotency(
          idempotency.tenantId,
          idempotency.route,
          idempotency.idempotencyKey,
        )
        if (existing) {
          this.db.exec('COMMIT')
          return {
            created: false,
            resourceId: existing.resourceId,
            payloadHash: existing.payloadHash,
          }
        }
      }
      this.db.prepare(`
        INSERT INTO payment_links (
          id, tenant_id, slug, mode, pricing_rule_id, min_amount_sats,
          max_amount_sats, title, description, expires_at, max_uses,
          use_count, reserved_uses, active, indexable, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        link.id,
        link.tenantId,
        link.slug,
        link.mode,
        link.pricingRuleId,
        link.minAmountSats,
        link.maxAmountSats,
        link.title,
        link.description,
        link.expiresAt,
        link.maxUses,
        link.useCount,
        link.reservedUses,
        link.active ? 1 : 0,
        link.indexable ? 1 : 0,
        link.createdAt,
        link.updatedAt,
      )
      if (idempotency) {
        this.db.prepare(`
          INSERT INTO merchant_action_idempotency
            (tenant_id, route, idempotency_key, payload_hash, resource_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          idempotency.tenantId,
          idempotency.route,
          idempotency.idempotencyKey,
          idempotency.payloadHash,
          idempotency.resourceId,
          idempotency.createdAt,
        )
      }
      this.db.exec('COMMIT')
      return {
        created: true,
        resourceId: link.id,
        payloadHash: idempotency?.payloadHash ?? null,
      }
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  paymentLink(tenantId: string, id: string): PaymentLink | undefined {
    const row = this.db.prepare(`
      SELECT ${PAYMENT_LINK_COLUMNS} FROM payment_links WHERE tenant_id=? AND id=?
    `).get(tenantId, id) as Record<string, unknown> | undefined
    return row ? this.materializePaymentLink(row) : undefined
  }

  paymentLinkBySlug(slug: string): PaymentLink | undefined {
    const row = this.db.prepare(`
      SELECT ${PAYMENT_LINK_COLUMNS} FROM payment_links WHERE slug=?
    `).get(slug) as Record<string, unknown> | undefined
    return row ? this.materializePaymentLink(row) : undefined
  }

  listPaymentLinks(tenantId: string, limit: number, afterId?: string): PaymentLink[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)))
    if (!afterId) {
      return (this.db.prepare(`
        SELECT ${PAYMENT_LINK_COLUMNS} FROM payment_links
        WHERE tenant_id=? ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(tenantId, bounded) as Record<string, unknown>[])
        .map((row) => this.materializePaymentLink(row))
    }
    const cursor = this.db.prepare(`
      SELECT created_at createdAt, id FROM payment_links WHERE tenant_id=? AND id=?
    `).get(tenantId, afterId) as { createdAt: string; id: string } | undefined
    if (!cursor) return []
    const rows = this.db.prepare(`
      SELECT ${PAYMENT_LINK_COLUMNS} FROM payment_links
      WHERE tenant_id=? AND (created_at < ? OR (created_at=? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(
      tenantId,
      cursor.createdAt,
      cursor.createdAt,
      cursor.id,
      bounded,
    ) as unknown as Record<string, unknown>[]
    return rows.map((row) => this.materializePaymentLink(row))
  }

  updatePaymentLink(link: PaymentLink): boolean {
    const result = this.db.prepare(`
      UPDATE payment_links SET slug=?, mode=?, pricing_rule_id=?, min_amount_sats=?,
        max_amount_sats=?, title=?, description=?, expires_at=?, max_uses=?,
        active=?, indexable=?, updated_at=?
      WHERE tenant_id=? AND id=?
    `).run(
      link.slug,
      link.mode,
      link.pricingRuleId,
      link.minAmountSats,
      link.maxAmountSats,
      link.title,
      link.description,
      link.expiresAt,
      link.maxUses,
      link.active ? 1 : 0,
      link.indexable ? 1 : 0,
      link.updatedAt,
      link.tenantId,
      link.id,
    ) as { changes: number }
    return result.changes === 1
  }

  reservePaymentLinkUse(reservation: PaymentLinkReservation, now: string): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const reserved = this.db.prepare(`
        UPDATE payment_links
        SET reserved_uses=reserved_uses+1, updated_at=?
        WHERE tenant_id=? AND id=? AND active=1
          AND (expires_at IS NULL OR expires_at>?)
          AND (max_uses IS NULL OR use_count+reserved_uses<max_uses)
      `).run(now, reservation.tenantId, reservation.paymentLinkId, now) as { changes: number }
      if (reserved.changes !== 1) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.prepare(`
        INSERT INTO payment_link_use_reservations
          (id, tenant_id, payment_link_id, payment_intent_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        reservation.id,
        reservation.tenantId,
        reservation.paymentLinkId,
        reservation.paymentIntentId,
        reservation.createdAt,
      )
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  releasePaymentLinkReservation(reservationId: string): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const reservation = this.db.prepare(`
        SELECT tenant_id tenantId, payment_link_id paymentLinkId
        FROM payment_link_use_reservations WHERE id=?
      `).get(reservationId) as { tenantId: string; paymentLinkId: string } | undefined
      if (!reservation) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.prepare(`
        UPDATE payment_links SET reserved_uses=reserved_uses-1
        WHERE tenant_id=? AND id=? AND reserved_uses>0
      `).run(reservation.tenantId, reservation.paymentLinkId)
      this.db.prepare('DELETE FROM payment_link_use_reservations WHERE id=?')
        .run(reservationId)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  releaseAllPaymentLinkReservations(): number {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.db.prepare(`
        SELECT tenant_id tenantId, payment_link_id paymentLinkId, COUNT(*) count
        FROM payment_link_use_reservations GROUP BY tenant_id, payment_link_id
      `).all() as Array<{ tenantId: string; paymentLinkId: string; count: number }>
      for (const row of rows) {
        this.db.prepare(`
          UPDATE payment_links
          SET reserved_uses=MAX(0, reserved_uses-?), updated_at=?
          WHERE tenant_id=? AND id=?
        `).run(row.count, new Date().toISOString(), row.tenantId, row.paymentLinkId)
      }
      const removed = this.db.prepare('DELETE FROM payment_link_use_reservations')
        .run() as { changes: number }
      this.db.exec('COMMIT')
      return removed.changes
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  merchantActionIdempotency(
    tenantId: string,
    route: string,
    idempotencyKey: string,
  ): MerchantActionIdempotency | undefined {
    return this.db.prepare(`
      SELECT tenant_id tenantId, route, idempotency_key idempotencyKey,
        payload_hash payloadHash, resource_id resourceId, created_at createdAt
      FROM merchant_action_idempotency
      WHERE tenant_id=? AND route=? AND idempotency_key=?
    `).get(tenantId, route, idempotencyKey) as MerchantActionIdempotency | undefined
  }

  private insertPaymentIntent(
    intent: PaymentIntent,
    encrypted: EncryptedIntentSecret,
  ): void {
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

  listPaymentIntents(tenantId: string, limit: number, afterId?: string): PaymentIntent[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)))
    if (!afterId) {
      const rows = this.db.prepare(`
        SELECT ${PAYMENT_INTENT_COLUMNS} FROM payment_intents
        WHERE tenant_id=? ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(tenantId, bounded) as unknown as StoredPaymentIntent[]
      return rows.map((row) => this.materialize(row))
    }
    const cursor = this.db.prepare(`
      SELECT created_at createdAt, id FROM payment_intents WHERE tenant_id=? AND id=?
    `).get(tenantId, afterId) as { createdAt: string; id: string } | undefined
    if (!cursor) return []
    const rows = this.db.prepare(`
      SELECT ${PAYMENT_INTENT_COLUMNS} FROM payment_intents
      WHERE tenant_id=? AND (created_at < ? OR (created_at=? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(
      tenantId,
      cursor.createdAt,
      cursor.createdAt,
      cursor.id,
      bounded,
    ) as unknown as StoredPaymentIntent[]
    return rows.map((row) => this.materialize(row))
  }

  paymentIntentTotals(tenantId: string): {
    settledCount: number
    settledVolumeSats: string
    pendingCount: number
    failedCount: number
  } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END), 0) settledCount,
        COALESCE(SUM(CASE WHEN status='succeeded' THEN CAST(amount_sats AS INTEGER) ELSE 0 END), 0) settledVolumeSats,
        COALESCE(SUM(CASE WHEN status IN ('requires_payment','processing') THEN 1 ELSE 0 END), 0) pendingCount,
        COALESCE(SUM(CASE WHEN status IN ('expired','canceled','failed') THEN 1 ELSE 0 END), 0) failedCount
      FROM payment_intents WHERE tenant_id=?
    `).get(tenantId) as Record<string, number>
    return {
      settledCount: Number(row.settledCount ?? 0),
      settledVolumeSats: String(row.settledVolumeSats ?? 0),
      pendingCount: Number(row.pendingCount ?? 0),
      failedCount: Number(row.failedCount ?? 0),
    }
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

  private materializePaymentLink(row: Record<string, unknown>): PaymentLink {
    return {
      ...row,
      active: row.active === 1,
      indexable: row.indexable === 1,
    } as unknown as PaymentLink
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
