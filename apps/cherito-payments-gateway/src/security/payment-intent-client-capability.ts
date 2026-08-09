import { createHash, createHmac } from 'node:crypto'

const CLIENT_CAPABILITY_DOMAIN = 'cherito:payment-intent-client:v1'
const CLIENT_CAPABILITY_HASH_DOMAIN = 'cherito:payment-intent-client-hash:v1'

export function derivePaymentIntentClientSecret(
  intentSecret: string,
  intentId: string,
  tenantId: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(intentSecret)) {
    throw new Error('Stored Payment Intent secret is invalid')
  }
  const digest = createHmac('sha256', Buffer.from(intentSecret, 'hex'))
    .update(CLIENT_CAPABILITY_DOMAIN)
    .update('\0')
    .update(tenantId)
    .update('\0')
    .update(intentId)
    .digest('base64url')
  return `cs_v1_${digest}`
}

export function hashPaymentIntentClientSecret(clientSecret: string): string {
  return createHash('sha256')
    .update(`${CLIENT_CAPABILITY_HASH_DOMAIN}\0${clientSecret}`)
    .digest('hex')
}
