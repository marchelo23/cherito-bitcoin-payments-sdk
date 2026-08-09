import type { LightningErrorCode } from '@cherito/bitcoin-sdk'

const MAX_LOG_STRING_BYTES = 160

const SENSITIVE_FIELDS = [
  'authorization',
  'cookie',
  'setCookie',
  'apiKey',
  'api_key',
  'merchantApiKey',
  'merchant_api_key',
  'secret',
  'secretKey',
  'apiSecret',
  'clientSecret',
  'client_secret',
  'clientSecretHash',
  'intentSecret',
  'intent_secret',
  'webhookSecret',
  'webhook_secret',
  'prevWebhookSecret',
  'macaroon',
  'macaroonHex',
  'macaroonPath',
  'lndMacaroon',
  'rune',
  'clnRune',
  'lnbitsApiKey',
  'lnbits_api_key',
  'password',
  'token',
  'statusToken',
  'accessToken',
  'refreshToken',
  'privateKey',
  'private_key',
  'databaseEncryptionKey',
  'xprv',
  'xpriv',
  'seed',
  'seedPhrase',
  'mnemonic',
  'pepper',
  'tlsCertBase64',
  'tlsCert',
  'tls_cert',
  'tlsPrivateKey',
  'tlsCertificate',
  'certificate',
  'providerCredentials',
  'paymentRequest',
  'payment_request',
  'paymentHash',
  'payment_hash',
  'bolt11',
  'bolt12',
  'offer',
  'preimage',
  'metadata',
  'description',
  'payerNote',
  'LND_MACAROON_HEX',
  'LND_TLS_CERT_BASE64',
  'LND_REST_URL',
  'LNDK_GRPC_URL',
  'CHERITO_INTENT_SECRET_KEY',
  'CHERITO_INTENT_SECRET_PREVIOUS_KEYS',
] as const

const CONTAINER_FIELDS = ['headers', 'body', 'config', 'credentials', 'providerResponse'] as const

function nestedPaths(name: string): string[] {
  return [name, `*.${name}`, `*.*.${name}`, `*.*.*.${name}`, `*.*.*.*.${name}`]
}

/**
 * Defense in depth for accidental structured logging. Production call sites
 * still use SafeLogFields rather than passing arbitrary objects to the logger.
 */
export const SAFE_LOG_REDACTION_PATHS = [
  ...SENSITIVE_FIELDS.flatMap(nestedPaths),
  ...CONTAINER_FIELDS.flatMap(nestedPaths),
  'req.headers',
  'request.headers',
  'req.body',
  'request.body',
  'res.body',
  'response.body',
  'err',
  'error',
  'cause',
  '*.err',
  '*.error',
  '*.cause',
  '*.*.err',
  '*.*.error',
  '*.*.cause',
] as const

export interface SafeLogFields {
  event: string
  requestId?: string
  method?: string
  route?: string
  outcome?: 'success' | 'failure' | 'denied' | 'degraded'
  tenantId?: string
  providerType?: string
  status?: string
  errorCode?: string
  httpStatus?: number
  attemptCount?: number
}

export interface SafeLogger {
  debug(fields: Record<string, unknown>, message?: string): void
  info(fields: Record<string, unknown>, message?: string): void
  warn(fields: Record<string, unknown>, message?: string): void
  error(fields: Record<string, unknown>, message?: string): void
  fatal(fields: Record<string, unknown>, message?: string): void
}

export type SafeLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LogDestination {
  write(message: string): void
}

function safeString(value: string): string {
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? '\ufffd' : character
  }).join('')
  let result = ''
  let bytes = 0
  for (const character of withoutControls) {
    const nextBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + nextBytes > MAX_LOG_STRING_BYTES) break
    result += character
    bytes += nextBytes
  }
  return result
}

function sanitizeFields(fields: SafeLogFields): Record<string, string | number> {
  const output: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') output[key] = safeString(value)
    else if (typeof value === 'number' && Number.isFinite(value)) output[key] = value
  }
  return output
}

/** Logging must never be able to change payment behavior. */
export function safeLog(
  logger: SafeLogger,
  level: SafeLogLevel,
  fields: SafeLogFields,
  message: string,
): void {
  try {
    logger[level](sanitizeFields(fields), safeString(message))
  } catch {
    // Logging is deliberately best-effort. The original application error or
    // payment-state transition remains authoritative and is never swallowed.
  }
}

const LIGHTNING_ERROR_CODES: ReadonlySet<LightningErrorCode> = new Set([
  'NODE_OFFLINE',
  'AUTHENTICATION_FAILED',
  'TLS_ERROR',
  'TLS_HOSTNAME_MISMATCH',
  'INVALID_RESPONSE',
  'TIMEOUT',
  'CONFIGURATION_ERROR',
  'PROVIDER_UNAVAILABLE',
])

export function safeProviderErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && LIGHTNING_ERROR_CODES.has(code as LightningErrorCode)
    ? code
    : 'PROVIDER_FAILURE'
}

export function createSafeLoggerOptions(level: string, stream?: LogDestination) {
  return {
    level,
    base: null,
    ...(stream ? { stream } : {}),
    redact: {
      paths: [...SAFE_LOG_REDACTION_PATHS],
      censor: '[REDACTED]',
    },
    serializers: {
      req(request: { method?: unknown }) {
        return { method: typeof request.method === 'string' ? safeString(request.method) : 'UNKNOWN' }
      },
      res(response: { statusCode?: unknown }) {
        return { statusCode: typeof response.statusCode === 'number' ? response.statusCode : 0 }
      },
      err(error: unknown) {
        return {
          type: 'Error',
          message: '[REDACTED]',
          stack: '[REDACTED]',
          code: safeProviderErrorCode(error),
        }
      },
    },
  }
}

export const NOOP_SAFE_LOGGER: SafeLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
}

export function writeSafeProcessEvent(
  destination: Pick<NodeJS.WriteStream, 'write'>,
  level: 'info' | 'error' | 'fatal',
  code: string,
): void {
  try {
    destination.write(`${JSON.stringify({ level, code: safeString(code) })}\n`)
  } catch {
    // No fallback printing: duplicating the original error could expose data.
  }
}
