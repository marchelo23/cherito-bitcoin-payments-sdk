import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const E2E_ROOT = resolve(here, '..')
export const REPO_ROOT = resolve(E2E_ROOT, '..')
export const TMP_DIR = resolve(E2E_ROOT, '.tmp')
export const LOG_DIR = resolve(TMP_DIR, 'logs')
export const STATE_FILE = resolve(TMP_DIR, 'state.json')
export const GATEWAY_ENV_FILE = resolve(TMP_DIR, 'gateway.env')
export const MERCHANT_LND_DIR = resolve(TMP_DIR, 'lnd-merchant')
export const PAYER_LND_DIR = resolve(TMP_DIR, 'lnd-payer')
export const SECRETS_DIR = resolve(TMP_DIR, 'secrets')
export const COMPOSE_FILE = resolve(E2E_ROOT, 'docker-compose.regtest.yml')
export const COMPOSE_PROJECT = 'cherito-e2e'

export const PORTS = {
  bitcoinRpc: 18443,
  merchantRest: 18080,
  payerRest: 28080,
  gateway: 13100,
  receiver: 14000,
} as const

export const BITCOIN_RPC_USER = 'cheritoe2e'
export const BITCOIN_RPC_PASSWORD = 'cheritoe2edisposable'
export const BITCOIN_WALLET = 'e2eregtest'

export const GATEWAY_URL = `http://127.0.0.1:${PORTS.gateway}`
export const RECEIVER_URL = `http://127.0.0.1:${PORTS.receiver}`
export const RECEIVER_INTERNAL_URL = 'http://merchant-receiver:4000/webhooks/cherito'
export const MERCHANT_LND_URL = `https://127.0.0.1:${PORTS.merchantRest}`
export const PAYER_LND_URL = `https://127.0.0.1:${PORTS.payerRest}`

export const EXPECTED_NETWORK = 'regtest'
export const LOG_CANARY = 'E2E_SHOULD_NEVER_BE_LOGGED_123'

export const CHANNEL_CAPACITY_SATS = 5_000_000
export const PAYER_FUNDING_BTC = 1

export const TIMEOUTS = {
  service: 180_000,
  chain: 120_000,
  channel: 240_000,
  settlement: 90_000,
  webhook: 90_000,
  gatewayBoot: 120_000,
} as const
