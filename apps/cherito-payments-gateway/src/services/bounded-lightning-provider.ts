import type {
  CreateInvoiceInput,
  CreatedInvoice,
  LightningCapabilities,
  LightningInvoice,
  LightningReceiveProvider,
  PublicNodeInfo,
} from '@cherito/bitcoin-sdk'

interface QueuedTask<T> {
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function overloaded(): Error {
  return Object.assign(new Error('Lightning provider capacity is exhausted'), {
    statusCode: 503,
    code: 'SERVICE_UNAVAILABLE',
  })
}

/** Bounds both active calls and queued work so provider degradation cannot grow memory forever. */
export class BoundedLightningProvider implements LightningReceiveProvider {
  readonly providerType: LightningReceiveProvider['providerType']
  private active = 0
  private readonly queue: Array<QueuedTask<unknown>> = []

  constructor(
    private readonly provider: LightningReceiveProvider,
    private readonly maxConcurrency: number,
    private readonly maxQueue: number,
  ) {
    this.providerType = provider.providerType
  }

  getCapabilities(): Promise<LightningCapabilities> {
    return this.schedule(() => this.provider.getCapabilities())
  }

  getNodeInfo(): Promise<PublicNodeInfo> {
    return this.schedule(() => this.provider.getNodeInfo())
  }

  createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice> {
    return this.schedule(() => this.provider.createInvoice(input))
  }

  getInvoice(paymentHash: string): Promise<LightningInvoice> {
    return this.schedule(() => this.provider.getInvoice(paymentHash))
  }

  subscribeToInvoice(
    paymentHash: string,
    callback: (invoice: LightningInvoice) => void,
  ): Promise<() => Promise<void>> {
    // LND's current subscription implementation polls internally, which would
    // bypass this wrapper. Poll through getInvoice so every provider call is
    // subject to the same concurrency and queue bounds.
    let stopped = false
    let timer: NodeJS.Timeout | undefined
    let delayMs = 1_000
    let fingerprint = ''
    const poll = async () => {
      if (stopped) return
      try {
        const invoice = await this.getInvoice(paymentHash)
        const nextFingerprint = `${invoice.state}:${invoice.settledAt ?? ''}`
        delayMs = 1_000
        if (nextFingerprint !== fingerprint) {
          fingerprint = nextFingerprint
          callback(invoice)
        }
        if (['settled', 'expired', 'canceled'].includes(invoice.state)) return
      } catch {
        delayMs = Math.min(delayMs * 2, 15_000)
      }
      if (!stopped) timer = setTimeout(poll, delayMs)
    }
    void poll()
    return Promise.resolve(async () => {
      stopped = true
      if (timer) clearTimeout(timer)
    })
  }

  private schedule<T>(run: () => Promise<T>): Promise<T> {
    if (this.active < this.maxConcurrency) return this.start(run)
    if (this.queue.length >= this.maxQueue) return Promise.reject(overloaded())
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve, reject } as QueuedTask<unknown>)
    })
  }

  private async start<T>(run: () => Promise<T>): Promise<T> {
    this.active += 1
    try {
      return await run()
    } finally {
      this.active -= 1
      const next = this.queue.shift()
      if (next) void this.start(next.run).then(next.resolve, next.reject)
    }
  }
}
