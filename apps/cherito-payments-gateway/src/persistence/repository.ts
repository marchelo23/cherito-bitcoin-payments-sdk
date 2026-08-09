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
  }
}
