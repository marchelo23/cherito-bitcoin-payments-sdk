import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  LightningReceiveProvider,
  Bolt12ReceiveProvider,
} from "@cherito/bitcoin-sdk";
import type { Config } from "../config.js";
import type { Repository, Session } from "../persistence/repository.js";
import { findProduct } from "./catalog.js";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export class PaymentService {
  private listeners = new Map<string, Set<(s: Session) => void>>();
  constructor(
    private lnd: LightningReceiveProvider,
    private bolt12: Bolt12ReceiveProvider | undefined,
    private repo: Repository,
    private config: Config,
  ) {}
  async create(productId: string, quantity: number, key: string) {
    const payloadHash = hash(JSON.stringify({ productId, quantity })),
      old = this.repo.idempotency(key);
    if (old && Date.parse(old.expiresAt) > Date.now()) {
      if (old.payloadHash !== payloadHash)
        throw Object.assign(new Error("Idempotency key payload conflict"), {
          statusCode: 409,
          code: "IDEMPOTENCY_CONFLICT",
        });
      const s = this.repo.session(old.sessionId);
      if (s) return { ...this.public(s), statusToken: old.token };
    }
    const product = findProduct(productId);
    if (!product?.active)
      throw Object.assign(new Error("Product unavailable"), {
        statusCode: 404,
        code: "PRODUCT_NOT_FOUND",
      });
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > product.maxQuantity
    )
      throw Object.assign(new Error("Quantity is invalid"), {
        statusCode: 400,
        code: "INVALID_QUANTITY",
      });
    const amount = product.priceSats * BigInt(quantity);
    if (
      amount < this.config.MIN_INVOICE_SATS ||
      amount > this.config.MAX_INVOICE_SATS
    )
      throw Object.assign(new Error("Amount is outside merchant limits"), {
        statusCode: 400,
        code: "AMOUNT_OUT_OF_RANGE",
      });
    const orderId = `ord_${randomUUID()}`,
      id = `chk_${randomUUID()}`,
      token = randomBytes(32).toString("base64url"),
      invoice = await this.lnd.createInvoice({
        orderId,
        amountSats: amount,
        memo: `Cherito order ${orderId}`,
        expirySeconds: this.config.DEFAULT_INVOICE_EXPIRY_SECONDS,
      }),
      s: Session = {
        id,
        orderId,
        productId,
        quantity,
        amountSats: amount.toString(),
        paymentRequest: invoice.paymentRequest,
        paymentHash: invoice.paymentHash,
        expiresAt: invoice.expiresAt,
        state: invoice.state,
        tokenHash: hash(token),
      };
    this.repo.createCheckout(s, invoice, {
      key,
      payloadHash,
      token,
      expiresAt: new Date(
        Date.now() + this.config.IDEMPOTENCY_TTL_SECONDS * 1000,
      ).toISOString(),
    });
    void this.watch(s);
    return { ...this.public(s), statusToken: token };
  }
  public(s: Session) {
    return {
      checkoutSessionId: s.id,
      orderId: s.orderId,
      amountSats: s.amountSats,
      paymentRequest: s.paymentRequest,
      paymentHash: s.paymentHash,
      expiresAt: s.expiresAt,
      state: s.state,
    };
  }
  authorize(id: string, token: string) {
    const s = this.repo.session(id);
    if (!s) return;
    const a = Buffer.from(s.tokenHash),
      b = Buffer.from(hash(token));
    return a.length === b.length && timingSafeEqual(a, b) ? s : undefined;
  }
  listen(id: string, callback: (s: Session) => void) {
    const set = this.listeners.get(id) ?? new Set();
    set.add(callback);
    this.listeners.set(id, set);
    return () => set.delete(callback);
  }
  private async watch(s: Session) {
    await this.lnd.subscribeToInvoice(s.paymentHash, (i) => {
      this.repo.settle(s.paymentHash, i);
      const current = this.repo.session(s.id);
      if (current)
        for (const listener of this.listeners.get(s.id) ?? [])
          listener(current);
    });
  }
  async createOffer(productId: string) {
    const product = findProduct(productId);
    if (!product?.active || !product.offerEnabled)
      throw Object.assign(new Error("Product is not approved for Offers"), {
        statusCode: 404,
        code: "PRODUCT_NOT_FOUND",
      });
    if (!this.bolt12)
      throw Object.assign(new Error("BOLT12 is not configured"), {
        statusCode: 501,
        code: "BOLT12_NOT_CONFIGURED",
      });
    const caps = await this.bolt12.getCapabilities();
    if (!caps.bolt12Receive)
      throw Object.assign(new Error("LNDK is unavailable"), {
        statusCode: 503,
        code: "LNDK_UNAVAILABLE",
      });
    const offer = await this.bolt12.createOffer({
      productId,
      amountSats: product.priceSats,
      description: product.name,
    });
    this.repo.saveOffer(productId, offer);
    return {
      offerId: offer.offerId,
      offer: offer.offer,
      amountSats: offer.amountSats.toString(),
    };
  }
}
