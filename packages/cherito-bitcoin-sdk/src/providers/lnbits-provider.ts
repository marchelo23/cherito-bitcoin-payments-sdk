import { LightningError } from '../errors.js'
import type { LightningReceiveProvider } from './provider.js'
import type {
  LightningCapabilities,
  PublicNodeInfo,
  CreateInvoiceInput,
  CreatedInvoice,
  LightningInvoice,
  InvoiceState,
} from '../types.js'

const NETWORKS: ReadonlyArray<PublicNodeInfo['network']> = ['mainnet', 'testnet', 'signet', 'regtest']
const MSAT_PER_SAT = 1000n

export interface LnbitsProviderConfig {
  url: string
  apiKey: string
  network: PublicNodeInfo['network']
  alias?: string
  timeoutMs?: number
  pollIntervalMs?: number
}

interface LnbitsPaymentDetails {
  bolt11?: unknown
  payment_hash?: unknown
  amount?: unknown
  expiry?: unknown
  time?: unknown
  paid_at?: unknown
  settled_at?: unknown
  pending?: unknown
  status?: unknown
}

function configurationError(message: string): LightningError {
  return new LightningError('CONFIGURATION_ERROR', message)
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (cause) {
    throw new LightningError('CONFIGURATION_ERROR', 'LNbits URL is not a valid absolute URL', { cause })
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw configurationError('LNbits URL must use http or https')
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1e11 ? value : value * 1000
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  if (typeof value === 'string' && value.length > 0) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && /^\d+$/.test(value)) return toIsoTimestamp(numeric)
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
  }
  return undefined
}

function millisatsToSats(value: unknown): bigint | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(Math.trunc(value))) return undefined
    const millisats = BigInt(Math.trunc(Math.abs(value)))
    return millisats / MSAT_PER_SAT
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const millisats = BigInt(value)
    return (millisats < 0n ? -millisats : millisats) / MSAT_PER_SAT
  }
  return undefined
}

function isSettled(payload: Record<string, unknown>, details: LnbitsPaymentDetails): boolean {
  if (payload.paid === true) return true
  const status = nonEmptyString(payload.status) ?? nonEmptyString(details.status)
  return status === 'success'
}

export class LnbitsProvider implements LightningReceiveProvider {
  readonly providerType = 'external' as const

  private readonly url: string
  private readonly apiKey: string
  private readonly network: PublicNodeInfo['network']
  private readonly alias: string | undefined
  private readonly timeoutMs: number
  private readonly pollIntervalMs: number

  constructor(config: LnbitsProviderConfig) {
    if (typeof config?.url !== 'string' || config.url.trim().length === 0) {
      throw configurationError('LNbits URL is required')
    }
    if (typeof config.apiKey !== 'string' || config.apiKey.trim().length === 0) {
      throw configurationError('LNbits API key is required')
    }
    if (!NETWORKS.includes(config.network)) {
      throw configurationError(`LNbits network must be one of ${NETWORKS.join(', ')}`)
    }
    if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) {
      throw configurationError('LNbits timeoutMs must be a positive number')
    }
    if (config.pollIntervalMs !== undefined && (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs <= 0)) {
      throw configurationError('LNbits pollIntervalMs must be a positive number')
    }

