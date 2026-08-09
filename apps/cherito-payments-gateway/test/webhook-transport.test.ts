import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createHmac } from 'node:crypto'
import {
  isForbiddenWebhookAddress,
  WebhookTransport,
} from '../src/services/webhook-transport.js'
import { WebhookService } from '../src/services/webhook-service.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

test('SSRF validation rejects private, link-local, metadata, multicast, and IPv6 local ranges', async () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.20.1.1', '192.168.1.1', '169.254.169.254',
    '224.0.0.1', '::1', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1',
  ]) assert.equal(isForbiddenWebhookAddress(address), true, address)
  const transport = new WebhookTransport({ production: true, resolve: async () => [{ address: '10.0.0.1', family: 4 }] })
  await assert.rejects(transport.validate('https://merchant.example/hook'), /forbidden/)
  await assert.rejects(transport.validate('https://user:pass@merchant.example/hook'), /credentials/)
  await assert.rejects(transport.validate('http://merchant.example/hook'), /HTTPS/)
  await assert.rejects(transport.validate('https://localhost/hook'), /forbidden/)
  await assert.rejects(transport.validate('https://[::1]/hook'), /forbidden/)
})

test('delivery pins the validated address, does not follow redirects, and bounds response bodies', async () => {
  let host = ''
  const server = createServer((request, response) => {
    host = request.headers.host ?? ''
    if (request.url === '/timeout') return
    if (request.url === '/large') {
      response.writeHead(200)
      response.end('x'.repeat(100))
      return
    }
    response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
    response.end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  let resolutions = 0
  const transport = new WebhookTransport({
    production: false,
    allowPrivateAddresses: true,
    maximumResponseBytes: 1_024,
    resolve: async () => {
      resolutions += 1
      return [{ address: '127.0.0.1', family: 4 }]
    },
  })
  const redirect = await transport.deliver(`http://merchant.example:${port}/redirect`, '{}', {})
  assert.equal(redirect.ok, false)
  assert.equal(redirect.statusCode, 302)
  assert.equal(resolutions, 1)
  assert.match(host, /^merchant\.example:/)
  const bounded = new WebhookTransport({
    production: false,
    allowPrivateAddresses: true,
    maximumResponseBytes: 16,
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  })
  await assert.rejects(
    bounded.deliver(`http://merchant.example:${port}/large`, '{}', {}),
    (error: unknown) => (error as { code?: string }).code === 'WEBHOOK_RESPONSE_TOO_LARGE',
  )
  const impatient = new WebhookTransport({
    production: false,
    allowPrivateAddresses: true,
    timeoutMs: 20,
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  })
  await assert.rejects(
    impatient.deliver(`http://merchant.example:${port}/timeout`, '{}', {}),
    (error: unknown) => (error as { code?: string }).code === 'WEBHOOK_TIMEOUT',
  )
})

test('webhook verification rejects tampering, wrong secret, staleness, and malformed signatures', () => {
  const body = '{"id":"event"}'
  const secret = 'whsec_test'
  const timestamp = Math.floor(Date.now() / 1_000)
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  const header = `t=${timestamp},v1=${signature}`
  assert.equal(WebhookService.verify(secret, header, body), true)
  assert.equal(WebhookService.verify(secret, header, `${body}x`), false)
  assert.equal(WebhookService.verify('wrong', header, body), false)
  assert.equal(WebhookService.verify(secret, `t=${timestamp - 1_000},v1=${signature}`, body), false)
  assert.equal(WebhookService.verify(secret, 'malformed', body), false)
})
