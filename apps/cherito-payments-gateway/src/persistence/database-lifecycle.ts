import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { PaymentIntentSecretCipher } from '../security/payment-intent-secret-cipher.js'
import {
  derivePaymentIntentClientSecret,
  hashPaymentIntentClientSecret,
} from '../security/payment-intent-client-capability.js'

export const LATEST_DATABASE_SCHEMA_VERSION = 5
export const DATABASE_BACKUP_FORMAT_VERSION = 1

const LEGACY_TENANT_ID = 'legacy'
const LEGACY_CREATED_AT = '1970-01-01T00:00:00.000Z'

export interface DatabaseBackupMetadata {
  formatVersion: number
  schemaVersion: number
  createdAt: string
  applicationVersion: string
  databaseBytes: number
  sha256?: string
  reason?: string
}

export interface DatabaseMigrationOptions {
  busyTimeoutMs?: number
  backupDirectory?: string
  applicationVersion?: string
  intentSecretCipher?: PaymentIntentSecretCipher
  now?: () => Date
  migrations?: readonly DatabaseMigration[]
}

export interface DatabaseMigration {
  version: number
  name: string
  destructive?: boolean
  backupRequired?(db: DatabaseSync): boolean
  up(db: DatabaseSync, context: MigrationContext): void
}

interface MigrationContext {
  databasePath: string
  options: Required<Pick<DatabaseMigrationOptions, 'busyTimeoutMs' | 'applicationVersion' | 'now'>>
    & Omit<DatabaseMigrationOptions, 'busyTimeoutMs' | 'applicationVersion' | 'now'>
  backupCreated: boolean
}

export interface OpenDatabaseOptions extends DatabaseMigrationOptions {
  readOnly?: boolean
  migrate?: boolean
}

function databaseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export function sqlitePath(databaseUrl: string): string {
  const path = databaseUrl.replace(/^file:/, '')
  if (path === ':memory:' || path.startsWith(':memory:')) return ':memory:'
  if (path.length === 0) throw databaseError('DATABASE_URL_INVALID', 'SQLite database path is empty')
  return resolve(path)
}

