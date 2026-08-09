import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { PaymentIntentSecretCipher } from '../security/payment-intent-secret-cipher.js'
import {
  DATABASE_BACKUP_FORMAT_VERSION,
  LATEST_DATABASE_SCHEMA_VERSION,
  assertSupportedSchema,
  configureSqliteConnection,
  currentSchemaVersion,
  openDatabase,
  sqlitePath,
  validateDatabaseIntegrity,
  type DatabaseBackupMetadata,
} from './database-lifecycle.js'

export interface CreateBackupOptions {
  databaseUrl: string
  destination: string
  applicationVersion?: string
  reason?: string
}

export interface RestoreBackupOptions {
  backupPath: string
  destinationDatabaseUrl: string
  intentSecretCipher: PaymentIntentSecretCipher
  backupDirectory?: string
  busyTimeoutMs?: number
}

function backupError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function assertNoProhibitedWalletMaterial(db: DatabaseSync): void {
  const isProhibited = (name: string): boolean => {
    const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_')
    return /(^|_)seeds?($|_)/.test(normalized)
      || /(^|_)mnemonic($|_)/.test(normalized)
      || /(^|_)xprv($|_)/.test(normalized)
      || /(^|_)xpriv($|_)/.test(normalized)
      || normalized.includes('private_key')
      || normalized.includes('admin_macaroon')
  }
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  for (const { name } of tables) {
    if (isProhibited(name)) {
      throw backupError(
        'DATABASE_BACKUP_PROHIBITED_MATERIAL',
        `Refusing to back up prohibited wallet table ${name}`,
      )
    }
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>
    const match = columns.find((column) => isProhibited(column.name))
    if (match) {
      throw backupError(
        'DATABASE_BACKUP_PROHIBITED_MATERIAL',
        `Refusing to back up prohibited wallet field ${name}.${match.name}`,
      )
    }
  }
}

function openReadOnlyDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA query_only=ON; PRAGMA busy_timeout=5000;')
    assertSupportedSchema(db)
    validateDatabaseIntegrity(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export async function createDatabaseBackup(
  options: CreateBackupOptions,
): Promise<{ path: string; metadataPath: string; metadata: DatabaseBackupMetadata }> {
  const sourcePath = sqlitePath(options.databaseUrl)
  if (sourcePath === ':memory:') {
    throw backupError('DATABASE_BACKUP_UNSUPPORTED', 'In-memory databases cannot be backed up')
  }
  const destination = resolve(options.destination)
  const metadataPath = `${destination}.json`
  for (const path of [destination, metadataPath]) {
    try {
      await stat(path)
      throw backupError(
        'DATABASE_BACKUP_EXISTS',
        `Refusing to overwrite existing backup artifact ${path}`,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const tempPath = `${destination}.partial-${process.pid}-${Date.now()}`
  const source = openReadOnlyDatabase(sourcePath)
  try {
    assertNoProhibitedWalletMaterial(source)
    await backup(source, tempPath, { rate: 100 })
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  } finally {
    source.close()
  }

  try {
    const verified = openReadOnlyDatabase(tempPath)
    const schemaVersion = currentSchemaVersion(verified)
    verified.close()
    const fileStat = await stat(tempPath)
    const metadata: DatabaseBackupMetadata = {
      formatVersion: DATABASE_BACKUP_FORMAT_VERSION,
      schemaVersion,
      createdAt: new Date().toISOString(),
      applicationVersion: options.applicationVersion ?? '1.0.0',
      databaseBytes: fileStat.size,
      sha256: await sha256File(tempPath),
      reason: options.reason,
    }
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await rename(tempPath, destination)
    await chmod(destination, 0o600)
    return { path: destination, metadataPath, metadata }
  } catch (error) {
    await Promise.all([
      rm(tempPath, { force: true }).catch(() => {}),
      rm(metadataPath, { force: true }).catch(() => {}),
    ])
    throw error
  }
}

function parseMetadata(value: unknown): DatabaseBackupMetadata {
  if (!value || typeof value !== 'object') {
    throw backupError('DATABASE_BACKUP_METADATA_INVALID', 'Backup metadata must be an object')
  }
  const metadata = value as Partial<DatabaseBackupMetadata>
  if (
    metadata.formatVersion !== DATABASE_BACKUP_FORMAT_VERSION
    || !Number.isInteger(metadata.schemaVersion)
    || typeof metadata.createdAt !== 'string'
    || !Number.isFinite(Date.parse(metadata.createdAt))
    || typeof metadata.applicationVersion !== 'string'
    || !Number.isInteger(metadata.databaseBytes)
    || typeof metadata.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(metadata.sha256)
  ) {
    throw backupError('DATABASE_BACKUP_METADATA_INVALID', 'Backup metadata is missing or malformed')
  }
  if (metadata.schemaVersion! > LATEST_DATABASE_SCHEMA_VERSION) {
    throw backupError(
      'DATABASE_SCHEMA_TOO_NEW',
      `Backup schema ${metadata.schemaVersion} is newer than supported version ${LATEST_DATABASE_SCHEMA_VERSION}`,
    )
  }
  return metadata as DatabaseBackupMetadata
}

export async function restoreDatabaseBackup(
  options: RestoreBackupOptions,
): Promise<{ schemaVersion: number; requiresProviderReconciliation: true }> {
  const backupPath = resolve(options.backupPath)
  const destination = sqlitePath(options.destinationDatabaseUrl)
  if (destination === ':memory:') {
    throw backupError('DATABASE_RESTORE_UNSUPPORTED', 'Restore requires a file-backed database')
  }
  for (const artifact of [destination, `${destination}-wal`, `${destination}-shm`]) {
    try {
      await stat(artifact)
      throw backupError(
        'DATABASE_RESTORE_DESTINATION_EXISTS',
        `Restore destination artifact already exists; stop writes and move it aside: ${artifact}`,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  let parsedMetadata: unknown
  try {
    parsedMetadata = JSON.parse(await readFile(`${backupPath}.json`, 'utf8'))
  } catch (error) {
    throw backupError(
      'DATABASE_BACKUP_METADATA_INVALID',
      `Backup metadata cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const metadata = parseMetadata(parsedMetadata)
  const backupStat = await stat(backupPath)
  if (backupStat.size !== metadata.databaseBytes) {
    throw backupError('DATABASE_BACKUP_SIZE_MISMATCH', 'Backup size does not match metadata')
  }
  if (await sha256File(backupPath) !== metadata.sha256) {
    throw backupError('DATABASE_BACKUP_CHECKSUM_MISMATCH', 'Backup checksum does not match metadata')
  }

  const source = openReadOnlyDatabase(backupPath)
  const sourceVersion = currentSchemaVersion(source)
  if (sourceVersion !== metadata.schemaVersion) {
    source.close()
    throw backupError('DATABASE_BACKUP_METADATA_INVALID', 'Backup schema does not match metadata')
  }
  assertNoProhibitedWalletMaterial(source)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const tempDestination = `${destination}.restore-partial-${process.pid}-${Date.now()}`
  try {
    await backup(source, tempDestination, { rate: 100 })
  } catch (error) {
    await rm(tempDestination, { force: true }).catch(() => {})
    throw error
  } finally {
    source.close()
  }

  try {
    const restored = openDatabase(`file:${tempDestination}`, {
      busyTimeoutMs: options.busyTimeoutMs,
      backupDirectory: options.backupDirectory,
      intentSecretCipher: options.intentSecretCipher,
    })
    configureSqliteConnection(restored, options.busyTimeoutMs)
    validateDatabaseIntegrity(restored)
    const schemaVersion = currentSchemaVersion(restored)
    restored.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    restored.close()
    await Promise.all([
      rm(`${tempDestination}-wal`, { force: true }).catch(() => {}),
      rm(`${tempDestination}-shm`, { force: true }).catch(() => {}),
    ])
    await rename(tempDestination, destination)
    await chmod(destination, 0o600)
    return { schemaVersion, requiresProviderReconciliation: true }
  } catch (error) {
    await Promise.all([
      rm(tempDestination, { force: true }).catch(() => {}),
      rm(`${tempDestination}-wal`, { force: true }).catch(() => {}),
      rm(`${tempDestination}-shm`, { force: true }).catch(() => {}),
    ])
    throw error
  }
}
