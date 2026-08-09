import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'

const CIPHER = 'aes-256-gcm'
const ENCRYPTION_VERSION = 1
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16
const STORAGE_DOMAIN = 'cherito:payment-intent-secret-storage:v1'
const KEY_ID_DOMAIN = 'cherito:payment-intent-secret-key-id:v1'

export interface EncryptedIntentSecret {
  version: number
  keyId: string
  nonce: string
  ciphertext: string
  authTag: string
}

interface EncryptionKey {
  id: string
  value: Buffer
}

function decodeKey(encoded: string, field: string): Buffer {
  if (
    encoded.length === 0
    || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw new Error(`${field} must be a canonical base64-encoded 32-byte key`)
  }
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error(`${field} must be a canonical base64-encoded 32-byte key`)
  }
  return key
}

function keyId(key: Buffer): string {
  return createHash('sha256')
    .update(KEY_ID_DOMAIN)
    .update('\0')
    .update(key)
    .digest('base64url')
}

function additionalAuthenticatedData(tenantId: string, intentId: string): Buffer {
  return Buffer.from(`${STORAGE_DOMAIN}\0${tenantId}\0${intentId}`, 'utf8')
}

/**
 * Encrypts the random per-intent capability key before it reaches SQLite.
 *
 * The first configured key is active for writes. Previous keys are decrypt-only
 * and allow an online rotation; the repository re-encrypts old rows with the
 * active key during startup.
 */
export class PaymentIntentSecretCipher {
  private readonly activeKey: EncryptionKey
  private readonly keys: ReadonlyMap<string, Buffer>

  constructor(activeKeyBase64: string, previousKeys = '') {
    const activeValue = decodeKey(activeKeyBase64, 'CHERITO_INTENT_SECRET_KEY')
    this.activeKey = { id: keyId(activeValue), value: activeValue }

    const allKeys = new Map<string, Buffer>([[this.activeKey.id, activeValue]])
    for (const [index, encoded] of previousKeys
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .entries()) {
      const value = decodeKey(encoded, `CHERITO_INTENT_SECRET_PREVIOUS_KEYS[${index}]`)
      const id = keyId(value)
      if (allKeys.has(id)) {
        throw new Error('Payment Intent encryption keys must be unique')
      }
      allKeys.set(id, value)
    }
    this.keys = allKeys
  }

  encrypt(secret: string, tenantId: string, intentId: string): EncryptedIntentSecret {
    if (!/^[a-f0-9]{64}$/.test(secret)) {
      throw new Error('Payment Intent secret must be a 32-byte lowercase hex value')
    }
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(CIPHER, this.activeKey.value, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    })
    cipher.setAAD(additionalAuthenticatedData(tenantId, intentId))
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(secret, 'hex')),
      cipher.final(),
    ])

    return {
      version: ENCRYPTION_VERSION,
      keyId: this.activeKey.id,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
    }
  }

  decrypt(encrypted: EncryptedIntentSecret, tenantId: string, intentId: string): string {
    if (encrypted.version !== ENCRYPTION_VERSION) {
      throw new Error(`Unsupported Payment Intent secret encryption version: ${encrypted.version}`)
    }
    const key = this.keys.get(encrypted.keyId)
    if (!key) {
      throw new Error(`Missing Payment Intent encryption key: ${encrypted.keyId}`)
    }

    try {
      const nonce = Buffer.from(encrypted.nonce, 'base64url')
      const ciphertext = Buffer.from(encrypted.ciphertext, 'base64url')
      const authTag = Buffer.from(encrypted.authTag, 'base64url')
      if (nonce.length !== NONCE_BYTES || authTag.length !== AUTH_TAG_BYTES) {
        throw new Error('Invalid encrypted Payment Intent secret envelope')
      }
      const decipher = createDecipheriv(CIPHER, key, nonce, {
        authTagLength: AUTH_TAG_BYTES,
      })
      decipher.setAAD(additionalAuthenticatedData(tenantId, intentId))
      decipher.setAuthTag(authTag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      if (plaintext.length !== 32) {
        throw new Error('Invalid decrypted Payment Intent secret length')
      }
      return plaintext.toString('hex')
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Missing Payment Intent')) throw error
      throw new Error('Stored Payment Intent secret authentication failed')
    }
  }

  usesActiveKey(encrypted: EncryptedIntentSecret): boolean {
    return encrypted.version === ENCRYPTION_VERSION && encrypted.keyId === this.activeKey.id
  }
}
