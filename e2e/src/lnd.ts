import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { resolve } from 'node:path'
import { EXPECTED_NETWORK, MERCHANT_LND_DIR, PAYER_LND_DIR, PORTS } from './env.js'

export type NodeRole = 'merchant' | 'payer'

const DIRS: Record<NodeRole, string> = {
  merchant: MERCHANT_LND_DIR,
  payer: PAYER_LND_DIR,
}

const PORTS_BY_ROLE: Record<NodeRole, number> = {
  merchant: PORTS.merchantRest,
  payer: PORTS.payerRest,
}

export function tlsCertPath(role: NodeRole): string {
  return resolve(DIRS[role], 'tls.cert')
}

export function adminMacaroonPath(role: NodeRole): string {
  return resolve(DIRS[role], 'data/chain/bitcoin/regtest/admin.macaroon')
}

export async function readTlsCert(role: NodeRole): Promise<Buffer> {
  return readFile(tlsCertPath(role))
}

export async function readAdminMacaroon(role: NodeRole): Promise<Buffer> {
  return readFile(adminMacaroonPath(role))
}

export interface LndCallOptions {
  method?: string
  body?: unknown
  macaroon?: Buffer
  timeoutMs?: number
}

export async function lndRest<T>(
  role: NodeRole,
  path: string,
  options: LndCallOptions = {},
): Promise<T> {
  const ca = await readTlsCert(role)
  const macaroon = options.macaroon ?? (await readAdminMacaroon(role))
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body)

  return new Promise<T>((resolvePromise, rejectPromise) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: PORTS_BY_ROLE[role],
        path,
        method: options.method ?? 'GET',
        ca,
        servername: '127.0.0.1',
        headers: {
          'grpc-metadata-macaroon': macaroon.toString('hex'),
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            rejectPromise(new Error(`lnd ${role} ${path} failed (${status}): ${text.slice(0, 300)}`))
            return
          }
          try {
            resolvePromise(text ? (JSON.parse(text) as T) : ({} as T))
          } catch {
            rejectPromise(new Error(`lnd ${role} ${path} returned non-JSON: ${text.slice(0, 200)}`))
          }
        })
      },
    )

    req.setTimeout(options.timeoutMs ?? 30_000, () => {
      req.destroy(new Error(`lnd ${role} ${path} timed out`))
    })
    req.on('error', rejectPromise)
    if (payload) req.write(payload)
    req.end()
  })
}

export interface LndInfo {
  identity_pubkey: string
  alias: string
  synced_to_chain: boolean
  block_height: number
  chains: Array<{ chain: string; network: string }>
}

export async function getInfo(role: NodeRole): Promise<LndInfo> {
  return lndRest<LndInfo>(role, '/v1/getinfo')
}

export async function assertRegtestNode(role: NodeRole): Promise<void> {
  const info = await getInfo(role)
  const network = info.chains?.[0]?.network
  if (network !== EXPECTED_NETWORK) {
    throw new Error(
      `ABORT: lnd ${role} reports network "${String(network)}" but ${EXPECTED_NETWORK} is required`,
    )
  }
}

export async function getServerState(role: NodeRole): Promise<string> {
  const result = await lndRest<{ state: string }>(role, '/v1/state')
  return result.state
}

export async function newAddress(role: NodeRole): Promise<string> {
  const result = await lndRest<{ address: string }>(role, '/v1/newaddress?type=WITNESS_PUBKEY_HASH')
  return result.address
}

export async function walletBalance(role: NodeRole): Promise<bigint> {
  const result = await lndRest<{ confirmed_balance: string }>(role, '/v1/balance/blockchain')
  return BigInt(result.confirmed_balance ?? '0')
}

export async function connectPeer(
  from: NodeRole,
  pubkey: string,
  host: string,
): Promise<void> {
  try {
    await lndRest(from, '/v1/peers', {
      method: 'POST',
      body: { addr: { pubkey, host }, perm: true },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('already connected')) throw error
  }
}

export async function listPeers(role: NodeRole): Promise<string[]> {
  const result = await lndRest<{ peers?: Array<{ pub_key: string }> }>(role, '/v1/peers')
  return (result.peers ?? []).map((peer) => peer.pub_key)
}

export async function openChannel(
  from: NodeRole,
  pubkeyHex: string,
  localFundingSats: number,
  pushSats: number,
): Promise<string> {
  const result = await lndRest<{ funding_txid_str?: string; funding_txid_bytes?: string }>(
    from,
    '/v1/channels',
    {
      method: 'POST',
      body: {
        node_pubkey: Buffer.from(pubkeyHex, 'hex').toString('base64'),
        local_funding_amount: String(localFundingSats),
        push_sat: String(pushSats),
        target_conf: 1,
      },
    },
  )
  return result.funding_txid_str ?? result.funding_txid_bytes ?? ''
}

export interface LndChannel {
  active: boolean
  remote_pubkey: string
  capacity: string
  local_balance: string
  remote_balance: string
  chan_id: string
}

export async function listChannels(role: NodeRole): Promise<LndChannel[]> {
  const result = await lndRest<{ channels?: LndChannel[] }>(role, '/v1/channels')
  return result.channels ?? []
}

export async function pendingChannelCount(role: NodeRole): Promise<number> {
  const result = await lndRest<{ pending_open_channels?: unknown[] }>(role, '/v1/channels/pending')
  return result.pending_open_channels?.length ?? 0
}

export interface LndInvoice {
  memo: string
  r_hash: string
  payment_request: string
  value: string
  settled: boolean
  state: string
  amt_paid_sat: string
  settle_date: string
  creation_date: string
  expiry: string
}

export async function lookupInvoice(role: NodeRole, paymentHashHex: string): Promise<LndInvoice> {
  return lndRest<LndInvoice>(role, `/v1/invoice/${paymentHashHex}`)
}

export async function listInvoices(role: NodeRole): Promise<LndInvoice[]> {
  const result = await lndRest<{ invoices?: LndInvoice[] }>(
    role,
    '/v1/invoices?num_max_invoices=1000&reversed=true',
  )
  return result.invoices ?? []
}

export interface PaymentResult {
  payment_error: string
  payment_preimage: string
  payment_hash: string
}

export async function payInvoice(
  role: NodeRole,
  paymentRequest: string,
  timeoutMs = 60_000,
): Promise<PaymentResult> {
  const result = await lndRest<PaymentResult>(role, '/v1/channels/transactions', {
    method: 'POST',
    body: { payment_request: paymentRequest },
    timeoutMs,
  })
  if (result.payment_error) {
    throw new Error(`payer failed to pay invoice: ${result.payment_error}`)
  }
  return result
}

export async function bakeInvoiceMacaroon(role: NodeRole): Promise<Buffer> {
  const result = await lndRest<{ macaroon: string }>(role, '/v1/macaroon', {
    method: 'POST',
    body: {
      permissions: [
        { entity: 'invoices', action: 'read' },
        { entity: 'invoices', action: 'write' },
        { entity: 'info', action: 'read' },
      ],
    },
  })

  const value = result.macaroon
  if (!value) throw new Error(`lnd ${role} returned an empty baked macaroon`)
  const isHex = /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0
  return Buffer.from(value, isHex ? 'hex' : 'base64')
}

export function base64ToHex(value: string): string {
  return Buffer.from(value, 'base64').toString('hex')
}

export function hexToBase64Url(value: string): string {
  return Buffer.from(value, 'hex').toString('base64url')
}
