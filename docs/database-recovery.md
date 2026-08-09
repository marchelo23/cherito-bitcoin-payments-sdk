# Database migrations, backup, and disaster recovery

Cherito treats SQLite as payment infrastructure. Startup applies immutable,
ordered migrations and refuses to open a database whose schema is newer than
the binary supports (`DATABASE_SCHEMA_TOO_NEW`). Migration versions are:

1. tenant, API-key fingerprint, and pricing-rule foundation;
2. legacy checkout tables and the durable webhook outbox;
3. canonical Payment Intents with application-encrypted capability keys;
4. tenant ownership, composite foreign keys, status checks, uniqueness, and
   legacy traceability tables;
5. forward migration of legacy checkouts into canonical Payment Intents.

Versions are history. Never edit a released migration; add the next integer.
Every migration and its version record share a transaction. A migration that
rewrites or drops data must be marked destructive. Cherito then creates a
consistent pre-migration backup first; backup failure blocks the migration.
After upgrading, do not run an older Cherito binary against the upgraded file.

## Supported database states

The migrator supports empty databases, the original checkout schema
(`products`, `orders`, `lightning_invoices`, `checkout_sessions`,
`idempotency_records`, and `bolt12_offers`), the tenant schema from early
releases, and the encrypted Payment Intent schema merged by PR #37. Legacy IDs,
orders, hashes, exact decimal satoshi strings, invoice states, and BOLT12 offers
remain in place. `legacy_*_mappings` make every migrated checkout traceable to
its canonical Payment Intent. New legacy checkouts are dual-written atomically
to that canonical model during the compatibility period.

Unmerged prototype schemas, including the old Payment Link prototype, are not
silently reinterpreted. Startup fails with `DATABASE_SCHEMA_UNSUPPORTED`; rebase
and migrate that feature from the canonical schema instead.

## SQLite runtime policy

Every application connection enables:

- `foreign_keys=ON`;
- WAL journal mode;
- a configurable `busy_timeout` (5 seconds by default);
- `synchronous=FULL` and `secure_delete=ON`.

Startup and maintenance validate `PRAGMA integrity_check` and
`PRAGMA foreign_key_check`. Shutdown stops reconciliation and webhook workers,
then closes all SQLite handles. Operators should monitor disk space for the DB,
`-wal`, backups, and temporary restore files. Cherito performs a full WAL
checkpoint before an automatic destructive-migration backup and a truncate
checkpoint before publishing a restored database.

## Operator backup

Use Node's supported SQLite backup API; never copy a live `.sqlite` file while
WAL writes are active.

```sh
pnpm db backup \
  --database file:/var/lib/cherito/gateway.sqlite \
  --output /var/backups/cherito/gateway-2026-08-08.sqlite \
  --reason scheduled
```

The command writes the consistent database plus a sibling `.json` manifest
containing format version, schema version, creation time, application version,
byte size, SHA-256, and reason. Existing artifacts are never overwritten. The
backup scanner refuses schemas containing seed phrases, xprvs, private keys, or
admin macaroons.

The database currently contains operational payment data and may contain
webhook signing secrets and legacy status tokens. Payment Intent capability
keys are AES-256-GCM encrypted, but a backup still requires external encryption,
restricted access, and encrypted off-host storage. Keep
`CHERITO_INTENT_SECRET_KEY` outside both the database and its backup, in a
separate secret manager. Losing that key prevents capability recovery; storing
it beside the backup removes the security boundary.

Suggested baseline: hourly backups with at least 24 hourly and 30 daily copies,
plus a restore drill after releases that add migrations. This is an operational
starting point, not a universal promise: choose and document an RPO/RTO based on
merchant volume and provider availability.

## Restore runbook

1. Stop all gateway instances and prevent writes.
2. Preserve the failed database, its `-wal`, and `-shm` files for forensics.
3. Fetch the database and manifest from encrypted off-host storage.
4. Provide the Payment Intent encryption key through the secret manager.
5. Restore to a new, absent path:

   ```sh
   CHERITO_INTENT_SECRET_KEY="$KEY_FROM_SECRET_MANAGER" \
   pnpm db restore \
     --input /var/backups/cherito/gateway-2026-08-08.sqlite \
     --database file:/var/lib/cherito/restored.sqlite
   ```

6. The command validates manifest format, size, checksum, schema compatibility,
   SQLite integrity, foreign keys, prohibited fields, and pending migrations.
7. Point `DATABASE_URL` at the restored path and start one gateway instance.
8. Do not send traffic until startup completes. Before constructing the HTTP
   server, Cherito queries the Lightning provider for every non-terminal
   Payment Intent with bounded concurrency, applies only monotonic transitions,
   persists one logical terminal event, and subscribes only if still pending.
9. Confirm health, reconciliation logs, pending count, and webhook backlog; then
   restore normal traffic and additional instances.

A restored `requires_payment` or `processing` value is never authoritative.
Only provider reconciliation may promote it to `succeeded`. Repeating recovery
cannot create another logical settlement event because state CAS and the
`(tenant_id, payment_intent_id, type)` uniqueness constraint protect
fulfillment.

## Failure scenarios

- **Lost database host:** restore the newest verified off-host backup to a new
  path, reconcile, then switch traffic.
- **Corrupt database:** stop writes, retain evidence, test the newest backup,
  and work backward until integrity and foreign-key validation pass.
- **Compromised database credentials or copy:** rotate merchant API keys,
  webhook secrets, client capability encryption keys, and any exposed legacy
  tokens according to their threat boundary. Database-only theft does not
  reveal encrypted Payment Intent capability keys without the application key.
- **Lost encryption key:** payment state remains readable, but affected client
  capabilities cannot be reconstructed. Restore the missing key from the
  independent secret-manager recovery process; do not generate a replacement
  and pretend old capabilities remain valid.

SQLite is intended for a single gateway writer deployment. Multi-region or
multi-writer operation requires a future transactional database adapter (for
example PostgreSQL), not shared-filesystem SQLite.
