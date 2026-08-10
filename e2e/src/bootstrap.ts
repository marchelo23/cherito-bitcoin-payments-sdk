import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  assertRegtest,
  ensureWallet,
  getBlockCount,
  getWalletBalance,
  mineBlocks,
  sendToAddress,
} from './bitcoind.js'
import * as docker from './docker.js'
import {
  BITCOIND_DIR,
  CHANNEL_CAPACITY_SATS,
  GATEWAY_ENV_FILE,
  LOG_DIR,
  MERCHANT_LND_DIR,
  PAYER_FUNDING_BTC,
  PAYER_LND_DIR,
  RECEIVER_INTERNAL_URL,
  SECRETS_DIR,
  STATE_FILE,
  TIMEOUTS,
  TMP_DIR,
} from './env.js'
import {
  assertRegtestNode,
  bakeInvoiceMacaroon,
  connectPeer,
  getInfo,
  getServerState,
  listChannels,
  newAddress,
  openChannel,
  readTlsCert,
  walletBalance,
} from './lnd.js'
import {
  configureWebhook,
  createPaymentIntent,
  health,
  receiverSetSecret,
  rotateWebhookSecret,
} from './gateway-client.js'
import { waitFor } from './wait.js'

export interface TenantFixture {
  tenantId: string
  apiKey: string
  webhookSecret?: string
}

export interface E2EState {
  merchantPubkey: string
  payerPubkey: string
  channelPoint: string
  tenantA: TenantFixture
  tenantB: TenantFixture
}

export async function prepareWorkspace(): Promise<void> {
  await rm(TMP_DIR, { recursive: true, force: true })
  for (const directory of [BITCOIND_DIR, MERCHANT_LND_DIR, PAYER_LND_DIR, SECRETS_DIR, LOG_DIR]) {
    await mkdir(directory, { recursive: true })
    await chmod(directory, 0o777)
  }
}

export async function writeGatewayEnv(): Promise<void> {
  const intentKey = randomBytes(32).toString('base64')
  const lines = [
    'NODE_ENV=development',
    'WEBHOOK_ALLOW_PRIVATE_DESTINATIONS=true',
    'PORT=3100',
    'HOST=0.0.0.0',
    'LIGHTNING_PROVIDER=lnd',
    'LND_REST_URL=https://lnd-merchant:8080',
    'LND_TLS_CERT_PATH=/run/secrets/lnd-tls.cert',
    'LND_MACAROON_PATH=/run/secrets/cherito-invoice.macaroon',
    'ALLOWED_ORIGINS=http://localhost:3000',
    'MIN_INVOICE_SATS=1000',
    'MAX_INVOICE_SATS=4000000',
    'DEFAULT_INVOICE_EXPIRY_SECONDS=60',
    'DATABASE_URL=file:/app/data/cherito-e2e.db',
    'DATABASE_BACKUP_DIR=/app/data/backups',
    `CHERITO_INTENT_SECRET_KEY=${intentKey}`,
    'LOG_LEVEL=info',
    'PAYMENT_INTENT_RECONCILIATION_INTERVAL_MS=2000',
    'PAYMENT_INTENT_WATCH_RETRY_BASE_MS=500',
    'PAYMENT_INTENT_WATCH_RETRY_MAX_MS=5000',
    'WEBHOOK_RETRY_INTERVAL_MS=1000',
    'SQLITE_BUSY_TIMEOUT_MS=15000',
    'RATE_LIMIT_WINDOW_MS=60000',
    'RATE_LIMIT_CREATE_INVOICE=50',
    'RATE_LIMIT_PAYMENT_LINK_RESOLVE=8',
    'RATE_LIMIT_PAYMENT_LINK_CREATE_IP=200',
    'RATE_LIMIT_PAYMENT_LINK_CREATE_TENANT=200',
    'RATE_LIMIT_PAYMENT_LINK_CREATE_LINK=200',
    'RATE_LIMIT_AUTH_FAILURES=200',
    'RATE_LIMIT_WEBHOOK_MANAGEMENT=200',
    'BOOTSTRAP_TENANT_NAME=E2E Merchant A',
    'BOOTSTRAP_KEY_PATH=/app/data/bootstrap-key.txt',
  ]
  await writeFile(GATEWAY_ENV_FILE, `${lines.join('\n')}\n`, { mode: 0o600 })
}

