# Cherito Incident Response Runbooks

Operational procedures for responding to credential compromise, false-settlement
risk, database theft and malicious releases in Cherito.

This document is the incident-response companion to
[`../SECURITY.md`](../SECURITY.md) (how vulnerabilities are reported) and
[`threat-model.md`](threat-model.md) (what the system defends and where the trust
boundaries sit). Database restore mechanics live in
[`database-recovery.md`](database-recovery.md) and are referenced rather than
repeated here.

**Status:** documentation and design level. Several containment steps below depend
on capabilities that are not implemented yet. Those are marked inline as
`Implementation dependency: #NN` and collected in
[section 12](#12-implementation-dependency-register). Nothing in this document
should be read as describing a capability that exists today unless it names a real
command, configuration variable or code path.

**This is project guidance, not a contractual SLA.** Cherito is pre-release
software maintained on a best-effort basis. Timings below are targets that help
responders sequence work, not commitments to any merchant.

---

## Contents

1. [Custody boundary — what an incident can and cannot cost](#1-custody-boundary--what-an-incident-can-and-cannot-cost)
2. [Current containment capabilities](#2-current-containment-capabilities)
3. [Roles](#3-roles)
4. [Severity and escalation](#4-severity-and-escalation)
5. [Evidence preservation checklist](#5-evidence-preservation-checklist)
6. [Runbooks](#6-runbooks)
7. [Merchant notification criteria](#7-merchant-notification-criteria)
8. [Emergency release procedure](#8-emergency-release-procedure)
9. [Tabletop exercise: suspected credential exposure](#9-tabletop-exercise-suspected-credential-exposure)
10. [Post-incident review](#10-post-incident-review)
11. [Related controls in other issues](#11-related-controls-in-other-issues)
12. [Implementation dependency register](#12-implementation-dependency-register)

---

## 1. Custody boundary — what an incident can and cannot cost

Read this before triaging anything. It determines which incidents can lose money
and which cannot.

Cherito is **receive-only and non-custodial**. It never holds seed phrases, never
signs outgoing payments, never manages channels and never takes custody of merchant
funds. `loadConfig` refuses to start if `ADMIN_MACAROON`, `SEED`, `XPRV` or
`PRIVATE_KEY` are present in the environment, so an operator cannot accidentally
hand the gateway wallet-spending material.

The practical consequences during an incident:

| Compromise | Can it move bitcoin? | Primary loss |
| --- | --- | --- |
| Merchant API key | No | Unauthorized intent creation, pricing/config changes, order data |
| Webhook secret | No | Forged fulfillment events to the merchant backend |
| Gateway database or backup | No | Payment metadata, webhook secrets, order mapping |
| Invoice-scoped LND macaroon | No (issue/lookup only) | Invoice forgery, payment metadata, node reconnaissance |
| An **overprivileged** node credential | **Yes** | Funds — treat as SEV-0 immediately |
| Merchant's node itself | **Yes** | Funds — outside Cherito's boundary; escalate to the node operator |

So: **a Cherito compromise is a payment-integrity and data incident, not a wallet
incident** — unless the deployment violated the least-privilege credential policy in
[#18](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/18), or the
merchant's node was compromised independently. Confirm which case you are in during
triage, because it changes severity, notification and whether seed rotation is even
relevant.

---

## 2. Current containment capabilities

What a responder can actually do today, and how.

| Action | Available? | How |
| --- | --- | --- |
| Revoke one merchant API key | Yes, tenant-scoped | `TenantService.revokeApiKey(tenantId, keyId)` → sets `revoked_at`; key lookup filters `revoked_at IS NULL`. **In-process only — no HTTP route.** |
| Issue a replacement API key | Yes | `ApiKeyService.generate(...)`, plaintext returned once |
| Disable a single tenant | Yes | `TenantService.disableTenant(tenantId)` / `enableTenant(tenantId)`. In-process only. |
| Rotate a tenant webhook secret | Yes | `TenantService.rotateWebhookSecret(tenantId)` → current becomes `prev_webhook_secret`, `secret_rotated_at` stamped |
| Sign or verify with the **previous** webhook secret | **No** | `prev_webhook_secret` is persisted but no signing or verification path reads it. See runbook 3. |
| Remove a tenant webhook endpoint | Yes | `TenantService.configureWebhookUrl(tenantId, null)` |
| Replay a specific webhook event | Yes | `WebhookService.replayEvent(tenantId, eventId)`. In-process only. |
| Disable BOLT12/LNDK independently | Yes | `BOLT12_PROVIDER=none` and restart — BOLT11 keeps working |
| Disable BOLT11/LND independently | **No** | `LIGHTNING_PROVIDER` is `z.literal("lnd")` and LND credentials are required at startup. Stopping LND stops the gateway for every tenant. |
| Force reconciliation against the provider | Partially | `PaymentIntentService.reconcile()` runs at startup before the HTTP server binds, and on the `PAYMENT_INTENT_RECONCILIATION_INTERVAL_MS` loop (60s default). **No manual trigger** — a restart is the operator lever. |
| Verify database integrity | Yes | `pnpm db validate`, plus `PRAGMA integrity_check` / `foreign_key_check` at startup |
| Take a consistent backup | Yes | `pnpm db backup --database … --output … --reason …` |
| Restore a backup | Yes | `pnpm db restore --input … --database …` — see [`database-recovery.md`](database-recovery.md) |

> **The most important operational gap:** there is no operator-facing admin API or
> CLI for tenant, key or webhook actions. Every "revoke", "disable" and "rotate"
> above is a `TenantService` / `WebhookService` method reachable only from inside
> the process. Containment today means running a small maintenance script against
> the same database, or a controlled direct SQL update, then restarting.
> **Write the maintenance script before you need it** — an incident is the wrong
> time to author one. No tracking issue covers an operator management API yet; open
> one rather than treating this gap as resolved.

Provider support is narrower than the threat model's diagrams suggest. Today
`LIGHTNING_PROVIDER` accepts only `lnd`, and `BOLT12_PROVIDER` accepts only `none`
or `lndk`. **Core Lightning runes and LNbits/external provider API credentials are
not supported and therefore cannot be configured, leaked from, or rotated in
Cherito.** See runbook 1 for what applies when those land.

---

## 3. Roles

Cherito has no staffed on-call rota. These are **roles, not people** — on a small
team one person may hold several, and that is fine as long as the assignment is
stated explicitly in the incident record at declaration time.

| Role | Owns |
| --- | --- |
| **Incident Lead** | Declares the incident and its severity, keeps the timeline, decides containment vs. evidence trade-offs, decides when the incident is closed. Single decision-maker. |
| **Technical Lead** | Investigation and technical containment: credential rotation, configuration changes, reconciliation, restores, and authoring the fix. |
| **Communications Owner** | All merchant-facing communication, the notification decision under [section 7](#7-merchant-notification-criteria), and status updates. Owns what is said and when. |
| **Release Owner** | Executes [section 8](#8-emergency-release-procedure): review, CI, artifact build, checksums, and publishing the GitHub Security Advisory. |

Rules that hold regardless of who is wearing which hat:

- The Incident Lead is **not** the same person as the reviewer of the emergency fix.
  Urgency does not remove the second pair of eyes (see section 8).
- Advisory publication is the Release Owner's call **only after** the fix is on
  `main`; the Communications Owner does not pre-announce exploitable detail.
- If nobody has claimed Incident Lead, the person who noticed holds it until handed
  over explicitly. Record the handover.

---

## 4. Severity and escalation

Severity drives urgency and notification, not blame. When a finding sits between
two levels, take the higher one until evidence justifies dropping it.

### SEV-0 — Critical

Funds, settlement integrity or broad tenant isolation are at stake.

- Theft or unauthorized movement of bitcoin
- Forged settlement — a Payment Intent reporting `succeeded` without real provider
  settlement
- Exposure of wallet or node-control credentials, or of any credential with send,
  channel or signing permission
- Remote code execution in the gateway, SDK, widget, container or build pipeline
- Broad cross-tenant compromise — data access spanning tenants, or a flaw that lets
  any authenticated merchant reach any other
- Malicious or backdoored release, package or container image

**Response:** declare immediately, all four roles assigned, containment starts
before root cause is understood, emergency release path (section 8) opens in
parallel. Merchant notification is presumed necessary.

### SEV-1 — High

Scoped compromise of one tenant, or a bypass of an authenticity control.

- Tenant-specific authorization bypass
- Merchant API key compromise
- Webhook forgery or signature bypass
- SSRF reaching internal systems, cloud metadata, or a node's control interface

**Response:** declare, assign Incident Lead and Technical Lead at minimum, contain
the affected tenant or path without disrupting others, notify the affected merchant.
Communications Owner is engaged if any merchant data or credential was exposed.

### SEV-2 — Medium

Real security defect with no demonstrated funds, settlement or cross-tenant impact:
information disclosure with a limited blast radius, a control that fails only under
unrealistic preconditions, a hardening gap with a plausible but unproven path.

**Response:** normal review and fix cycle, no emergency release, advisory at the
maintainers' discretion once patched.

### SEV-3 — Low

Defense-in-depth gaps and best-practice deviations with no attack path.

**Response:** ordinary backlog.

### Escalation triggers

Raise severity immediately — do not wait for a scheduled check-in — the moment any
of these becomes true:

- Evidence that funds moved, or that any credential with send permission was exposed
- A second tenant is confirmed affected
- The compromise is confirmed to reach the build, release or deployment pipeline
- Exploitable detail becomes public before a fix is available
- You cannot rule out settlement forgery within the first review pass

---

## 5. Evidence preservation checklist

Collect this before destructive containment where it is safe to do so; when
containment and evidence conflict, **containment wins** and the Incident Lead
records what was lost.

### Always capture

- [ ] **UTC timestamps** for detection, each containment action, and each state
      change. Use UTC everywhere — mixed local time has broken more incident
      timelines than missing data.
- [ ] **Request IDs** for the suspect requests
- [ ] **Affected tenant IDs** (`tnt_…`)
- [ ] **Payment Intent IDs** (`pi_…`) and their status before and after
- [ ] **Payment hashes**, only where operationally required to reconcile against the
      provider
- [ ] **Commit SHA** of the running build
- [ ] **Deployed version / container image digest**
- [ ] **Sanitized logs** — the smallest excerpt that shows the behavior
- [ ] **Provider state evidence** — the authoritative invoice lookup response, with
      the state, amount and settle time
- [ ] **API key prefixes only** (`sk_live_` + the safe prefix), never the key
- [ ] **Database and WAL/SHM files** preserved intact if corruption or tampering is
      suspected, before any restore

### Never place in a ticket, chat, commit, screenshot or advisory

- Seed phrases or wallet recovery phrases
- Private keys
- Plaintext macaroons (or macaroon files/hex)
- CLN runes
- Merchant API keys
- Webhook signing secrets
- Client secrets (`cs_…`)
- Encryption keys, including `CHERITO_INTENT_SECRET_KEY` and any previous key

Refer to a credential by **role and identifier**, never by value: "the invoice
macaroon mounted at `LND_MACAROON_PATH`", "API key `ak_…` for tenant `tnt_…`",
"the webhook secret rotated at `2026-08-09T14:03:00Z`". A responder who needs the
value has the secret manager; a ticket reader does not.

If a secret does reach a ticket or chat: treat it as compromised, rotate it, and
record that rotation in the timeline. **Deleting the message is not rotation.**
Note also that Cherito's own logging redaction is still being hardened
(`Implementation dependency: #22`), so review log excerpts by hand before attaching
them.

---

## 6. Runbooks

Every runbook follows the same shape: **Detect → Contain → Rotate/Repair →
Reconcile → Evidence**. Work top to bottom; do not skip reconciliation because
containment looked clean.

---

### Runbook 1 — Leaked Lightning provider credential

#### 1a. LND macaroon (supported today)

The gateway uses one LND credential for the whole deployment, supplied as
`LND_MACAROON_PATH` (preferred) or `LND_MACAROON_HEX`, with TLS material in
`LND_TLS_CERT_PATH` / `LND_TLS_CERT_BASE64`.

**Detection.** Any of:

- Invoices in the node that Cherito has no corresponding Payment Intent for
- Node API calls from an unexpected source IP, or outside the gateway's usual rate
- The macaroon file appearing in a backup, image layer, log, ticket or chat
- `LND_MACAROON_HEX` visible in a process listing, CI log or crash dump
- Provider auth failures right after an unplanned credential change
- Node logs showing permissions being exercised that Cherito never uses

**Assess scope first — this determines severity.** Under the #18 least-privilege
policy the macaroon is limited to node info, invoice creation and invoice
lookup/subscription, and **cannot spend**. Verify the actual permissions of the
leaked macaroon rather than assuming the policy was followed. If it carries send,
channel-management, signing, seed or wallet-backup permission, this is **SEV-0 with
funds at risk** — escalate to the node operator immediately and treat it as a node
compromise, not just a Cherito incident.

**Containment.**

1. Stop using the credential. Because LND is required at startup and is
   deployment-wide, there is no way to disable BOLT11 while keeping the gateway up
   — see section 2. Choose deliberately between running degraded and stopping the
   gateway, and record the choice.
2. If BOLT12/LNDK is unaffected, leave it alone. Conversely, an LNDK credential leak
   is independently containable with `BOLT12_PROVIDER=none` + restart, which keeps
   BOLT11 serving every tenant.
3. Restrict at the node instead of at Cherito where you can: firewall the LND REST
   endpoint to the gateway host so the leaked credential is unusable from elsewhere.
   This is usually faster than a rotation and buys time.
4. **Do not disable unrelated tenants.** One provider credential is shared by all
   tenants, so provider-side containment is inherently global — that is a reason to
   prefer network restriction over a gateway stop, not a reason to widen the blast
   radius further.

**Rotation.**

1. Bake a new least-privilege macaroon at the node (invoice creation, invoice
   lookup/subscribe, node info — nothing else).
2. Place it in the secret manager and update the mount that `LND_MACAROON_PATH`
   points at. Prefer a mounted file over `LND_MACAROON_HEX`: environment values leak
   through process listings, crash dumps and child processes (#18).
3. Restart the gateway. Startup validates configuration, runs
   `PRAGMA integrity_check` and `foreign_key_check`, and reconciles every
   non-terminal Payment Intent **before** the HTTP server binds — so a restart is
   also a reconciliation.
4. **Invalidate the old macaroon at the node.** Rotating Cherito's copy does nothing
   to the leaked one. For LND this means baking a replacement and revoking/deleting
   the old macaroon's root key at the node; confirm the old credential now fails.
   Until you have confirmed that, the incident is not contained.
5. Rotate the TLS material too if the leak could have included it.

**Recovery.**

- Reconcile **every** non-terminal Payment Intent against authoritative provider
  state. This happens automatically at startup and on the reconciliation loop; the
  scope is `nonTerminalPaymentIntents()`.
- **Do not infer settlement from local cached state.** A stored
  `requires_payment` or `processing` value proves nothing after a credential
  incident. Only a provider invoice lookup may promote an intent to `succeeded`, and
  `applyProviderInvoice` rejects any provider response whose `paymentHash` does not
  match the intent it was fetched for.
- Check the node for invoices created during the exposure window that have no
  matching Payment Intent — those are the attacker's, and any that settled represent
  funds paid to the merchant's node against an order the merchant never recorded.
  Reconcile these with the merchant manually; do not fabricate intents for them.

**Evidence.** Standard checklist (section 5), plus: exposure window start and end in
UTC, the macaroon's actual permission set (describe it — never attach the file),
node-side invoice list for the window, and the confirmation that the old credential
now fails.

#### 1b. Core Lightning rune

**Not supported.** `LIGHTNING_PROVIDER` accepts only `lnd`, so no CLN rune can be
configured in Cherito today and none can leak from it. If a merchant's CLN rune
leaks, that is a node-operator incident: rotate at the node using CLN's own
mechanisms.

When CLN support lands, apply runbook 1a with these substitutions: the credential is
a rune rather than a macaroon; invalidation is `commando-blacklist` at the node
rather than macaroon root-key revocation; and the least-privilege equivalent must be
restricted to invoice and node-info methods.

`Implementation dependency: #15`

#### 1c. LNbits or other external provider API credential

**Not supported.** There is no external-provider adapter, so there is no such
credential in Cherito today.

When it lands, note that the custody classification changes the runbook
fundamentally: a custodial provider credential may allow **withdrawal**, which makes
its exposure SEV-0 with funds at risk — unlike the invoice-scoped macaroon in 1a.
Containment must disable the provider integration and invalidate the credential in
the provider's own dashboard, since revoking Cherito's copy does not revoke the
attacker's.

`Implementation dependency: #16`

---

### Runbook 2 — Leaked merchant API key

**A merchant API key is not a wallet credential.** It authenticates a merchant to
the Cherito API — it cannot spend, cannot reach the node directly, and cannot move
bitcoin. Do not escalate this to a wallet incident, do not tell a merchant to rotate
node credentials because of it, and do not touch seed material. Establish that
distinction with the merchant early; it is the single most common panic in this
class of incident.

Keys are `sk_live_`-prefixed, stored only as SHA-256 hashes (the plaintext is shown
once at creation and is not recoverable), verified in constant time, and revoked
per-key with `revoked_at`.

**Detection.**

- Requests using the key from unexpected origins or at unusual rates
- Payment Intents created for orders the merchant does not recognize
- Pricing rules changed without a corresponding merchant action
- The key appearing in a repository, log, CI output, browser bundle or ticket
- A merchant reporting they found a key somewhere it should not be
- The bootstrap key file at `BOOTSTRAP_KEY_PATH` still readable on disk after
  provisioning

**Containment.**

1. **Identify the tenant and the specific key.** Match on the key ID and safe prefix
   from logs — never on the key value. A tenant may hold several keys.
2. **Revoke only that key** via `TenantService.revokeApiKey(tenantId, keyId)`. The
   call is tenant-scoped (`WHERE id=? AND tenant_id=?`), so it cannot revoke another
   tenant's key even if a wrong ID is passed. Revocation is immediate: subsequent
   lookups filter on `revoked_at IS NULL`.
   - No HTTP route exists for this (section 2) — use the maintenance script.
     `Implementation dependency: operator management API — no tracking issue yet`
3. **Do not revoke the tenant's other keys** unless evidence shows they were exposed
   too. Mass revocation is an outage for that merchant and buys nothing.
4. **Do not touch other tenants.** Nothing about one merchant's key compromise
   implicates another's.
5. Disable the whole tenant (`disableTenant`) only if the merchant asks, or if
   unauthorized activity continues after revocation — that indicates a second
   unrevoked credential or a deeper problem.

**Replacement.**

1. Issue a new key with `ApiKeyService.generate(...)`. The plaintext is returned
   once — deliver it through the merchant's established secure channel, never by
   email, chat or ticket.
2. Have the merchant deploy it and confirm traffic on the new key before you
   consider the rotation done.
3. If the bootstrap key was the leaked one, also confirm the file at
   `BOOTSTRAP_KEY_PATH` has been removed from the host after provisioning.

**Investigation — what did the key actually do?**

Enumerate, scoped to that tenant only:

- Payment Intents created, and whether any reached a terminal state
- Pricing-rule writes: `upsertPricingRule` / `deactivatePricingRule` calls, and
  whether current rules match what the merchant expects. **Confirm this explicitly**
  — an attacker who can set prices can arrange to buy at an attacker-chosen amount,
  which is a quieter and more profitable outcome than creating obvious junk intents.
- Webhook configuration changes — a changed `webhookUrl` redirects a merchant's
  events to the attacker. Verify the endpoint on record is the merchant's.
- Whether any additional API keys were created under the tenant.

Cherito has no tenant-safe audit event stream yet, so this reconstruction currently
depends on application logs and database inspection.
`Implementation dependency: #25`

**Preserve tenant isolation while investigating.** Query with an explicit
`tenant_id` filter, and keep the findings for one tenant out of any other tenant's
communication.

**Reconcile.** If intents were created or mutated, reconcile them against provider
state (runbook 5) before the merchant fulfills anything associated with them.

**Evidence.** Standard checklist, plus: key ID and prefix (never the value), tenant
ID, first and last suspicious request timestamps in UTC, the diff of pricing rules
and webhook configuration across the window, and the revocation timestamp.

---

### Runbook 3 — Leaked webhook secret

The webhook secret lets an attacker **forge events that look authentic to the
merchant's backend** — most damagingly a `payment_intent.succeeded` for an order that
was never paid. It grants no access to Cherito and cannot move funds; the loss is
merchant-side fulfillment of unpaid orders.

Cherito signs deliveries `HMAC-SHA256(secret, "<timestamp>.<body>")` and sends
`cherito-signature: t=<unix>,v1=<hex>`. `WebhookService.verify` enforces a
**300-second** default timestamp tolerance.

**Detection.**

- Merchant reports fulfillment events Cherito has no matching delivery record for
- Deliveries the merchant accepted whose event IDs do not exist in Cherito
- The secret found in a merchant repository, log, ticket or client-side bundle
- Merchant-side order state ahead of Cherito's Payment Intent state
- A spike in merchant fulfillment with no corresponding settled intents

**Containment and rotation.**

1. Rotate with `TenantService.rotateWebhookSecret(tenantId)`. This generates a new
   secret, moves the current one into `prev_webhook_secret`, and stamps
   `secret_rotated_at`.
2. **Understand exactly what the overlap does and does not give you.**
   `prev_webhook_secret` is persisted, but **no signing or verification path in
   Cherito reads it**. Outbound deliveries are signed with the current secret only,
   and `WebhookService.verify` accepts a single secret per call. So rotation is
   effectively a **hard cutover from Cherito's side**: the moment you rotate, every
   delivery is signed with the new secret and a merchant still verifying with the
   old one will reject all of them.
   - The safe sequence is therefore: **give the merchant the new secret and have
     them accept both old and new before you rotate**, by calling their verifier
     twice — once per secret — during the transition, then drop the old one.
     `prev_webhook_secret` exists to support that merchant-side window; Cherito does
     not automate it. Overlapping-rotation support and its tests are
     `Implementation dependency: #19`.
   - Note also that `WebhookService.verify` lives in the gateway and is **not
     exported from `@cherito/bitcoin-sdk`**, so merchants currently implement
     verification themselves against the documented scheme.
3. If the merchant cannot coordinate a window quickly and forged events are actively
   arriving, remove the endpoint entirely with
   `configureWebhookUrl(tenantId, null)`. No deliveries beat forged deliveries.
   Deliveries queue as pending; restore the URL after rotation.
4. Rotate **only the affected tenant's** secret. Webhook secrets are per-tenant.

**Prevent replay during recovery.**

- The 300-second tolerance bounds replay of a captured legitimate delivery. Anything
  older is rejected outright, which is why the merchant must not widen the tolerance
  "to be safe" during an incident — that is the opposite of safe.
- Cherito's retry loop backs off across 7 attempts up to one hour and marks
  exhausted deliveries permanently failed, so a backlog draining after recovery is
  bounded and will not loop indefinitely.
- **Instruct the merchant to make fulfillment idempotent on the Payment Intent ID**
  before you replay anything. Every terminal transition emits exactly one logical
  event, protected by state CAS and the
  `(tenant_id, payment_intent_id, type)` uniqueness constraint — but that guarantee
  is Cherito-side. If the merchant fulfills on every accepted delivery, replays will
  double-fulfill.
- Broader replay-resistance hardening is `Implementation dependency: #21`.

**Verify recent deliveries.** For the exposure window, compare Cherito's event and
delivery records against what the merchant acted on. Any merchant-side fulfillment
with no matching Cherito event is a forged delivery — and is also your best evidence
of the exposure window's true start.

**Replay only what is legitimate, and only after reconciliation.**

1. Reconcile the affected Payment Intents against the provider first (runbook 5).
2. Then replay with `WebhookService.replayEvent(tenantId, eventId)`, which creates a
   new delivery for the **same** event ID.
3. **Do not trust merchant-side fulfillment records to decide what to replay.** They
   are exactly what the attacker was writing to. The authoritative list of events
   that should exist is Cherito's Payment Intent state after provider reconciliation
   — nothing else.

**Evidence.** Standard checklist, plus: rotation timestamp, the delivery/event IDs
in the window, the merchant's list of accepted deliveries, and the reconciled set of
events that legitimately exist.

---

### Runbook 4 — Stolen database or database backup

Be precise about which of two very different incidents you have:

- **Confidentiality compromise** — someone has a copy of the data. The live database
  may be perfectly intact. Restoring does nothing; rotation is the response.
- **Integrity compromise / corruption** — the data itself is wrong or damaged.
  Restoring and reconciling is the response; rotation may be unnecessary.

They can co-occur, but conflating them wastes the first hour. Decide which you have
before acting.

#### Security boundary: what a stolen copy actually reveals

| Data in the database | Exposure if a copy is stolen |
| --- | --- |
| Merchant API keys | **Not exposed** — stored as SHA-256 hashes only |
| Payment Intent client capability secrets | **Not exposed without the application key** — AES-256-GCM encrypted under `CHERITO_INTENT_SECRET_KEY`, which is held outside the database |
| **Webhook signing secrets** | **Exposed** — `webhook_secret` and `prev_webhook_secret` are plaintext columns |
| Legacy status tokens | **Exposed** where present |
| Payment Intents, amounts, statuses, timestamps | Exposed |
| Merchant order IDs and order mapping | Exposed |
| Tenant configuration and pricing rules | Exposed |
| Webhook endpoints, events, delivery attempts | Exposed |
| **Seed phrases, private keys, admin macaroons** | **Never present** — the backup scanner refuses schemas containing them |

**The headline: a stolen database yields every affected tenant's webhook signing
secret, but no API keys and no wallet material.** Treat every webhook secret in the
stolen copy as compromised.

**Detection.** Unexpected access to the database volume, backup bucket or host; a
backup artifact in the wrong location or with unexpected permissions; a manifest
SHA-256 that does not match; a snapshot or image shared beyond its intended
audience; `pnpm db validate` or startup `integrity_check` failing.

**Containment.**

1. Revoke access to the storage location and rotate the credentials that allowed the
   copy (cloud storage keys, SSH keys, backup-tool credentials).
2. Determine **which database version** was taken, and therefore which schema and
   which sensitive columns existed in it. An older backup may predate encrypted
   capability storage and expose more; a newer one may contain tenants an older one
   did not. Use the manifest's schema version and creation time rather than guessing.
3. Establish exactly which tenants appear in the stolen copy — notification scope
   depends on it.

**Rotation.** Rotate what the copy actually exposed, not everything:

- **Webhook signing secrets for every tenant in the copy** — mandatory, they were
  plaintext. Follow runbook 3's coordination sequence per tenant.
- **Legacy status tokens** present in the copy.
- **`CHERITO_INTENT_SECRET_KEY`** — required if the key could have been taken
  alongside the database (same host, same snapshot, key stored beside the backup),
  because that combination decrypts capability secrets. Use
  `CHERITO_INTENT_SECRET_PREVIOUS_KEYS` to keep existing records readable during the
  transition. If the key was in a separate secret manager and provably not included,
  rotation is not required — record that reasoning.
- **Merchant API keys** — not strictly required, since only hashes were exposed.
  Rotate if the merchant requests it or if you cannot establish what else the
  attacker reached.
- **Provider credentials** — only if they were on the same host or in the same
  snapshot. The database itself does not contain them.

**Do not rotate Bitcoin seed phrases.** Cherito never stores them and the backup
scanner refuses any schema that contains them, so a database theft is not wallet
exposure. Rotate seeds **only** if there is independent evidence that actual wallet
secrets were exposed — which would be a node incident, not a Cherito one. Seed
rotation is expensive, disruptive and irreversible; do not perform it reflexively.

**Restore — only when integrity is suspect.**

1. Stop all gateway instances and prevent writes.
2. Preserve the failed database plus its `-wal` and `-shm` files for forensics.
3. Restore the newest verified backup to a **new** path with `pnpm db restore`,
   which validates manifest format, size, SHA-256 checksum, schema compatibility,
   SQLite integrity, foreign keys, prohibited fields and pending migrations.
4. If validation fails, work backward through older backups until one passes.
5. Full mechanics are in [`database-recovery.md`](database-recovery.md); follow it
   rather than improvising.

**Validate integrity.** `pnpm db validate`, plus the `PRAGMA integrity_check` and
`PRAGMA foreign_key_check` that run at startup and during maintenance.

**Reconcile after any restore.** A restored database is stale by definition. On
startup Cherito queries the provider for every non-terminal Payment Intent with
bounded concurrency, applies only monotonic transitions, and persists one logical
terminal event each. **A restored `requires_payment` or `processing` value is never
authoritative** — only provider reconciliation may promote it to `succeeded`.
Confirm reconciliation completed and the pending count settled before restoring
traffic.

**Evidence.** Standard checklist, plus: backup manifest (format version, schema
version, creation time, SHA-256, reason), the storage access log for the window,
the tenant list contained in the copy, and the rotation decision and its reasoning
for each credential class above.

---

### Runbook 5 — Suspected false settlement or payment-state corruption

**This is the incident class Cherito exists to prevent.** A false `succeeded`
means a merchant ships goods for a payment that never arrived. Treat any credible
report as SEV-0 until provider evidence says otherwise.

**Detection.**

- A merchant reports fulfilling an order with no corresponding received payment
- A Payment Intent is `succeeded` with no matching settled provider invoice
- Merchant-side order state runs ahead of Cherito's state
- Amounts on an intent disagree with the provider invoice
- Terminal states appearing without a corresponding webhook event record
- An unexplained cluster of settlements in a narrow window

**Immediate containment.**

1. **Freeze merchant fulfillment** for the affected intents — the merchant pausing
   shipment is the only action that stops loss accruing while you investigate. Ask
   for it first, before you understand the cause.
2. Scope it: one tenant, one time window, or one payment path if you can bound it.
   A deployment-wide freeze is justified only if the mechanism is unknown and the
   pattern spans tenants.
3. Preserve state before repairing anything — take a backup with
   `pnpm db backup --reason incident-<id>`.

**Authority — what may and may not decide that a payment settled.**

**Only an authoritative provider invoice lookup may establish settlement.** None of
the following is settlement evidence, individually or in combination:

- Browser or checkout-widget state
- SSE status stream messages
- A webhook delivery, including one with a valid signature
- The local database's stored status
- A merchant's order record
- A payer's screenshot or claim

The whole point of the design is that the browser cannot authorize fulfillment.
During an incident, that principle is what you fall back on.

**Investigate.**

1. For each suspect intent, query the provider directly for the invoice by payment
   hash.
2. Compare, field by field:
   - `paymentHash` — must match the intent. `applyProviderInvoice` throws on a
     mismatch, and a mismatch found here is itself a serious finding.
   - `providerInvoiceId` / invoice identity
   - **amount** — an amount disagreement is as serious as a status disagreement
   - **status** — provider state versus stored status
   - settle time versus the intent's `settledAt`
3. Build the affected set: intents where stored status is ahead of provider truth
   (the dangerous direction — Cherito claims paid, provider disagrees), and intents
   where it is behind (the safe direction — reconciliation fixes it).
4. Ask which is true: a genuine gateway defect, a forged webhook accepted by the
   merchant (runbook 3), or a merchant-side integration bug. All three present as
   "false settlement" from the merchant's side, and the fix differs completely.

**Repair — monotonic transitions only.**

- Cherito's transition table is strictly monotonic and `succeeded` is terminal with
  **no outbound transitions at all**:
  - `requires_payment → processing | succeeded | expired | failed | canceled`
  - `processing → succeeded | expired | failed | canceled`
  - `succeeded → ∅`
- **There is deliberately no supported path to un-succeed a Payment Intent.** If an
  intent is wrongly `succeeded`, the repair is a merchant-side reversal decision
  plus a code fix — not a database edit that rewrites history. Any direct SQL
  correction must be recorded in the incident timeline with the evidence that
  justified it, and reviewed by someone other than whoever ran it.
- **Never mark a payment `succeeded` manually.** Not from a merchant's assurance,
  not from a webhook, not to clear a backlog. Let reconciliation promote it from the
  provider's answer, or leave it alone. If reconciliation will not promote it, that
  is information — the payment did not settle.
- Intents behind provider truth need no manual action: reconciliation applies the
  correct transition on the next loop or at restart.

**Prevent duplicate fulfillment.** Each terminal transition emits exactly one
logical event, guarded by state CAS and the
`(tenant_id, payment_intent_id, type)` uniqueness constraint, so repeated recovery
cannot manufacture a second settlement event. Confirm the merchant deduplicates on
Payment Intent ID before unfreezing.

**Replay only after reconciliation.** Once provider truth is established and state
is consistent, replay the legitimate events with `replayEvent`. Never replay to
"push through" a state you could not verify.

**Record the timeline.** For this runbook the timeline is a deliverable, not
paperwork — it is what tells the merchant which orders to trust. Capture in UTC:
first affected intent, detection, freeze, provider queries and their answers, each
repair, unfreeze, and the final reconciled list of genuinely settled intents.

**Evidence.** Standard checklist, plus the provider lookup response for every
affected intent (this is the authoritative record — keep it), the before/after
status of each intent, and the pre-repair backup path.

---

### Runbook 6 — Compromised package, container or release

**Containment.**

1. **Stop publishing and deploying the affected artifact immediately.** Halt
   release workflows and any automated deployment that would pull it.
2. **Revoke the CI and release credentials** that could have produced it: registry
   tokens, package tokens, deploy keys, and any GitHub Actions secret in scope.
   Assume every secret the compromised job could read is compromised.
3. **Disable the compromised automation** — the workflow, the runner, or the
   integration — rather than trying to patch it live.
4. Warn against deploying the affected version before you know the full story;
   a holding notice beats a silent gap.

**Investigation.**

1. Identify the affected commit and artifact range: the last known-good commit, the
   first bad one, and every artifact built between them.
2. Inspect what build provenance exists. Cherito's CI currently runs install, lint,
   build, typecheck and tests only — **there is no SBOM, no signing, no build
   attestation, no dependency scanning and no secret scanning today**, so provenance
   evidence is limited to workflow run logs and commit history.
   `Implementation dependency: #23`
3. Compare the trusted commit SHA against the artifact: rebuild from the known-good
   commit and diff the output against the published artifact. Differences that are
   not explained by build nondeterminism are your finding.
4. **Do not claim reproducible builds.** Cherito does not provide them. A rebuild
   diff is evidence to interpret, not proof — expect benign differences from
   timestamps and build metadata, and reason about what a difference means rather
   than treating any diff as compromise or any match as clearance.
5. Check whether vendored material was touched — the LNDK protobuf files have
   recorded provenance in `apps/cherito-payments-gateway/proto/PROVENANCE.md`;
   automated verification of it is part of #23.
6. Review the lockfile diff across the range for substituted or newly introduced
   dependencies.

**Recovery.**

1. Fix from known-good source, never by patching the compromised artifact.
2. **Require peer review.** A supply-chain incident is precisely when an unreviewed
   commit is most dangerous.
3. Run full CI — lint, build, typecheck, tests — plus whatever dependency and
   secret scanning is available at the time.
4. Rebuild the artifact from clean source on clean infrastructure with fresh
   credentials.
5. Publish a new patched release. Follow [section 8](#8-emergency-release-procedure).
6. **Publish SHA-256 checksums** for downloadable artifacts so users can verify what
   they install. Checksum, SBOM and provenance publishing are not yet automated:
   `Implementation dependency: #23`
7. Publish a GitHub Security Advisory naming affected versions, the compromise
   window, how to verify what a user installed, and what they must do.

**Disclosure discipline.** State the affected version range, the window and the
required user action. **Do not publish exploit details for anything still
unpatched**, and do not include the malicious payload or a working reproduction in
the advisory.

**Evidence.** Standard checklist, plus: affected commit and artifact range, workflow
run IDs, registry publication timestamps, the rebuild comparison result, and the
list of credentials revoked with their revocation times.

---

### Runbook 7 — SSRF or internal network exposure

Cherito makes outbound requests to two attacker-influenceable classes of
destination: **tenant-configured webhook URLs** and **operator-configured provider
URLs** (`LND_REST_URL`, `LNDK_GRPC_URL`). Webhook URLs are the higher risk because
merchants control them.

`validateWebhookUrl` rejects non-`http(s)` protocols and resolves the hostname,
blocking `127.0.0.0/8`, `10.0.0.0/8`, `172.16–31.0.0/12`, `192.168.0.0/16` and
`169.254.0.0/16` (cloud metadata). Two known limitations to keep in mind while
investigating: **IPv6 ranges are not covered**, and the check resolves DNS before
the request, leaving a rebinding window between validation and connection.

**Detection.** Outbound connections to internal ranges, cloud metadata endpoints or
the node's control interface; webhook configuration attempts that fail SSRF
validation in a pattern suggesting probing; unexpected internal service access logs;
a webhook endpoint pointed at an internal hostname; unusual DNS resolution behavior
for a configured endpoint.

**Containment.**

1. Remove the offending webhook configuration —
   `configureWebhookUrl(tenantId, null)` — which stops deliveries to that
   destination without disturbing other tenants.
2. If the vector is a provider URL, correct the configuration and restart.
3. Block the destination at the network layer if requests are still in flight.
4. Restrict egress from the gateway host to the destinations it genuinely needs
   (the LND endpoint, LNDK if enabled, merchant webhook endpoints). Egress control
   is the durable fix; the URL validator is one layer.

**Investigation.**

1. Enumerate every destination actually contacted during the window — not just the
   configured URL, since redirects and rebinding can change the real target.
2. Determine specifically whether **cloud metadata services** (`169.254.169.254`)
   or **node control interfaces** were reachable. These are the two outcomes that
   turn an SSRF into a credential incident.
3. Establish whether responses were returned to the attacker or merely triggered
   blind. A blind SSRF that reached metadata but returned nothing is materially less
   severe — but only if you can actually demonstrate nothing was returned.
4. Check whether the same path could reach the LND REST endpoint, which would expose
   node interaction using the gateway's network position.

**Rotate only what the exposure justifies.** If metadata was reachable **and**
responses were returned, rotate the cloud instance credentials it would have served.
If node interfaces were reachable, apply runbook 1. If the SSRF was blind and no
sensitive destination responded, rotation may not be warranted — record the
reasoning rather than rotating reflexively or skipping silently.

**Patch.** Fix the URL validation for the specific bypass, add a regression test for
it, and consider the two known limitations above. Transport and network-boundary
hardening was addressed in
[#20](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/20); a bypass
found now is a regression against it and should reference it.

**Review logs safely.** Outbound-request logs may contain URLs with credentials in
query strings or userinfo. Sanitize before attaching anything to a ticket, and never
paste a raw metadata-service response — it may itself be a credential.

**Evidence.** Standard checklist, plus: the configured URL as recorded, the
destinations actually contacted, DNS resolution results, whether responses were
returned, and the tenant that owned the configuration.

---

### Runbook 8 — Cross-merchant / cross-tenant data access

Tenant isolation is a core invariant: one merchant must never reach another's data.
A confirmed breach of it is SEV-1, or SEV-0 if it is broad or trivially exploitable.

**Detection.** A merchant reporting data that is not theirs; queries or responses
containing a tenant ID that does not match the authenticated tenant; a Payment
Intent or pricing rule accessed under the wrong tenant; a report from a researcher;
test failures in the tenancy suite.

**Containment.**

1. Disable the affected API path if the flaw is reachable and you cannot fix it
   within the hour. An unavailable endpoint beats a leaking one.
2. Revoke the attacker's API credential (runbook 2), scoped to their tenant.
3. Disable the attacking tenant with `disableTenant(tenantId)` if abuse continues.
4. **Do not disable the victim tenant.** They did nothing wrong and disabling them
   compounds the harm.

**Identify the tenants involved.** Establish the attacking tenant ID, every victim
tenant ID, and the specific records reached. Be exact: notification scope and the
merchants' own obligations depend on this list being right.

**Protect victim confidentiality during the investigation.** This is easy to get
wrong under pressure:

- **Never disclose one merchant's identity, data or volume to another.** Not to the
  attacker, and not to another victim.
- When communicating with the attacking tenant — including if they turn out to be a
  well-meaning researcher who stumbled into it — describe what they accessed
  **without confirming whose data it was**.
- Keep per-tenant findings in separate records; do not circulate a combined list.
- Scope every investigative query by explicit tenant ID, and be careful that the
  investigation itself does not become a second cross-tenant exposure.

**Determine read versus write.** This drives everything downstream:

- **Read only** — a confidentiality incident. Establish what was read and notify.
- **Write or mutation possible** — an integrity incident too. Determine whether
  pricing rules, webhook configuration, Payment Intents or API keys were modified
  under the victim tenant, and reconcile.

If you cannot conclusively rule out mutation, treat it as mutation.

**Reconcile.** Where mutation was possible, reconcile the victim's affected Payment
Intents against provider state (runbook 5) before they fulfill anything, and
diff their pricing rules and webhook configuration against what they expect.

**Notify.** Every confirmed victim is notified — cross-tenant access is on the
mandatory list in [section 7](#7-merchant-notification-criteria). Tell each merchant
what of *theirs* was accessed, whether it was modified, and what they should do. Do
not tell them about other victims.

**Evidence.** Standard checklist, plus: attacking and victim tenant IDs held
separately, the request IDs and endpoints used, the specific records reached, the
read/write determination and how you reached it, and the credential revocation
timestamp.

---

## 7. Merchant notification criteria

The Communications Owner owns the decision and the message. Notify affected
merchants — do not wait for a fix — when any of these is confirmed:

- **Their credentials were exposed** — API key, webhook secret, or client secrets.
  Include what to rotate and how.
- **Their data was exposed** — Payment Intents, order mapping, configuration,
  including via a stolen database or backup.
- **False settlement is possible for their orders.** Notify on *possible*, not
  confirmed: a merchant who might be shipping unpaid orders needs to know now.
- **Cross-tenant access touched their data**, in either direction.
- **A malicious or compromised release affects them** — with the affected version
  range and how to verify what they are running.
- **They must act**: rotate a credential, upgrade, or change configuration.

Also notify, with less urgency, when a fix changes behavior they depend on, or when
an advisory naming a version they run is about to publish.

**What a notification contains.** What happened in plain terms; what of theirs was
affected; what they must do and by when; what Cherito has already done; who to
reply to. Send it through the merchant's established channel.

**What it never contains.** Exploitable detail before remediation; any secret value,
including one being rotated; another merchant's identity or data; speculation
presented as fact. If scope is still unknown, say that it is under investigation and
give a time for the next update — an honest partial update beats a delayed complete
one.

**Sequencing against public disclosure.** Affected merchants are told before the
public advisory. The advisory publishes once the fix is on `main`. If details leak
before the fix is ready, notify merchants immediately with mitigation guidance
rather than waiting for the planned sequence.

---

## 8. Emergency release procedure

For SEV-0 and SEV-1 fixes. Owned by the Release Owner.

**Urgency does not bypass code review or CI.** An unreviewed emergency patch to a
payments system can easily be worse than the bug — a rushed fix to a settlement path
can forge settlements as effectively as an attacker. Every step below runs even when
the incident is live. If a step genuinely cannot run, the Incident Lead records
which one and why; nobody silently skips one.

1. **Private fix branch.** Develop on a private branch or in the private fork
   attached to the GitHub Security Advisory, so the fix does not disclose the flaw
   before release. Keep commit messages free of exploit detail.
2. **Peer review.** At least one reviewer who is not the author. Review the fix, its
   test, and its blast radius.
3. **Tests** — `pnpm test`. Include a regression test that fails before the fix and
   passes after.
4. **Lint** — `pnpm run lint`.
5. **Typecheck** — `pnpm run typecheck`.
6. **Build** — `pnpm run build`.
7. **Dependency and security checks where available.** Run whatever exists at the
   time; today CI covers install, lint, build, typecheck and tests only.
   Dependency scanning, secret scanning, SAST and license checks are
   `Implementation dependency: #23`. Note in the incident record which checks were
   unavailable — do not imply coverage that did not run.
8. **Merge to `main`** once review and checks pass. `main` is the only branch that
   receives security fixes (see [`../SECURITY.md`](../SECURITY.md)).
9. **Build the patched artifact** from the merged commit, on clean infrastructure.
   For a supply-chain incident, use fresh credentials.
10. **Publish SHA-256 checksums** for every downloadable artifact, alongside the
    commit SHA it was built from. Automated checksum, SBOM and provenance publishing
    are `Implementation dependency: #23`.
11. **Publish the GitHub Security Advisory** — impact, affected commit range, fixed
    version, required user action, and credit to the reporter as they requested. No
    exploit details for anything still unpatched.
12. **Notify affected users** per [section 7](#7-merchant-notification-criteria),
    before or simultaneously with the advisory, never after.

Cherito has no tagged releases or published packages yet, so "publish a patched
release" currently means a commit on `main` plus an advisory. Redeploy from `main`
to pick up security fixes. When tagged releases begin, steps 9–11 gain real
artifacts and this section should be revisited.

---

## 9. Tabletop exercise: suspected credential exposure

A documented walkthrough satisfying issue #28's tabletop requirement, completed at
**documentation and design level**. It was executed on paper against the current
implementation to find gaps — not against a running deployment.

**All credentials below are fabricated examples.** No real secret appears in this
document, and none may be added to it. Values are truncated placeholders, not
working credentials.

### Scenario

> A merchant reports that their integration repository was briefly public. Two
> credentials may be exposed: their Cherito merchant API key
> (`sk_live_EXAMPLE…`, key ID `ak_EXAMPLE`, tenant `tnt_EXAMPLE`) and a
> **limited invoice-scoped LND macaroon** used by the deployment. Exposure window is
> roughly 40 minutes. There is no evidence yet of misuse.

### Walkthrough

**1. Detection.** Merchant report at `2026-08-09T09:12:00Z`. Corroborate before
acting: check requests on `ak_EXAMPLE` for unfamiliar origins or rate changes, and
the node for invoices without matching Payment Intents. Record the window as
reported and refine it later — the true window is often wider than the reported one.

**2. Severity.** Start at **SEV-1**. Two credentials, one tenant, no confirmed
misuse. Then check the escalation triggers explicitly:

- Does the macaroon carry send, channel, signing or seed permission? Under the #18
  policy it should be invoice-scoped only. **Verify rather than assume** — if it is
  overprivileged, this is immediately **SEV-0 with funds at risk**.
- Is more than one tenant implicated? No — the API key is tenant-scoped. But the
  macaroon is deployment-wide, so provider-side containment will affect all tenants.

Exercise outcome: **SEV-1**, holding, with an explicit note that the macaroon
permission check gates escalation to SEV-0.

**3. Containment.** Assign roles and record who holds each. Then:

- API key: revoke `ak_EXAMPLE` only. Leave the tenant's other keys and every other
  tenant alone.
- Macaroon: prefer restricting the LND REST endpoint at the network layer to the
  gateway host — it is faster than rotation and avoids a gateway stop. Do not stop
  the gateway for a scoped, unconfirmed exposure.

> **Gap found:** revocation has no HTTP route; it is an in-process
> `TenantService.revokeApiKey` call. The exercise required assuming a maintenance
> script exists. **Action: write and test that script before it is needed.**

**4. Credential revocation.** `TenantService.revokeApiKey('tnt_EXAMPLE', 'ak_EXAMPLE')`
— tenant-scoped, so a wrong ID cannot affect another tenant. Confirm the key now
fails authentication rather than assuming the write landed. For the macaroon, bake a
replacement and **invalidate the old one at the node**; confirm the old credential
is rejected. Rotating Cherito's copy alone leaves the leaked credential live — the
exercise flagged this as the step most likely to be skipped under pressure.

**5. Replacement.** Issue a new key with `ApiKeyService.generate(...)`; the plaintext
appears once. Deliver it through the merchant's established secure channel — not
email, chat or the incident ticket. Update `LND_MACAROON_PATH` to the new mounted
macaroon and restart. Confirm merchant traffic on the new key before declaring the
rotation complete.

**6. Payment Intent reconciliation.** The restart reconciles every non-terminal
intent against provider state before the HTTP server binds. Verify completion in the
logs; do not assume it ran. Check the node for invoices created during the window
with no matching Payment Intent. **No intent is promoted to `succeeded` without a
provider lookup**, and no intent is edited by hand.

**7. Webhook verification.** The tenant's webhook secret was *not* in the exposed
repository, so no rotation is required — record that reasoning rather than rotating
reflexively. Still verify that `webhookUrl` for `tnt_EXAMPLE` is unchanged: an
attacker with the API key could have repointed it, which is a quiet and easily
missed outcome. Compare deliveries in the window against merchant-side fulfillment.

**8. Evidence preservation.** Apply the section 5 checklist: UTC timestamps, request
IDs, `tnt_EXAMPLE`, affected `pi_…` IDs, running commit SHA and image digest,
sanitized logs, provider lookups, and the macaroon's permission set **described, not
attached**. Key prefixes only. No credential value in any artifact.

**9. Merchant notification decision.** Notify — their credentials were confirmed
exposed and they must act (section 7). Content: what was exposed, that the key is
revoked and replaced, that no misuse was found (if that holds), the macaroon
rotation, and what they must do. Do not mention other tenants. Because the macaroon
is deployment-wide, decide whether other merchants need an operational notice about
the restart even though their data was not exposed.

**10. Post-incident review.** Within a week, per [section 10](#10-post-incident-review).

### Findings from this exercise

| # | Finding | Action |
| --- | --- | --- |
| 1 | No operator-facing route for key revocation, tenant disable or webhook rotation | Write and test a maintenance script; open an issue for an operator management API |
| 2 | Rotating Cherito's credential copy does not invalidate the leaked one | Made an explicit, separately confirmed step in runbook 1 |
| 3 | LND is deployment-wide, so provider containment cannot be scoped to one tenant | Documented in section 2; prefer network-layer restriction |
| 4 | No manual reconciliation trigger — restart is the only lever | Documented in section 2; `Implementation dependency: #7` for richer recovery controls |
| 5 | Reconstructing "what did this key do" relies on ad-hoc log and DB inspection | `Implementation dependency: #25` (tenant-safe audit events) |
| 6 | Webhook secret overlap is stored but not honored by any verification path | Documented in runbook 3; `Implementation dependency: #19` |

### Completion checklist

- [x] Scenario defined with fake credentials only
- [x] Detection walked through
- [x] Severity assessed against the section 4 criteria, with escalation triggers checked
- [x] Containment walked through, without over-broad tenant or provider impact
- [x] Credential revocation walked through for both credential classes
- [x] Replacement and secure delivery walked through
- [x] Payment Intent reconciliation walked through against provider truth
- [x] Webhook verification walked through, including the rotate/no-rotate decision
- [x] Evidence preservation applied, with no real secrets used
- [x] Merchant notification decision reached against section 7
- [x] Post-incident review scheduled
- [x] Gaps recorded with owners or dependency issues
- [ ] **Exercise repeated against a running regtest deployment** —
      `Implementation dependency: #26`
- [ ] **Operator maintenance script for revocation written and tested** — no
      tracking issue yet

The two unchecked items are deliberately unchecked: this exercise validates the
*procedure*, not the *runtime capability*. Do not mark them complete until they are
genuinely done.

---

## 10. Post-incident review

Hold within one week of closing any SEV-0 or SEV-1. The Incident Lead runs it.

Cover: the UTC timeline from first exposure to closure; how it was detected and
whether it could have been detected sooner; what worked and what did not; whether
containment was appropriately scoped, or too broad or too narrow; whether any secret
reached a ticket, chat or commit and was subsequently rotated; whether merchants
were notified correctly and in time; and every gap found, with an owner and a
tracking issue.

Reviews are **blameless**. A procedure that only works under ideal conditions is a
procedure that will fail during the next incident — surfacing that is the point.

Update this document as part of the review, not afterwards. If a runbook was wrong,
missing or unusable under pressure, fix it while the incident is fresh.

---

## 11. Related controls in other issues

This document coordinates controls implemented elsewhere; it does not reimplement
them.

| Issue | Status | Controls relied on here |
| --- | --- | --- |
| [#17](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/17) | Closed | Threat model, trust boundaries, adversary model — [`threat-model.md`](threat-model.md) |
| [#18](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/18) | Closed | Least-privilege node credentials, secret handling, refusal to start with `ADMIN_MACAROON`/`SEED`/`XPRV`/`PRIVATE_KEY` |
| [#19](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/19) | **Open** | Key hierarchy and rotation lifecycle, overlapping webhook-secret and API-key rotation |
| [#20](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/20) | Closed | SSRF defenses and network boundaries — runbook 7 |
| [#23](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/23) | **Open** | Supply-chain and CI controls, secure release, SBOM, checksums, provenance — runbook 6 and section 8 |
| [#24](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/24) | Closed | Migrations, backups, restore and post-restore reconciliation — [`database-recovery.md`](database-recovery.md) |
| [#5](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/5) | Closed | Merchant API keys and scoped client tokens — runbook 2 |
| [#8](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/8) | Closed | Signed, retryable, idempotent webhooks — runbook 3 |

---

## 12. Implementation dependency register

Every capability this document references that does not fully exist today. Keep this
table honest — it is the difference between a runbook and a wish.

| Dependency | Blocks | Issue |
| --- | --- | --- |
| Core Lightning provider and rune handling | Runbook 1b — no CLN credential exists in Cherito today | [#15](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/15) |
| External provider adapter with custody classification | Runbook 1c — no LNbits/external credential exists today; custody class changes severity | [#16](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/16) |
| Overlapping webhook-secret and API-key rotation, with tests | Runbook 3 — `prev_webhook_secret` is stored but no signing or verification path reads it | [#19](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/19) |
| Replay-resistance and abuse-control hardening | Runbook 3 — replay prevention during recovery | [#21](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/21) |
| Safe-logging and redaction guarantees | Section 5 — log excerpts need manual review before attaching | [#22](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/22) |
| Dependency scanning, secret scanning, SAST, SBOM, checksums, provenance, signed releases | Runbook 6 and section 8 steps 7 and 10 | [#23](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/23) |
| Tenant-safe audit events | Runbook 2 and runbook 8 — reconstructing what a credential did | [#25](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/25) |
| Regtest end-to-end and failure-injection coverage | Section 9 — running the tabletop against a live deployment | [#26](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/26) |
| Manual reconciliation trigger and richer recovery controls | Section 2 — restart is currently the only operator lever | [#7](https://github.com/Truja503/cherito-bitcoin-payments-sdk/issues/7) |
| **Operator management API or CLI** for key revocation, tenant disable, webhook rotation and event replay | Runbooks 2, 3, 5, 8 — every containment action is in-process only | **No tracking issue yet — open one** |

When a dependency lands, update the runbook that references it and remove the row.
A stale register is worse than none: it teaches responders to ignore the warnings.
