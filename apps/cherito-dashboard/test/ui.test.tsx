import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, mockFetch, resetStorage, mount, localStorageEntries, type FetchCall } from './harness'



const API_KEY = 'sk_live_ui_test_key'
const CREDENTIALS = { gatewayUrl: 'http://localhost:3100', apiKey: API_KEY }

const INTENTS = [
  {
    id: 'pi_settled_1',
    tenantId: 'tnt_1',
    merchantOrderId: 'order-1',
    pricingRuleId: null,
    paymentLinkId: null,
    amountSats: '25000',
    currency: 'SAT',
    description: 'Specialty coffee',
    status: 'succeeded',
    expiresAt: '2026-08-11T10:00:00.000Z',
    settledAt: '2026-08-11T09:30:00.000Z',
    createdAt: '2026-08-11T09:00:00.000Z',
    updatedAt: '2026-08-11T09:30:00.000Z',
  },
  {
    id: 'pi_pending_2',
    tenantId: 'tnt_1',
    merchantOrderId: 'order-2',
    pricingRuleId: null,
    paymentLinkId: null,
    amountSats: '15000',
    currency: 'SAT',
    description: 'Pupusas',
    status: 'requires_payment',
    expiresAt: '2026-08-11T11:00:00.000Z',
    settledAt: null,
    createdAt: '2026-08-11T10:00:00.000Z',
    updatedAt: '2026-08-11T10:00:00.000Z',
  },
]

const LINKS = [
  {
    id: 'pl_1',
    slug: 'coffee-abc123',
    mode: 'fixed',
    title: 'Coffee link',
    description: null,
    active: true,
    minAmountSats: null,
    maxAmountSats: null,
    maxUses: 10,
    useCount: 3,
    expiresAt: null,
    createdAt: '2026-08-11T09:00:00.000Z',
  },
]

function gatewayResponder(overrides: Record<string, { status?: number; body?: unknown }> = {}) {
  return (call: FetchCall) => {
    const path = call.url.replace('http://localhost:3100', '').split('?')[0]!
    if (overrides[path]) return overrides[path]!
    if (path === '/health') return { body: { status: 'ok', lightning: 'connected' } }
    if (path === '/v1/capabilities') {
      return { body: { bolt11Receive: true, bolt12Receive: false, invoiceStreaming: true } }
    }
    if (path === '/v1/node') {
      return { body: { network: 'regtest', alias: 'cherito-node', syncedToChain: true } }
    }
    if (path === '/v1/payment-intents/summary') {
      return { body: { settledCount: 1, settledVolumeSats: '25000', pendingCount: 1, failedCount: 0 } }
    }
    if (path === '/v1/payment-intents') return { body: { items: INTENTS } }
    if (path === '/v1/payment-links') return { body: { items: LINKS } }
    if (path === '/v1/webhooks/config') {
      return {
        body: {
          enabled: true,
          endpoint: 'https://merchant.example/hook',
          signingSecretConfigured: true,
          secretRotatedAt: '2026-08-10T00:00:00.000Z',
        },
      }
    }
    if (path === '/v1/api-keys') {
      return {
        body: {
          items: [
            { id: 'mak_1', keyPrefix: 'sk_live_abcd', label: 'bootstrap', createdAt: '2026-08-01T00:00:00.000Z', revokedAt: null },
          ],
        },
      }
    }
    return { status: 404, body: { code: 'NOT_FOUND' } }
  }
}

async function mountApp(initialPath = '/') {
  const { MemoryRouter } = await import('react-router-dom')
  const { default: App } = await import('../src/App')
  return mount(
    <MemoryRouter initialEntries={[initialPath]}>
      <App />
    </MemoryRouter>,
  )
}

before(() => {
  installDom()
})

beforeEach(() => {
  resetStorage()
})

test('the connect screen is shown when there is no session', async () => {
  mockFetch(gatewayResponder())
  const view = await mountApp()

  assert.match(view.text(), /Connect to your Cherito gateway/)
  assert.ok(view.find('input[aria-label="Gateway URL"]'))
  assert.ok(view.find('input[aria-label="Merchant API key"]'))
  assert.equal(view.text().includes('2,450,000'), false, 'mock metrics are still rendered')

  await view.unmount()
})

test('an invalid merchant key surfaces an unauthorized message and no session is stored', async () => {
  mockFetch(gatewayResponder({ '/v1/node': { status: 401, body: { code: 'UNAUTHORIZED' } } }))
  const view = await mountApp()

  await view.setValue(view.find('input[aria-label="Merchant API key"]'), 'sk_live_wrong')
  await view.submit(view.find('form'))

  assert.match(view.text(), /merchant API key was rejected/i)
  assert.equal(globalThis.sessionStorage.getItem('cherito.dashboard.session'), null)

  await view.unmount()
})

test('a network failure is reported separately from an auth failure', async () => {
  mockFetch(() => new TypeError('failed to fetch'))
  const view = await mountApp()

  await view.setValue(view.find('input[aria-label="Merchant API key"]'), 'sk_live_any')
  await view.submit(view.find('form'))

  assert.match(view.text(), /Could not reach the gateway/i)
  await view.unmount()
})

