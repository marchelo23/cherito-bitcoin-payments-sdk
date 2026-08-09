import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export interface WebhookTransportOptions {
  production?: boolean
  timeoutMs?: number
  maximumResponseBytes?: number
  allowPrivateAddresses?: boolean
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
}

function forbiddenIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true
  }
  const [a, b] = octets as [number, number, number, number]
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 0 && octets[2] === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && octets[2] === 100)
    || (a === 203 && b === 0 && octets[2] === 113)
    || a >= 224
}

export function isForbiddenWebhookAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]!
  const family = net.isIP(normalized)
  if (family === 4) return forbiddenIpv4(normalized)
  if (family !== 6) return true
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('ff')) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return forbiddenIpv4(mapped[1]!)
  const mappedHex = normalized.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/)
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16)
    const low = Number.parseInt(mappedHex[2]!, 16)
    return forbiddenIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  return false
}

function transportError(code: string, message: string): Error {
  const statusCode = code === 'WEBHOOK_URL_INVALID' || code === 'WEBHOOK_SSRF_BLOCKED'
    ? 400
    : 502
  return Object.assign(new Error(message), { code, statusCode })
}

export class WebhookTransport {
  private readonly production: boolean
  private readonly timeoutMs: number
  private readonly maximumResponseBytes: number
  private readonly allowPrivateAddresses: boolean
  private readonly resolve: (hostname: string) => Promise<ResolvedAddress[]>

  constructor(options: WebhookTransportOptions = {}) {
    this.production = options.production ?? process.env.NODE_ENV === 'production'
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.maximumResponseBytes = options.maximumResponseBytes ?? 64 * 1024
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? process.env.NODE_ENV === 'test'
    this.resolve = options.resolve ?? (async (hostname) => {
      const rows = await dns.lookup(hostname, { all: true, verbatim: true })
      return rows.map((row) => ({ address: row.address, family: row.family as 4 | 6 }))
    })
  }

  async validate(urlString: string): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
    let url: URL
    try {
      url = new URL(urlString)
    } catch {
      throw transportError('WEBHOOK_URL_INVALID', 'Webhook URL is invalid')
    }
    if (url.username || url.password) {
      throw transportError('WEBHOOK_URL_INVALID', 'Webhook URL credentials are forbidden')
    }
    if (this.production ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) {
      throw transportError('WEBHOOK_URL_INVALID', 'Webhook URL must use HTTPS')
    }
    const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname
    if (!hostname || hostname.toLowerCase() === 'localhost') {
      throw transportError('WEBHOOK_SSRF_BLOCKED', 'Webhook destination is forbidden')
    }
    const literalFamily = net.isIP(hostname)
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await this.resolve(hostname).catch(() => [])
    if (addresses.length === 0
      || (!this.allowPrivateAddresses && addresses.some((row) => isForbiddenWebhookAddress(row.address)))) {
      throw transportError('WEBHOOK_SSRF_BLOCKED', 'Webhook destination is forbidden')
    }
    return { url, addresses }
  }

  async deliver(
    urlString: string,
    body: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<{ ok: boolean; statusCode: number }> {
    const { url, addresses } = await this.validate(urlString)
    const approved = addresses[0]!
    const request = url.protocol === 'https:' ? https.request : http.request
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown, value?: { ok: boolean; statusCode: number }) => {
        if (settled) return
        settled = true
        clearTimeout(totalTimer)
        if (error) reject(error)
        else resolve(value!)
      }
      const req = request(url, {
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
        servername: url.hostname.startsWith('[') ? undefined : url.hostname,
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) {
            ;(callback as unknown as (
              error: NodeJS.ErrnoException | null,
              addresses: ResolvedAddress[],
            ) => void)(null, [approved])
            return
          }
          callback(null, approved.address, approved.family)
        },
      }, (response) => {
        let received = 0
        response.on('data', (chunk: Buffer | string) => {
          received += Buffer.byteLength(chunk)
          if (received > this.maximumResponseBytes) {
            const error = transportError(
              'WEBHOOK_RESPONSE_TOO_LARGE',
              'Webhook response exceeded limit',
            )
            response.destroy()
            req.destroy()
            finish(error)
          }
        })
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0
          // Redirects are never followed; every destination must be independently configured.
          finish(undefined, { ok: statusCode >= 200 && statusCode < 300, statusCode })
        })
      })
      const totalTimer = setTimeout(() => {
        req.destroy(transportError('WEBHOOK_TIMEOUT', 'Webhook delivery timed out'))
      }, this.timeoutMs)
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(transportError('WEBHOOK_TIMEOUT', 'Webhook connection timed out'))
      })
      req.on('error', (error) => finish(error))
      req.end(body)
    })
  }
}
