# Security Policy

Cherito is a receive-only Bitcoin/Lightning payment layer. A defect here can cost a
merchant real money, so security reports are treated as first-class work.

This document explains which code is maintained, how to report a vulnerability
privately, what a good report contains, what is in scope, and what happens after
you report.

---

## 1. Supported versions

Cherito is **pre-release software under active development**. It has no tagged
releases, no published packages, and no long-term support branches.

| Target | Security fixes | Notes |
| ------ | -------------- | ----- |
| `main` | Yes | The only branch that receives security fixes. |
| Feature branches / open PRs | No | Reports are welcome, but fixes land on `main`. |
| Forks and vendored copies | No | Rebase onto `main` to pick up fixes. |

The `1.0.0` version string in the workspace `package.json` files is a placeholder
for internal wiring. It does **not** indicate a released, supported or
production-ready version, and no backport guarantee exists for it.

Because there is no release channel yet, fixes are delivered as commits on `main`.
Anyone running Cherito should track `main` directly and re-deploy after a security
fix lands. When tagged releases begin, this section will be updated with the
concrete supported-version window; until then, please do not read a support
commitment into anything above.

The project has not completed the external security review listed in
[`docs/threat-model.md`](docs/threat-model.md), and is **not recommended for
production merchant payments** yet.

---

## 2. Reporting a vulnerability

**Do not report exploitable vulnerabilities through public GitHub issues, pull
requests, discussions, or any other public channel.** A public issue discloses the
flaw to attackers before merchants can patch, and this project has no release
pipeline to get a fix out ahead of that.

### Private reporting (the only supported route)

Report privately through **GitHub Private Vulnerability Reporting**, which is
enabled on this repository:

**https://github.com/Truja503/cherito-bitcoin-payments-sdk/security/advisories/new**

You can also reach it from the repository's **Security** tab → **Advisories** →
**Report a vulnerability**. A GitHub account is required; the report is visible
only to you and the maintainers, and the discussion thread stays private until an
advisory is published.

There is deliberately **no security email address** for this project. If you find
an address claiming to be a Cherito security contact, it is not maintained by us —
please use the link above instead.

### If you cannot use GitHub advisories

If you are unable to use private reporting, open a public issue that contains
**only** a request for a private channel — no vulnerability details, no affected
endpoints, no proof-of-concept, no logs. A maintainer will open a private advisory
thread and invite you to it.

---

## 3. What to include in a report

The more of this you can provide, the faster the fix. Anything you cannot
determine, just say so.

- **Affected component** — gateway, SDK, checkout widget, provider integration,
  database layer, CI/build, or dependency.
- **Version / commit** — the exact `main` commit SHA you tested, plus branch and
  Node.js version.
- **Description** — what the flaw is and which security property it breaks
  (authentication, tenant isolation, payment integrity, confidentiality).
- **Reproducible steps** — an ordered walkthrough, ideally a minimal
  proof-of-concept, request sequence, or failing test. State the preconditions
  (configuration, provider mode, whether you needed a valid merchant API key).
- **Security impact** — what an attacker gains, what privileges they need to start,
  and whether it crosses a tenant, merchant or funds boundary. If you have a
  severity estimate, include your reasoning.
- **Suggested mitigation** — any fix, configuration change or workaround you know
  of. Optional, and never required.
- **Relevant logs or output** — trimmed to the smallest useful excerpt and
  **redacted of all secrets** (see the prohibition below). Redact rather than omit
  when you can, so the shape of the data is still visible.
- **Prior disclosure** — whether you have already reported this elsewhere, shared
  it with a third party, published it, or filed for a CVE, and any deadline you are
  working to. Say so up front so we can plan coordinated disclosure around it.
- **Credit preference** — the name or handle you want in the advisory, or that you
  prefer to stay anonymous.

---

## 4. Scope

The following areas are in scope. Each names the concrete surface so you can point
at the right code.

