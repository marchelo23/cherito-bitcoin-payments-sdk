import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  LndRestProvider,
  LightningError,
  loadCredential,
  type Bolt12ReceiveProvider,
} from "@cherito/bitcoin-sdk";
import { loadConfig, type Config } from "./config.js";
import { Repository } from "./persistence/repository.js";
import { PaymentService } from "./services/payment-service.js";
import { LndkProvider } from "./services/lndk-provider.js";
const checkout = z
    .object({
      productId: z.string().regex(/^[a-z0-9-]{3,80}$/),
      quantity: z.number().int().min(1).max(10),
    })
    .strict(),
  offer = z
    .object({ productId: z.string().regex(/^[a-z0-9-]{3,80}$/) })
    .strict();
const token = (header: unknown) =>
  typeof header === "string" ? header.replace(/^Bearer\s+/i, "") : "";
export async function buildServer(config: Config = loadConfig()) {
  const [cert, macaroon] = await Promise.all([
      loadCredential(
        config.LND_TLS_CERT_PATH,
        config.LND_TLS_CERT_BASE64,
        "base64",
      ),
      loadCredential(config.LND_MACAROON_PATH, config.LND_MACAROON_HEX, "hex"),
    ]),
    lnd = new LndRestProvider({
      url: config.LND_REST_URL,
      tlsCertificate: cert,
      macaroon,
      timeoutMs: 8000,
    });
  let bolt12: Bolt12ReceiveProvider | undefined;
  if (config.BOLT12_PROVIDER === "lndk")
    try {
      bolt12 = await LndkProvider.connect({
        url: config.LNDK_GRPC_URL!,
        certificatePath: config.LNDK_TLS_CERT_PATH!,
        macaroonPath: config.LNDK_MACAROON_PATH!,
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          code: "LNDK_UNAVAILABLE",
          message: error instanceof Error ? error.message : "LNDK unavailable",
        }),
      );
    }
  const repo = new Repository(config.DATABASE_URL),
    payments = new PaymentService(lnd, bolt12, repo, config),
    app = Fastify({
      logger: {
        level: config.LOG_LEVEL,
        redact: [
          "req.headers.authorization",
          "req.headers.grpc-metadata-macaroon",
          "*.macaroon",
          "*.certificate",
        ],
      },
      bodyLimit: 16384,
      requestTimeout: 15000,
    });
  await app.register(cors, {
    origin: (origin, callback) =>
      callback(
        null,
        !origin ||
          config.ALLOWED_ORIGINS.split(",")
            .map((x) => x.trim())
            .includes(origin),
      ),
    methods: ["GET", "POST"],
    allowedHeaders: ["content-type", "authorization", "idempotency-key"],
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.headers({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    });
    return payload;
  });
  const rates = new Map<string, { start: number; count: number }>();
  app.get("/health", async (_req, reply) => {
    try {
      await lnd.getNodeInfo();
      return { status: "ok", lightning: "connected", provider: "lnd" };
    } catch {
      return reply
        .code(503)
        .send({
          status: "degraded",
          lightning: "disconnected",
          provider: "lnd",
        });
    }
  });
  app.get("/v1/node", () => lnd.getNodeInfo());
  app.get("/v1/capabilities", async () => {
    const base = await lnd.getCapabilities(),
      extra = bolt12
        ? await bolt12.getCapabilities().catch(() => undefined)
        : undefined;
    return { ...base, bolt12Receive: extra?.bolt12Receive === true };
  });
  app.post("/v1/checkout-sessions", async (req, reply) => {
    const now = Date.now(),
      ip = req.ip,
      current = rates.get(ip);
    if (!current || now - current.start >= 60000)
      rates.set(ip, { start: now, count: 1 });
    else if (++current.count > config.RATE_LIMIT_CREATE_INVOICE)
      return reply
        .code(429)
        .send({ code: "RATE_LIMITED", message: "Too many checkout requests" });
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !z.uuid().safeParse(key).success)
      return reply
        .code(400)
        .send({
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "A UUID Idempotency-Key is required",
        });
    const input = checkout.parse(req.body);
    return reply
      .code(201)
      .send(await payments.create(input.productId, input.quantity, key));
  });
  app.get<{ Params: { id: string } }>(
    "/v1/checkout-sessions/:id",
    async (req, reply) => {
      const s = payments.authorize(
        req.params.id,
        token(req.headers.authorization),
      );
      return s
        ? payments.public(s)
        : reply
            .code(401)
            .send({
              code: "INVALID_STATUS_TOKEN",
              message: "Invalid status token",
            });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/checkout-sessions/:id/events",
    async (req, reply) => {
      const s = payments.authorize(
        req.params.id,
        token(req.headers.authorization),
      );
      if (!s)
        return reply
          .code(401)
          .send({
            code: "INVALID_STATUS_TOKEN",
            message: "Invalid status token",
          });
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      const send = (value: typeof s) =>
        reply.raw.write(
          `event: invoice.${value.state}\ndata: ${JSON.stringify({ checkoutSessionId: value.id, orderId: value.orderId, state: value.state, expiresAt: value.expiresAt })}\n\n`,
        );
      send(s);
      const remove = payments.listen(s.id, send),
        ping = setInterval(() => reply.raw.write(": keepalive\n\n"), 15000);
      req.raw.on("close", () => {
        remove();
        clearInterval(ping);
      });
    },
  );
  app.post("/v1/offers", async (req) => {
    const input = offer.parse(req.body);
    return payments.createOffer(input.productId);
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number; code?: string },
      status =
        e.statusCode ??
        (error instanceof z.ZodError
          ? 400
          : error instanceof LightningError
            ? 502
            : 500);
    req.log.error(
      { code: e.code ?? "INTERNAL_ERROR", message: e.message },
      "request failed",
    );
    reply
      .code(status)
      .send({
        code: e.code ?? "INTERNAL_ERROR",
        message: status === 500 ? "Internal server error" : e.message,
        requestId: req.id,
      });
  });
  return app;
}
if (process.env.NODE_ENV !== "test") {
  const config = loadConfig();
  buildServer(config)
    .then((app) => app.listen({ port: config.PORT, host: config.HOST }))
    .catch((error) => {
      console.error(
        JSON.stringify({
          level: "fatal",
          message: error instanceof Error ? error.message : "Startup failed",
        }),
      );
      process.exitCode = 1;
    });
}
