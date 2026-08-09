import QRCode from 'qrcode'

type IntentStatus = 'requires_payment' | 'processing' | 'succeeded' | 'expired' | 'failed' | 'canceled'
type WidgetMode = 'payment-intent' | 'payment-link'

interface PaymentIntentView {
  id: string
  amountSats: string
  currency: 'SAT'
  description: string
  status: IntentStatus
  paymentRequest: string
  expiresAt: string
  settledAt: string | null
  updatedAt: string
}

interface CreatedPaymentIntent extends PaymentIntentView {
  tenantId: string
  clientSecret: string
}

interface PaymentLinkView {
  slug: string
  mode: 'fixed' | 'open_amount' | 'donation'
  title: string
  description: string | null
  amountSats?: string
  minAmountSats?: string
  maxAmountSats?: string
  expiresAt: string | null
}

export interface CheritoMessages {
  pay: string
  create: string
  close: string
  copyInvoice: string
  copyLink: string
  amount: string
  payerNote: string
  preparing: string
  requires_payment: string
  processing: string
  succeeded: string
  expired: string
  failed: string
  canceled: string
  interrupted: string
  error: string
}

const ENGLISH: CheritoMessages = {
  pay: 'Pay with Bitcoin',
  create: 'Create invoice',
  close: 'Close checkout',
  copyInvoice: 'Copy invoice',
  copyLink: 'Copy Lightning link',
  amount: 'Amount in satoshis',
  payerNote: 'Optional note',
  preparing: 'Preparing payment',
  requires_payment: 'Waiting for payment',
  processing: 'Payment detected; waiting for final settlement',
  succeeded: 'Payment confirmed',
  expired: 'Invoice expired',
  failed: 'Payment failed',
  canceled: 'Payment canceled',
  interrupted: 'Live updates interrupted; checking periodically',
  error: 'Unable to prepare payment',
}

const TERMINAL = new Set<IntentStatus>(['succeeded', 'expired', 'failed', 'canceled'])

function apiError(response: Response): Error {
  return Object.assign(new Error(`Cherito API returned ${response.status}`), { status: response.status })
}

export class CheritoBitcoinCheckout extends HTMLElement {
  messages: CheritoMessages = { ...ENGLISH }
  private lifecycle?: AbortController
  private countdownTimer?: ReturnType<typeof setInterval>
  private pollTimer?: ReturnType<typeof setTimeout>
  private watching = false
  private intent?: CreatedPaymentIntent
  private lastStatus?: IntentStatus
  private link?: PaymentLinkView

  connectedCallback(): void {
    if (!this.shadowRoot) this.renderShell()
  }

  disconnectedCallback(): void {
    this.cleanup()
  }