| Area | What it covers |
| ---- | -------------- |
| **Merchant API authentication** | `sk_live_` API key generation, hashing, timing-safe verification, revocation, bootstrap key handling, rate limiting, and any way to authenticate without a valid key. |
| **Tenant isolation** | Any path where one merchant reads, modifies or infers another merchant's tenants, keys, pricing rules, intents, invoices or webhook configuration. Cross-tenant authorization bypass is the highest-value bug class in this project. |
| **Lightning provider integrations** | LND REST, LNDK/BOLT12 and the provider abstraction: TLS verification and pinning, macaroon and rune handling, SSRF or internal-network reachability through provider URLs, and trusting unvalidated provider responses. |
| **Payment Intents** | Intent state machine and transitions, idempotency keys, client-secret derivation and hashing, recovery and reconciliation logic, amount and expiry handling, replay, and anything that lets a payment appear settled when it is not. |
| **Webhook verification** | Outbound signing, the HMAC scheme, signature/timestamp validation, replay windows, delivery and retry logic, and secret rotation. |
| **Cryptographic secrets** | `CHERITO_INTENT_SECRET_KEY` and previous-key rotation, secret derivation, key material in memory or on disk, weak randomness, non-constant-time comparison, and secrets reaching logs, errors or backups. |
| **Checkout and browser capabilities** | The checkout widget and client, scoped `cs_` client secrets, CORS and allowed origins, SSE and polling status endpoints, XSS, and any way a browser-side capability escalates beyond read-only status for its own intent. |
| **Database security** | SQLite lifecycle, migrations, backup and recovery paths, file permissions, injection, at-rest exposure of secrets, and data leakage through backups or error messages. |
| **Dependency and supply chain** | Vulnerable or malicious dependencies reachable from Cherito code, `pnpm-lock.yaml` integrity, container build and `Dockerfile` issues, vendored protobuf provenance, and CI workflow injection or secret exposure. |

### Out of scope

- Findings against a **third party's** node, wallet, hosted deployment or merchant
  site that you do not own or have written permission to test.
- Volumetric denial-of-service, load testing, and traffic flooding.
- Missing hardening that has no demonstrated impact (header/version scanners,
  best-practice checklists) without a concrete attack path.
- Vulnerabilities requiring an already-compromised host, root access, or a
  physically present attacker.
- Social engineering of maintainers or users.

If you are unsure whether something is in scope, report it privately and ask.

---

## 5. Never include these in a report

Cherito is non-custodial and never needs your key material. **Do not send, paste,
attach or screenshot any of the following** — not in an advisory, not in a log
excerpt, not in a proof-of-concept:

- Seed phrases or wallet recovery phrases
- Private keys of any kind
- LND macaroons, CLN runes, or other node credentials
- Wallet credentials, node unlock passwords, or backup files containing them
- Production merchant API keys, client secrets, or webhook signing secrets
- Real customer payment data, invoices tied to real payments, or personal data

Describe the credential's **role** instead ("an admin macaroon", "a live
`sk_live_` key for tenant A"), and redact the value. Use a throwaway regtest or
signet setup with disposable credentials for proof-of-concept work.

If a report reaches us containing this material, we will ask you to rotate it
immediately, and the affected content will be removed from the thread. **Sending a
real secret does not make a report more credible — it makes it more dangerous.**

---

## 6. Safe harbor and responsible testing

We will not pursue or support legal action against researchers who make a good
faith effort to follow this policy. That good faith effort means:

- **Test only what is yours.** Use your own deployment, your own node, your own
  merchant account, or a system whose owner has given you explicit written
  authorization. There is no Cherito-operated public test environment — running
  Cherito locally against regtest or signet is the intended way to research it.
- **Do not touch third-party funds or data.** Never attempt to move, redirect,
  intercept or spend bitcoin that is not yours, and never access another merchant's
  or customer's data. If you find a cross-tenant flaw, prove it with your own two
  accounts.
- **Stop at proof.** Once you can demonstrate the vulnerability, stop. Do not
  pivot deeper, escalate further, install persistence, or expand access beyond what
  the demonstration requires.
- **No destructive testing.** No data deletion or corruption, no denial-of-service
  or resource-exhaustion attacks, no degrading service for others.
- **Respect privacy.** Do not access, copy, retain or share personal data or
  payment data. If you encounter it accidentally, stop, do not save it, and tell us
  in the report.
- **Minimize impact.** Prefer the least invasive test that proves the point, and
  work against test data wherever possible.
- **Give us a chance to fix it.** Keep the finding private while we work through
  the process in section 7.

This safe harbor covers this repository and its code. It cannot authorize testing
against systems operated by anyone else — merchants, hosting providers, Lightning
node operators or payment counterparties. Only the owner of those systems can
authorize that, and this policy does not grant it.

---

## 7. What happens after you report

This project is maintained by a small team on a best-effort basis. The timelines
below are the targets we aim for, consistent with
[`docs/threat-model.md`](docs/threat-model.md) — they are **goals, not contractual
guarantees**, and we would rather state that honestly than promise an SLA we cannot
hold. If you have not heard from us within a stated window, please ping the same
advisory thread.

1. **Acknowledgment** — we aim to confirm we received your report within **72
   hours**, in the private advisory thread. This confirms receipt only; it is not a
   verdict on the finding.
