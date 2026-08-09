import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { TenantRepository, MerchantApiKey } from '../persistence/tenant-repository.js'

/**
 * API key format: sk_live_<32 random bytes base64url>
 * The prefix is safe to log/display; the full key is only shown once at creation.
 * Keys are stored as SHA-256 hashes — the plaintext is never persisted.
 *
 * Security invariants:
 * - Timing-safe comparison always used when verifying keys
 * - Key hash is never logged (only the 12-char prefix is logged/displayed)
 * - Revoked keys are rejected before tenant lookup
 */
export class ApiKeyService {
  constructor(private readonly repo: TenantRepository) {}

  /**
   * Generate a new merchant API key for the given tenant.
   * Returns the plaintext key — this is the ONLY time it will be visible.
   */
  async generate(tenantId: string, label: string): Promise<{ key: string; record: MerchantApiKey }> {
    const raw = `sk_live_${randomBytes(32).toString('base64url')}`
    const keyHash = this.hashKey(raw)
    const keyPrefix = raw.slice(0, 12)  // safe to store/display

    const record: MerchantApiKey = {
      id: `mak_${randomUUID()}`,
      tenantId,
      keyHash,
      keyPrefix,
      label,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    }

    this.repo.createApiKey(record)
    return { key: raw, record }
  }

  /**
   * Verify a raw API key and return the associated key record.
   * Returns undefined if the key is invalid or revoked.
   * Uses timing-safe comparison to prevent oracle attacks.
   */
  verify(rawKey: string): { tenantId: string; keyId: string } | undefined {
    if (!rawKey.startsWith('sk_live_') && !rawKey.startsWith('sk_test_')) return undefined

    const keyHash = this.hashKey(rawKey)
    const record = this.repo.apiKeyByHash(keyHash)
    if (!record) return undefined
    if (record.revokedAt) return undefined

    // Extra timing-safe check even though the DB query already matched by hash
    const a = Buffer.from(keyHash)
    const b = Buffer.from(record.keyHash)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined

    return { tenantId: record.tenantId, keyId: record.id }
  }

  revoke(keyId: string, tenantId: string): void {
    this.repo.revokeApiKey(keyId, tenantId)
  }

  private hashKey(raw: string): string {
    return createHash('sha256').update(raw).digest('hex')
  }
}
