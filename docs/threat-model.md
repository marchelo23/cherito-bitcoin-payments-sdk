# Cherito Threat Model and Trust-Boundary Document

**Version**: 1.0  
**Status**: Draft — pending external review before stable release  
**Scope**: cherito-bitcoin-payments-sdk v1 (receive-only Lightning payment layer)

---

## 1. System Overview

Cherito is a receive-only Lightning payment layer. It coordinates invoice creation, payment status verification, and event notification. It never signs outgoing payments, manages channels, holds seed phrases, or takes custody of merchant funds.

```
[Payer's wallet]
     │ Lightning network (BOLT11 / BOLT12)
     ▼
[Merchant's LND / CLN node]        ← sovereign, merchant-controlled
     │ HTTPS + pinned TLS + limited macaroon
     ▼
[cherito-payments-gateway]         ← trust boundary B1
     │ Bearer sk_live_...
     ▼
[Merchant backend / WordPress / WooCommerce]  ← trust boundary B2
     │ Bearer cs_... (scoped client secret)
     ▼
[Browser / Static site]            ← untrusted
```

---

## 2. Trust Boundaries

| ID  | Boundary                                        | Direction | Trust Level       |
|-----|-------------------------------------------------|-----------|-------------------|
| B1  | Gateway ↔ LND/CLN REST/gRPC                    | Outbound  | High (pinned TLS + least-privilege macaroon) |
| B2  | Merchant backend ↔ Gateway                      | Inbound   | High (secret API key, server-to-server only) |
| B3  | Browser / static site ↔ Gateway                 | Inbound   | Low (scoped client secret, read-only) |
| B4  | Gateway ↔ Merchant webhook endpoint            | Outbound  | Medium (signed payload, merchant verifies HMAC) |
| B5  | WordPress/WooCommerce ↔ Gateway                 | Inbound   | High (secret API key, server-side only) |

---

## 3. Assets

| Asset                       | Sensitivity | Notes                                              |
|-----------------------------|-------------|-----------------------------------------------------|
| LND/CLN macaroon            | Critical    | Least-privilege invoice-only; never admin macaroon |
| LND TLS certificate         | High        | Used for cert pinning; not a secret itself         |
| Merchant API keys (`sk_live_`) | Critical | SHA-256 hashed in DB; plaintext shown once only   |
| Webhook secrets             | High        | Used for HMAC-SHA256 webhook signing               |
| Client secrets (`cs_`)      | Medium      | Scoped, short-lived (invoice expiry), read-only    |
| Payment intent data         | Medium      | Contains payment hashes, amounts, metadata         |
| SQLite database file        | High        | Contains all payment state; must be encrypted at rest |

---

## 4. Adversary Model

### 4.1 External Attacker (Internet)
- **Capabilities**: Can send arbitrary HTTP requests to the public gateway.
- **Goals**: Steal credentials, forge payment confirmations, inject data, cause denial of service, enumerate invoices.
- **Mitigations**: Rate limiting, strict Zod validation, no `*` CORS, security headers, no credentials in browser-facing responses.

### 4.2 Malicious Payer (Browser)
- **Capabilities**: Can manipulate browser-side code, intercept client secrets, observe SSE events.
- **Goals**: Claim payment success without paying, extract merchant credentials.
- **Key invariant**: Settlement is derived **only** from the Lightning provider callback. Browser cannot influence payment status. Client secrets are read-only and scoped to a single payment intent.

### 4.3 Compromised Merchant Backend
- **Capabilities**: Possesses valid `sk_live_` API keys.
- **Goals**: Access other tenants' data, create fraudulent invoices.
- **Mitigations**: All DB queries are scoped by `tenantId`. Cross-tenant access returns 404 (no data leak). API keys are tenant-bound.

### 4.4 Supply Chain Attacker
- **Capabilities**: May inject malicious code through dependencies.
- **Mitigations**: `package-lock.json` lockfile enforced. Dependency audit in CI. No custom cryptography — only Node.js built-in `node:crypto`.