2. **Triage** — we reproduce the issue, confirm the affected components and
   commits, and tell you whether we consider it valid and in scope. If we cannot
   reproduce it, we will say what we tried and ask for specifics rather than
   silently closing it.
3. **Severity assessment** — we rate the impact using the guidance in section 8,
   factoring in exploitability, the privileges required, and whether real funds or
   cross-tenant data are reachable. We will share our reasoning, and you are
   welcome to push back if you think we have it wrong.
4. **Remediation** — we develop a fix on a private branch where the severity
   warrants it. Critical findings take priority over all other work. Every security
   fix goes through the normal review and CI gates — an urgent fix is still a
   reviewed fix, and we will not ship an unreviewed patch to move faster. We aim to
   include a regression test with each fix.
5. **Coordinated disclosure** — we publish a GitHub Security Advisory once the fix
   is on `main`, describing the impact, affected commit range and remediation, and
   crediting you as you requested. We will agree a disclosure date with you and
   coordinate around any deadline you are working to. We ask that you hold public
   details until the advisory is out; if a fix is taking longer than expected we
   will tell you why rather than let the thread go quiet. Advisories describe
   fixed issues — we do not publish exploit details for unpatched flaws.

Reports that turn out to be out of scope, already known, or not security-relevant
still get a reply explaining why.

---

## 8. Severity guidance

Ratings depend on exploitability and preconditions as well as impact, but the
following are the finding classes we treat as **potentially critical**. If your
finding looks like one of these, say so prominently in the report:

- **Theft or unauthorized movement of bitcoin** — any path that redirects,
  intercepts or spends funds, or that causes a payout to a destination the merchant
  did not authorize.
- **Exposure of wallet or node credentials** — leaking macaroons, runes, node
  credentials or wallet material through logs, errors, backups, API responses or
  the checkout surface.
- **Cross-tenant authorization bypass** — reading or modifying another merchant's
  data, keys or payments, or acting on their behalf.
- **Forging successful payment state** — making a Payment Intent report as settled,
  paid or succeeded without a real, verified Lightning settlement. This lets an
  attacker take goods without paying, and it is critical even if no bitcoin moves.
- **Bypassing webhook authenticity** — forging a valid signature, replaying a
  delivery, or otherwise convincing a merchant backend that an unauthenticated
  event came from Cherito.
- **Remote code execution** — in the gateway, SDK, checkout widget, container image
  or build pipeline.
- **Extraction of sensitive cryptographic material** — recovering intent secret
  keys, webhook signing secrets, API key material, or client-secret derivation
  inputs, including via timing side channels or weak randomness.

Also treated seriously, typically **high**: authentication bypass on merchant API
endpoints, API key or client-secret leakage, SSRF reaching internal networks or a
node's control interface, injection into the database layer, privilege escalation
from a browser-scoped `cs_` capability, and supply-chain compromise of a dependency
or the release pipeline.

Lower-severity findings — information disclosure without a clear attack path,
missing hardening, and issues needing unrealistic preconditions — are still
welcome, and still get triaged.

---

## 9. Incident response

The sections above cover how a vulnerability reaches us. What maintainers and
operators do once something has actually gone wrong — a leaked credential, a stolen
database, a suspected false settlement, a compromised release — is documented
separately in **[`docs/incident-response.md`](docs/incident-response.md)**.

It contains runbooks for each of those scenarios, the severity and escalation
ladder, an evidence-preservation checklist, incident roles, merchant notification
criteria, the emergency release procedure, and a worked credential-compromise
tabletop exercise.

Two things worth knowing before you need it:

- **A Cherito compromise is a payment-integrity and data incident, not a wallet
  incident.** Cherito never holds seed phrases and never signs outgoing payments,
  and the gateway refuses to start if `ADMIN_MACAROON`, `SEED`, `XPRV` or
  `PRIVATE_KEY` are present in its environment. Runbook 1 covers the exception —
  a node credential that was provisioned with more permission than the policy allows.
- **Several containment actions are not yet automated.** Key revocation, tenant
  disable, webhook rotation and event replay exist only as in-process service
  methods with no operator-facing route. The document marks every such gap as an
  `Implementation dependency` rather than implying the capability exists.

## 10. Related documents

- [`docs/incident-response.md`](docs/incident-response.md) — incident runbooks,
  severity ladder, evidence handling, emergency release and tabletop exercise.
- [`docs/threat-model.md`](docs/threat-model.md) — trust boundaries, attacker
  model, and the security work outstanding before a production recommendation.
- [`docs/database-recovery.md`](docs/database-recovery.md) — database backup and
  recovery procedures.
- [`README.md`](README.md) — deployment and configuration guidance.

Thank you for helping keep Cherito and its merchants safe.
