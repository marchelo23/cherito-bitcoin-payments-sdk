# Cherito regtest end-to-end suite

This suite proves the Cherito payment flow against **real Bitcoin and Lightning software** on a
disposable regtest network. Nothing here mocks a Lightning provider, and no test writes settlement
state directly into the Cherito database.

## One command

```bash
pnpm test:e2e
```

That single command builds and starts the topology, initialises the chain, funds nodes, opens a
channel, boots the gateway and a merchant webhook receiver, runs the suite, collects logs on
failure, and tears everything down. It is idempotent: it removes any previous environment first,
so running it twice in a row needs no manual Docker cleanup.

Useful variants:

| Command | Purpose |
|---|---|
| `pnpm test:e2e` | Full suite (default) |
| `pnpm test:e2e:smoke` | Fast subset used on pull requests |
| `pnpm --filter @cherito/e2e run test:e2e -- --suite maintenance` | Backup and restore rehearsal (see known gaps) |
| `pnpm regtest:up` | Start the environment and leave it running |
| `pnpm regtest:down` | Remove containers, volumes and networks |

Suite files run **sequentially, one Node process per file, in a declared order**. Destructive
scenarios run last, and a failure in one file cannot cascade into the next.

Add `--keep` to leave the environment running after a failure for interactive debugging.

## Requirements

- Docker with the Compose v2 plugin
- Node.js 22.5 or newer, pnpm 10 or newer
- Roughly 4 GB of free RAM and 10 GB of disk for images and chain data

On macOS without Docker Desktop, [Colima](https://github.com/abiosoft/colima) works:

```bash
brew install colima docker docker-compose qemu
colima start --cpu 4 --memory 8 --disk 60
```

## Topology

`docker-compose.regtest.yml` defines an isolated project (`cherito-e2e`) with its own network and
volumes. Nothing is shared with `docker-compose.yml` or `docker-compose.production.yml`.

| Service | Image | Role |
|---|---|---|
| `bitcoind` | `polarlightning/bitcoind` | Bitcoin Core in regtest, mining and funding |
| `lnd-merchant` | `polarlightning/lnd` | The merchant's node, the settlement authority |
| `lnd-payer` | `polarlightning/lnd` | A second real node that actually pays invoices |
| `gateway` | built from the repository `Dockerfile` | Cherito itself |
| `merchant-receiver` | `e2e/receiver` | Deterministic webhook receiver and fulfilment ledger |

Ports are bound to `127.0.0.1` only. LND wallets are created with `--noseedbackup`, so no seed
phrase exists anywhere in the environment.

### Credentials

The bootstrap bakes a **restricted** macaroon on the merchant node with only
`invoices:read`, `invoices:write` and `info:read`, and that is the only credential the gateway
receives. The admin macaroon stays in the LND data directory and is used solely by the test
fixtures for chain and channel setup.

Every secret is generated at runtime into `e2e/.tmp/`, which is git-ignored. No credential is
committed to the repository.

### Regtest assertions

The bootstrap aborts immediately if `bitcoind` reports a chain other than `regtest`, or if either
LND node reports a network other than `regtest`. There is no mainnet configuration anywhere in the
topology, and `bitcoind` runs with `-dnsseed=0`.

## What the suite proves

Every payment test compares three independent sources of truth:

```
provider truth (merchant LND)  <->  cherito truth (API/database)  <->  merchant fulfilment (receiver)
```

| File | Coverage |
|---|---|
| `happy-path.test.ts` | Full real payment, three-truth agreement, client capability view, channel liquidity moved |
| `lifecycle.test.ts` | Invoice expiry, idempotent create, `IDEMPOTENCY_CONFLICT`, terminal-state stability |
| `authorization.test.ts` | Forged client capability, cross-tenant read and mutation, non-enumerating denials |
| `payment-links.test.ts` | Fixed-price tamper rejection, server-side pricing, fresh invoice per invocation, rate limit |
| `malformed-input.test.ts` | Unknown fields, malformed JSON, oversized body and metadata, invalid amounts, bounded errors |
| `webhook-failures.test.ts` | Receiver outage and retry, forged signature, stale timestamp, replay suppression |
| `restart.test.ts` | Payment while gateway down, durable pending webhook across restart, provider restart |
| `failure-injection.test.ts` | Database lock, provider outage, SSE disconnect and resume |
| `log-secrets.test.ts` | No API key, client secret, webhook secret, macaroon, encryption key or canary in logs |

## Known gaps

`migration-restore.test.ts` is **not part of the `full` suite** and does not currently pass. It
lives in the `maintenance` suite. The backup step works, but `database-cli restore` run against the
stopped gateway's volume exits with `DATABASE_COMMAND_FAILED`, and the CLI intentionally does not
disclose the underlying cause, so the failure is still undiagnosed. Because the scenario stops the
gateway, it is isolated so it cannot affect other files.

Until that scenario passes, the restore rehearsal in the release checklist remains an operator
procedure rather than an automated gate.

Duplicate and out-of-order provider events are covered by the provider-contract tests in
`apps/cherito-payments-gateway/test/payment-intent.test.ts` (cases 15 to 17), which drive the real
state machine with a stub provider. Real LND cannot be made to emit an invalid event sequence, so
that behaviour is deliberately not claimed as observed regtest behaviour.

## Failure injection

| Scenario | Mechanism |
|---|---|
| Database unavailable | A short-lived process inside the gateway container holds `BEGIN EXCLUSIVE` on the SQLite file, so writes hit the busy timeout. No host file is touched. |
| Provider outage | `docker compose stop lnd-merchant`, then restart and verify recovery |
| Receiver outage | The receiver returns 503 on demand via `POST /__test/mode` |
| SSE disconnect | The client aborts the stream and reconnects |

## Timing

The suite is deliberately time-bound rather than sleep-driven: every wait uses a bounded poll with
an explicit timeout and a descriptive failure message. Two scenarios are inherently slow because
they depend on real expiry and retry behaviour:

- invoice expiry uses the minimum permitted `DEFAULT_INVOICE_EXPIRY_SECONDS` of 60 seconds
- webhook retry uses the configured `WEBHOOK_RETRY_INTERVAL_MS`, set to 1 second for tests

## CI

- Pull requests run `regtest-smoke` (happy path plus malformed input) after the unit suite
- `main`, a nightly schedule, and `workflow_dispatch` run the full suite via `regtest-e2e.yml`
- Logs are sanitised of key material before upload and retained for 7 days
- Docker resources are pruned in an `always()` step