export async function relaxLndPermissions(service: 'lnd-merchant' | 'lnd-payer'): Promise<void> {
  await waitFor(async () => {
    const result = await docker.exec(service, ['chmod', '-R', 'a+rX', '/lnd'], true)
    return result.code === 0 ? true : undefined
  }, { description: `${service} credentials to become host-readable`, timeoutMs: 120_000, intervalMs: 2_000 })
}

export async function startChainAndNodes(): Promise<void> {
  await docker.up(['bitcoind'])

  await waitFor(async () => {
    await assertRegtest()
    return true
  }, { description: 'bitcoind regtest RPC', timeoutMs: TIMEOUTS.service })

  await ensureWallet()

  const height = await getBlockCount()
  if (height < 150) await mineBlocks(150 - height)

  await docker.up(['lnd-merchant', 'lnd-payer'])
  await relaxLndPermissions('lnd-merchant')
  await relaxLndPermissions('lnd-payer')

  for (const role of ['merchant', 'payer'] as const) {
    await waitFor(async () => {
      await assertRegtestNode(role)
      return true
    }, { description: `lnd ${role} regtest identity`, timeoutMs: TIMEOUTS.service })

    let lastState = 'unknown'
    await waitFor(async () => {
      lastState = await getServerState(role)
      return lastState === 'SERVER_ACTIVE' ? lastState : undefined
    }, {
      description: () => `lnd ${role} rpc server to reach SERVER_ACTIVE (last state ${lastState})`,
      timeoutMs: TIMEOUTS.service,
      intervalMs: 2_000,
    })
  }
}

export async function fundAndOpenChannel(): Promise<{
  merchantPubkey: string
  payerPubkey: string
  channelPoint: string
}> {
  await waitFor(async () => (await getWalletBalance()) > PAYER_FUNDING_BTC + 1, {
    description: 'spendable regtest coins in the bitcoind wallet',
    timeoutMs: TIMEOUTS.chain,
  })

  const merchant = await getInfo('merchant')
  const payer = await getInfo('payer')

  const payerAddress = await newAddress('payer')
  await sendToAddress(payerAddress, PAYER_FUNDING_BTC)
  await mineBlocks(6)

  await waitFor(async () => {
    const balance = await walletBalance('payer')
    return balance > 0n ? balance : undefined
  }, { description: 'payer on-chain balance', timeoutMs: TIMEOUTS.chain })

  await waitFor(async () => (await getInfo('payer')).synced_to_chain, {
    description: 'payer chain sync',
    timeoutMs: TIMEOUTS.chain,
  })
  await waitFor(async () => (await getInfo('merchant')).synced_to_chain, {
    description: 'merchant chain sync',
    timeoutMs: TIMEOUTS.chain,
  })

  await waitFor(async () => {
    await connectPeer('payer', merchant.identity_pubkey, 'lnd-merchant:9735')
    return true
  }, { description: 'payer to connect to the merchant node', timeoutMs: TIMEOUTS.chain, intervalMs: 2_000 })

  const existing = (await listChannels('payer')).find(
    (channel) => channel.remote_pubkey === merchant.identity_pubkey,
  )
  const channelPoint = existing
    ? existing.chan_id
    : await openChannel('payer', merchant.identity_pubkey, CHANNEL_CAPACITY_SATS, 0)

  await waitFor(async () => {
    await mineBlocks(1)
    const payerChannels = await listChannels('payer')
    const merchantChannels = await listChannels('merchant')
    const payerActive = payerChannels.some(
      (channel) => channel.remote_pubkey === merchant.identity_pubkey && channel.active,
    )
    const merchantActive = merchantChannels.some(
      (channel) => channel.remote_pubkey === payer.identity_pubkey && channel.active,
    )
    return payerActive && merchantActive ? true : undefined
  }, { description: 'active payment channel on both nodes', timeoutMs: TIMEOUTS.channel, intervalMs: 2_000 })

  return {
    merchantPubkey: merchant.identity_pubkey,
    payerPubkey: payer.identity_pubkey,
    channelPoint,
  }
}

