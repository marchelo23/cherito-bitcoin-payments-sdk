import type { PaymentIntentStatus } from '../api/types'

const TONE: Record<string, string> = {
  succeeded: 'success',
  requires_payment: 'warning',
  processing: 'warning',
  expired: 'default',
  canceled: 'default',
  failed: 'default',
}

const LABEL: Record<string, string> = {
  succeeded: 'Settled',
  requires_payment: 'Pending',
  processing: 'Processing',
  expired: 'Expired',
  canceled: 'Canceled',
  failed: 'Failed',
}

export function StatusBadge({ status }: { status: PaymentIntentStatus | string }) {
  return (
    <span className={`badge ${TONE[status] ?? 'default'}`}>
      {LABEL[status] ?? status}
    </span>
  )
}

export function HealthBadge({ state }: { state: 'connected' | 'degraded' | 'unavailable' | 'loading' }) {
  const tone = state === 'connected' ? 'success' : state === 'degraded' ? 'warning' : 'default'
  const label = state === 'connected'
    ? 'Connected'
    : state === 'degraded'
      ? 'Degraded'
      : state === 'unavailable'
        ? 'Unavailable'
        : 'Checking…'
  return <span className={`badge ${tone}`}>{label}</span>
}