### 4.5 Insider / Compromised Server
- **Capabilities**: Read access to the SQLite database.
- **Goals**: Extract merchant API keys, redirect funds.
- **Mitigations**: API keys stored as SHA-256 hashes only. Webhook secrets stored; consider encryption at rest for production. Seed phrases and private keys are explicitly forbidden at startup.

---

## 5. Threat Scenarios

### T1: Browser Forges Payment Confirmation
- **Attack**: Client sends a crafted SSE event or POST claiming `state=settled`.
- **Mitigation**: Browser never sends settlement state. Settlement is emitted only after `LightningReceiveProvider.subscribeToInvoice()` receives a terminal state from the node. The gateway does not trust any inbound claim of payment success.
- **Status**: ✅ Mitigated by design.

### T2: Replay Attack on API
- **Attack**: Attacker records a valid Payment Intent creation request and replays it.
- **Mitigation**: Idempotency keys are UUIDs; replay of the same key returns the same intent (idempotent). New keys create new intents. Rate limiting per IP prevents brute-force creation.
- **Status**: ✅ Mitigated.

### T3: Replay Attack on Webhook
- **Attack**: Attacker captures a `payment_intent.succeeded` webhook and replays it to the merchant.
- **Mitigation**: Webhooks include a Unix timestamp in the signed payload. Merchants should reject events where `|now - timestamp| > 300s`. Delivery ID is unique per attempt for merchant-side deduplication.
- **Status**: ✅ Mitigated (merchant must implement tolerance check).

### T4: API Key Enumeration
- **Attack**: Attacker brute-forces `sk_live_` keys.
- **Mitigation**: Keys are 32 random bytes (256 bits of entropy). Timing-safe comparison used. No enumeration endpoint.
- **Status**: ✅ Mitigated.

### T5: SSRF via LND_REST_URL
- **Attack**: Attacker-controlled environment variable points to internal metadata service (e.g., `http://169.254.169.254/`).
- **Mitigation**: (1) URL must be HTTPS. (2) URL is parsed as a `URL` object; relative paths rejected. (3) `ADMIN_MACAROON` and `SEED` variables explicitly forbidden. (4) Deployment guide recommends network-level restrictions.
- **Status**: ⚠️ Partially mitigated — protocol enforcement is done, but IP allowlisting is deployment-level.

### T6: Cross-Tenant Data Leak
- **Attack**: Tenant A's API key is used to read Tenant B's payment intents.
- **Mitigation**: All Payment Intent queries require both `id` AND `tenantId`. A valid key for Tenant A cannot retrieve Tenant B's records (returns 404).
- **Status**: ✅ Mitigated.

### T7: Admin Macaroon Exposure
- **Attack**: Admin macaroon is used instead of limited invoice macaroon.
- **Mitigation**: Gateway refuses known wallet-secret environment-variable names and ambiguous or malformed credential sources. Operators must bake and test a dedicated receive-only macaroon. Cherito cannot infer or cryptographically verify macaroon permissions from a variable name or byte encoding.
- **Status**: ⚠️ Partially mitigated — least privilege remains an operator responsibility.

### T8: Log Injection / Credential Leak via Logs
- **Attack**: Credentials appear in structured log output.
- **Mitigation**: Production call sites construct bounded allowlisted events; automatic request logging and raw bodies are disabled. Nested secret fields are redacted as defense in depth, provider errors become stable categories, and user control characters remain inside one JSON event. Production paths do not use direct `console` output.
- **Status**: ✅ Mitigated.

### T9: Payment Link Amount Override
- **Attack**: Client POSTs to `/v1/pay/:slug` with a manipulated amount.
- **Mitigation**: `/v1/pay/:slug` ignores all client-submitted amounts. The server always reads the amount from the PaymentLink or PricingRule record in the database. The request body is validated but amount fields are ignored.
- **Status**: ✅ Mitigated by design.

### T10: Denial of Service via Invoice Flood
- **Attack**: Attacker creates thousands of invoices to exhaust LND resources.
- **Mitigation**: In-process per-IP rate limiter (configurable via `RATE_LIMIT_CREATE_INVOICE`). Deployment guide recommends nginx/Cloudflare in front. Invoice limits enforced (`MIN_INVOICE_SATS`, `MAX_INVOICE_SATS`).
- **Status**: ⚠️ Partially mitigated — in-process rate limiting is single-instance only.

