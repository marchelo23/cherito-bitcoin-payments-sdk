import { z } from "zod";
import { PaymentIntentSecretCipher } from './security/payment-intent-secret-cipher.js'

const FORBIDDEN_WALLET_ENVIRONMENT_VARIABLES = [
  'ADMIN_MACAROON',
  'SEED',
  'SEED_PHRASE',
  'WALLET_SEED',
  'MNEMONIC',
  'XPRV',
  'XPRIV',
  'PRIVATE_KEY',
] as const

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false
  }
  const decoded = Buffer.from(value, 'base64')
  return decoded.length > 0 && decoded.toString('base64') === value
}

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  HOST: z.string().default("0.0.0.0"),
  LIGHTNING_PROVIDER: z.literal("lnd").default("lnd"),
  LND_REST_URL: z.string().url(),
  LND_TLS_CERT_PATH: z.string().min(1).optional(),
  LND_MACAROON_PATH: z.string().min(1).optional(),
  LND_TLS_CERT_BASE64: z.string().refine(isCanonicalBase64, {
    message: 'LND_TLS_CERT_BASE64 must be canonical base64',
  }).optional(),
  LND_MACAROON_HEX: z.string().regex(/^(?:[0-9a-fA-F]{2})+$/, {
    message: 'LND_MACAROON_HEX must contain complete hexadecimal bytes',
  }).optional(),
  BOLT12_PROVIDER: z.enum(["none", "lndk"]).default("none"),
  LNDK_GRPC_URL: z.string().optional(),
  LNDK_TLS_CERT_PATH: z.string().optional(),
  LNDK_MACAROON_PATH: z.string().optional(),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  MIN_INVOICE_SATS: z.coerce.bigint().default(1000n),
  MAX_INVOICE_SATS: z.coerce.bigint().default(10000000n),
  DEFAULT_INVOICE_EXPIRY_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86400)
    .default(900),
  RATE_LIMIT_CREATE_INVOICE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
  RATE_LIMIT_AUTH_FAILURES: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_PAYMENT_LINK_RESOLVE: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_PAYMENT_LINK_CREATE_IP: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_PAYMENT_LINK_CREATE_TENANT: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_PAYMENT_LINK_CREATE_LINK: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WEBHOOK_MANAGEMENT: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_SSE_CONNECTIONS: z.coerce.number().int().positive().default(60),
  TRUST_PROXY: z.string().default(''),
  PROVIDER_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  PROVIDER_MAX_QUEUE: z.coerce.number().int().min(0).max(10_000).default(100),
  SSE_MAX_GLOBAL: z.coerce.number().int().min(1).default(1_000),
  SSE_MAX_PER_TENANT: z.coerce.number().int().min(1).default(20),
  DATABASE_URL: z.string().default("file:./data/cherito-payments.db"),
  DATABASE_BACKUP_DIR: z.string().optional(),
  CHERITO_INTENT_SECRET_KEY: z.string().min(1),
  CHERITO_INTENT_SECRET_PREVIOUS_KEYS: z.string().default(""),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  PAYMENT_INTENT_RECOVERY_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  PAYMENT_INTENT_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  PAYMENT_INTENT_WATCH_RETRY_BASE_MS: z.coerce.number().int().min(100).default(1_000),
  PAYMENT_INTENT_WATCH_RETRY_MAX_MS: z.coerce.number().int().min(1_000).default(60_000),
  SQLITE_BUSY_TIMEOUT_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
  BOOTSTRAP_TENANT_NAME: z.string().min(2).max(80).default("Default Merchant"),
  BOOTSTRAP_KEY_PATH: z.string().optional(),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  for (const name of FORBIDDEN_WALLET_ENVIRONMENT_VARIABLES)
    if (env[name])
      throw new Error(`Unsafe configuration is forbidden: ${name}`);
  const c = schema.parse(env);
  // Reject malformed or duplicate keys before opening or migrating SQLite.
  new PaymentIntentSecretCipher(
    c.CHERITO_INTENT_SECRET_KEY,
    c.CHERITO_INTENT_SECRET_PREVIOUS_KEYS,
  );
  if (!c.LND_TLS_CERT_PATH && !c.LND_TLS_CERT_BASE64)
    throw new Error("LND TLS credential is required");
  if (c.LND_TLS_CERT_PATH && c.LND_TLS_CERT_BASE64)
    throw new Error('LND TLS credential source is ambiguous');
  if (!c.LND_MACAROON_PATH && !c.LND_MACAROON_HEX)
    throw new Error("Limited invoice macaroon is required");
  if (c.LND_MACAROON_PATH && c.LND_MACAROON_HEX)
    throw new Error('LND macaroon credential source is ambiguous');
  if (c.MIN_INVOICE_SATS > c.MAX_INVOICE_SATS)
    throw new Error("Invoice limits are inverted");
  if (c.PAYMENT_INTENT_WATCH_RETRY_BASE_MS > c.PAYMENT_INTENT_WATCH_RETRY_MAX_MS)
    throw new Error("Payment Intent watcher retry limits are inverted");
  if (
    c.BOLT12_PROVIDER === "lndk" &&
    (!c.LNDK_GRPC_URL || !c.LNDK_TLS_CERT_PATH || !c.LNDK_MACAROON_PATH)
  )
    throw new Error("LNDK requires URL and separate mounted credentials");
  return c;
}
