import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, mockFetch, fetchCalls, resetStorage, localStorageEntries } from './harness'
import { CheritoClient, normalizeGatewayUrl } from '../src/api/cherito-client'
import { ApiError } from '../src/api/errors'
import { clearSession, loadSession, saveSession } from '../src/session'

const CREDENTIALS = { gatewayUrl: 'http://localhost:3100', apiKey: 'sk_live_dashboard_test_key' }

before(() => {
  installDom()
})

beforeEach(() => {
  resetStorage()
})

test('every authenticated request carries a bearer header and no key in the query', async () => {
  mockFetch(() => ({ body: { items: [] } }))
  const client = new CheritoClient(CREDENTIALS)

  await client.node()
  await client.listPaymentIntents({ limit: 10 })
  await client.listPaymentLinks()
  await client.webhookConfig()
  await client.listApiKeys()

  assert.equal(fetchCalls.length, 5)
  for (const call of fetchCalls) {
    assert.equal(call.headers.authorization, `Bearer ${CREDENTIALS.apiKey}`)
    assert.equal(call.url.includes(CREDENTIALS.apiKey), false, `key leaked into ${call.url}`)
    assert.ok(call.url.startsWith('http://localhost:3100/v1/'))
  }
})

test('public endpoints are requested without the merchant key', async () => {
  mockFetch(() => ({ body: { status: 'ok', lightning: 'connected' } }))
  const client = new CheritoClient(CREDENTIALS)

  await client.health()
  await client.capabilities()

  for (const call of fetchCalls) {
    assert.equal(call.headers.authorization, undefined)
  }
})

test('payment link creation sends a uuid idempotency key', async () => {
  mockFetch(() => ({ status: 201, body: { id: 'pl_1' } }))
  await new CheritoClient(CREDENTIALS).createPaymentLink({ mode: 'fixed', title: 'Coffee', productId: 'p-1' })

  const call = fetchCalls[0]!
  assert.equal(call.method, 'POST')
  assert.match(
    call.headers['idempotency-key']!,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  )
  assert.deepEqual(call.body, { mode: 'fixed', title: 'Coffee', productId: 'p-1' })
})

test('http failures become typed errors with safe messages', async () => {
  const cases: Array<[number, string, string]> = [
    [401, 'UNAUTHORIZED', 'unauthorized'],
    [404, 'NOT_FOUND', 'not_found'],
    [429, 'RATE_LIMITED', 'rate_limited'],
    [400, 'INVALID', 'invalid_request'],
    [502, 'PROVIDER_UNAVAILABLE', 'provider_unavailable'],
    [500, 'BOOM', 'server_error'],
  ]

  for (const [status, code, kind] of cases) {
    mockFetch(() => ({ status, body: { code, message: 'internal detail: stack trace at line 42' } }))
    await assert.rejects(
      () => new CheritoClient(CREDENTIALS).node(),
      (error: ApiError) => {
        assert.equal(error.kind, kind)
        assert.equal(error.status, status)
        assert.equal(error.message.includes('stack trace'), false, 'raw server body leaked')
        return true
      },
    )
  }
})

test('network failures are distinguished from http errors', async () => {
  mockFetch(() => new TypeError('failed to fetch'))
  await assert.rejects(
    () => new CheritoClient(CREDENTIALS).health(),
    (error: ApiError) => {
      assert.equal(error.kind, 'network')
      assert.equal(error.status, undefined)
      return true
    },
  )
})

test('gateway urls are normalized and validated', () => {
  assert.equal(normalizeGatewayUrl('http://localhost:3100/'), 'http://localhost:3100')
  assert.equal(normalizeGatewayUrl('  https://pay.example.com//  '), 'https://pay.example.com')
  assert.throws(() => normalizeGatewayUrl('not-a-url'))
  assert.throws(() => normalizeGatewayUrl('ftp://pay.example.com'))
})

test('the session helper never writes the merchant key to localStorage', () => {
  saveSession(CREDENTIALS)

  assert.deepEqual(loadSession(), CREDENTIALS)
  assert.deepEqual(localStorageEntries(), [], 'credentials reached localStorage')

  const serialized = JSON.stringify(localStorageEntries())
  assert.equal(serialized.includes(CREDENTIALS.apiKey), false)

  clearSession()
  assert.equal(loadSession(), undefined)
})
