import { PaymentIntentSecretCipher } from './security/payment-intent-secret-cipher.js'
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
} from './persistence/database-backup.js'
import {
  currentSchemaVersion,
  openDatabase,
  validateDatabaseIntegrity,
} from './persistence/database-lifecycle.js'

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
    const result = await createDatabaseBackup({
      databaseUrl: argument('database') ?? process.env.DATABASE_URL ?? '',
      destination: requiredArgument('output'),
      applicationVersion: process.env.npm_package_version ?? '1.0.0',
      reason: argument('reason') ?? 'operator backup',
    })
    console.info(JSON.stringify({
      code: 'DATABASE_BACKUP_CREATED',
      path: result.path,
      metadataPath: result.metadataPath,
      schemaVersion: result.metadata.schemaVersion,
      createdAt: result.metadata.createdAt,
    }))
    return
  }

  if (command === 'restore') {
    const result = await restoreDatabaseBackup({
      backupPath: requiredArgument('input'),
      destinationDatabaseUrl: argument('database') ?? process.env.DATABASE_URL ?? '',
      intentSecretCipher: intentSecretCipher(),
      backupDirectory: process.env.DATABASE_BACKUP_DIR,
      busyTimeoutMs: Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 5_000),
    })
    console.info(JSON.stringify({
      code: 'DATABASE_RESTORE_COMPLETED',
      schemaVersion: result.schemaVersion,
      requiresProviderReconciliation: result.requiresProviderReconciliation,
      nextStep: 'Start the gateway; it reconciles non-terminal payments before accepting traffic.',
    }))
    return
  }

  if (command === 'validate') {
    const databaseUrl = argument('database') ?? process.env.DATABASE_URL ?? ''
    const db = openDatabase(databaseUrl, { readOnly: true, migrate: false })
    try {
      validateDatabaseIntegrity(db)
      console.info(JSON.stringify({
        code: 'DATABASE_VALID',
        schemaVersion: currentSchemaVersion(db),
      }))
    } finally {
      db.close()
    }
    return
  }

  throw new Error(
    'Usage: database-cli <backup|restore|validate> --database file:/path --output/--input /path',
  )
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({
    code: (error as { code?: string }).code ?? 'DATABASE_COMMAND_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
})
