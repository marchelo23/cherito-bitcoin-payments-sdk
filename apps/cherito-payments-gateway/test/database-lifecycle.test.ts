import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CreatedInvoice,
  LightningCapabilities,
  LightningInvoice,
  LightningReceiveProvider,
  PublicNodeInfo,
} from '@cherito/bitcoin-sdk'
import type { Config } from '../src/config.js'
import {
  applyDatabaseMigrations,
  currentSchemaVersion,
  LATEST_DATABASE_SCHEMA_VERSION,
  openDatabase,
  type DatabaseMigration,
} from '../src/persistence/database-lifecycle.js'
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
} from '../src/persistence/database-backup.js'
import {
  PaymentIntentRepository,
  type PaymentIntent,
} from '../src/persistence/payment-intent-repository.js'
import { PaymentIntentSecretCipher } from '../src/security/payment-intent-secret-cipher.js'
import {
  derivePaymentIntentClientSecret,
  hashPaymentIntentClientSecret,
} from '../src/security/payment-intent-client-capability.js'
import {
  PaymentIntentService,
  type PaymentIntentEventSink,
} from '../src/services/payment-intent-service.js'
import type { TenantService } from '../src/services/tenant-service.js'

const KEY = Buffer.alloc(32, 0x38).toString('base64')
const cipher = () => new PaymentIntentSecretCipher(KEY)
const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cherito-database-lifecycle-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function createLegacyDatabase(path: string): void {
  const db = new DatabaseSync(path)
  const now = '2025-01-01T00:00:00.000Z'
  db.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, price_sats TEXT NOT NULL, active INTEGER NOT NULL
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, quantity INTEGER NOT NULL,
      amount_sats TEXT NOT NULL, state TEXT NOT NULL, confirmed_at TEXT
    );
    CREATE TABLE lightning_invoices (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL, provider TEXT NOT NULL,
      payment_hash TEXT UNIQUE NOT NULL, payment_request TEXT NOT NULL,
      amount_sats TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, settled_at TEXT, provider_add_index TEXT,
      provider_settle_index TEXT
    );
    CREATE TABLE checkout_sessions (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL, amount_sats TEXT NOT NULL,
      payment_request TEXT NOT NULL, payment_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL, state TEXT NOT NULL, token_hash TEXT NOT NULL
    );
    CREATE TABLE idempotency_records (
      key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, session_id TEXT NOT NULL,
      status_token TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE bolt12_offers (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, offer TEXT NOT NULL,
      amount_sats TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `)
  db.prepare('INSERT INTO products VALUES (?,?,?,?)')
    .run('coffee', 'Coffee', '9007199254740993', 1)
  db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)')
    .run('ord_pending', 'coffee', 1, '9007199254740993', 'pending', null)
  db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)')
    .run('ord_settled', 'coffee', 2, '18014398509481986', 'confirmed', now)
  const insertInvoice = db.prepare('INSERT INTO lightning_invoices VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  insertInvoice.run(
    'provider_pending', 'ord_pending', 'lnd', 'hash_pending', 'ln_pending',
    '9007199254740993', 'pending', now, '2030-01-01T00:00:00.000Z', null, '1', null,
  )
  insertInvoice.run(
    'provider_settled', 'ord_settled', 'lnd', 'hash_settled', 'ln_settled',
    '18014398509481986', 'settled', now, '2030-01-01T00:00:00.000Z', now, '2', '3',
  )
  const insertSession = db.prepare('INSERT INTO checkout_sessions VALUES (?,?,?,?,?,?,?,?,?,?)')
  insertSession.run(
    'chk_pending', 'ord_pending', 'coffee', 1, '9007199254740993',
    'ln_pending', 'hash_pending', '2030-01-01T00:00:00.000Z', 'pending', 'token_pending',
  )
  insertSession.run(
    'chk_settled', 'ord_settled', 'coffee', 2, '18014398509481986',
    'ln_settled', 'hash_settled', '2030-01-01T00:00:00.000Z', 'settled', 'token_settled',
  )
  const insertIdempotency = db.prepare('INSERT INTO idempotency_records VALUES (?,?,?,?,?)')
  insertIdempotency.run('idem_pending', 'payload_pending', 'chk_pending', 'secret_pending', '2030-01-01T00:00:00.000Z')
  insertIdempotency.run('idem_settled', 'payload_settled', 'chk_settled', 'secret_settled', '2030-01-01T00:00:00.000Z')
  db.prepare('INSERT INTO bolt12_offers VALUES (?,?,?,?,?)')
    .run('offer_coffee', 'coffee', 'lno1legacy', '9007199254740993', now)
  db.close()
}

function tenant(id: string) {
  const now = new Date().toISOString()
  return {
    id,
    name: id,
    disabled: false,
    webhookUrl: null,
    webhookSecret: null,
    prevWebhookSecret: null,
    secretRotatedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

function intent(tenantId: string, id: string, overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  const digest = createHash('sha256').update(`${tenantId}:${id}`).digest('hex')
  const now = new Date().toISOString()
  return {
    id,
    tenantId,
    merchantOrderId: null,
    pricingRuleId: null,
    paymentLinkId: null,
    amountSats: '1000',
    currency: 'SAT',
    description: 'Database lifecycle test',
    metadata: null,
    status: 'requires_payment',
    paymentRequest: `lnbcrt_${digest}`,
    paymentHash: digest,
    providerInvoiceId: `provider_${digest}`,
    intentSecret: digest,
    clientSecretHash: digest,
    idempotencyKey: null,
    idempotencyPayloadHash: null,
    expiresAt: '2030-01-01T00:00:00.000Z',
    settledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('versioned SQLite migrations', () => {
  test('empty database migrates to the immutable latest history and repeated startup is safe', () => {
    const path = join(temporaryDirectory(), 'fresh.sqlite')
    for (let startup = 0; startup < 3; startup += 1) {
      const db = openDatabase(`file:${path}`, { intentSecretCipher: cipher() })
      assert.equal(currentSchemaVersion(db), LATEST_DATABASE_SCHEMA_VERSION)
      assert.deepEqual(
        (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>)
          .map(({ version }) => version),
        [1, 2, 3, 4, 5],
      )
      assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1)
      assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal')
      assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5_000)
      assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
      db.close()
    }
  })

  test('actual legacy checkout data forward-migrates without losing exact amounts or history', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'legacy.sqlite')
    const backups = join(directory, 'automatic-backups')
    createLegacyDatabase(path)

    const db = openDatabase(`file:${path}`, {
      intentSecretCipher: cipher(),
      backupDirectory: backups,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    })
    assert.equal(currentSchemaVersion(db), 5)
    assert.equal((db.prepare('SELECT COUNT(*) count FROM orders').get() as { count: number }).count, 2)
    assert.equal((db.prepare('SELECT COUNT(*) count FROM lightning_invoices').get() as { count: number }).count, 2)
    assert.equal((db.prepare('SELECT COUNT(*) count FROM checkout_sessions').get() as { count: number }).count, 2)
    assert.equal((db.prepare('SELECT COUNT(*) count FROM bolt12_offers').get() as { count: number }).count, 1)
    const migrated = db.prepare(`
      SELECT p.amount_sats amountSats, p.payment_hash paymentHash, p.status,
        p.merchant_order_id orderId, m.checkout_session_id sessionId
      FROM payment_intents p
      JOIN legacy_checkout_mappings m
        ON m.tenant_id=p.tenant_id AND m.payment_intent_id=p.id
      ORDER BY m.checkout_session_id
    `).all() as Array<Record<string, string>>
    assert.deepEqual(migrated.map((row) => ({ ...row })), [
      {
        amountSats: '9007199254740993',
        paymentHash: 'hash_pending',
        status: 'requires_payment',
        orderId: 'ord_pending',
        sessionId: 'chk_pending',
      },
      {
        amountSats: '18014398509481986',
        paymentHash: 'hash_settled',
        status: 'succeeded',
        orderId: 'ord_settled',
        sessionId: 'chk_settled',
      },
    ])
    assert.equal((db.prepare('PRAGMA foreign_key_check').all()).length, 0)
    db.close()
    const canonical = new PaymentIntentRepository(`file:${path}`, cipher())
    const pendingIntent = canonical.paymentIntentByHash('legacy', 'hash_pending')!
    const recoveredClientSecret = derivePaymentIntentClientSecret(
      pendingIntent.intentSecret,
      pendingIntent.id,
      pendingIntent.tenantId,
    )
    assert.equal(
      hashPaymentIntentClientSecret(recoveredClientSecret),
      pendingIntent.clientSecretHash,
    )
    canonical.close()
    assert.ok(readdirSync(backups).some((name) => name.endsWith('.sqlite')))
    assert.ok(readdirSync(backups).some((name) => name.endsWith('.sqlite.json')))
  })

  test('a failed migration rolls back its writes and never records its version', () => {
    const path = join(temporaryDirectory(), 'failure.sqlite')
    const db = new DatabaseSync(path)
    const migrations: readonly DatabaseMigration[] = [{
      version: 1,
      name: 'intentional failure',
      up(database) {
        database.exec('CREATE TABLE should_rollback (id TEXT PRIMARY KEY)')
        throw new Error('expected migration failure')
      },
    }]
    assert.throws(
      () => applyDatabaseMigrations(db, path, { migrations }),
      /expected migration failure/,
    )
    assert.equal(currentSchemaVersion(db), 0)
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='should_rollback'").get(), undefined)
    db.close()
  })

  test('a failed safety backup blocks destructive migration without losing legacy rows', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'legacy-blocked.sqlite')
    const invalidBackupDirectory = join(directory, 'not-a-directory')
    createLegacyDatabase(path)
    writeFileSync(invalidBackupDirectory, 'block mkdir')
    assert.throws(
      () => openDatabase(`file:${path}`, {
        intentSecretCipher: cipher(),
        backupDirectory: invalidBackupDirectory,
      }),
      (error: unknown) => (error as { code?: string }).code === 'DATABASE_BACKUP_FAILED',
    )
    const inspected = new DatabaseSync(path, { readOnly: true })
    assert.equal((inspected.prepare('SELECT COUNT(*) count FROM orders').get() as { count: number }).count, 2)
    assert.deepEqual(
      (inspected.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>)
        .map(({ version }) => version),
      [1, 2, 3],
    )
    inspected.close()
    const recovered = openDatabase(`file:${path}`, {
      intentSecretCipher: cipher(),
      backupDirectory: join(directory, 'valid-backups'),
    })
    assert.equal(currentSchemaVersion(recovered), 5)
    assert.equal((recovered.prepare('SELECT COUNT(*) count FROM orders').get() as { count: number }).count, 2)
    recovered.close()
  })

  test('future schemas and unmerged Payment Link prototypes fail closed', () => {
    const futurePath = join(temporaryDirectory(), 'future.sqlite')
    const future = new DatabaseSync(futurePath)
    future.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (6, 'future', '2026-01-01T00:00:00.000Z');
    `)
    future.close()
    assert.throws(
      () => openDatabase(`file:${futurePath}`, { intentSecretCipher: cipher() }),
      (error: unknown) => (error as { code?: string }).code === 'DATABASE_SCHEMA_TOO_NEW',
    )

    const prototypePath = join(temporaryDirectory(), 'prototype.sqlite')
    const prototype = new DatabaseSync(prototypePath)
    prototype.exec('CREATE TABLE payment_links (id TEXT PRIMARY KEY)')
    prototype.close()
    assert.throws(
      () => openDatabase(`file:${prototypePath}`, { intentSecretCipher: cipher() }),
      (error: unknown) => (error as { code?: string }).code === 'DATABASE_SCHEMA_UNSUPPORTED',
    )
  })

  test('database constraints enforce uniqueness and tenant ownership', () => {
    const path = join(temporaryDirectory(), 'constraints.sqlite')
    const repo = new PaymentIntentRepository(`file:${path}`, cipher())
    repo.createTenant(tenant('tenant_a'))
    repo.createTenant(tenant('tenant_b'))
    const now = new Date().toISOString()
    repo.upsertPricingRule({
      id: 'rule_a', tenantId: 'tenant_a', productId: 'coffee', name: 'Coffee',
      description: null, mode: 'fixed', priceSats: '1000', maxPriceSats: null,
      active: true, maxQuantity: 10, offerEnabled: false, createdAt: now, updatedAt: now,
    })
    repo.createPaymentIntent(intent('tenant_a', 'pi_a', {
      merchantOrderId: 'order-1',
      idempotencyKey: 'idem-1',
      idempotencyPayloadHash: 'payload-1',
    }))
    assert.throws(() => repo.createPaymentIntent(intent('tenant_a', 'pi_same_order', {
      merchantOrderId: 'order-1',
    })), /UNIQUE constraint failed/)
    assert.throws(() => repo.createPaymentIntent(intent('tenant_a', 'pi_same_idem', {
      idempotencyKey: 'idem-1',
      idempotencyPayloadHash: 'payload-1',
    })), /UNIQUE constraint failed/)
    repo.createPaymentIntent(intent('tenant_b', 'pi_b', {
      merchantOrderId: 'order-1',
      idempotencyKey: 'idem-1',
      idempotencyPayloadHash: 'payload-1',
    }))
    assert.throws(() => repo.createPaymentIntent(intent('tenant_b', 'pi_cross_rule', {
      pricingRuleId: 'rule_a',
    })), /FOREIGN KEY constraint failed/)
    assert.throws(() => repo.createPaymentIntent(intent('tenant_b', 'pi_same_hash', {
      paymentHash: repo.paymentIntent('tenant_a', 'pi_a')!.paymentHash,
    })), /UNIQUE constraint failed/)
    repo.createApiKey({
      id: 'key_a', tenantId: 'tenant_a', keyHash: 'fingerprint', keyPrefix: 'cherito_a',
      label: 'a', createdAt: now, revokedAt: null,
    })
    assert.throws(() => repo.createApiKey({
      id: 'key_b', tenantId: 'tenant_b', keyHash: 'fingerprint', keyPrefix: 'cherito_b',
      label: 'b', createdAt: now, revokedAt: null,
    }), /UNIQUE constraint failed/)
    repo.close()
  })

  test('one logical event is enforced for tenant, intent, and event type', () => {
    const path = join(temporaryDirectory(), 'events.sqlite')
    const repo = new PaymentIntentRepository(`file:${path}`, cipher())
    repo.createTenant(tenant('tenant_events'))
    const created = intent('tenant_events', 'pi_events')
    repo.createPaymentIntent(created)
    assert.equal(repo.transitionPaymentIntent({
      tenantId: created.tenantId,
      paymentHash: created.paymentHash,
      fromStatus: 'requires_payment',
      toStatus: 'succeeded',
      settledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      event: {
        id: 'event_1', deliveryId: 'delivery_1', type: 'payment_intent.succeeded',
        payload: '{}', createdAt: new Date().toISOString(),
      },
    }), true)
    assert.equal(repo.transitionPaymentIntent({
      tenantId: created.tenantId,
      paymentHash: created.paymentHash,
      fromStatus: 'requires_payment',
      toStatus: 'succeeded',
      updatedAt: new Date().toISOString(),
      event: {
        id: 'event_2', deliveryId: 'delivery_2', type: 'payment_intent.succeeded',
        payload: '{}', createdAt: new Date().toISOString(),
      },
    }), false)
    repo.close()
    const inspected = new DatabaseSync(path, { readOnly: true })
    assert.equal((inspected.prepare('SELECT COUNT(*) count FROM webhook_events').get() as { count: number }).count, 1)
    inspected.close()
  })
})

