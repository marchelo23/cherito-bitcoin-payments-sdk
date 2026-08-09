import type { DatabaseSync } from 'node:sqlite'
import {
  openDatabase,
  type DatabaseMigrationOptions,
} from './database-lifecycle.js'

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

export class WebhookRepository {
  protected db: DatabaseSync

  constructor(url: string, options: DatabaseMigrationOptions = {}) {
    this.db = openDatabase(url, options)
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

  /**
   * Atomically persists one logical event and its first delivery. The unique
   * event constraint makes duplicate settlement callbacks a no-op.
   */
  createEventAndDeliveryIfAbsent(
    event: WebhookEvent,
    delivery: WebhookDelivery,
  ): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO webhook_events
           (id, tenant_id, payment_intent_id, type, payload, created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          event.id,
          event.tenantId,
          event.paymentIntentId,
          event.type,
          event.payload,
          event.createdAt,
        ) as { changes: number }
      if (inserted.changes === 0) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries
           (id, event_id, tenant_id, status, attempt_count, last_attempt_at,
            next_attempt_at, delivered_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
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
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  event(tenantId: string, id: string): WebhookEvent | undefined {
    const row = this.db.prepare('SELECT id, tenant_id tenantId, payment_intent_id paymentIntentId, type, payload, created_at createdAt FROM webhook_events WHERE tenant_id=? AND id=?').get(tenantId, id) as Record<string, unknown> | undefined
    return row ? (row as unknown as WebhookEvent) : undefined
  }

  delivery(tenantId: string, id: string): WebhookDelivery | undefined {
    const row = this.db.prepare('SELECT id, event_id eventId, tenant_id tenantId, status, attempt_count attemptCount, last_attempt_at lastAttemptAt, next_attempt_at nextAttemptAt, delivered_at deliveredAt, created_at createdAt FROM webhook_deliveries WHERE tenant_id=? AND id=?').get(tenantId, id) as Record<string, unknown> | undefined
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

  markDelivered(tenantId: string, id: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare("UPDATE webhook_deliveries SET status='delivered', delivered_at=?, last_attempt_at=?, attempt_count = attempt_count + 1 WHERE tenant_id=? AND id=?")
      .run(now, now, tenantId, id)
  }

  markFailed(tenantId: string, id: string, nextAttemptAt: string): void {
    this.db
      .prepare("UPDATE webhook_deliveries SET status='failed', last_attempt_at=?, next_attempt_at=?, attempt_count = attempt_count + 1 WHERE tenant_id=? AND id=?")
      .run(new Date().toISOString(), nextAttemptAt, tenantId, id)
  }

  markPermanentlyFailed(tenantId: string, id: string): void {
    this.db
      .prepare("UPDATE webhook_deliveries SET status='permanently_failed', last_attempt_at=?, next_attempt_at=NULL, attempt_count = attempt_count + 1 WHERE tenant_id=? AND id=?")
      .run(new Date().toISOString(), tenantId, id)
  }

  close(): void {
    this.db.close()
  }
}
