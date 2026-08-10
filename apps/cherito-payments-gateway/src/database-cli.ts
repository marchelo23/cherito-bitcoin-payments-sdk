import { writeFile } from 'node:fs/promises'
import { PaymentIntentSecretCipher } from './security/payment-intent-secret-cipher.js'
import { PaymentIntentRepository } from './persistence/payment-intent-repository.js'
import { ApiKeyService } from './services/api-key-service.js'
import { TenantService } from './services/tenant-service.js'
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
} from './persistence/database-backup.js'
import {
  currentSchemaVersion,
  openDatabase,
  validateDatabaseIntegrity,
} from './persistence/database-lifecycle.js'
import { writeSafeProcessEvent } from './logging/safe-logger.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function requiredArgument(name: string): string {
  const value = argument(name)
  if (!value) throw new Error(`Missing required --${name} argument`)
  return value
}

function intentSecretCipher(): PaymentIntentSecretCipher {
  const active = process.env.CHERITO_INTENT_SECRET_KEY
  if (!active) throw new Error('CHERITO_INTENT_SECRET_KEY is required for restore')
  return new PaymentIntentSecretCipher(
    active,
    process.env.CHERITO_INTENT_SECRET_PREVIOUS_KEYS ?? '',
  )
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'backup') {
    await createDatabaseBackup({
      databaseUrl: argument('database') ?? process.env.DATABASE_URL ?? '',
      destination: requiredArgument('output'),
      applicationVersion: process.env.npm_package_version ?? '1.0.0',
      reason: argument('reason') ?? 'operator backup',
    })
    writeSafeProcessEvent(process.stdout, 'info', 'DATABASE_BACKUP_CREATED')
    return
  }

  if (command === 'restore') {
    await restoreDatabaseBackup({
      backupPath: requiredArgument('input'),
      destinationDatabaseUrl: argument('database') ?? process.env.DATABASE_URL ?? '',
      intentSecretCipher: intentSecretCipher(),
      backupDirectory: process.env.DATABASE_BACKUP_DIR,
      busyTimeoutMs: Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 5_000),
    })
    writeSafeProcessEvent(process.stdout, 'info', 'DATABASE_RESTORE_COMPLETED')
    return
  }

  if (command === 'validate') {
    const databaseUrl = argument('database') ?? process.env.DATABASE_URL ?? ''
    const db = openDatabase(databaseUrl, { readOnly: true, migrate: false })
    try {
      validateDatabaseIntegrity(db)
      currentSchemaVersion(db)
      writeSafeProcessEvent(process.stdout, 'info', 'DATABASE_VALID')
    } finally {
      db.close()
    }
    return
  }

  if (command === 'tenant' && process.argv[3] === 'create') {
    const repo = new PaymentIntentRepository(
      argument('database') ?? process.env.DATABASE_URL ?? '',
      intentSecretCipher(),
      Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 5_000),
      process.env.DATABASE_BACKUP_DIR,
    )
    try {
      const tenantService = new TenantService(repo, new ApiKeyService(repo))
      const { tenant, apiKey } = await tenantService.createTenant({
        name: requiredArgument('name'),
        apiKeyLabel: argument('label') ?? 'operator',
      })
      await writeFile(
        requiredArgument('key-out'),
        `${JSON.stringify({ tenantId: tenant.id, apiKey })}\n`,
        { mode: 0o600, flag: 'wx' },
      )
      writeSafeProcessEvent(process.stdout, 'info', 'TENANT_CREATED')
    } finally {
      repo.close()
    }
    return
  }

  throw new Error(
    'Usage: database-cli <backup|restore|validate|tenant create> --database file:/path --output/--input /path',
  )
}

void main().catch(() => {
  writeSafeProcessEvent(process.stderr, 'error', 'DATABASE_COMMAND_FAILED')
  process.exitCode = 1
})
