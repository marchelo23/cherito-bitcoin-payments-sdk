import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { LnbitsProvider, LightningError } from '../src/index.js'

const API_KEY = 'lnbits-secret-api-key'
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600
const PAST = Math.floor(Date.now() / 1000) - 3600

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

const realFetch = globalThis.fetch
let calls: RecordedCall[] = []

function mockFetch(responder: (call: RecordedCall, index: number) => unknown): void {
  calls = []
  globalThis.fetch = (async (input: unknown, init: Record<string, unknown> = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    const call: RecordedCall = {
      url: String(input),
      method: String(init.method ?? 'GET'),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    const index = calls.length
    calls.push(call)
    return responder(call, index)
  }) as unknown as typeof globalThis.fetch
}

function jsonResponse(payload: unknown, status = 200): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function brokenJsonResponse(status = 200): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token')
    },
  }
}

function provider(overrides: Record<string, unknown> = {}): LnbitsProvider {
  return new LnbitsProvider({
    url: 'https://lnbits.example.com/',
    apiKey: API_KEY,
    network: 'regtest',
    pollIntervalMs: 1,
    ...overrides,
  } as ConstructorParameters<typeof LnbitsProvider>[0])
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('LnbitsProvider construction', () => {
  test('accepts a valid configuration and normalizes the trailing slash', async () => {
    const lnbits = provider()
    assert.equal(lnbits.providerType, 'external')

    const capabilities = await lnbits.getCapabilities()
    assert.deepEqual(capabilities, {
      bolt11Receive: true,
      bolt12Receive: false,
      invoiceStreaming: false,
      provider: 'external',
    })

    mockFetch(() => jsonResponse({ payment_hash: 'a'.repeat(64), payment_request: 'lnbcrt1', expiry: FAR_FUTURE }))
    await lnbits.createInvoice({ orderId: 'o1', amountSats: 1000n, memo: 'm', expirySeconds: 600 })
    assert.equal(calls[0]!.url, 'https://lnbits.example.com/api/v1/payments')
  })

  test('rejects an invalid URL', () => {
    assert.throws(
      () => provider({ url: 'not-a-url' }),
      (error: LightningError) => {
        assert.equal(error.code, 'CONFIGURATION_ERROR')
        return true
      },
    )
    assert.throws(
      () => provider({ url: 'ftp://lnbits.example.com' }),
      (error: LightningError) => {
        assert.equal(error.code, 'CONFIGURATION_ERROR')
        return true
      },
    )
  })

  test('rejects an empty API key without echoing credentials', () => {
    for (const apiKey of ['', '   ']) {
      assert.throws(
        () => provider({ apiKey }),
        (error: LightningError) => {
          assert.equal(error.code, 'CONFIGURATION_ERROR')
          assert.ok(!error.message.includes(apiKey.trim()) || apiKey.trim() === '')
          return true
        },
      )
    }
  })

  test('requires an explicit network instead of assuming mainnet', async () => {
    assert.throws(
      () => provider({ network: 'not-a-network' }),
      (error: LightningError) => {
        assert.equal(error.code, 'CONFIGURATION_ERROR')
        return true
      },
    )
    const info = await provider({ network: 'regtest' }).getNodeInfo()
    assert.equal(info.network, 'regtest')
    assert.equal(info.syncedToChain, undefined)
    assert.equal(info.syncedToGraph, undefined)
  })
})

describe('LnbitsProvider createInvoice', () => {
  test('issues the documented request with credentials in the header only', async () => {
    mockFetch(() => jsonResponse({ payment_hash: 'b'.repeat(64), payment_request: 'lnbcrt2', expiry: FAR_FUTURE }))

    await provider().createInvoice({
      orderId: 'order-1',
      amountSats: 25_000n,
      memo: 'Cherito coffee',
      expirySeconds: 900,
    })

    const call = calls[0]!
    assert.equal(call.method, 'POST')
    assert.equal(call.url, 'https://lnbits.example.com/api/v1/payments')
    assert.equal(call.headers['X-Api-Key'], API_KEY)
    assert.equal(call.headers['Content-Type'], 'application/json')
    assert.deepEqual(call.body, {
      out: false,
      amount: 25000,
      memo: 'Cherito coffee',
      expiry: 900,
    })
  })

  test('maps a successful response onto the SDK invoice shape', async () => {
    mockFetch(() => jsonResponse({
      payment_hash: 'c'.repeat(64),
      payment_request: 'lnbcrt10u1positive',
      expiry: FAR_FUTURE,
    }))

    const invoice = await provider().createInvoice({
      orderId: 'order-2',
      amountSats: 1_000n,
      memo: 'memo',
      expirySeconds: 600,
    })

    assert.equal(invoice.paymentHash, 'c'.repeat(64))
    assert.equal(invoice.providerInvoiceId, 'c'.repeat(64))
    assert.equal(invoice.paymentRequest, 'lnbcrt10u1positive')
    assert.equal(invoice.amountSats, 1_000n)
    assert.equal(invoice.state, 'pending')
    assert.equal(invoice.expiresAt, new Date(FAR_FUTURE * 1000).toISOString())
  })

  test('rejects zero and negative amounts', async () => {
    mockFetch(() => jsonResponse({}))
    const lnbits = provider()
    for (const amountSats of [0n, -1n, -25_000n]) {
      await assert.rejects(
        () => lnbits.createInvoice({ orderId: 'o', amountSats, memo: 'm', expirySeconds: 600 }),
        (error: LightningError) => {
          assert.equal(error.code, 'CONFIGURATION_ERROR')
          return true
        },
      )
    }
    assert.equal(calls.length, 0)
  })

  test('rejects amounts that cannot be represented safely as a JS number', async () => {
    mockFetch(() => jsonResponse({}))
    await assert.rejects(
      () => provider().createInvoice({
        orderId: 'o',
        amountSats: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        memo: 'm',
        expirySeconds: 600,
      }),
      (error: LightningError) => {
        assert.equal(error.code, 'CONFIGURATION_ERROR')
        return true
      },
    )
    assert.equal(calls.length, 0)
  })

  test('rejects a malformed createInvoice response', async () => {
    const cases: unknown[] = [
      {},
      { payment_hash: 'd'.repeat(64) },
      { payment_request: 'lnbcrt1' },
      'not-an-object',
    ]

    for (const payload of cases) {
      mockFetch(() => jsonResponse(payload))
      await assert.rejects(
        () => provider().createInvoice({ orderId: 'o', amountSats: 1_000n, memo: 'm', expirySeconds: 600 }),
        (error: LightningError) => {
          assert.equal(error.code, 'INVALID_RESPONSE')
          return true
        },
      )
    }

    mockFetch(() => brokenJsonResponse())
    await assert.rejects(
      () => provider().createInvoice({ orderId: 'o', amountSats: 1_000n, memo: 'm', expirySeconds: 600 }),
      (error: LightningError) => {
        assert.equal(error.code, 'INVALID_RESPONSE')
        return true
      },
    )
  })

  test('maps HTTP failures without leaking the API key', async () => {
    mockFetch(() => jsonResponse({ detail: 'boom' }, 500))
    await assert.rejects(
      () => provider().createInvoice({ orderId: 'o', amountSats: 1_000n, memo: 'm', expirySeconds: 600 }),
      (error: LightningError) => {
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE')
        assert.ok(!error.message.includes(API_KEY))
        return true
      },
    )

    mockFetch(() => jsonResponse({ detail: 'nope' }, 401))
    await assert.rejects(
      () => provider().createInvoice({ orderId: 'o', amountSats: 1_000n, memo: 'm', expirySeconds: 600 }),
      (error: LightningError) => {
        assert.equal(error.code, 'AUTHENTICATION_FAILED')
        assert.ok(!error.message.includes(API_KEY))
        return true
      },
    )

    globalThis.fetch = (async () => {
      throw new TypeError('network down')
    }) as unknown as typeof globalThis.fetch
    await assert.rejects(
      () => provider().createInvoice({ orderId: 'o', amountSats: 1_000n, memo: 'm', expirySeconds: 600 }),
      (error: LightningError) => {
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE')
        return true
      },
    )
  })
})

describe('LnbitsProvider getInvoice', () => {
  test('maps an unpaid invoice to pending', async () => {
    mockFetch(() => jsonResponse({
      paid: false,
      details: { amount: 25_000_000, expiry: FAR_FUTURE, bolt11: 'lnbcrt25u1pending' },
    }))

    const invoice = await provider().getInvoice('e'.repeat(64))
    assert.equal(calls[0]!.url, `https://lnbits.example.com/api/v1/payments/${'e'.repeat(64)}`)
    assert.equal(invoice.state, 'pending')
    assert.equal(invoice.amountSats, 25_000n)
    assert.equal(invoice.paymentRequest, 'lnbcrt25u1pending')
    assert.equal(invoice.settledAt, undefined)
    assert.equal(invoice.amountPaidSats, undefined)
  })

  test('maps an expired unpaid invoice to expired', async () => {
    mockFetch(() => jsonResponse({ paid: false, details: { amount: 1_000_000, expiry: PAST } }))
    const invoice = await provider().getInvoice('f'.repeat(64))
    assert.equal(invoice.state, 'expired')
  })

  test('maps a paid invoice to settled and never invents a settlement time', async () => {
    mockFetch(() => jsonResponse({
      paid: true,
      details: { amount: 25_000_000, expiry: FAR_FUTURE, bolt11: 'lnbcrt25u1paid' },
    }))

    const withoutTimestamp = await provider().getInvoice('a'.repeat(64))
    assert.equal(withoutTimestamp.state, 'settled')
    assert.equal(withoutTimestamp.amountPaidSats, 25_000n)
    assert.equal(withoutTimestamp.settledAt, undefined)

    const paidAt = FAR_FUTURE - 60
    mockFetch(() => jsonResponse({
      paid: true,
      details: { amount: 25_000_000, expiry: FAR_FUTURE, paid_at: paidAt },
    }))
    const withTimestamp = await provider().getInvoice('a'.repeat(64))
    assert.equal(withTimestamp.settledAt, new Date(paidAt * 1000).toISOString())
  })

  test('rejects malformed getInvoice responses', async () => {
    mockFetch(() => jsonResponse('nope'))
    await assert.rejects(
      () => provider().getInvoice('b'.repeat(64)),
      (error: LightningError) => {
        assert.equal(error.code, 'INVALID_RESPONSE')
        return true
      },
    )

    mockFetch(() => jsonResponse({ paid: false, details: { amount: 1_000_000 } }))
    await assert.rejects(
      () => provider().getInvoice('b'.repeat(64)),
      (error: LightningError) => {
        assert.equal(error.code, 'INVALID_RESPONSE')
        assert.match(error.message, /expiry/)
        return true
      },
    )

    mockFetch(() => jsonResponse({ paid: false, details: { expiry: FAR_FUTURE } }))
    await assert.rejects(
      () => provider().getInvoice('b'.repeat(64)),
      (error: LightningError) => {
        assert.equal(error.code, 'INVALID_RESPONSE')
        assert.match(error.message, /amount/)
        return true
      },
    )
  })
})

describe('LnbitsProvider subscribeToInvoice', () => {
  test('polls until a terminal state, emits once, and then stops', async () => {
    const settled = deferred<void>()
    mockFetch((_call, index) => jsonResponse({
      paid: index >= 2,
      details: { amount: 25_000_000, expiry: FAR_FUTURE, bolt11: 'lnbcrt25u1poll' },
    }))

    const observed: string[] = []
    const lnbits = provider()
    const unsubscribe = await lnbits.subscribeToInvoice('c'.repeat(64), (invoice) => {
      observed.push(invoice.state)
      if (invoice.state === 'settled') settled.resolve()
    })

    await settled.promise
    const callsAtSettlement = calls.length
    await delay(40)

    assert.deepEqual(observed, ['pending', 'settled'])
    assert.equal(calls.length, callsAtSettlement, 'polling continued after a terminal state')

    await unsubscribe()
  })

  test('unsubscribing stops polling and prevents later callbacks', async () => {
    mockFetch(() => jsonResponse({
      paid: false,
      details: { amount: 25_000_000, expiry: FAR_FUTURE, bolt11: 'lnbcrt25u1open' },
    }))

    let invocations = 0
    const lnbits = provider()
    const unsubscribe = await lnbits.subscribeToInvoice('d'.repeat(64), () => {
      invocations += 1
    })

    await unsubscribe()
    const callsAfterUnsubscribe = calls.length
    await delay(40)

    assert.equal(invocations, 0, 'callback fired after unsubscribe')
    assert.equal(calls.length, callsAfterUnsubscribe, 'polling continued after unsubscribe')
  })

  test('a failing poll does not throw and polling recovers', async () => {
    const settled = deferred<void>()
    mockFetch((_call, index) => {
      if (index === 0) return jsonResponse({ detail: 'temporary' }, 503)
      return jsonResponse({
        paid: true,
        details: { amount: 25_000_000, expiry: FAR_FUTURE, bolt11: 'lnbcrt25u1recovered' },
      })
    })

    const observed: string[] = []
    const unsubscribe = await provider().subscribeToInvoice('e'.repeat(64), (invoice) => {
      observed.push(invoice.state)
      settled.resolve()
    })

    await settled.promise
    assert.deepEqual(observed, ['settled'])
    await unsubscribe()
  })
})
