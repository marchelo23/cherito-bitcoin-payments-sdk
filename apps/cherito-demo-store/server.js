import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = resolve(__dirname, 'public')

const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000
const GATEWAY_URL = (process.env.CHERITO_GATEWAY_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, '')
const API_KEY = process.env.CHERITO_API_KEY ?? ''

const PRODUCTS = new Map([
  ['cherito-coffee-001', { name: 'Salvadoran Specialty Coffee', amountSats: 25000n }],
  ['artisan-pupusa-002', { name: 'Artisan Pupusas Platter', amountSats: 15000n }],
  ['vip-developer-pass-003', { name: 'Lightning Developer VIP Pass', amountSats: 50000n }],
])

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readJsonBody(req, limitBytes = 16 * 1024) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        fail(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) return done({})
      try {
        done(JSON.parse(raw))
      } catch {
        fail(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', fail)
  })
}

async function callGateway(path, init = {}) {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
      ...init.headers,
    },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = {}
  }
  return { status: response.status, body }
}

function publicIntentView(intent, productName) {
  return {
    id: intent.id,
    description: productName ?? intent.description ?? '',
    amountSats: intent.amountSats,
    status: intent.status,
    paymentRequest: intent.paymentRequest,
    expiresAt: intent.expiresAt,
    settledAt: intent.settledAt ?? null,
    createdAt: intent.createdAt ?? new Date().toISOString(),
  }
}

async function handleCreateCheckout(req, res) {
  if (!API_KEY) {
    return sendJson(res, 503, {
      code: 'GATEWAY_NOT_CONFIGURED',
      message: 'Set CHERITO_API_KEY in the demo store environment before creating payments',
    })
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    return sendJson(res, 400, { code: 'INVALID_REQUEST', message: error.message })
  }

  const product = PRODUCTS.get(body.productId)
  if (!product) {
    return sendJson(res, 404, { code: 'UNKNOWN_PRODUCT', message: 'Unknown product' })
  }

  const result = await callGateway('/v1/payment-intents', {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({
      amountSats: product.amountSats.toString(),
      merchantOrderId: `demo-${crypto.randomUUID()}`,
      description: product.name,
    }),
  })

  if (result.status !== 201) {
    return sendJson(res, 502, {
      code: 'GATEWAY_ERROR',
      message: result.body.message ?? 'The Cherito gateway rejected the payment intent',
      gatewayStatus: result.status,
    })
  }

  return sendJson(res, 201, publicIntentView(result.body, product.name))
}

async function handleReadCheckout(res, intentId) {
  if (!API_KEY) {
    return sendJson(res, 503, {
      code: 'GATEWAY_NOT_CONFIGURED',
      message: 'Set CHERITO_API_KEY in the demo store environment',
    })
  }

  const result = await callGateway(`/v1/payment-intents/${encodeURIComponent(intentId)}`)
  if (result.status !== 200) {
    return sendJson(res, result.status === 404 ? 404 : 502, {
      code: result.status === 404 ? 'NOT_FOUND' : 'GATEWAY_ERROR',
      message: 'Payment intent is not available',
    })
  }
  return sendJson(res, 200, publicIntentView(result.body))
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const target = resolve(PUBLIC_DIR, relative)

  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('403 Forbidden')
    return
  }

  const data = await readFile(target)
  res.writeHead(200, {
    'content-type': MIME_TYPES[extname(target)] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
  })
  res.end(data)
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')

    if (pathname === '/api/status') {
      return sendJson(res, 200, { gatewayUrl: GATEWAY_URL, configured: API_KEY.length > 0 })
    }
    if (pathname === '/api/checkout' && req.method === 'POST') {
      return await handleCreateCheckout(req, res)
    }
    if (pathname.startsWith('/api/checkout/') && req.method === 'GET') {
      return await handleReadCheckout(res, pathname.slice('/api/checkout/'.length))
    }
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { code: 'NOT_FOUND', message: 'Unknown endpoint' })
    }

    await serveStatic(res, pathname)
  } catch {
    if (res.headersSent) return
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
  }
})

server.listen(PORT, () => {
  console.log(`\n⚡ Cherito Demo Store running at http://localhost:${PORT}`)
  console.log(`   gateway: ${GATEWAY_URL}`)
  console.log(`   merchant key: ${API_KEY ? 'configured (server-side only)' : 'MISSING — set CHERITO_API_KEY'}`)
})

export { server, PRODUCTS }
