import { useCallback, useMemo, useState } from 'react'
import type { CheritoClient } from '../api/cherito-client'
import type { PaymentIntentStatus } from '../api/types'
import { AsyncSection, EmptyState } from '../components/AsyncSection'
import { StatusBadge } from '../components/StatusBadge'
import { useAsync } from '../hooks/useAsync'
import { formatSats, formatWhen } from '../format'

type Filter = 'all' | 'pending' | 'settled' | 'failed'

const FILTERS: Array<{ id: Filter; label: string; statuses: PaymentIntentStatus[] }> = [
  { id: 'all', label: 'All', statuses: [] },
  { id: 'pending', label: 'Pending', statuses: ['requires_payment', 'processing'] },
  { id: 'settled', label: 'Settled', statuses: ['succeeded'] },
  { id: 'failed', label: 'Expired / failed', statuses: ['expired', 'canceled', 'failed'] },
]

export function TransactionsPage({ client }: { client: CheritoClient }) {
  const [filter, setFilter] = useState<Filter>('all')
  const intents = useAsync(useCallback(() => client.listPaymentIntents({ limit: 50 }), [client]), [client])

  const visible = useMemo(() => {
    if (!intents.data) return []
    const active = FILTERS.find((entry) => entry.id === filter)!
    if (active.statuses.length === 0) return intents.data.items
    return intents.data.items.filter((intent) => active.statuses.includes(intent.status))
  }, [intents.data, filter])

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Transactions</h1>
        <button type="button" className="btn-primary" onClick={intents.reload}>Refresh</button>
      </div>

      <div className="filter-row" role="tablist">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={filter === entry.id}
            className={`filter-chip${filter === entry.id ? ' active' : ''}`}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <section className="glass-panel panel">
        <AsyncSection
          {...intents}
          onRetry={intents.reload}
          isEmpty={() => visible.length === 0}
          empty={
            <EmptyState
              title={intents.data && intents.data.items.length > 0 ? 'No payment intents match this filter' : 'No payment intents yet'}
              hint={intents.data && intents.data.items.length > 0 ? undefined : 'Create one from your merchant backend to see it here.'}
            />
          }
        >
          {() => (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Intent</th>
                    <th>Order</th>
                    <th>Description</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Settled</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((intent) => (
                    <tr key={intent.id}>
                      <td className="mono">{intent.id}</td>
                      <td>{intent.merchantOrderId ?? '—'}</td>
                      <td>{intent.description || '—'}</td>
                      <td>{formatSats(intent.amountSats)} sats</td>
                      <td><StatusBadge status={intent.status} /></td>
                      <td>{formatWhen(intent.createdAt)}</td>
                      <td>{formatWhen(intent.settledAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncSection>
      </section>
    </div>
  )
}