---

## 6. Security Controls Summary

| Control                          | Location                          | Status  |
|----------------------------------|-----------------------------------|---------|
| Least-privilege macaroon         | Operator bake/verification         | ⚠️       |
| Forbidden env var check          | `config.ts`                       | ✅       |
| API key hashing (SHA-256)        | `api-key-service.ts`              | ✅       |
| Timing-safe key comparison       | `api-key-service.ts`              | ✅       |
| Scoped client secret (read-only) | `payment-intent-service.ts`       | ✅       |
| HMAC-SHA256 webhook signing      | `webhook-service.ts`              | ✅       |
| Webhook timestamp (replay resist) | `webhook-service.ts`             | ✅       |
| Webhook delivery ID (dedup)      | `webhook-service.ts`              | ✅       |
| Cross-tenant query scoping       | `repository.ts`                   | ✅       |
| HTTPS enforcement (LND URL)      | `lnd-rest-provider.ts`            | ✅       |
| TLS cert pinning                 | `lnd-rest-provider.ts`            | ✅       |
| CORS allowlist                   | `server.ts`                       | ✅       |
| Security response headers        | `server.ts` `onSend` hook         | ✅       |
| Log allowlist and redaction      | `logging/safe-logger.ts`          | ✅       |
| Rate limiting (per-IP)           | `server.ts`                       | ✅       |
| Request size limit (16KB)        | `server.ts` Fastify config        | ✅       |
| Schema migration tracking        | `repository.ts`                   | ✅       |
| Recovery after restart           | `payment-intent-service.ts`       | ✅       |
| Idempotency (replay-safe creation) | `repository.ts`                 | ✅       |

---

## 7. Non-Goals (Out of Scope for this Release)

- On-chain payments
- Seed phrase or private key management
- Channel management or liquidity
- Sending Lightning payments
- Multi-signature custody
- Fiat exchange or custody
- Comprehensive WAF / DDoS mitigation (deployment concern)
- Hardware Security Module (HSM) integration

---

## 8. Stable Release Gates (Security)

The following must be satisfied before recommending Cherito for real merchant payments:

- [ ] Threat model reviewed by an independent security reviewer
- [ ] Cryptographic design (key hierarchy, HMAC scheme) reviewed
- [x] Full LND regtest suite passes with settlement verification — `pnpm test:e2e` (see `e2e/README.md`)
- [ ] Network and SSRF controls tested (including IP allowlisting in deployment)
- [ ] Database at-rest encryption guidance documented
- [ ] Vulnerability disclosure process documented and published
- [ ] Dependency audit clean (`npm audit`)
- [ ] Webhook signature verification tested end-to-end

### Regtest gate: what is automated and what is operator policy

**Automated by CI:**

- Every pull request runs the unit suite and the regtest smoke subset (`regtest-smoke` in `ci.yml`).
- Pushes to `main`, a nightly schedule, and `workflow_dispatch` run the full regtest suite
  (`regtest-e2e.yml`). Logs are sanitised of key material before upload.

**Operator policy, not automated:**

- `main` has **no branch protection rule and no active ruleset**, so a green regtest run is not
  mechanically required to merge or to cut a release. Treat the checklist above as a human gate
  until a ruleset marks `regtest-smoke` and `regtest` as required status checks.
- The backup and restore rehearsal is not yet a passing automated scenario; see the known gaps in
  `e2e/README.md`. Restore drills remain a manual procedure documented in `docs/database-recovery.md`.

---

## 9. Vulnerability Disclosure

If you discover a security vulnerability in Cherito, **do not open a public GitHub issue**.

Contact: open a GitHub Security Advisory (private) on the repository, or email the maintainers directly. Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

We aim to respond within 72 hours. Rotate any exposed credentials immediately.

---

## 10. References

- [BOLT11 specification](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md)
- [BOLT12 specification (draft)](https://bolt12.org/)
- [LND REST API documentation](https://lightning.engineering/api-docs/api/lnd/)
- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [NIST SP 800-57: Key Management](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final)
