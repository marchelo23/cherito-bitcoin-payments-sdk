import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface WebhookEvent {
  id: string
  tenantId: string
  paymentIntentId: string
  type: string
  payload: string
  createdAt: string
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'permanently_failed'

export interface WebhookDelivery {
  id: string
  eventId: string
  tenantId: string
  status: WebhookDeliveryStatus
  attemptCount: number
  lastAttemptAt: string | null
  nextAttemptAt: string | null
  deliveredAt: string | null
  createdAt: string
}

const WEBHOOK_SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;

  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    payment_intent_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(tenant_id, payment_intent_id, type)
  );

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES webhook_events(id),
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    next_attempt_at TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL
  );
`

export class WebhookRepository {
  protected db: DatabaseSync

  constructor(url: string) {
    const file = url.replace(/^file:/, '')
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(WEBHOOK_SCHEMA)
  }

  createEvent(event: WebhookEvent): void {
    // Expected to be called within a transaction (or standalone)
    this.db
      .prepare('INSERT INTO webhook_events (id, tenant_id, payment_intent_id, type, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(event.id, event.tenantId, event.paymentIntentId, event.type, event.payload, event.createdAt)
  }

  createDelivery(delivery: WebhookDelivery): void {
    this.db
      .prepare(
        'INSERT INTO webhook_deliveries (id, event_id, tenant_id, status, attempt_count, last_attempt_at, next_attempt_at, delivered_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        delivery.id,
        delivery.eventId,
        delivery.tenantId,
        delivery.status,
        delivery.attemptCount,
        delivery.lastAttemptAt,
        delivery.nextAttemptAt,
        delivery.deliveredAt,
        delivery.createdAt,
      )
  }

  event(id: string): WebhookEvent | undefined {
    const row = this.db.prepare('SELECT id, tenant_id tenantId, payment_intent_id paymentIntentId, type, payload, created_at createdAt FROM webhook_events WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? (row as unknown as WebhookEvent) : undefined
  }

  delivery(id: string): WebhookDelivery | undefined {
    const row = this.db.prepare('SELECT id, event_id eventId, tenant_id tenantId, status, attempt_count attemptCount, last_attempt_at lastAttemptAt, next_attempt_at nextAttemptAt, delivered_at deliveredAt, created_at createdAt FROM webhook_deliveries WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? (row as unknown as WebhookDelivery) : undefined
  }

  pendingDeliveries(): WebhookDelivery[] {
    const now = new Date().toISOString()
    const rows = this.db
      .prepare(
        `SELECT id, event_id eventId, tenant_id tenantId, status, attempt_count attemptCount, last_attempt_at lastAttemptAt, next_attempt_at nextAttemptAt, delivered_at deliveredAt, created_at createdAt
         FROM webhook_deliveries WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT 100`,
      )
      .all(now) as Record<string, unknown>[]
    return rows.map(r => r as unknown as WebhookDelivery)
  }

  markDelivered(id: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare("UPDATE webhook_deliveries SET status='delivered', delivered_at=?, last_attempt_at=?, attempt_count = attempt_count + 1 WHERE id=?")
      .run(now, now, id)
  }

  markFailed(id: string, nextAttemptAt: string): void {
    this.db
      .prepare("UPDATE webhook_deliveries SET status='failed', last_attempt_at=?, next_attempt_at=?, attempt_count = attempt_count + 1 WHERE id=?")
      .run(new Date().toISOString(), nextAttemptAt, id)
  }

  markPermanentlyFailed(id: string): void {
    this.db
      .prepare("UPDATE webhook_deliveries SET status='permanently_failed', last_attempt_at=?, next_attempt_at=NULL, attempt_count = attempt_count + 1 WHERE id=?")
      .run(new Date().toISOString(), id)
  }
}
