import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  HOST: z.string().default("0.0.0.0"),
  LIGHTNING_PROVIDER: z.literal("lnd").default("lnd"),
  LND_REST_URL: z.string().url(),
  LND_TLS_CERT_PATH: z.string().optional(),
  LND_MACAROON_PATH: z.string().optional(),
  LND_TLS_CERT_BASE64: z.string().optional(),
  LND_MACAROON_HEX: z.string().optional(),
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
  DATABASE_URL: z.string().default("file:./data/cherito-payments.db"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  BOOTSTRAP_TENANT_NAME: z.string().default("Default Merchant"),
  BOOTSTRAP_KEY_PATH: z.string().optional(),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  for (const name of ["ADMIN_MACAROON", "SEED", "XPRV", "PRIVATE_KEY"])
    if (env[name])
      throw new Error(`Unsafe configuration is forbidden: ${name}`);
  const c = schema.parse(env);
  if (!c.LND_TLS_CERT_PATH && !c.LND_TLS_CERT_BASE64)
    throw new Error("LND TLS credential is required");
  if (!c.LND_MACAROON_PATH && !c.LND_MACAROON_HEX)
    throw new Error("Limited invoice macaroon is required");
  if (c.MIN_INVOICE_SATS > c.MAX_INVOICE_SATS)
    throw new Error("Invoice limits are inverted");
  if (
    c.BOLT12_PROVIDER === "lndk" &&
    (!c.LNDK_GRPC_URL || !c.LNDK_TLS_CERT_PATH || !c.LNDK_MACAROON_PATH)
  )
    throw new Error("LNDK requires URL and separate mounted credentials");
  return c;
}
