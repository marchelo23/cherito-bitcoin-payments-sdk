import { useCallback } from 'react'
import type { CheritoClient } from '../api/cherito-client'
import { AsyncSection } from '../components/AsyncSection'
import { HealthBadge } from '../components/StatusBadge'
import { useAsync } from '../hooks/useAsync'

export function SettingsPage({ client, onDisconnect }: { client: CheritoClient; onDisconnect: () => void }) {
  const health = useAsync(useCallback(() => client.health().catch(() => undefined), [client]), [client])
  const capabilities = useAsync(useCallback(() => client.capabilities(), [client]), [client])
  const node = useAsync(useCallback(() => client.node(), [client]), [client])

  const healthState = health.loading
    ? 'loading'
    : health.error || health.data === undefined
      ? 'unavailable'
      : health.data.status === 'ok'
        ? 'connected'
        : 'degraded'

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>

      <section className="glass-panel panel">
        <h2 className="panel-title">Connection</h2>
        <dl className="detail-list">
          <div><dt>Gateway URL</dt><dd className="mono">{client.gatewayUrl}</dd></div>
          <div><dt>Status</dt><dd><HealthBadge state={healthState} /></dd></div>
          <div><dt>Merchant key</dt><dd>Held in this browser tab only</dd></div>
        </dl>
        <button type="button" className="btn-primary" onClick={onDisconnect}>Disconnect</button>
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
            </dl>
          )}
        </AsyncSection>
      </section>

      <section className="glass-panel panel">
        <h2 className="panel-title">Capabilities</h2>
        <AsyncSection {...capabilities} onRetry={capabilities.reload}>
          {(data) => (
            <dl className="detail-list">
              <div><dt>BOLT11 receive</dt><dd>{String(data.bolt11Receive)}</dd></div>
              <div><dt>BOLT12 receive</dt><dd>{String(data.bolt12Receive)}</dd></div>
              <div><dt>Invoice streaming</dt><dd>{String(data.invoiceStreaming)}</dd></div>
            </dl>
          )}
        </AsyncSection>
      </section>
    </div>
  )
}
