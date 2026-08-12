import { useCallback } from 'react'
import type { CheritoClient } from '../api/cherito-client'
import { AsyncSection, EmptyState } from '../components/AsyncSection'
import { HealthBadge, StatusBadge } from '../components/StatusBadge'
import { useAsync } from '../hooks/useAsync'
import { formatSats, formatWhen } from '../format'

export function OverviewPage({ client }: { client: CheritoClient }) {
  const health = useAsync(useCallback(() => client.health().catch(() => undefined), [client]), [client])
  const capabilities = useAsync(useCallback(() => client.capabilities(), [client]), [client])
  const node = useAsync(useCallback(() => client.node(), [client]), [client])
  const summary = useAsync(useCallback(() => client.paymentIntentSummary(), [client]), [client])
  const recent = useAsync(useCallback(() => client.listPaymentIntents({ limit: 5 }), [client]), [client])

  const healthState = health.loading
    ? 'loading'
    : health.error || health.data === undefined
      ? 'unavailable'
      : health.data.status === 'ok'
        ? 'connected'
        : 'degraded'

  return (
    <div className="page">
      <h1 className="page-title">Overview</h1>

      <section className="card-grid">
        <div className="glass-panel stat-card">
          <span className="stat-label">Gateway health</span>
          <HealthBadge state={healthState} />
          <span className="stat-hint">
            {health.data ? `Lightning: ${health.data.lightning}` : 'No health response'}
          </span>
        </div>

        <div className="glass-panel stat-card">
          <span className="stat-label">Settled volume</span>
          <AsyncSection {...summary} onRetry={summary.reload}>
            {(data) => <span className="stat-value">{formatSats(data.settledVolumeSats)} sats</span>}
          </AsyncSection>
        </div>

        <div className="glass-panel stat-card">
          <span className="stat-label">Settled payments</span>
          <AsyncSection {...summary} onRetry={summary.reload}>
            {(data) => <span className="stat-value">{data.settledCount}</span>}
          </AsyncSection>
        </div>

        <div className="glass-panel stat-card">
          <span className="stat-label">Pending</span>
          <AsyncSection {...summary} onRetry={summary.reload}>
            {(data) => <span className="stat-value">{data.pendingCount}</span>}
          </AsyncSection>
        </div>

        <div className="glass-panel stat-card">
          <span className="stat-label">Expired / failed</span>
          <AsyncSection {...summary} onRetry={summary.reload}>
            {(data) => <span className="stat-value">{data.failedCount}</span>}
          </AsyncSection>
        </div>
      </section>

      <section className="glass-panel panel">
        <h2 className="panel-title">Lightning capabilities</h2>
        <AsyncSection {...capabilities} onRetry={capabilities.reload}>
          {(data) => (
            <ul className="capability-list">
              <li><span>BOLT11 receive</span><StatusBadge status={data.bolt11Receive ? 'succeeded' : 'failed'} /></li>
              <li><span>BOLT12 receive</span><StatusBadge status={data.bolt12Receive ? 'succeeded' : 'failed'} /></li>
              <li><span>Invoice streaming</span><StatusBadge status={data.invoiceStreaming ? 'succeeded' : 'failed'} /></li>
            </ul>
          )}
        </AsyncSection>
      </section>

      <section className="glass-panel panel">
        <h2 className="panel-title">Node</h2>
        <AsyncSection {...node} onRetry={node.reload}>
          {(data) => (
            <dl className="detail-list">
              <div><dt>Network</dt><dd>{data.network}</dd></div>
              {data.alias ? <div><dt>Alias</dt><dd>{data.alias}</dd></div> : null}
              {data.syncedToChain !== undefined ? (
                <div><dt>Synced to chain</dt><dd>{String(data.syncedToChain)}</dd></div>
              ) : null}
              {data.syncedToGraph !== undefined ? (
                <div><dt>Synced to graph</dt><dd>{String(data.syncedToGraph)}</dd></div>
              ) : null}
            </dl>
          )}
        </AsyncSection>
      </section>

      <section className="glass-panel panel">
        <h2 className="panel-title">Recent payment intents</h2>
        <AsyncSection
          {...recent}
          onRetry={recent.reload}
          isEmpty={(page) => page.items.length === 0}
          empty={<EmptyState title="No payment intents yet" hint="They appear here once your backend creates them." />}
        >
          {(page) => (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Intent</th><th>Description</th><th>Amount</th><th>Status</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {page.items.map((intent) => (
                    <tr key={intent.id}>
                      <td className="mono">{intent.id}</td>
                      <td>{intent.description || intent.merchantOrderId || '—'}</td>
                      <td>{formatSats(intent.amountSats)}</td>
                      <td><StatusBadge status={intent.status} /></td>
                      <td>{formatWhen(intent.createdAt)}</td>
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
