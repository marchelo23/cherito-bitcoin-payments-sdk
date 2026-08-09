import { afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

const browser = new Window({ url: 'https://merchant.example/' })
before(async () => {
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    customElements: browser.customElements,
    HTMLElement: browser.HTMLElement,
    HTMLCanvasElement: browser.HTMLCanvasElement,
    CustomEvent: browser.CustomEvent,
    DOMException: browser.DOMException,
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.defineProperty(browser.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4), width, height,
      }),
      putImageData: () => undefined,
      clearRect: () => undefined,
    }),
  })
  await import('../src/index.js')
})

afterEach(() => {
  browser.document.body.replaceChildren()
})

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_public_test',
    tenantId: 'tnt_public_test',
    clientSecret: 'client_secret_SHOULD_NOT_LEAK',
    amountSats: '25000',
    currency: 'SAT',
    description: 'Coffee',
    status: 'requires_payment',
    paymentRequest: 'lnbcrt_widget_test',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    settledAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Timed out waiting for widget state')
}

test('Payment Link open-amount mode renders untrusted text safely and never uses the legacy API', async () => {
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    return json({
      slug: 'pl_abcdefghijklmnopqrstuvwxyzABCDEF',
      mode: 'open_amount',
      title: '<img src=x onerror=SHOULD_NOT_EXECUTE>',
      description: '<script>SHOULD_NOT_EXECUTE</script>',
      minAmountSats: '100',
      maxAmountSats: '500',
      expiresAt: null,
    })
  }) as typeof fetch
  const widget = browser.document.createElement('cherito-bitcoin-checkout')
  widget.setAttribute('mode', 'payment-link')
  widget.setAttribute('api-url', 'https://gateway.example')
  widget.setAttribute('payment-link-slug', 'pl_abcdefghijklmnopqrstuvwxyzABCDEF')
  browser.document.body.append(widget)
  widget.shadowRoot!.querySelector<HTMLButtonElement>('.pay')!.click()
  await waitFor(() => widget.shadowRoot!.querySelector('.title')!.textContent.length > 0)
  assert.equal(requests.some((url) => url.includes('/v1/checkout-sessions')), false)
  assert.equal(widget.shadowRoot!.querySelector('.title')!.textContent, '<img src=x onerror=SHOULD_NOT_EXECUTE>')
  assert.equal(widget.shadowRoot!.querySelector('img'), null)
  assert.equal(widget.shadowRoot!.querySelector<HTMLElement>('.amount-field')!.hidden, false)
  assert.equal(widget.shadowRoot!.querySelector<HTMLElement>('.note-field')!.hidden, true)
})

test('fixed Payment Link creates an intent, renders no editable amount, and emits a safe event', async () => {
  const created = intent()
  const requests: Array<{ url: string; body?: string }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url.endsWith('/events')) return new Response(null, { status: 503 })
    if (url.endsWith('/status')) return json(created)
    if (init?.method === 'POST') return json(created, 201)
    return json({
      slug: 'pl_abcdefghijklmnopqrstuvwxyzABCDEF', mode: 'fixed', title: 'Coffee',
      description: null, amountSats: '25000', expiresAt: null,
    })
  }) as typeof fetch
  const widget = browser.document.createElement('cherito-bitcoin-checkout')
  widget.setAttribute('mode', 'payment-link')
  widget.setAttribute('api-url', 'https://gateway.example')
  widget.setAttribute('payment-link-slug', 'pl_abcdefghijklmnopqrstuvwxyzABCDEF')
  let detail: Record<string, unknown> | undefined
  widget.addEventListener('cherito:payment-created', (event) => {
    detail = (event as CustomEvent<Record<string, unknown>>).detail
  })
  browser.document.body.append(widget)
  widget.shadowRoot!.querySelector<HTMLButtonElement>('.pay')!.click()
  await waitFor(() => detail !== undefined)
  assert.equal(widget.shadowRoot!.querySelector<HTMLElement>('.amount-field')!.hidden, true)
  assert.equal(requests.find(({ body }) => body !== undefined)?.body, '{}')
  assert.deepEqual(detail, {
    paymentIntentId: created.id,
    amountSats: created.amountSats,
    status: created.status,
  })
  assert.equal(JSON.stringify(detail).includes(created.clientSecret), false)
  widget.remove()
})