    this.url = normalizeBaseUrl(config.url.trim())
    this.apiKey = config.apiKey.trim()
    this.network = config.network
    this.alias = config.alias
    this.timeoutMs = config.timeoutMs ?? 10_000
    this.pollIntervalMs = config.pollIntervalMs ?? 5_000
  }

  async getCapabilities(): Promise<LightningCapabilities> {
    return {
      bolt11Receive: true,
      bolt12Receive: false,
      invoiceStreaming: false,
      provider: 'external',
    }
  }

  async getNodeInfo(): Promise<PublicNodeInfo> {
    return this.alias === undefined
      ? { network: this.network }
      : { alias: this.alias, network: this.network }
  }

  private async request(path: string, init: { method?: string; body?: string } = {}): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await fetch(`${this.url}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: init.body,
        signal: controller.signal,
      })
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new LightningError('TIMEOUT', `LNbits request to ${path} timed out`, { cause })
      }
      throw new LightningError('PROVIDER_UNAVAILABLE', `LNbits request to ${path} failed`, { cause })
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401 || response.status === 403) {
      throw new LightningError('AUTHENTICATION_FAILED', 'LNbits rejected the configured API key')
    }
    if (!response.ok) {
      throw new LightningError(
        'PROVIDER_UNAVAILABLE',
        `LNbits returned HTTP ${response.status} for ${path}`,
      )
    }

    try {
      return await response.json()
    } catch (cause) {
      throw new LightningError('INVALID_RESPONSE', `LNbits returned malformed JSON for ${path}`, { cause })
    }
  }

  async createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice> {
    if (typeof input.amountSats !== 'bigint' || input.amountSats <= 0n) {
      throw new LightningError('CONFIGURATION_ERROR', 'Invoice amount must be a positive number of satoshis')
    }
    if (input.amountSats > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new LightningError(
        'CONFIGURATION_ERROR',
        'Invoice amount exceeds the largest value LNbits can represent safely',
      )
    }
    if (!Number.isInteger(input.expirySeconds) || input.expirySeconds <= 0) {
      throw new LightningError('CONFIGURATION_ERROR', 'Invoice expiry must be a positive whole number of seconds')
    }

    const payload = asRecord(await this.request('/api/v1/payments', {
      method: 'POST',
      body: JSON.stringify({
        out: false,
        amount: Number(input.amountSats),
        memo: input.memo,
        expiry: input.expirySeconds,
      }),
    }))

    if (!payload) {
      throw new LightningError('INVALID_RESPONSE', 'LNbits createInvoice returned a non-object response')
    }

    const details = (asRecord(payload.details) ?? {}) as LnbitsPaymentDetails
    const paymentHash = nonEmptyString(payload.payment_hash) ?? nonEmptyString(details.payment_hash)
    const paymentRequest = nonEmptyString(payload.payment_request)
      ?? nonEmptyString(payload.bolt11)
      ?? nonEmptyString(details.bolt11)

    if (!paymentHash || !paymentRequest) {
      throw new LightningError(
        'INVALID_RESPONSE',
        'LNbits createInvoice response is missing payment_hash or the BOLT11 invoice',
      )
    }

    const expiresAt = toIsoTimestamp(payload.expiry)
      ?? toIsoTimestamp(details.expiry)
      ?? new Date(Date.now() + input.expirySeconds * 1000).toISOString()

    return {
      providerInvoiceId: paymentHash,
      paymentHash,
      paymentRequest,
      amountSats: input.amountSats,
      expiresAt,
      state: 'pending',
    }
  }

  async getInvoice(paymentHash: string): Promise<LightningInvoice> {
    if (typeof paymentHash !== 'string' || paymentHash.length === 0) {
      throw new LightningError('CONFIGURATION_ERROR', 'Payment hash is required')
    }

    const payload = asRecord(await this.request(`/api/v1/payments/${encodeURIComponent(paymentHash)}`))
    if (!payload) {
      throw new LightningError('INVALID_RESPONSE', 'LNbits getInvoice returned a non-object response')
    }

    const details = (asRecord(payload.details) ?? {}) as LnbitsPaymentDetails
    const expiresAt = toIsoTimestamp(payload.expiry) ?? toIsoTimestamp(details.expiry)
    if (!expiresAt) {
      throw new LightningError(
        'INVALID_RESPONSE',
        'LNbits getInvoice response did not include an invoice expiry',
      )
    }

    const settled = isSettled(payload, details)
    const state: InvoiceState = settled
      ? 'settled'
      : Date.parse(expiresAt) <= Date.now()
        ? 'expired'
        : 'pending'

    const amountSats = millisatsToSats(payload.amount) ?? millisatsToSats(details.amount)
    if (amountSats === undefined) {
      throw new LightningError('INVALID_RESPONSE', 'LNbits getInvoice response did not include a usable amount')
    }

    const settledAt = settled
      ? toIsoTimestamp(payload.paid_at)
        ?? toIsoTimestamp(details.paid_at)
        ?? toIsoTimestamp(details.settled_at)
      : undefined

    const invoice: LightningInvoice = {
      providerInvoiceId: paymentHash,
      paymentHash,
      paymentRequest: nonEmptyString(details.bolt11) ?? nonEmptyString(payload.bolt11) ?? '',
      amountSats,
      expiresAt,
      state,
    }

    if (settled) invoice.amountPaidSats = amountSats
    if (settledAt) invoice.settledAt = settledAt
    return invoice
  }

  async subscribeToInvoice(
    paymentHash: string,
    callback: (invoice: LightningInvoice) => void,
  ): Promise<() => Promise<void>> {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastFingerprint = ''

    const poll = async (): Promise<void> => {
      if (cancelled) return
      try {
        const invoice = await this.getInvoice(paymentHash)
        if (cancelled) return

        const fingerprint = `${invoice.state}:${invoice.settledAt ?? ''}`
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint
          callback(invoice)
        }
        if (invoice.state === 'settled' || invoice.state === 'canceled' || invoice.state === 'expired') {
          return
        }
      } catch {
        if (cancelled) return
      }
      timer = setTimeout(() => void poll(), this.pollIntervalMs)
    }

    timer = setTimeout(() => void poll(), this.pollIntervalMs)

    return async () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }
}
