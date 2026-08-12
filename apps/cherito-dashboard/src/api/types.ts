export type PaymentIntentStatus =
  | 'requires_payment'
  | 'processing'
  | 'succeeded'
  | 'expired'
  | 'canceled'
  | 'failed'

export interface GatewayHealth {
  status: string
  lightning: string
}

export interface GatewayCapabilities {
  bolt11Receive: boolean
  bolt12Receive: boolean
  invoiceStreaming: boolean
}

export interface NodeInfo {
  alias?: string
  identityPubkey?: string
  network: string
  syncedToChain?: boolean
  syncedToGraph?: boolean
}

export interface PaymentIntentSummary {
  settledCount: number
  settledVolumeSats: string
  pendingCount: number
  failedCount: number
}

export interface MerchantPaymentIntent {
  id: string
  tenantId: string
  merchantOrderId: string | null
  pricingRuleId: string | null
  paymentLinkId: string | null
  amountSats: string
  currency: string
  description: string
  status: PaymentIntentStatus
  expiresAt: string
  settledAt: string | null
  createdAt: string
  updatedAt: string
}

export type PaymentLinkMode = 'fixed' | 'open_amount' | 'donation'

export interface PaymentLink {
  id: string
  slug: string
  mode: PaymentLinkMode
  title: string
  description: string | null
  active: boolean
  minAmountSats: string | null
  maxAmountSats: string | null
  maxUses: number | null
  useCount: number
  expiresAt: string | null
  createdAt: string
}

export interface CreatePaymentLinkInput {
  mode: PaymentLinkMode
  title: string
  description?: string
  productId?: string
  pricingRuleId?: string
  minAmountSats?: string
  maxAmountSats?: string
  maxUses?: number
  expiresAt?: string
}

export interface WebhookConfig {
  enabled: boolean
  endpoint: string | null
  signingSecretConfigured: boolean
  secretRotatedAt: string | null
}

export interface ApiKeyMetadata {
  id: string
  keyPrefix: string
  label: string
  createdAt: string
  revokedAt: string | null
}

export interface Page<T> {
  items: T[]
  next?: string
}