test('Payment Intent mode uses scoped Authorization, emits terminal status, and cleans up on disconnect', async () => {
  const pending = intent()
  const settled = intent({ status: 'succeeded', settledAt: new Date().toISOString() })
  const signals: AbortSignal[] = []
  const headers: HeadersInit[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal)
    headers.push(init?.headers ?? {})
    if (String(input).endsWith('/events')) {
      const payload = `event: payment_intent.succeeded\ndata: ${JSON.stringify(settled)}\n\n`
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload))
          controller.close()
        },
      }))
    }
    return json(pending)
  }) as typeof fetch
  const widget = browser.document.createElement('cherito-bitcoin-checkout')
  widget.setAttribute('mode', 'payment-intent')
  widget.setAttribute('api-url', 'https://gateway.example')
  widget.setAttribute('payment-intent-id', pending.id)
  widget.setAttribute('tenant-id', pending.tenantId)
  widget.setAttribute('client-secret', pending.clientSecret)
  let settledDetail: Record<string, unknown> | undefined
  widget.addEventListener('cherito:payment-settled', (event) => {
    settledDetail = (event as CustomEvent<Record<string, unknown>>).detail
  })
  browser.document.body.append(widget)
  widget.shadowRoot!.querySelector<HTMLButtonElement>('.pay')!.click()
  await waitFor(() => settledDetail !== undefined)
  assert.ok(headers.some((value) => JSON.stringify(value).includes(`Bearer ${pending.clientSecret}`)))
  assert.equal(JSON.stringify(settledDetail).includes(pending.clientSecret), false)
  assert.equal(settledDetail?.status, 'succeeded')
  widget.remove()
  assert.ok(signals.every((signal) => signal.aborted))
})

test('SSE disconnect retries are bounded and then fall back to scoped polling', async () => {
  const pending = intent()
  const settled = intent({ status: 'succeeded', settledAt: new Date().toISOString() })
  let eventAttempts = 0
  let statusAttempts = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/events')) {
      eventAttempts += 1
      return new Response(null, { status: 503 })
    }
    statusAttempts += 1
    return json(statusAttempts === 1 ? pending : settled)
  }) as typeof fetch
  const widget = browser.document.createElement('cherito-bitcoin-checkout')
  widget.setAttribute('mode', 'payment-intent')
  widget.setAttribute('api-url', 'https://gateway.example')
  widget.setAttribute('payment-intent-id', pending.id)
  widget.setAttribute('tenant-id', pending.tenantId)
  widget.setAttribute('client-secret', pending.clientSecret)
  widget.setAttribute('sse-retry-base-ms', '100')
  widget.setAttribute('poll-interval-ms', '100')
  let settledEvent = false
  widget.addEventListener('cherito:payment-settled', () => { settledEvent = true })
  browser.document.body.append(widget)
  widget.shadowRoot!.querySelector<HTMLButtonElement>('.pay')!.click()
  await waitFor(() => settledEvent)
  assert.equal(eventAttempts, 3)
  assert.equal(statusAttempts, 2)
  widget.remove()
})

test('controls are keyboard native and status updates are announced accessibly', () => {
  const widget = browser.document.createElement('cherito-bitcoin-checkout')
  browser.document.body.append(widget)
  const status = widget.shadowRoot!.querySelector('.status')!
  assert.equal(status.getAttribute('role'), 'status')
  assert.equal(status.getAttribute('aria-live'), 'polite')
  assert.equal(widget.shadowRoot!.querySelector('.dialog')!.getAttribute('role'), 'dialog')
  for (const button of widget.shadowRoot!.querySelectorAll('button')) {
    assert.equal(button.getAttribute('type'), 'button')
  }
})
