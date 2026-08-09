# Cherito Bitcoin Payments SDK v1

Open-source, receive-only Lightning payment SDK, gateway and browser widget. It
does not send funds, manage wallets/channels, perform on-chain operations or touch
node signing material. The public browser communicates only with the gateway.

```text
Website / Web Component --HTTPS--> Gateway --TLS + limited macaroon--> LND REST
                                      `--TLS + separate credential--> LNDK gRPC
```

## What is included

- `@cherito/bitcoin-sdk`: typed provider contracts, LND REST BOLT11 adapter,
  strict public-key and satoshi utilities, and checkout client.
- `cherito-payments-gateway`: Fastify API, server-owned catalog/prices, SQLite,
  idempotency, authenticated SSE and polling-compatible status endpoint.
- `@cherito/checkout-widget`: accessible Web Component with local QR generation,
  copy actions, expiry countdown and the `cherito:payment-settled` event.
- Optional LNDK adapter using upstream `lndkrpc.proto` pinned at commit
  `e0b23440a3a3c259122d0aefc1a5f4fd928b323e`.

Node 22.5+ is required because persistence uses the built-in `node:sqlite` API.
See the [database recovery runbook](docs/database-recovery.md) for migration,
backup, restore, and provider-reconciliation procedures.

## Install and develop

```bash
npm install
cp .env.example .env
npm run build
set -a; source .env; set +a
npm run dev
```

Set the frontend origin in `ALLOWED_ORIGINS`. Set `DATABASE_URL` to a writable,
durable location. All amounts are `bigint` internally and decimal strings in JSON.
Edit the approved merchant catalog in
`apps/cherito-payments-gateway/src/services/catalog.ts`; clients cannot submit a
price.

## Connect LND safely

The gateway calls only `GetInfo`, `AddInvoice`, and `LookupInvoice`. Bake a
dedicated macaroon with the corresponding minimum permissions (verify these
permission names against your installed LND release):

```bash
lncli bakemacaroon \
  --save_to=cherito-invoice.macaroon \
  info:read \
  invoices:read \
  invoices:write
```

Copy LND's `tls.cert` and this macaroon into `secrets/`; never use the admin
macaroon. Choose exactly one source (mounted file or inline value) for each
credential; ambiguous or malformed sources stop startup. The gateway also refuses
known high-privilege or wallet-material environment settings. These name and
format checks cannot prove the macaroon's permissions, so verify least privilege
against the installed LND version.

Choose a URL whose hostname/IP exists in LND's certificate:

```env
LND_REST_URL=https://127.0.0.1:8080
LND_REST_URL=https://192.168.1.20:8080
LND_REST_URL=https://umbrel.local:8080
LND_REST_URL=https://lightning.internal.cherito.coffee
```

`localhost`, private IPs and `umbrel.local` work only when the gateway is on the
same host/LAN. A cloud deployment cannot reach Cherito's private LAN. Do not expose
LND REST or gRPC to the internet.

Local mode:

```text
Local website -> local gateway -> local/LAN LND
```

Production mode:

```text
Public website -> limited public HTTPS gateway -> private network -> LND
```

Put a normal HTTPS reverse proxy in front of port 3100 in production.

## Run with Docker

```bash
mkdir -p secrets data
cp /path/from/lnd/tls.cert secrets/lnd-tls.cert
cp /path/from/lnd/cherito-invoice.macaroon secrets/cherito-invoice.macaroon
cp .env.example .env
docker compose up --build
docker compose -f docker-compose.production.yml up -d --build
```

The image runs as non-root with a read-only root filesystem, read-only credentials,
persistent SQLite volume, healthcheck, restart policy and resource limits.

## API and payment verification

```bash
curl http://localhost:3100/health
curl http://localhost:3100/v1/capabilities
curl http://localhost:3100/v1/node
curl -X POST http://localhost:3100/v1/checkout-sessions \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen | tr '[:upper:]' '[:lower:]')" \
  -d '{"productId":"cherito-coffee-001","quantity":2}'
curl http://localhost:3100/v1/checkout-sessions/chk_ID \
  -H 'Authorization: Bearer STATUS_TOKEN'
curl -N http://localhost:3100/v1/checkout-sessions/chk_ID/events \
  -H 'Authorization: Bearer STATUS_TOKEN'
```

The order changes to confirmed exactly once only after LND reports `SETTLED`.
`ACCEPTED` maps to “Payment detected” but never confirms an order.

## Widget integration

Build and serve `packages/cherito-checkout-widget/dist/index.js` from your own site:

```html
<script type="module" src="/vendor/cherito-checkout-widget/index.js"></script>
<cherito-bitcoin-checkout
  api-url="https://payments.cherito.coffee"
  product-id="cherito-coffee-001">
</cherito-bitcoin-checkout>
```

The QR is generated locally. The widget copies either the raw BOLT11 or
`lightning:<invoice>`, authenticates its event stream, falls back to polling, and
dispatches:

```js
window.addEventListener('cherito:payment-settled', ({ detail }) => {
  showOrderConfirmation(detail.orderId)
})
```

Do not send payment hashes, invoices, node data, or status tokens to analytics.
See [Logging, privacy, and retention](docs/logging-and-privacy.md) for the exact log
allowlist, diagnostics exposure, retention guidance, and remaining privacy work.

## Experimental BOLT12 with LNDK

Set `BOLT12_PROVIDER=lndk` and configure `LNDK_GRPC_URL`, its TLS certificate and a
credential separate from the BOLT11 gateway credential. LNDK itself must be
configured against LND according to its official documentation. At startup the
adapter requires a ready TLS gRPC channel. Only then does `/v1/capabilities` report
`bolt12Receive: true`; otherwise BOLT11 remains available. `POST /v1/offers` accepts
only an approved `productId`, calls official `CreateOffer`, preserves the returned
Offer/blinded paths unchanged, and persists its identifier. With `none`, it returns
`501 BOLT12_NOT_CONFIGURED`.

LNDK is optional and experimental. The adapter is unit-tested with mocks but has
not been proven against your real LNDK instance; this project does not claim live
BOLT12 validation until the optional regtest is run. Upstream currently exposes no
capabilities or disable-offer RPC, so neither is fabricated.

## Tests and optional regtest

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

For integration, configure `.env` against regtest, start the gateway, create a
session using the commands above, pay `paymentRequest` from another regtest node,
and assert the SSE sequence ends in `invoice.settled`. This test is opt-in because
it creates a real invoice on the configured node.

## Troubleshooting

- **certificate hostname mismatch:** regenerate/configure LND's certificate for the exact hostname/IP; never disable verification.
- **connection refused:** confirm LND port 8080, routing, firewall and shared LAN.
- **macaroon permission denied:** bake the limited credential again with the three documented permissions.
- **node not synced:** use a merchant API key to inspect sync flags from `/v1/node`.
- **invoice creation failed:** inspect redacted structured logs, limits, LND status and permissions.
- **invoice expired:** create a fresh checkout; expired invoices are never confirmed.
- **SSE disconnected:** the widget displays interruption and switches to authenticated polling.
- **LNDK unavailable:** verify its TLS endpoint and separate credential; BOLT11 remains operational.
- **BOLT12 not configured:** expected with `BOLT12_PROVIDER=none`.

## Security reporting and license

Do not open a public issue containing credentials. Rotate any credential that was
exposed. This v1 is prepared for an MIT license; review organizational ownership
before publishing.
