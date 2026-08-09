# Logging, privacy, and retention

Cherito treats logs as a minimized operational data stream, not as a copy of HTTP
traffic or the payment database. Structured application logs contain only the
request ID, method, route template, outcome, HTTP status, a tenant ID after
successful authentication, and a bounded provider/error category when needed.
These fields exist to correlate failures without reconstructing a customer's
payment activity.

## Data intentionally excluded

Application logs must not contain request or response bodies, headers, cookies,
API keys, client capabilities, webhook secrets, node credentials, TLS material,
provider URLs, invoices, offers, preimages, payment hashes, descriptions,
metadata, payer notes, database paths, or stack traces. The logger uses both a
strict call-site allowlist and nested-field redaction as defense in depth. Provider
exceptions are normalized to Cherito categories before logging or returning them.

`/health` exposes only generic gateway and Lightning availability. Node identity,
network and synchronization details are available from `/v1/node` only to an
authenticated merchant. `/v1/capabilities` exposes capability booleans, not the
configured provider.

The first bootstrap API key is written once to the explicitly configured
`BOOTSTRAP_KEY_PATH` with mode `0600`. An empty database will not bootstrap in
production or development without that destination. The value is never sent
through the logger or stdout.

## Operational retention

Keep application logs for the shortest period that supports incident response;
7–30 days is a reasonable starting range for many small deployments, but the
operator must choose a period appropriate to its risks and obligations. Restrict
production log access, encrypt storage and transport, and delete expired archives.
Do not retain customer descriptions or metadata in a log pipeline.

Application logs and audit events are different records:

- Application logs support availability and debugging and are aggressively
  minimized.
- Audit events record security-relevant actor/action/target changes. If an audit
  system is added, it should use stable IDs and action types, enforce tenant
  access, and still never store plaintext credentials or request bodies.

Metrics must use bounded labels such as route template, status class and provider
type. Never label metrics with tenant IDs, intent/order IDs, payment hashes,
invoices, customer fields, arbitrary errors, URLs or IP addresses.

## Payment and browser privacy

Render invoice QR codes locally. Do not send invoices, payment hashes, node data,
client capabilities, metadata or status tokens to analytics or third-party image
services. Avoid third-party scripts on checkout pages and enforce an appropriate
Content Security Policy. A hosted/custodial Lightning provider still observes the
merchant's payment activity; logging controls do not remove that provider trust.

Cherito's environment-variable checks reject obvious wallet-secret names, but
variable names cannot prove a macaroon is least privilege. Operators must bake a
dedicated receive-only credential, verify its permissions against their installed
LND version, and test that unnecessary operations are denied.

## Work outside this logging change

Issue #22 also calls for tenant-configurable database retention jobs, data
export/deletion workflows, and `noindex` behavior when public Payment Links exist.
Those lifecycle features are not implemented by the safe-logging change and must
be completed and reviewed before issue #22 is closed. No GDPR, PCI, or other
compliance certification is claimed.
