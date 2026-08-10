import {
  BITCOIN_RPC_PASSWORD,
  BITCOIN_RPC_USER,
  BITCOIN_WALLET,
  EXPECTED_NETWORK,
  PORTS,
} from './env.js'

const BASE_URL = `http://127.0.0.1:${PORTS.bitcoinRpc}`
const AUTH = Buffer.from(`${BITCOIN_RPC_USER}:${BITCOIN_RPC_PASSWORD}`).toString('base64')

interface RpcEnvelope<T> {
  result: T
  error: { code: number; message: string } | null
}

export async function bitcoinRpc<T>(
  method: string,
  params: unknown[] = [],
  wallet?: string,
): Promise<T> {
  const url = wallet ? `${BASE_URL}/wallet/${wallet}` : BASE_URL
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${AUTH}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'cherito-e2e', method, params }),
  })

  const text = await response.text()
  let envelope: RpcEnvelope<T>
  try {
    envelope = JSON.parse(text) as RpcEnvelope<T>
  } catch {
    throw new Error(`bitcoind ${method} returned non-JSON (${response.status}): ${text.slice(0, 200)}`)
  }

  if (envelope.error) {
    throw new Error(`bitcoind ${method} failed: ${envelope.error.message} (code ${envelope.error.code})`)
  }
  return envelope.result
}

export interface BlockchainInfo {
  chain: string
  blocks: number
  initialblockdownload: boolean
}

export async function getBlockchainInfo(): Promise<BlockchainInfo> {
  return bitcoinRpc<BlockchainInfo>('getblockchaininfo')
}

export async function assertRegtest(): Promise<void> {
  const info = await getBlockchainInfo()
  if (info.chain !== EXPECTED_NETWORK) {
    throw new Error(
      `ABORT: bitcoind reports chain "${info.chain}" but ${EXPECTED_NETWORK} is required`,
    )
  }
}

export async function ensureWallet(): Promise<void> {
  const wallets = await bitcoinRpc<string[]>('listwallets')
  if (wallets.includes(BITCOIN_WALLET)) return

  try {
    await bitcoinRpc('loadwallet', [BITCOIN_WALLET])
    return
  } catch {
    await bitcoinRpc('createwallet', [BITCOIN_WALLET, false, false, '', false, true, true])
  }
}

export async function getNewAddress(): Promise<string> {
  return bitcoinRpc<string>('getnewaddress', ['', 'bech32'], BITCOIN_WALLET)
}

export async function mineBlocks(count: number, address?: string): Promise<string[]> {
  const target = address ?? (await getNewAddress())
  return bitcoinRpc<string[]>('generatetoaddress', [count, target], BITCOIN_WALLET)
}

export async function getWalletBalance(): Promise<number> {
  return bitcoinRpc<number>('getbalance', [], BITCOIN_WALLET)
}

export async function sendToAddress(address: string, amountBtc: number): Promise<string> {
  return bitcoinRpc<string>('sendtoaddress', [address, amountBtc], BITCOIN_WALLET)
}

export async function getBlockCount(): Promise<number> {
  return bitcoinRpc<number>('getblockcount')
}
