# API abuse controls

The gateway applies separate fixed-window policies to authentication failures, merchant Payment
Intent creation, public Payment Link resolution, public Payment Link invoice creation, webhook
management, and SSE capacity. Public invoice creation consumes independent IP, tenant, and link
buckets. Provider calls have hard active and queued limits; overflow returns a stable service error
instead of retaining an unbounded promise.

Relevant environment settings include:

- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_AUTH_FAILURES`
- `RATE_LIMIT_CREATE_INVOICE`
- `RATE_LIMIT_PAYMENT_LINK_RESOLVE`
- `RATE_LIMIT_PAYMENT_LINK_CREATE_IP`
- `RATE_LIMIT_PAYMENT_LINK_CREATE_TENANT`
- `RATE_LIMIT_PAYMENT_LINK_CREATE_LINK`
- `RATE_LIMIT_WEBHOOK_MANAGEMENT`
- `RATE_LIMIT_SSE_CONNECTIONS`
- `PROVIDER_MAX_CONCURRENCY` and `PROVIDER_MAX_QUEUE`
- `SSE_MAX_GLOBAL` and `SSE_MAX_PER_TENANT`

The built-in rate limiter is deliberately behind a small interface, but its storage is local to one
process. Multi-replica deployments must replace it with a shared atomic implementation.

## Proxies

`X-Forwarded-For` is ignored by default. Set `TRUST_PROXY` only to an explicit comma-separated
Fastify trust list matching proxies actually controlled by the operator. Setting it broadly allows
clients to choose the IP identity used by abuse controls.

## Webhook network boundary

Production webhook URLs require HTTPS and cannot contain URL credentials. Every attempt resolves
all addresses, rejects the destination if any address is private/reserved, and connects with a
pinned lookup to the validated address. Redirects are not followed. Connection/total duration and
response bytes are bounded. The event ID remains stable across retries while every attempt receives
a fresh timestamp/signature.

## Request boundaries

Mutation bodies use strict schemas and reject unknown fields. The Fastify body limit is 16 KiB;
metadata and customer-provided text have smaller semantic/UTF-8 bounds. Collection APIs use
deterministic ordering and a maximum page size of 100. Public errors exclude database paths,
provider details, tenant existence, credentials, and node identity.