export function configureSqliteConnection(db: DatabaseSync, busyTimeoutMs = 5_000): void {
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=${Math.max(0, Math.trunc(busyTimeoutMs))};
    PRAGMA synchronous=FULL;
    PRAGMA secure_delete=ON;
  `)
}

export function openDatabase(
  databaseUrl: string,
  options: OpenDatabaseOptions = {},
): DatabaseSync {
  const path = sqlitePath(databaseUrl)
  if (path !== ':memory:' && !options.readOnly) mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false })
  try {
    configureSqliteConnection(db, options.busyTimeoutMs)
    if (!options.readOnly && options.migrate !== false) {
      applyDatabaseMigrations(db, path, options)
    } else if (options.readOnly) {
      assertSupportedSchema(db)
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
  )
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set()
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name),
  )
}

export function currentSchemaVersion(db: DatabaseSync): number {
  if (!tableExists(db, 'schema_migrations')) return 0
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) version FROM schema_migrations').get() as {
    version: number
  }
  return row.version
}

export function assertSupportedSchema(db: DatabaseSync): number {
  const version = currentSchemaVersion(db)
  if (version > LATEST_DATABASE_SCHEMA_VERSION) {
    throw databaseError(
      'DATABASE_SCHEMA_TOO_NEW',
      `Database schema ${version} is newer than supported version ${LATEST_DATABASE_SCHEMA_VERSION}`,
    )
  }
  assertMigrationHistory(db, version)
  return version
}

function assertMigrationHistory(db: DatabaseSync, current: number): void {
  if (current === 0) return
  const versions = (db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>).map(({ version }) => version)
  for (let expected = 1; expected <= current; expected += 1) {
    if (versions[expected - 1] !== expected) {
      throw databaseError(
        'DATABASE_MIGRATION_HISTORY_INVALID',
        `Database migration history has a gap before version ${expected}`,
      )
    }
  }
}

function rowCount(db: DatabaseSync, table: string): number {
  if (!tableExists(db, table)) return 0
  return (db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count
}

function hasDurableData(db: DatabaseSync): boolean {
  return [
    'orders',
    'lightning_invoices',
    'checkout_sessions',
    'idempotency_records',
    'bolt12_offers',
    'tenants',
    'merchant_api_keys',
    'pricing_rules',
    'payment_intents',
    'webhook_events',
    'webhook_deliveries',
  ].some((table) => rowCount(db, table) > 0)
}

function escapeSqliteString(value: string): string {
  return value.replaceAll("'", "''")
}

function sha256FileSync(path: string): string {
  const hash = createHash('sha256')
  const descriptor = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    closeSync(descriptor)
  }
  return hash.digest('hex')
}

function writeBackupMetadata(path: string, metadata: DatabaseBackupMetadata): void {
  writeFileSync(`${path}.json`, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
}

function createPreMigrationBackup(db: DatabaseSync, context: MigrationContext, version: number): void {
  if (context.backupCreated || context.databasePath === ':memory:' || !hasDurableData(db)) return
  const backupDirectory = resolve(
    context.options.backupDirectory ?? join(dirname(context.databasePath), 'backups'),
  )
  let path: string | undefined
  try {
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 })
    const timestamp = context.options.now().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    path = join(backupDirectory, `pre-migration-v${version}-${timestamp}.sqlite`)
    if (existsSync(path)) {
      throw databaseError('DATABASE_BACKUP_EXISTS', `Refusing to overwrite migration backup ${path}`)
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec(`VACUUM INTO '${escapeSqliteString(path)}'`)
    writeBackupMetadata(path, {
      formatVersion: DATABASE_BACKUP_FORMAT_VERSION,
      schemaVersion: currentSchemaVersion(db),
      createdAt: context.options.now().toISOString(),
      applicationVersion: context.options.applicationVersion,
      databaseBytes: statSync(path).size,
      sha256: sha256FileSync(path),
      reason: `before destructive migration ${version}`,
    })
    context.backupCreated = true
  } catch (error) {
    if (path) {
      rmSync(path, { force: true })
      rmSync(`${path}.json`, { force: true })
    }
    throw databaseError(
      'DATABASE_BACKUP_FAILED',
      `Destructive migration ${version} blocked because its backup failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function createTenantFoundation(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      webhook_url TEXT,
      webhook_secret TEXT,
      prev_webhook_secret TEXT,
      secret_rotated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS merchant_api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pricing_rules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      mode TEXT NOT NULL DEFAULT 'fixed',
      price_sats TEXT,
      max_price_sats TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      max_quantity INTEGER NOT NULL DEFAULT 10 CHECK (max_quantity > 0),
      offer_enabled INTEGER NOT NULL DEFAULT 0 CHECK (offer_enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, product_id),
      UNIQUE(tenant_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON merchant_api_keys(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_pricing_rules_tenant ON pricing_rules(tenant_id, active);
  `)
}

function createLegacyAndOutboxFoundation(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_sats TEXT NOT NULL,
      active INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      amount_sats TEXT NOT NULL,
      state TEXT NOT NULL,
      confirmed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS lightning_invoices (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      payment_hash TEXT UNIQUE NOT NULL,
      payment_request TEXT NOT NULL,
      amount_sats TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      settled_at TEXT,
      provider_add_index TEXT,
      provider_settle_index TEXT
    );
    CREATE TABLE IF NOT EXISTS checkout_sessions (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      amount_sats TEXT NOT NULL,
      payment_request TEXT NOT NULL,
      payment_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL,
      token_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency_records (
      key TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status_token TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bolt12_offers (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      offer TEXT NOT NULL,
      amount_sats TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

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
  `)
}

function createPaymentIntentFoundation(db: DatabaseSync, context: MigrationContext): void {
  const columns = tableColumns(db, 'payment_intents')
  if (columns.size === 0) {
    db.exec(`
      CREATE TABLE payment_intents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        merchant_order_id TEXT,
        pricing_rule_id TEXT REFERENCES pricing_rules(id),
        payment_link_id TEXT,
        amount_sats TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'SAT' CHECK (currency = 'SAT'),
        description TEXT NOT NULL,
        metadata TEXT,
        status TEXT NOT NULL,
        payment_request TEXT NOT NULL,
        payment_hash TEXT NOT NULL UNIQUE,
        provider_invoice_id TEXT NOT NULL UNIQUE,
        intent_secret_version INTEGER NOT NULL,
        intent_secret_key_id TEXT NOT NULL,
        intent_secret_nonce TEXT NOT NULL,
        intent_secret_ciphertext TEXT NOT NULL,
        intent_secret_auth_tag TEXT NOT NULL,
        client_secret_hash TEXT NOT NULL,
        idempotency_key TEXT,
        idempotency_payload_hash TEXT,
        expires_at TEXT NOT NULL,
        settled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  } else if (!columns.has('intent_secret_ciphertext')) {
    if (!columns.has('intent_secret')) {
      throw databaseError(
        'DATABASE_SCHEMA_UNSUPPORTED',
        'Detected an unmerged prototype Payment Intent schema without recoverable capability keys',
      )
    }
    const cipher = context.options.intentSecretCipher
    if (!cipher) {
      throw databaseError(
        'DATABASE_ENCRYPTION_KEY_REQUIRED',
        'CHERITO_INTENT_SECRET_KEY is required to migrate plaintext Payment Intent secrets',
      )
    }
    const rows = db.prepare('SELECT id, tenant_id tenantId, intent_secret intentSecret FROM payment_intents')
      .all() as Array<{ id: string; tenantId: string; intentSecret: string }>
    db.exec(`
      ALTER TABLE payment_intents ADD COLUMN intent_secret_version INTEGER;
      ALTER TABLE payment_intents ADD COLUMN intent_secret_key_id TEXT;
      ALTER TABLE payment_intents ADD COLUMN intent_secret_nonce TEXT;
      ALTER TABLE payment_intents ADD COLUMN intent_secret_ciphertext TEXT;
      ALTER TABLE payment_intents ADD COLUMN intent_secret_auth_tag TEXT;
    `)
    const update = db.prepare(`
      UPDATE payment_intents SET intent_secret_version=?, intent_secret_key_id=?,
        intent_secret_nonce=?, intent_secret_ciphertext=?, intent_secret_auth_tag=? WHERE id=?
    `)
    for (const row of rows) {
      const encrypted = cipher.encrypt(row.intentSecret, row.tenantId, row.id)
      update.run(
        encrypted.version,
        encrypted.keyId,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authTag,
        row.id,
      )
    }
    db.exec(`
      CREATE TABLE payment_intents_v3 (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        merchant_order_id TEXT,
        pricing_rule_id TEXT REFERENCES pricing_rules(id),
        payment_link_id TEXT,
        amount_sats TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'SAT' CHECK (currency = 'SAT'),
        description TEXT NOT NULL,
        metadata TEXT,
        status TEXT NOT NULL,
        payment_request TEXT NOT NULL,
        payment_hash TEXT NOT NULL UNIQUE,
        provider_invoice_id TEXT NOT NULL UNIQUE,
        intent_secret_version INTEGER NOT NULL,
        intent_secret_key_id TEXT NOT NULL,
        intent_secret_nonce TEXT NOT NULL,
        intent_secret_ciphertext TEXT NOT NULL,
        intent_secret_auth_tag TEXT NOT NULL,
        client_secret_hash TEXT NOT NULL,
        idempotency_key TEXT,
        idempotency_payload_hash TEXT,
        expires_at TEXT NOT NULL,
        settled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO payment_intents_v3 SELECT
        id, tenant_id, merchant_order_id, pricing_rule_id, payment_link_id,
        amount_sats, currency, description, metadata, status,
        payment_request, payment_hash, provider_invoice_id,
        intent_secret_version, intent_secret_key_id, intent_secret_nonce,
        intent_secret_ciphertext, intent_secret_auth_tag, client_secret_hash,
        idempotency_key, idempotency_payload_hash, expires_at, settled_at,
        created_at, updated_at
      FROM payment_intents;
      DROP TABLE payment_intents;
      ALTER TABLE payment_intents_v3 RENAME TO payment_intents;
    `)
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_tenant_idempotency
      ON payment_intents(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_tenant_order
      ON payment_intents(tenant_id, merchant_order_id) WHERE merchant_order_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_payment_intents_recovery
      ON payment_intents(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_payment_intents_tenant_created
      ON payment_intents(tenant_id, created_at);
    CREATE TABLE IF NOT EXISTS payment_intent_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)
  const appliedAt = context.options.now().toISOString()
  for (const version of [1, 2, 3]) {
    db.prepare('INSERT OR IGNORE INTO payment_intent_schema_migrations VALUES (?, ?)')
      .run(version, appliedAt)
  }
}

function hardenTenantOwnership(db: DatabaseSync): void {
  const crossTenantPricing = db.prepare(`
    SELECT COUNT(*) count
    FROM payment_intents p
    LEFT JOIN pricing_rules r
      ON r.tenant_id=p.tenant_id AND r.id=p.pricing_rule_id
    WHERE p.pricing_rule_id IS NOT NULL AND r.id IS NULL
  `).get() as { count: number }
  const orphanedEvents = db.prepare(`
    SELECT COUNT(*) count
    FROM webhook_events e
    LEFT JOIN payment_intents p
      ON p.tenant_id=e.tenant_id AND p.id=e.payment_intent_id
    WHERE p.id IS NULL
  `).get() as { count: number }
  const crossTenantDeliveries = db.prepare(`
    SELECT COUNT(*) count
    FROM webhook_deliveries d
    LEFT JOIN webhook_events e
      ON e.tenant_id=d.tenant_id AND e.id=d.event_id
    WHERE e.id IS NULL
  `).get() as { count: number }
  if (crossTenantPricing.count + orphanedEvents.count + crossTenantDeliveries.count > 0) {
    throw databaseError(
      'DATABASE_TENANT_OWNERSHIP_VIOLATION',
      'Existing rows violate canonical tenant ownership; migration stopped without deleting them',
    )
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_rules_tenant_id
      ON pricing_rules(tenant_id, id);

    CREATE TABLE payment_intents_v4 (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      merchant_order_id TEXT,
      pricing_rule_id TEXT,
      payment_link_id TEXT,
      amount_sats TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'SAT' CHECK (currency = 'SAT'),
      description TEXT NOT NULL,
      metadata TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('requires_payment','processing','succeeded','expired','failed','canceled')
      ),
      payment_request TEXT NOT NULL,
      payment_hash TEXT NOT NULL UNIQUE,
      provider_invoice_id TEXT NOT NULL UNIQUE,
      intent_secret_version INTEGER NOT NULL,
      intent_secret_key_id TEXT NOT NULL,
      intent_secret_nonce TEXT NOT NULL,
      intent_secret_ciphertext TEXT NOT NULL,
      intent_secret_auth_tag TEXT NOT NULL,
      client_secret_hash TEXT NOT NULL,
      idempotency_key TEXT,
      idempotency_payload_hash TEXT,
      expires_at TEXT NOT NULL,
      settled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, id),
      FOREIGN KEY(tenant_id, pricing_rule_id) REFERENCES pricing_rules(tenant_id, id)
    );

    INSERT INTO payment_intents_v4 SELECT
      id, tenant_id, merchant_order_id, pricing_rule_id, payment_link_id,
      amount_sats, UPPER(currency), description, metadata, status,
      payment_request, payment_hash, provider_invoice_id,
      intent_secret_version, intent_secret_key_id, intent_secret_nonce,
      intent_secret_ciphertext, intent_secret_auth_tag, client_secret_hash,
      idempotency_key, idempotency_payload_hash, expires_at, settled_at,
      created_at, updated_at
    FROM payment_intents;

    CREATE TABLE webhook_events_v4 (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      payment_intent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tenant_id, id),
      UNIQUE(tenant_id, payment_intent_id, type),
      FOREIGN KEY(tenant_id, payment_intent_id)
        REFERENCES payment_intents_v4(tenant_id, id)
    );
    INSERT INTO webhook_events_v4 SELECT
      id, tenant_id, payment_intent_id, type, payload, created_at FROM webhook_events;

    CREATE TABLE webhook_deliveries_v4 (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','delivered','failed','permanently_failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_attempt_at TEXT,
      next_attempt_at TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(tenant_id, event_id) REFERENCES webhook_events_v4(tenant_id, id)
    );
    INSERT INTO webhook_deliveries_v4 SELECT
      id, event_id, tenant_id, status, attempt_count, last_attempt_at,
      next_attempt_at, delivered_at, created_at FROM webhook_deliveries;

    DROP TABLE webhook_deliveries;
    DROP TABLE webhook_events;
    DROP TABLE payment_intents;
    ALTER TABLE payment_intents_v4 RENAME TO payment_intents;
    ALTER TABLE webhook_events_v4 RENAME TO webhook_events;
    ALTER TABLE webhook_deliveries_v4 RENAME TO webhook_deliveries;

    CREATE UNIQUE INDEX idx_payment_intents_tenant_idempotency
      ON payment_intents(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX idx_payment_intents_tenant_order
      ON payment_intents(tenant_id, merchant_order_id) WHERE merchant_order_id IS NOT NULL;
    CREATE INDEX idx_payment_intents_recovery ON payment_intents(status, expires_at);
    CREATE INDEX idx_payment_intents_tenant_created ON payment_intents(tenant_id, created_at);
    CREATE INDEX idx_webhook_events_intent
      ON webhook_events(tenant_id, payment_intent_id);
    CREATE INDEX idx_webhook_deliveries_due
      ON webhook_deliveries(status, next_attempt_at);

    CREATE TABLE legacy_product_mappings (
      product_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      pricing_rule_id TEXT NOT NULL,
      migrated_at TEXT NOT NULL,
      FOREIGN KEY(tenant_id, pricing_rule_id) REFERENCES pricing_rules(tenant_id, id)
    );
    CREATE TABLE legacy_checkout_mappings (
      checkout_session_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      tenant_id TEXT NOT NULL,
      payment_intent_id TEXT NOT NULL UNIQUE,
      migrated_at TEXT NOT NULL,
      FOREIGN KEY(tenant_id, payment_intent_id) REFERENCES payment_intents(tenant_id, id)
    );
  `)
}

function legacyStatus(state: string): string {
  switch (state) {
    case 'settled': return 'succeeded'
    case 'accepted': return 'processing'
    case 'expired': return 'expired'
    case 'canceled': return 'canceled'
    case 'failed': return 'failed'
    default: return 'requires_payment'
  }
}

function migrateLegacyPayments(db: DatabaseSync, context: MigrationContext): void {
  const sessions = rowCount(db, 'checkout_sessions')
  if (sessions === 0) return
  const cipher = context.options.intentSecretCipher
  if (!cipher) {
    throw databaseError(
      'DATABASE_ENCRYPTION_KEY_REQUIRED',
      'CHERITO_INTENT_SECRET_KEY is required to migrate legacy payments',
    )
  }

  const joined = db.prepare(`
    SELECT
      s.id sessionId, s.order_id orderId, s.product_id productId,
      s.quantity, s.amount_sats amountSats, s.payment_request paymentRequest,
      s.payment_hash paymentHash, s.expires_at expiresAt, s.state sessionState,
      i.id providerInvoiceId, i.state invoiceState, i.created_at createdAt,
      i.settled_at settledAt,
      o.state orderState,
      p.name productName, p.price_sats productPriceSats, p.active productActive,
      r.key idempotencyKey, r.payload_hash idempotencyPayloadHash
    FROM checkout_sessions s
    JOIN orders o ON o.id=s.order_id
    JOIN lightning_invoices i ON i.order_id=s.order_id AND i.payment_hash=s.payment_hash
    LEFT JOIN products p ON p.id=s.product_id
    LEFT JOIN idempotency_records r ON r.session_id=s.id
    ORDER BY s.id
  `).all() as Array<Record<string, string | number | null>>
  if (joined.length !== sessions) {
    throw databaseError(
      'DATABASE_LEGACY_INCONSISTENT',
      'Legacy checkout rows are orphaned; migration stopped without discarding payment history',
    )
  }

  const now = context.options.now().toISOString()
  db.prepare(`
    INSERT OR IGNORE INTO tenants
      (id, name, disabled, webhook_url, webhook_secret, prev_webhook_secret,
       secret_rotated_at, created_at, updated_at)
    VALUES (?, ?, 0, NULL, NULL, NULL, NULL, ?, ?)
  `).run(LEGACY_TENANT_ID, 'Legacy Checkout', LEGACY_CREATED_AT, now)

  const insertRule = db.prepare(`
    INSERT OR IGNORE INTO pricing_rules
      (id, tenant_id, product_id, name, description, mode, price_sats,
       max_price_sats, active, max_quantity, offer_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'fixed', ?, NULL, ?, 100, ?, ?, ?)
  `)
  const insertProductMap = db.prepare(`
    INSERT OR IGNORE INTO legacy_product_mappings VALUES (?, ?, ?, ?)
  `)
  const insertIntent = db.prepare(`
    INSERT OR IGNORE INTO payment_intents (
      id, tenant_id, merchant_order_id, pricing_rule_id, payment_link_id,
      amount_sats, currency, description, metadata, status,
      payment_request, payment_hash, provider_invoice_id,
      intent_secret_version, intent_secret_key_id, intent_secret_nonce,
      intent_secret_ciphertext, intent_secret_auth_tag, client_secret_hash,
      idempotency_key, idempotency_payload_hash, expires_at, settled_at,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)
  const insertCheckoutMap = db.prepare(`
    INSERT OR IGNORE INTO legacy_checkout_mappings VALUES (?, ?, ?, ?, ?)
  `)

  const products = new Map<string, Record<string, string | number | null>>()
  for (const row of joined) products.set(String(row.productId), row)
  for (const [productId, row] of products) {
    const pricingRuleId = `pr_legacy_${createHash('sha256').update(productId).digest('hex').slice(0, 24)}`
    const hasOffer = Boolean(db.prepare('SELECT 1 FROM bolt12_offers WHERE product_id=?').get(productId))
    insertRule.run(
      pricingRuleId,
      LEGACY_TENANT_ID,
      productId,
      String(row.productName ?? productId),
      'Migrated from the legacy checkout catalog',
      row.productPriceSats ?? row.amountSats ?? null,
      Number(row.productActive ?? 1),
      hasOffer ? 1 : 0,
      now,
      now,
    )
    insertProductMap.run(productId, LEGACY_TENANT_ID, pricingRuleId, now)
  }

  for (const row of joined) {
    const sessionId = String(row.sessionId)
    const orderId = String(row.orderId)
    const productId = String(row.productId)
    const intentId = `pi_legacy_${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`
    const pricingRuleId = `pr_legacy_${createHash('sha256').update(productId).digest('hex').slice(0, 24)}`
    const intentSecret = randomBytes(32).toString('hex')
    const encrypted = cipher.encrypt(intentSecret, LEGACY_TENANT_ID, intentId)
    const clientSecretHash = hashPaymentIntentClientSecret(
      derivePaymentIntentClientSecret(intentSecret, intentId, LEGACY_TENANT_ID),
    )
    const status = legacyStatus(String(row.invoiceState ?? row.sessionState))
    const createdAt = String(row.createdAt)
    insertIntent.run(
      intentId,
      LEGACY_TENANT_ID,
      orderId,
      pricingRuleId,
      null,
      String(row.amountSats),
      'SAT',
      String(row.productName ?? `Legacy order ${orderId}`),
      JSON.stringify({
        legacy: {
          checkoutSessionId: sessionId,
          orderId,
          productId,
          quantity: Number(row.quantity),
        },
      }),
      status,
      String(row.paymentRequest),
      String(row.paymentHash),
      String(row.providerInvoiceId),
      encrypted.version,
      encrypted.keyId,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.authTag,
      clientSecretHash,
      row.idempotencyKey ?? null,
      row.idempotencyPayloadHash ?? null,
      String(row.expiresAt),
      status === 'succeeded' ? row.settledAt ?? createdAt : null,
      createdAt,
      row.settledAt ?? createdAt,
    )
    insertCheckoutMap.run(sessionId, orderId, LEGACY_TENANT_ID, intentId, now)
  }
}

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  { version: 1, name: 'tenant foundation', up: createTenantFoundation },
  { version: 2, name: 'legacy checkout and webhook outbox foundation', up: createLegacyAndOutboxFoundation },
  {
    version: 3,
    name: 'canonical encrypted Payment Intents',
    backupRequired: (db) => tableColumns(db, 'payment_intents').has('intent_secret'),
    up: createPaymentIntentFoundation,
  },
  { version: 4, name: 'tenant ownership and relational hardening', destructive: true, up: hardenTenantOwnership },
  { version: 5, name: 'legacy checkout forward migration', up: migrateLegacyPayments },
] as const

export function applyDatabaseMigrations(
  db: DatabaseSync,
  databasePath: string,
  options: DatabaseMigrationOptions = {},
): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT,
      applied_at TEXT NOT NULL
    )
  `)
  const migrationColumns = tableColumns(db, 'schema_migrations')
  if (!migrationColumns.has('name')) db.exec('ALTER TABLE schema_migrations ADD COLUMN name TEXT')

  const migrations = options.migrations ?? DATABASE_MIGRATIONS
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!
    if (migration.version !== index + 1) {
      throw new Error('Database migrations must be contiguous and monotonically increasing')
    }
  }
  const latest = migrations.at(-1)?.version ?? 0
  const current = currentSchemaVersion(db)
  if (current > latest) {
    throw databaseError(
      'DATABASE_SCHEMA_TOO_NEW',
      `Database schema ${current} is newer than supported version ${latest}`,
    )
  }
  assertMigrationHistory(db, current)
  if (current < latest && tableExists(db, 'payment_links')) {
    throw databaseError(
      'DATABASE_SCHEMA_UNSUPPORTED',
      'Detected an unmerged Payment Links prototype; rebase its branch before migrating this database',
    )
  }

  const context: MigrationContext = {
    databasePath,
    options: {
      ...options,
      busyTimeoutMs: options.busyTimeoutMs ?? 5_000,
      applicationVersion: options.applicationVersion ?? '1.0.0',
      now: options.now ?? (() => new Date()),
    },
    backupCreated: false,
  }

  for (const migration of migrations) {
    if (migration.version <= current) continue
    const scrubPlaintextIntentSecret = migration.version === 3
      && tableColumns(db, 'payment_intents').has('intent_secret')
    if (migration.destructive || migration.backupRequired?.(db)) {
      createPreMigrationBackup(db, context, migration.version)
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db, context)
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, context.options.now().toISOString())
      db.exec('COMMIT')
      if (scrubPlaintextIntentSecret) db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  validateDatabaseIntegrity(db)
  return currentSchemaVersion(db)
}

export function validateDatabaseIntegrity(db: DatabaseSync): void {
  const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw databaseError(
      'DATABASE_INTEGRITY_CHECK_FAILED',
      `SQLite integrity check failed: ${integrity.map(Object.values).flat().join(', ')}`,
    )
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeys.length > 0) {
    throw databaseError(
      'DATABASE_FOREIGN_KEY_CHECK_FAILED',
      `SQLite reported ${foreignKeys.length} foreign-key violation(s)`,
    )
  }
}