class RestoreProvider implements LightningReceiveProvider {
  getCalls = 0
  subscribeCalls = 0
  constructor(readonly invoice: LightningInvoice) {}
  async getCapabilities(): Promise<LightningCapabilities> {
    return { provider: 'lnd', bolt11Receive: true, bolt12Receive: false, invoiceStreaming: true }
  }
  async getNodeInfo(): Promise<PublicNodeInfo> {
    return { alias: 'restore', network: 'regtest', syncedToChain: true, syncedToGraph: true }
  }
  async createInvoice(): Promise<CreatedInvoice> {
    throw new Error('restore tests never create invoices')
  }
  async getInvoice(): Promise<LightningInvoice> {
    this.getCalls += 1
    return { ...this.invoice }
  }
  async subscribeToInvoice(): Promise<() => Promise<void>> {
    this.subscribeCalls += 1
    return async () => {}
  }
}

class RestoreEventSink implements PaymentIntentEventSink {
  count = 0
  enqueuePaymentIntentEvent(): void { this.count += 1 }
}

describe('SQLite-safe backup, restore, and provider recovery', () => {
  async function preparedBackup(status: PaymentIntent['status'] = 'requires_payment') {
    const directory = temporaryDirectory()
    const sourcePath = join(directory, 'source.sqlite')
    const source = new PaymentIntentRepository(`file:${sourcePath}`, cipher())
    source.createTenant(tenant('tenant_restore'))
    const payment = intent('tenant_restore', 'pi_restore', {
      status,
      settledAt: status === 'succeeded' ? '2026-01-01T00:00:00.000Z' : null,
    })
    source.createPaymentIntent(payment)
    source.close()
    const backupPath = join(directory, 'backup.sqlite')
    const backup = await createDatabaseBackup({
      databaseUrl: `file:${sourcePath}`,
      destination: backupPath,
      applicationVersion: 'test-version',
      reason: 'automated restore test',
    })
    return { directory, backupPath, backup, payment }
  }

  test('backup API produces a consistent WAL-aware database plus validated metadata', async () => {
    const { backupPath, backup } = await preparedBackup()
    assert.equal(backup.metadata.schemaVersion, 5)
    assert.equal(backup.metadata.applicationVersion, 'test-version')
    assert.match(backup.metadata.sha256!, /^[a-f0-9]{64}$/)
    assert.equal(JSON.parse(readFileSync(`${backupPath}.json`, 'utf8')).databaseBytes, backup.metadata.databaseBytes)
    const verified = new DatabaseSync(backupPath, { readOnly: true })
    assert.equal(
      (verified.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check,
      'ok',
    )
    verified.close()
    await assert.rejects(
      () => createDatabaseBackup({ databaseUrl: `file:${backupPath}`, destination: backupPath }),
      (error: unknown) => (error as { code?: string }).code === 'DATABASE_BACKUP_EXISTS',
    )
  })

  test('backup refuses schemas containing wallet key material', async () => {
    const directory = temporaryDirectory()
    const sourcePath = join(directory, 'unsafe.sqlite')
    const db = openDatabase(`file:${sourcePath}`, { intentSecretCipher: cipher() })
    db.exec('CREATE TABLE wallet_seeds (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.close()
    await assert.rejects(
      () => createDatabaseBackup({
        databaseUrl: `file:${sourcePath}`,
        destination: join(directory, 'must-not-exist.sqlite'),
      }),
      (error: unknown) => (error as { code?: string }).code === 'DATABASE_BACKUP_PROHIBITED_MATERIAL',
    )
  })

  test('restore requires a clean destination and rejects damaged or incompatible metadata', async () => {
    const first = await preparedBackup()
    const destination = join(first.directory, 'restored.sqlite')
    const restored = await restoreDatabaseBackup({
      backupPath: first.backupPath,
      destinationDatabaseUrl: `file:${destination}`,
      intentSecretCipher: cipher(),
    })
    assert.deepEqual(restored, { schemaVersion: 5, requiresProviderReconciliation: true })
    await assert.rejects(
      () => restoreDatabaseBackup({
        backupPath: first.backupPath,
        destinationDatabaseUrl: `file:${destination}`,
        intentSecretCipher: cipher(),
      }),
      (error: unknown) => (error as { code?: string }).code === 'DATABASE_RESTORE_DESTINATION_EXISTS',
    )

    const corrupt = await preparedBackup()
    appendFileSync(corrupt.backupPath, 'corruption')
    await assert.rejects(
      () => restoreDatabaseBackup({
        backupPath: corrupt.backupPath,
        destinationDatabaseUrl: `file:${join(corrupt.directory, 'corrupt-restore.sqlite')}`,
        intentSecretCipher: cipher(),
      }),
      (error: unknown) => (error as { code?: string }).code === 'DATABASE_BACKUP_SIZE_MISMATCH',
    )

    const incompatible = await preparedBackup()
    const metadata = JSON.parse(readFileSync(`${incompatible.backupPath}.json`, 'utf8')) as Record<string, unknown>
    metadata.schemaVersion = LATEST_DATABASE_SCHEMA_VERSION + 1
    writeFileSync(`${incompatible.backupPath}.json`, JSON.stringify(metadata))
    await assert.rejects(
      () => restoreDatabaseBackup({
        backupPath: incompatible.backupPath,
        destinationDatabaseUrl: `file:${join(incompatible.directory, 'future-restore.sqlite')}`,
        intentSecretCipher: cipher(),
      }),
      (error: unknown) => (error as { code?: string }).code === 'DATABASE_SCHEMA_TOO_NEW',
    )
  })

  test('restored pending payments reconcile provider settlement once without duplicate fulfillment', async () => {
    const { directory, backupPath, payment } = await preparedBackup()
    const destination = join(directory, 'reconciled.sqlite')
    await restoreDatabaseBackup({
      backupPath,
      destinationDatabaseUrl: `file:${destination}`,
      intentSecretCipher: cipher(),
    })
    const repo = new PaymentIntentRepository(`file:${destination}`, cipher())
    const provider = new RestoreProvider({
      providerInvoiceId: payment.providerInvoiceId,
      paymentHash: payment.paymentHash,
      paymentRequest: payment.paymentRequest,
      amountSats: BigInt(payment.amountSats),
      expiresAt: payment.expiresAt,
      state: 'settled',
      settledAt: '2026-02-01T00:00:00.000Z',
    })
    const sink = new RestoreEventSink()
    const service = new PaymentIntentService(
      provider,
      repo,
      {} as Config,
      {} as TenantService,
      sink,
      { logger: { error() {} }, reconciliationIntervalMs: 100_000 },
    )
    await service.recoverPendingIntents()
    await service.recoverPendingIntents()
    assert.equal(repo.paymentIntent(payment.tenantId, payment.id)?.status, 'succeeded')
    assert.equal(repo.paymentIntent(payment.tenantId, payment.id)?.settledAt, '2026-02-01T00:00:00.000Z')
    assert.equal(provider.getCalls, 1)
    assert.equal(provider.subscribeCalls, 0)
    assert.equal(sink.count, 1)
    await service.shutdown()
    repo.close()
    const inspected = new DatabaseSync(destination, { readOnly: true })
    assert.equal((inspected.prepare('SELECT COUNT(*) count FROM webhook_events').get() as { count: number }).count, 1)
    inspected.close()
  })

  test('a restored already-settled payment remains terminal without provider or fulfillment replay', async () => {
    const { directory, backupPath, payment } = await preparedBackup('succeeded')
    const destination = join(directory, 'already-settled.sqlite')
    await restoreDatabaseBackup({
      backupPath,
      destinationDatabaseUrl: `file:${destination}`,
      intentSecretCipher: cipher(),
    })
    const repo = new PaymentIntentRepository(`file:${destination}`, cipher())
    const provider = new RestoreProvider({
      providerInvoiceId: payment.providerInvoiceId,
      paymentHash: payment.paymentHash,
      paymentRequest: payment.paymentRequest,
      amountSats: BigInt(payment.amountSats),
      expiresAt: payment.expiresAt,
      state: 'settled',
    })
    const sink = new RestoreEventSink()
    const service = new PaymentIntentService(
      provider, repo, {} as Config, {} as TenantService, sink, { logger: { error() {} } },
    )
    await service.recoverPendingIntents()
    assert.equal(repo.paymentIntent(payment.tenantId, payment.id)?.status, 'succeeded')
    assert.equal(provider.getCalls, 0)
    assert.equal(sink.count, 0)
    await service.shutdown()
    repo.close()
  })
})