test('the overview renders real health, capabilities, node and metrics', async () => {
  globalThis.sessionStorage.setItem('cherito.dashboard.session', JSON.stringify(CREDENTIALS))
  mockFetch(gatewayResponder())

  const view = await mountApp('/')
  const text = view.text()

  assert.match(text, /Connected/)
  assert.match(text, /BOLT11 receive/)
  assert.match(text, /regtest/)
  assert.match(text, /25,000 sats/)
  assert.match(text, /Specialty coffee/)
  assert.equal(text.includes('2,450,000'), false)
  assert.equal(text.includes('142'), false)

  await view.unmount()
})

test('capabilities the gateway denies are not shown as available', async () => {
  globalThis.sessionStorage.setItem('cherito.dashboard.session', JSON.stringify(CREDENTIALS))
  mockFetch(gatewayResponder({
    '/v1/capabilities': { body: { bolt11Receive: true, bolt12Receive: false, invoiceStreaming: false } },
  }))

  const view = await mountApp('/')
  const rows = view.findAll('.capability-list li').map((row) => row.textContent ?? '')

  assert.match(rows[0]!, /BOLT11 receive.*Settled/)
  assert.match(rows[1]!, /BOLT12 receive.*Failed/)
  assert.match(rows[2]!, /Invoice streaming.*Failed/)

  await view.unmount()
})

test('the transactions page lists real payment intents and filters them', async () => {
  globalThis.sessionStorage.setItem('cherito.dashboard.session', JSON.stringify(CREDENTIALS))
  mockFetch(gatewayResponder())

  const view = await mountApp('/transactions')
  assert.equal(view.findAll('tbody tr').length, 2)
  assert.match(view.text(), /order-1/)

  await view.click(view.findByText('Settled') ?? null)
  const rows = view.findAll('tbody tr')
  assert.equal(rows.length, 1)
  assert.match(rows[0]!.textContent ?? '', /pi_settled_1/)

  await view.unmount()
})

test('the transactions page shows an empty state when there is nothing yet', async () => {
  globalThis.sessionStorage.setItem('cherito.dashboard.session', JSON.stringify(CREDENTIALS))
  mockFetch(gatewayResponder({ '/v1/payment-intents': { body: { items: [] } } }))

  const view = await mountApp('/transactions')
  assert.match(view.text(), /No payment intents yet/)
  assert.equal(view.findAll('tbody tr').length, 0)

  await view.unmount()
})

test('the payment links page lists links from the gateway', async () => {
  globalThis.sessionStorage.setItem('cherito.dashboard.session', JSON.stringify(CREDENTIALS))
  mockFetch(gatewayResponder())

  const view = await mountApp('/payment-links')
  assert.match(view.text(), /Coffee link/)
  assert.match(view.text(), /coffee-abc123/)
  assert.match(view.text(), /Active/)

  await view.unmount()
})

test('the webhooks page shows configuration without revealing a stored secret', async () => {
  globalThis.sessionStorage.setItem('cherito.dashboard.session', JSON.stringify(CREDENTIALS))
  mockFetch(gatewayResponder())

  const view = await mountApp('/webhooks')
  const text = view.text()

  assert.match(text, /Enabled/)
  assert.match(text, /merchant\.example\/hook/)
  assert.match(text, /Configured/)
  assert.equal(text.includes('whsec_'), false, 'a stored signing secret was rendered')

  await view.unmount()
})

test('a rotated webhook secret is shown once with a warning and never stored', async () => {
  globalThis.sessionStorage.setItem('cherito.dashboard.session', JSON.stringify(CREDENTIALS))
  mockFetch(gatewayResponder({
    '/v1/webhooks/rotate-secret': {
      body: { signingSecret: 'whsec_rotated_once', secretRotatedAt: '2026-08-11T12:00:00.000Z' },
    },
  }))

  const view = await mountApp('/webhooks')
  await view.click(view.findByText('Rotate signing secret') ?? null)

  assert.match(view.text(), /whsec_rotated_once/)
  assert.match(view.text(), /shown once/i)

  const stored = JSON.stringify([
    ...localStorageEntries(),
    globalThis.sessionStorage.getItem('cherito.dashboard.session'),
  ])
  assert.equal(stored.includes('whsec_rotated_once'), false, 'webhook secret was persisted')

  await view.unmount()
})

test('the api keys page shows metadata only', async () => {
  globalThis.sessionStorage.setItem('cherito.dashboard.session', JSON.stringify(CREDENTIALS))
  mockFetch(gatewayResponder())

  const view = await mountApp('/api-keys')
  const text = view.text()

  assert.match(text, /mak_1/)
  assert.match(text, /bootstrap/)
  assert.equal(text.includes(API_KEY), false, 'the live merchant key was rendered')
  assert.match(text, /not available here/i)

  await view.unmount()
})

test('disconnecting clears the stored merchant credential', async () => {
  globalThis.sessionStorage.setItem('cherito.dashboard.session', JSON.stringify(CREDENTIALS))
  mockFetch(gatewayResponder())

  const view = await mountApp('/')
  assert.ok(globalThis.sessionStorage.getItem('cherito.dashboard.session'))

  await view.click(view.findByText('Disconnect') ?? null)

  assert.equal(globalThis.sessionStorage.getItem('cherito.dashboard.session'), null)
  assert.deepEqual(localStorageEntries(), [])
  assert.match(view.text(), /Connect to your Cherito gateway/)

  await view.unmount()
})
