import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PaymentIntentSecretCipher } from '../src/security/payment-intent-secret-cipher.js'
import { PaymentIntentRepository } from '../src/persistence/payment-intent-repository.js'

const KEY_A = Buffer.alloc(32, 0xa1).toString('base64')
const KEY_B = Buffer.alloc(32, 0xb2).toString('base64')
const SECRET = Buffer.alloc(32, 0xc3).toString('hex')

test('AES-GCM intent-secret envelopes use random nonces and authenticated context', () => {
  const cipher = new PaymentIntentSecretCipher(KEY_A)
  const first = cipher.encrypt(SECRET, 'tnt_a', 'pi_a')
  const second = cipher.encrypt(SECRET, 'tnt_a', 'pi_a')

  assert.notEqual(first.nonce, second.nonce)
  assert.notEqual(first.ciphertext, SECRET)
  assert.equal(cipher.decrypt(first, 'tnt_a', 'pi_a'), SECRET)
  assert.throws(
    () => cipher.decrypt(first, 'tnt_b', 'pi_a'),
    /authentication failed/,
  )
  assert.throws(
    () => cipher.decrypt(first, 'tnt_a', 'pi_b'),
    /authentication failed/,
  )
})

test('wrong keys and modified authentication tags cannot decrypt an intent secret', () => {
  const cipherA = new PaymentIntentSecretCipher(KEY_A)
  const encrypted = cipherA.encrypt(SECRET, 'tnt_a', 'pi_a')
  const cipherB = new PaymentIntentSecretCipher(KEY_B)

  assert.throws(() => cipherB.decrypt(encrypted, 'tnt_a', 'pi_a'), /Missing Payment Intent/)
  assert.throws(
    () => cipherA.decrypt({ ...encrypted, authTag: Buffer.alloc(16).toString('base64url') }, 'tnt_a', 'pi_a'),
    /authentication failed/,
  )
})

test('encryption key configuration requires canonical unique 32-byte base64 keys', () => {
  assert.throws(() => new PaymentIntentSecretCipher('not-a-key'), /canonical base64/)
  assert.throws(() => new PaymentIntentSecretCipher(KEY_A, KEY_A), /must be unique/)
})

test('legacy plaintext rows migrate transactionally and their SQLite pages are scrubbed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cherito-intent-secret-migration-'))
  const databasePath = join(directory, 'gateway.sqlite')
  const databaseUrl = `file:${databasePath}`
  const tenantId = 'tnt_00000000-0000-4000-8000-000000000001'
  const intentId = 'pi_00000000-0000-4000-8000-000000000002'
  const plaintext = Buffer.alloc(32, 0xdd).toString('hex')
  const now = new Date().toISOString()

  try {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      PRAGMA secure_delete=ON;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES (1, '${now}');
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, disabled INTEGER NOT NULL,
        webhook_url TEXT, webhook_secret TEXT, prev_webhook_secret TEXT,
        secret_rotated_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE merchant_api_keys (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
        key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, label TEXT NOT NULL,
        created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE pricing_rules (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
        product_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        mode TEXT NOT NULL, price_sats TEXT, max_price_sats TEXT,
        active INTEGER NOT NULL, max_quantity INTEGER NOT NULL,
        offer_enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, product_id), UNIQUE(tenant_id, id)
      );
      INSERT INTO tenants VALUES (
        '${tenantId}', 'Migration Merchant', 0, NULL, NULL, NULL, NULL, '${now}', '${now}'
      );
      CREATE TABLE payment_intent_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO payment_intent_schema_migrations VALUES (1, '${now}');
      CREATE TABLE payment_intents (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, merchant_order_id TEXT,
        pricing_rule_id TEXT, payment_link_id TEXT, amount_sats TEXT NOT NULL,
        currency TEXT NOT NULL, description TEXT NOT NULL, metadata TEXT,
        status TEXT NOT NULL, payment_request TEXT NOT NULL,
        payment_hash TEXT NOT NULL UNIQUE, provider_invoice_id TEXT NOT NULL UNIQUE,
        intent_secret TEXT NOT NULL, client_secret_hash TEXT NOT NULL,
        idempotency_key TEXT, idempotency_payload_hash TEXT, expires_at TEXT NOT NULL,
        settled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    legacy.prepare('INSERT INTO payment_intents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        intentId,
        tenantId,
        null,
        null,
        null,
        '2000',
        'SAT',
        'Legacy intent',
        null,
        'requires_payment',
        'lnbcrt_legacy',
        'hash_legacy',
        'provider_legacy',
        plaintext,
        '00'.repeat(32),
        'legacy-key',
        '11'.repeat(32),
        new Date(Date.now() + 60_000).toISOString(),
        null,
        now,
        now,
      )
    legacy.close()

    const migrated = new PaymentIntentRepository(
      databaseUrl,
      new PaymentIntentSecretCipher(KEY_A),
    )
    assert.equal(migrated.paymentIntent(tenantId, intentId)?.intentSecret, plaintext)
    migrated.close()

    const inspected = new DatabaseSync(databasePath, { readOnly: true })
    const columns = inspected.prepare('PRAGMA table_info(payment_intents)').all() as Array<{
      name: string
    }>
    const versions = inspected
      .prepare('SELECT version FROM payment_intent_schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    const schemaVersion = inspected
      .prepare('SELECT MAX(version) version FROM schema_migrations')
      .get() as { version: number }
    inspected.close()
    assert.equal(columns.some(({ name }) => name === 'intent_secret'), false)
    assert.deepEqual(versions.map(({ version }) => version), [1, 2, 3])
    assert.equal(schemaVersion.version, 6)
    assert.equal(readFileSync(databasePath).includes(Buffer.from(plaintext, 'utf8')), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
