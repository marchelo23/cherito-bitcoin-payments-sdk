import { useCallback } from 'react'
import type { CheritoClient } from '../api/cherito-client'
import { AsyncSection, EmptyState } from '../components/AsyncSection'
import { useAsync } from '../hooks/useAsync'
import { formatWhen } from '../format'

export function ApiKeysPage({ client }: { client: CheritoClient }) {
  const keys = useAsync(useCallback(() => client.listApiKeys(), [client]), [client])

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">API Keys</h1>
        <button type="button" className="btn-primary" onClick={keys.reload}>Refresh</button>
      </div>

      <section className="glass-panel panel">
        <AsyncSection
          {...keys}
          onRetry={keys.reload}
          isEmpty={(page) => page.items.length === 0}
          empty={<EmptyState title="No API keys found for this merchant" />}
        >
          {(page) => (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Key ID</th><th>Prefix</th><th>Label</th><th>Created</th><th>State</th></tr>
                </thead>
                <tbody>
                  {page.items.map((key) => (
                    <tr key={key.id}>
                      <td className="mono">{key.id}</td>
                      <td className="mono">{key.keyPrefix}…</td>
                      <td>{key.label}</td>
                      <td>{formatWhen(key.createdAt)}</td>
                      <td>
                        <span className={`badge ${key.revokedAt ? 'default' : 'success'}`}>
                          {key.revokedAt ? 'Revoked' : 'Active'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncSection>
      </section>

      <section className="glass-panel panel">
        <h2 className="panel-title">Creating and revoking keys is not available here</h2>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          The gateway has no HTTP route for minting or revoking merchant keys, and this dashboard
          authenticates with a merchant key itself. Exposing those actions would let a single leaked
          key mint replacements or revoke its siblings, so they are deliberately left out of this MVP
          rather than shipped behind an unsafe shortcut.
        </p>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
          Keys are provisioned out of band today. Raw keys are stored only as hashes and are never
          recoverable through any API.
        </p>
      </section>
    </div>
  )
}
