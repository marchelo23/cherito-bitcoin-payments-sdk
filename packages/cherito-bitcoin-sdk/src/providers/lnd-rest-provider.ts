import https from 'node:https'
import { LightningError } from '../errors.js'
import { mapLndInvoiceState } from '../invoices/invoice-status.js'
import type {
  CreateInvoiceInput,
  CreatedInvoice,
  LightningCapabilities,
  LightningInvoice,
  PublicNodeInfo,
} from '../types.js'
import type { LightningReceiveProvider } from './provider.js'

type Json = Record<string, unknown>

export interface LndRestConfig {
  url: string
  tlsCertificate: Buffer
  macaroon: Buffer
  timeoutMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
}

/**
 * LND REST BOLT11 receive provider.
 *
 * Security invariants:
 *  - URL must use HTTPS (enforced at construction)
 *  - TLS cert pinned via custom CA agent; host verification is not disabled
 *  - Only invoice-scoped macaroon is accepted; admin macaroon is refused by
 *    the config layer before this class is ever instantiated
 *  - SSRF: the `url` is validated as a URL object; relative paths are rejected
 */
export class LndRestProvider implements LightningReceiveProvider {
  readonly providerType = 'lnd' as const
  private agent: https.Agent

  constructor(private readonly config: LndRestConfig) {
    const url = new URL(config.url) // throws on malformed URL
    if (url.protocol !== 'https:') {
      throw new LightningError('CONFIGURATION_ERROR', 'LND_REST_URL must use HTTPS')
    }
    // Validate that this is not a relative path or data URI that could escape
    if (!url.hostname) {
      throw new LightningError('CONFIGURATION_ERROR', 'LND_REST_URL must have a hostname')
    }
    this.agent = new https.Agent({ ca: config.tlsCertificate })
  }

  async getCapabilities(): Promise<LightningCapabilities> {
    // subscribeToInvoice currently polls getInvoice; do not advertise native streaming.
    return { bolt11Receive: true, bolt12Receive: false, invoiceStreaming: false, provider: 'lnd' }
  }

  private async request(path: string, method = 'GET', body?: Json, signal?: AbortSignal): Promise<Json> {
    return new Promise((resolve, reject) => {
      // Only allow simple paths — never interpolate unchecked user data here
      const target = new URL(path, this.config.url)
      const req = https.request(
        target,
        {
          agent: this.agent,
          method,
          signal,
          headers: {
            'content-type': 'application/json',
            // Intentionally kept out of application-level logs by Fastify redact config
            'grpc-metadata-macaroon': this.config.macaroon.toString('hex'),
          },
        },
        (res) => {
          let raw = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { raw += chunk })
          res.on('end', () => {
            if (res.statusCode === 401 || res.statusCode === 403) {
              return reject(
                new LightningError('AUTHENTICATION_FAILED', 'LND rejected the limited invoice macaroon'),
              )
            }
            if (!res.statusCode || res.statusCode >= 400) {
              return reject(
                new LightningError('INVALID_RESPONSE', `LND returned HTTP ${res.statusCode ?? 'unknown'}`),
              )
            }
            try {
              resolve(JSON.parse(raw) as Json)
            } catch (cause) {
              reject(new LightningError('INVALID_RESPONSE', 'LND returned malformed JSON', { cause }))
            }
          })
        },
      )

      req.setTimeout(this.config.timeoutMs ?? 8000, () =>
        req.destroy(new LightningError('TIMEOUT', 'LND request timed out')),
      )

      req.on('error', (cause: NodeJS.ErrnoException) => {
        if (cause instanceof LightningError) return reject(cause)
        if (cause.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
          return reject(
            new LightningError(
              'TLS_HOSTNAME_MISMATCH',
              'The configured LND hostname or IP is not present in its TLS certificate',
              { cause },
            ),
          )
        }
        if (cause.code?.includes('CERT') || cause.code?.includes('TLS')) {
          return reject(
            new LightningError('TLS_ERROR', 'LND TLS certificate validation failed', { cause }),
          )
        }
        reject(new LightningError('NODE_OFFLINE', 'LND is offline or unreachable', { cause }))
      })

      if (body) req.write(JSON.stringify(body))
      req.end()
    })
  }

  async getNodeInfo(): Promise<PublicNodeInfo> {
    const x = await this.request('/v1/getinfo')
    const chains = x.chains as Array<{ network?: string }> | undefined
    const n = chains?.[0]?.network
    return {
      alias: typeof x.alias === 'string' ? x.alias : undefined,
      identityPubkey: typeof x.identity_pubkey === 'string' ? x.identity_pubkey : undefined,
      network: n === 'testnet' || n === 'signet' || n === 'regtest' ? n : 'mainnet',
      syncedToChain: x.synced_to_chain === true,
      syncedToGraph: x.synced_to_graph === true,
    }
  }

  async createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice> {
    if (input.amountSats <= 0n) throw new TypeError('Invoice amount must be positive')
    const x = await this.request('/v1/invoices', 'POST', {
      value: input.amountSats.toString(),
      memo: input.memo.slice(0, 120),
      expiry: String(input.expirySeconds),
    })
    const paymentHash = Buffer.from(String(x.r_hash), 'base64').toString('hex')
    const created = await this.getInvoice(paymentHash)
    return { ...created, paymentRequest: String(x.payment_request) }
  }

  async getInvoice(hash: string): Promise<LightningInvoice> {
    if (!/^[0-9a-f]{64}$/i.test(hash)) {
      throw new TypeError('Payment hash must contain 32 bytes of hexadecimal data')
    }
    const x = await this.request(`/v1/invoice/${hash.toLowerCase()}`)
    const createdMs = Number(x.creation_date) * 1000
    const expiresAt = new Date(createdMs + Number(x.expiry) * 1000).toISOString()
    return {
      providerInvoiceId: String(x.add_index ?? hash),
      paymentHash: hash.toLowerCase(),
      paymentRequest: String(x.payment_request ?? ''),
      amountSats: BigInt(String(x.value ?? 0)),
      amountPaidSats: BigInt(String(x.amt_paid_sat ?? 0)),
      expiresAt,
      state: mapLndInvoiceState(x.state, expiresAt),
      settledAt:
        x.settle_date && x.settle_date !== '0'
          ? new Date(Number(x.settle_date) * 1000).toISOString()
          : undefined,
      providerAddIndex: String(x.add_index ?? ''),
      providerSettleIndex: String(x.settle_index ?? ''),
    }
  }

  async subscribeToInvoice(
    hash: string,
    callback: (invoice: LightningInvoice) => void,
  ): Promise<() => Promise<void>> {
    let stopped = false
    let timer: NodeJS.Timeout | undefined
    let last = ''
    let delay = this.config.reconnectMinMs ?? 1000

    const poll = async () => {
      if (stopped) return
      try {
        const invoice = await this.getInvoice(hash)
        const fingerprint = `${invoice.state}:${invoice.settledAt ?? ''}`
        delay = this.config.reconnectMinMs ?? 1000
        if (fingerprint !== last) {
          last = fingerprint
          callback(invoice)
        }
        if (['settled', 'expired', 'canceled'].includes(invoice.state)) return
      } catch {
        delay = Math.min(delay * 2, this.config.reconnectMaxMs ?? 15000)
      }
      timer = setTimeout(poll, delay)
    }

    void poll()
    return async () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }
}