  private renderShell(): void {
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = `<style>
      :host{--cherito-accent:#6b421f;--cherito-bg:#fffaf2;--cherito-text:#24170f;font-family:system-ui,sans-serif}
      button,input,textarea{font:inherit}.pay,.action{border:2px solid var(--cherito-accent);border-radius:.5rem;padding:.7rem 1rem;background:var(--cherito-accent);color:white;cursor:pointer}
      button:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid #1677ff;outline-offset:3px}
      .overlay{position:fixed;inset:0;z-index:9999;display:none;place-items:center;padding:1rem;background:#0009}.overlay.open{display:grid}
      .dialog{position:relative;width:min(30rem,92vw);max-height:90vh;overflow:auto;padding:2rem;border-radius:1rem;background:var(--cherito-bg);color:var(--cherito-text)}
      .close{position:absolute;right:.75rem;top:.5rem;border:0;background:transparent;font-size:1.8rem;cursor:pointer}.status{font-weight:700;padding-right:2rem}
      .field{display:grid;gap:.35rem;margin:.8rem 0}.field[hidden],.payment[hidden]{display:none}.qr{display:block;margin:1rem auto;max-width:100%}
      .invoice{box-sizing:border-box;width:100%;height:5rem;resize:none}.actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}.amount{font-size:1.25rem;font-weight:700}
    </style>
    <button type="button" class="pay"></button>
    <div class="overlay">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="cherito-status" tabindex="-1">
        <button type="button" class="close"></button>
        <p id="cherito-status" class="status" role="status" aria-live="polite"></p>
        <p class="title"></p><p class="description"></p>
        <div class="field amount-field" hidden><label for="cherito-amount"></label><input id="cherito-amount" inputmode="numeric" pattern="[0-9]+"></div>
        <div class="field note-field" hidden><label for="cherito-note"></label><textarea id="cherito-note" maxlength="500"></textarea></div>
        <button type="button" class="action create" hidden></button>
        <div class="payment" hidden>
          <p class="amount"></p><canvas class="qr" aria-label="Lightning invoice QR code"></canvas><p class="timer"></p>
          <textarea class="invoice" readonly aria-label="BOLT11 Lightning invoice"></textarea>
          <div class="actions"><button type="button" class="action copy-invoice"></button><button type="button" class="action copy-link"></button><a class="wallet action"></a></div>
        </div>
      </section>
    </div>`
    this.labelControls()
    this.element<HTMLButtonElement>('.pay').addEventListener('click', () => void this.open())
    this.element<HTMLButtonElement>('.close').addEventListener('click', () => this.close())
    this.element<HTMLButtonElement>('.create').addEventListener('click', () => void this.createFromLink())
    this.element<HTMLButtonElement>('.copy-invoice').addEventListener('click', () => void this.copy(false))
    this.element<HTMLButtonElement>('.copy-link').addEventListener('click', () => void this.copy(true))
    this.element<HTMLElement>('.dialog').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close()
    })
  }

  private labelControls(): void {
    this.element<HTMLButtonElement>('.pay').textContent = this.messages.pay
    this.element<HTMLButtonElement>('.close').textContent = '×'
    this.element<HTMLButtonElement>('.close').ariaLabel = this.messages.close
    this.element<HTMLLabelElement>('label[for="cherito-amount"]').textContent = this.messages.amount
    this.element<HTMLLabelElement>('label[for="cherito-note"]').textContent = this.messages.payerNote
    this.element<HTMLButtonElement>('.create').textContent = this.messages.create
    this.element<HTMLButtonElement>('.copy-invoice').textContent = this.messages.copyInvoice
    this.element<HTMLButtonElement>('.copy-link').textContent = this.messages.copyLink
    this.element<HTMLAnchorElement>('.wallet').textContent = this.messages.pay
  }

  private get mode(): WidgetMode {
    return this.getAttribute('mode') === 'payment-intent' ? 'payment-intent' : 'payment-link'
  }

  private get api(): string {
    const value = this.getAttribute('api-url')
    if (!value) throw new Error('api-url is required')
    return value.replace(/\/$/, '')
  }

  private async open(): Promise<void> {
    this.cleanup()
    this.lifecycle = new AbortController()
    this.element('.overlay').classList.add('open')
    this.element<HTMLElement>('.dialog').focus()
    this.setStatusMessage('preparing')
    try {
      if (this.mode === 'payment-intent') await this.loadExistingIntent()
      else await this.loadPaymentLink()
    } catch (error) {
      if ((error as Error).name !== 'AbortError') this.fail(error)
    }
  }

  private async loadExistingIntent(): Promise<void> {
    const id = this.getAttribute('payment-intent-id')
    const tenantId = this.getAttribute('tenant-id')
    const clientSecret = this.getAttribute('client-secret')
    if (!id || !tenantId || !clientSecret) {
      throw new Error('payment-intent-id, tenant-id and client-secret are required')
    }
    const intent = await this.status(id, tenantId, clientSecret)
    await this.acceptIntent({ ...intent, tenantId, clientSecret }, false)
  }

  private async loadPaymentLink(): Promise<void> {
    const slug = this.getAttribute('payment-link-slug')
    if (!slug) throw new Error('payment-link-slug is required')
    const response = await fetch(`${this.api}/v1/payment-links/${encodeURIComponent(slug)}`, {
      signal: this.lifecycle?.signal,
    })
    if (!response.ok) throw apiError(response)
    this.link = await response.json() as PaymentLinkView
    this.element('.title').textContent = this.link.title
    this.element('.description').textContent = this.link.description ?? ''
    if (this.link.mode === 'fixed') {
      await this.createFromLink()
      return
    }
    const amountField = this.element<HTMLElement>('.amount-field')
    amountField.hidden = false
    const amount = this.element<HTMLInputElement>('#cherito-amount')
    amount.min = this.link.minAmountSats ?? '1'
    amount.max = this.link.maxAmountSats ?? ''
    this.element<HTMLElement>('.note-field').hidden = this.link.mode !== 'donation'
    this.element<HTMLButtonElement>('.create').hidden = false
    this.setStatusMessage('requires_payment')
  }

  private async createFromLink(): Promise<void> {
    if (!this.link) return
    this.element<HTMLButtonElement>('.create').disabled = true
    this.setStatusMessage('preparing')
    try {
      const body: { amountSats?: string; payerNote?: string } = {}
      if (this.link.mode !== 'fixed') body.amountSats = this.element<HTMLInputElement>('#cherito-amount').value
      if (this.link.mode === 'donation') {
        const note = this.element<HTMLTextAreaElement>('#cherito-note').value
        if (note) body.payerNote = note
      }
      const response = await fetch(`${this.api}/v1/payment-links/${encodeURIComponent(this.link.slug)}/payment-intents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.lifecycle?.signal,
      })
      if (!response.ok) throw apiError(response)
      await this.acceptIntent(await response.json() as CreatedPaymentIntent, true)
    } catch (error) {
      if ((error as Error).name !== 'AbortError') this.fail(error)
    } finally {
      this.element<HTMLButtonElement>('.create').disabled = false
    }
  }

  private async acceptIntent(intent: CreatedPaymentIntent, created: boolean): Promise<void> {
    this.intent = intent
    this.element<HTMLElement>('.payment').hidden = false
    this.element('.amount').textContent = `${intent.amountSats} sats`
    this.element<HTMLTextAreaElement>('.invoice').value = intent.paymentRequest
    const uri = `lightning:${intent.paymentRequest}`
    this.element<HTMLAnchorElement>('.wallet').href = uri
    await QRCode.toCanvas(this.element<HTMLCanvasElement>('.qr'), uri, { width: 250, margin: 1 })
    this.startCountdown(intent.expiresAt)
    this.applyStatus(intent.status)
    if (created) this.emit('cherito:payment-created', intent)
    if (!TERMINAL.has(intent.status)) void this.watch(intent)
  }

  private async watch(intent: CreatedPaymentIntent): Promise<void> {
    if (this.watching) return
    this.watching = true
    try {
      for (let attempt = 0; attempt < 3 && !this.lifecycle?.signal.aborted; attempt += 1) {
        try {
          await this.readSse(intent)
          if (this.lastStatus && TERMINAL.has(this.lastStatus)) return
        } catch (error) {
          if ((error as Error).name === 'AbortError') return
        }
        try {
          await this.delay(Math.min(this.sseRetryBaseMs * 2 ** attempt, 5_000))
        } catch (error) {
          if ((error as Error).name === 'AbortError') return
          throw error
        }
      }
      if (!this.lifecycle?.signal.aborted && !(this.lastStatus && TERMINAL.has(this.lastStatus))) {
        this.setStatusMessage('interrupted')
        this.schedulePoll(intent, 0)
      }
    } finally {
      this.watching = false
    }
  }

  private async readSse(intent: CreatedPaymentIntent): Promise<void> {
    const response = await fetch(`${this.api}/v1/payment-intents/${encodeURIComponent(intent.id)}/events`, {
      headers: this.clientHeaders(intent),
      signal: this.lifecycle?.signal,
    })
    if (!response.ok || !response.body) throw apiError(response)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const part = await reader.read()
      if (part.done) throw new Error('SSE disconnected')
      buffer += decoder.decode(part.value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const data = block.split('\n').find((line) => line.startsWith('data:'))
        if (!data) continue
        const update = JSON.parse(data.slice(5).trim()) as PaymentIntentView
        this.applyStatus(update.status)
        if (TERMINAL.has(update.status)) return
      }
    }
  }

  private schedulePoll(intent: CreatedPaymentIntent, attempt: number): void {
    if (this.lifecycle?.signal.aborted) return
    const delay = Math.min(this.pollingIntervalMs + attempt * 500, 10_000)
    this.pollTimer = setTimeout(async () => {
      try {
        const update = await this.status(intent.id, intent.tenantId, intent.clientSecret)
        this.applyStatus(update.status)
        if (!TERMINAL.has(update.status)) this.schedulePoll(intent, 0)
      } catch (error) {
        if ((error as Error).name !== 'AbortError') this.schedulePoll(intent, attempt + 1)
      }
    }, delay)
  }

  private async status(id: string, tenantId: string, clientSecret: string): Promise<PaymentIntentView> {
    const response = await fetch(`${this.api}/v1/payment-intents/${encodeURIComponent(id)}/status`, {
      headers: this.clientHeaders({ tenantId, clientSecret }),
      signal: this.lifecycle?.signal,
    })
    if (!response.ok) throw apiError(response)
    return response.json() as Promise<PaymentIntentView>
  }

  private clientHeaders(intent: Pick<CreatedPaymentIntent, 'tenantId' | 'clientSecret'>): HeadersInit {
    return { authorization: `Bearer ${intent.clientSecret}`, 'x-cherito-tenant-id': intent.tenantId }
  }

  private get sseRetryBaseMs(): number {
    return this.boundedTimingAttribute('sse-retry-base-ms', 1_000)
  }

  private get pollingIntervalMs(): number {
    return this.boundedTimingAttribute('poll-interval-ms', 3_000)
  }

  private boundedTimingAttribute(name: string, fallback: number): number {
    const parsed = Number(this.getAttribute(name))
    return Number.isFinite(parsed) ? Math.max(100, Math.min(60_000, Math.trunc(parsed))) : fallback
  }

  private applyStatus(status: IntentStatus): void {
    if (this.lastStatus === status) return
    this.lastStatus = status
    this.setStatusMessage(status)
    if (!this.intent) return
    if (status === 'requires_payment' || status === 'processing') this.emit('cherito:payment-pending', this.intent, status)
    if (status === 'succeeded') this.emit('cherito:payment-settled', this.intent, status)
    if (status === 'expired') this.emit('cherito:payment-expired', this.intent, status)
    if (TERMINAL.has(status)) this.stopNetworkWork()
  }

  private emit(name: string, intent: PaymentIntentView, status = intent.status): void {
    this.dispatchEvent(new CustomEvent(name, {
      bubbles: true,
      composed: true,
      detail: { paymentIntentId: intent.id, amountSats: intent.amountSats, status },
    }))
  }

  private fail(error: unknown): void {
    this.setStatusMessage('error')
    this.dispatchEvent(new CustomEvent('cherito:error', {
      bubbles: true,
      composed: true,
      detail: { code: (error as { status?: number }).status ? 'API_ERROR' : 'WIDGET_ERROR' },
    }))
  }

  private startCountdown(expiresAt: string): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1_000))
      this.element('.timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    }
    tick()
    this.countdownTimer = setInterval(tick, 1_000)
  }

  private async copy(asUri: boolean): Promise<void> {
    const invoice = this.element<HTMLTextAreaElement>('.invoice').value
    await navigator.clipboard.writeText(asUri ? `lightning:${invoice}` : invoice)
  }

  private setStatusMessage(key: keyof CheritoMessages): void {
    this.element('.status').textContent = this.messages[key]
  }

  private close(): void {
    this.cleanup()
    this.element('.overlay').classList.remove('open')
    this.element<HTMLButtonElement>('.pay').focus()
  }

  private stopNetworkWork(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = undefined
  }

  private cleanup(): void {
    this.lifecycle?.abort()
    this.lifecycle = undefined
    this.stopNetworkWork()
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.countdownTimer = undefined
    this.watching = false
    this.intent = undefined
    this.link = undefined
    this.lastStatus = undefined
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.lifecycle?.signal
      const timer = setTimeout(resolve, milliseconds)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  }

  private element<T extends Element = HTMLElement>(selector: string): T {
    const value = this.shadowRoot?.querySelector<T>(selector)
    if (!value) throw new Error(`Widget element is missing: ${selector}`)
    return value
  }
}

if (!customElements.get('cherito-bitcoin-checkout')) {
  customElements.define('cherito-bitcoin-checkout', CheritoBitcoinCheckout)
}