export async function installGatewayCredentials(): Promise<void> {
  const cert = await readTlsCert('merchant')
  await writeFile(resolve(SECRETS_DIR, 'lnd-tls.cert'), cert, { mode: 0o644 })

  const macaroonBase64 = await bakeInvoiceMacaroon('merchant')
  await writeFile(
    resolve(SECRETS_DIR, 'cherito-invoice.macaroon'),
    Buffer.from(macaroonBase64, 'base64'),
    { mode: 0o644 },
  )
}

export async function startGatewayAndReceiver(): Promise<void> {
  await docker.up(['merchant-receiver', 'gateway'])
  await waitFor(async () => {
    const result = await health()
    return result.status === 200 && result.body.status === 'ok' ? true : undefined
  }, { description: 'cherito gateway health', timeoutMs: TIMEOUTS.gatewayBoot })
}

export async function provisionTenants(): Promise<{ tenantA: TenantFixture; tenantB: TenantFixture }> {
  const bootstrapRaw = await docker.execOrThrow('gateway', ['cat', '/app/data/bootstrap-key.txt'])
  const apiKeyA = bootstrapRaw.trim()
  if (!apiKeyA.startsWith('sk_')) {
    throw new Error('bootstrap API key was not produced by the gateway')
  }

  await docker.exec('gateway', ['rm', '-f', '/app/data/tenant-b.json'])
  await docker.execOrThrow('gateway', [
    'node',
    'dist/database-cli.js',
    'tenant',
    'create',
    '--name',
    'E2E Merchant B',
    '--label',
    'e2e',
    '--key-out',
    '/app/data/tenant-b.json',
  ])
  const tenantBRaw = await docker.execOrThrow('gateway', ['cat', '/app/data/tenant-b.json'])
  const tenantB = JSON.parse(tenantBRaw.trim()) as { tenantId: string; apiKey: string }

  const configured = await configureWebhook(apiKeyA, RECEIVER_INTERNAL_URL)
  if (configured.status !== 200) {
    throw new Error(`webhook configuration failed (${configured.status}): ${configured.text}`)
  }
  const rotated = await rotateWebhookSecret(apiKeyA)
  if (rotated.status !== 200 || !rotated.body.signingSecret) {
    throw new Error(`webhook secret rotation failed (${rotated.status}): ${rotated.text}`)
  }
  await receiverSetSecret(rotated.body.signingSecret)

  const probe = await createPaymentIntent(apiKeyA, {
    amountSats: '1000',
    merchantOrderId: `bootstrap-tenant-probe-${Date.now()}`,
  })
  if (probe.status !== 201) {
    throw new Error(`unable to resolve tenant A id (${probe.status}): ${probe.text}`)
  }

  return {
    tenantA: {
      tenantId: probe.body.tenantId,
      apiKey: apiKeyA,
      webhookSecret: rotated.body.signingSecret,
    },
    tenantB: { tenantId: tenantB.tenantId, apiKey: tenantB.apiKey },
  }
}

export async function saveState(state: E2EState): Promise<void> {
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

export async function loadState(): Promise<E2EState> {
  return JSON.parse(await readFile(STATE_FILE, 'utf8')) as E2EState
}

export async function bootstrapEnvironment(): Promise<E2EState> {
  await docker.assertDockerAvailable()
  await prepareWorkspace()
  await writeGatewayEnv()
  await startChainAndNodes()
  const channel = await fundAndOpenChannel()
  await installGatewayCredentials()
  await startGatewayAndReceiver()
  const tenants = await provisionTenants()

  const state: E2EState = {
    merchantPubkey: channel.merchantPubkey,
    payerPubkey: channel.payerPubkey,
    channelPoint: channel.channelPoint,
    tenantA: tenants.tenantA,
    tenantB: tenants.tenantB,
  }
  await saveState(state)
  return state
}
