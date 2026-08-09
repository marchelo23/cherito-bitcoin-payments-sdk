# Payment Links and the checkout widget

Payment Links are reusable public configuration; every invocation creates a new canonical
Payment Intent and a new BOLT11 invoice. A use is committed only after that Payment Intent is
durably stored. Provider failures release the reservation, while a SQLite `BEGIN IMMEDIATE`
reservation prevents concurrent callers from exceeding `maxUses`.

## Merchant API

All management requests use `Authorization: Bearer <merchant-api-key>`. Creating a link also
requires a UUID `Idempotency-Key`.

- `POST /v1/payment-links`
- `GET /v1/payment-links?limit=20&after=<id>`
- `GET /v1/payment-links/manage/:id`
- `PATCH /v1/payment-links/:id`
- `POST /v1/payment-links/:id/disable`
- `POST /v1/payment-links/:id/rotate-slug`

Fixed links reference a server-owned fixed pricing rule. Open-amount and donation links require
decimal-string `minAmountSats` and `maxAmountSats`. Amounts are never parsed through floating
point. Donation notes are normalized, byte-bounded, treated as text, and never logged.

Public checkout URLs use `GET /v1/payment-links/:slug`. To make a physical QR code, encode the
complete URL (for example `https://pay.example/link/pl_...`) rather than a long-lived invoice.
The checkout then invokes `POST /v1/payment-links/:slug/payment-intents`; it must never cache or
reuse the returned BOLT11.

## Web Component

The framework-independent ESM bundle can be served from `@cherito/checkout-widget/dist/index.js`
or a pinned npm CDN URL with `<script type="module">`. See
[`examples/payment-links.html`](../examples/payment-links.html).

Payment Link mode:

```html
<cherito-bitcoin-checkout
  mode="payment-link"
  api-url="https://gateway.example"
  payment-link-slug="pl_REPLACE_WITH_THE_PUBLIC_SLUG">
</cherito-bitcoin-checkout>
```

Payment Intent mode is for a merchant backend that has already created an intent:

```html
<cherito-bitcoin-checkout
  mode="payment-intent"
  api-url="https://gateway.example"
  payment-intent-id="pi_REPLACE"
  tenant-id="tnt_REPLACE"
  client-secret="REPLACE_WITH_SCOPED_CLIENT_CAPABILITY">
</cherito-bitcoin-checkout>
```

The capability is sent in the `Authorization` header, never a URL. The component uses scoped SSE,
bounded reconnects, and polling fallback. Removing the element or reaching a terminal state cleans
up streams and timers.

Events are `cherito:payment-created`, `cherito:payment-pending`,
`cherito:payment-settled`, `cherito:payment-expired`, and `cherito:error`. Payment events contain
only `paymentIntentId`, `amountSats`, and `status`; capabilities and BOLT11 invoices are excluded.

Browser events are informational and are **not fulfillment authorization**. Fulfillment must use
an authenticated merchant read or the provider-authoritative, signed webhook event.

## Current secret-storage limitation

Payment Intent client capabilities use the encrypted application-key design from the canonical
Payment Intent implementation. Existing tenant webhook signing-secret columns remain plaintext in
the current main schema; this PR does not repurpose the Payment Intent cipher or invent a second
crypto format. Database compromise therefore compromises webhook signing secrets until issue #19
adds a purpose-separated application secret envelope and migration.
