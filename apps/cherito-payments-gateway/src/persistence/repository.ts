import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from 'node:crypto'
import type {
  LightningInvoice,
  InvoiceState,
  CreatedOffer,
} from "@cherito/bitcoin-sdk";
import {
  openDatabase,
  type DatabaseMigrationOptions,
} from './database-lifecycle.js'
import type { PaymentIntentSecretCipher } from '../security/payment-intent-secret-cipher.js'
import {
  derivePaymentIntentClientSecret,
  hashPaymentIntentClientSecret,
} from '../security/payment-intent-client-capability.js'

const LEGACY_TENANT_ID = 'legacy'

function stableLegacyId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}

function canonicalStatus(state: InvoiceState): string {
  switch (state) {
    case 'settled': return 'succeeded'
    case 'accepted': return 'processing'
    case 'expired': return 'expired'
    case 'canceled': return 'canceled'
    default: return 'requires_payment'
  }
}
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
  private readonly intentSecretCipher?: PaymentIntentSecretCipher
  constructor(url: string, options: DatabaseMigrationOptions = {}) {
    this.db = openDatabase(url, options)
    this.intentSecretCipher = options.intentSecretCipher
  }
  createCheckout(
    s: Session,
    i: LightningInvoice,
    x: { key: string; payloadHash: string; token: string; expiresAt: string },
  ) {
    const cipher = this.intentSecretCipher
    if (!cipher) {
      throw Object.assign(
        new Error('CHERITO_INTENT_SECRET_KEY is required for legacy checkout compatibility'),
        { code: 'DATABASE_ENCRYPTION_KEY_REQUIRED' },
      )
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString()
      const pricingRuleId = stableLegacyId('pr_legacy', s.productId)
      const paymentIntentId = stableLegacyId('pi_legacy', s.id)
      const unitPrice = (BigInt(s.amountSats) / BigInt(s.quantity)).toString()
      const intentSecret = randomBytes(32).toString('hex')
      const encrypted = cipher.encrypt(intentSecret, LEGACY_TENANT_ID, paymentIntentId)
      const clientSecretHash = hashPaymentIntentClientSecret(
        derivePaymentIntentClientSecret(intentSecret, paymentIntentId, LEGACY_TENANT_ID),
      )

      this.db.prepare(`
        INSERT OR IGNORE INTO tenants
          (id, name, disabled, webhook_url, webhook_secret, prev_webhook_secret,
           secret_rotated_at, created_at, updated_at)
        VALUES (?, 'Legacy Checkout', 0, NULL, NULL, NULL, NULL, ?, ?)
      `).run(LEGACY_TENANT_ID, now, now)
      this.db.prepare('INSERT OR IGNORE INTO products VALUES (?, ?, ?, 1)')
        .run(s.productId, s.productId, unitPrice)
      this.db.prepare(`
        INSERT OR IGNORE INTO pricing_rules
          (id, tenant_id, product_id, name, description, mode, price_sats,
           max_price_sats, active, max_quantity, offer_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'fixed', ?, NULL, 1, 100, 0, ?, ?)
      `).run(
        pricingRuleId,
        LEGACY_TENANT_ID,
        s.productId,
        s.productId,
        'Legacy checkout compatibility rule',
        unitPrice,
        now,
        now,
      )
      this.db.prepare('INSERT OR IGNORE INTO legacy_product_mappings VALUES (?, ?, ?, ?)')
        .run(s.productId, LEGACY_TENANT_ID, pricingRuleId, now)
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
      this.db.prepare(`
        INSERT INTO payment_intents (
          id, tenant_id, merchant_order_id, pricing_rule_id, payment_link_id,
          amount_sats, currency, description, metadata, status,
          payment_request, payment_hash, provider_invoice_id,
          intent_secret_version, intent_secret_key_id, intent_secret_nonce,
          intent_secret_ciphertext, intent_secret_auth_tag, client_secret_hash,
          idempotency_key, idempotency_payload_hash, expires_at, settled_at,
          created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        paymentIntentId,
        LEGACY_TENANT_ID,
        s.orderId,
        pricingRuleId,
        null,
        s.amountSats,
        'SAT',
        `Legacy checkout ${s.orderId}`,
        JSON.stringify({
          legacy: {
            checkoutSessionId: s.id,
            orderId: s.orderId,
            productId: s.productId,
            quantity: s.quantity,
          },
        }),
        canonicalStatus(s.state),
        s.paymentRequest,
        s.paymentHash,
        i.providerInvoiceId,
        encrypted.version,
        encrypted.keyId,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authTag,
        clientSecretHash,
        x.key,
        x.payloadHash,
        s.expiresAt,
        null,
        now,
        now,
      )
      this.db.prepare('INSERT INTO legacy_checkout_mappings VALUES (?, ?, ?, ?, ?)')
        .run(s.id, s.orderId, LEGACY_TENANT_ID, paymentIntentId, now)
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
  settle(hash: string, i: LightningInvoice) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString()
      const toStatus = canonicalStatus(i.state)
      const allowedFrom = toStatus === 'succeeded'
        ? ['requires_payment', 'processing']
        : toStatus === 'processing'
          ? ['requires_payment']
          : toStatus === 'expired' || toStatus === 'canceled'
            ? ['requires_payment', 'processing']
            : []
      const mapping = this.db.prepare(`
        SELECT tenant_id tenantId, payment_intent_id paymentIntentId
        FROM legacy_checkout_mappings
        WHERE checkout_session_id=(
          SELECT id FROM checkout_sessions WHERE payment_hash=?
        )
      `).get(hash) as { tenantId: string; paymentIntentId: string } | undefined
      let canonicalChanged = false
      if (mapping && allowedFrom.length > 0) {
        const placeholders = allowedFrom.map(() => '?').join(',')
        const changed = this.db.prepare(`
          UPDATE payment_intents
          SET status=?, settled_at=?, updated_at=?
          WHERE tenant_id=? AND id=? AND status IN (${placeholders})
        `).run(
          toStatus,
          toStatus === 'succeeded' ? i.settledAt ?? now : null,
          now,
          mapping.tenantId,
          mapping.paymentIntentId,
          ...allowedFrom,
        ) as { changes: number }
        canonicalChanged = changed.changes === 1
      }

      if (mapping && !canonicalChanged) {
        this.db.exec('COMMIT')
        return
      }
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
          
      if (mapping && toStatus === 'succeeded') {
        const eventId = stableLegacyId('evt_legacy_succeeded', mapping.paymentIntentId)
        const payload = JSON.stringify({
          id: mapping.paymentIntentId,
          object: 'payment_intent',
          status: 'succeeded',
          paymentHash: hash,
          settledAt: i.settledAt ?? now,
        })
        const event = this.db.prepare(`
          INSERT OR IGNORE INTO webhook_events
            (id, tenant_id, payment_intent_id, type, payload, created_at)
          VALUES (?, ?, ?, 'payment_intent.succeeded', ?, ?)
        `).run(eventId, mapping.tenantId, mapping.paymentIntentId, payload, now) as {
          changes: number
        }
        const webhook = this.db.prepare(`
          SELECT webhook_url webhookUrl, webhook_secret webhookSecret
          FROM tenants WHERE id=?
        `).get(mapping.tenantId) as {
          webhookUrl: string | null
          webhookSecret: string | null
        }
        if (event.changes === 1 && webhook.webhookUrl && webhook.webhookSecret) {
          this.db.prepare(`
            INSERT INTO webhook_deliveries
              (id, event_id, tenant_id, status, attempt_count, last_attempt_at,
               next_attempt_at, delivered_at, created_at)
            VALUES (?, ?, ?, 'pending', 0, NULL, ?, NULL, ?)
          `).run(stableLegacyId('wd_legacy', eventId), eventId, mapping.tenantId, now, now)
        }
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
  }

  close() {
    this.db.close();
  }
}
