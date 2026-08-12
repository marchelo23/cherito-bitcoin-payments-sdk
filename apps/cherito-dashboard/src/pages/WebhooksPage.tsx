import { useCallback, useState } from 'react'
import type { CheritoClient } from '../api/cherito-client'
import { AsyncSection } from '../components/AsyncSection'
import { useAsync } from '../hooks/useAsync'
import { describeError } from '../api/errors'
import { formatWhen } from '../format'

export function WebhooksPage({ client }: { client: CheritoClient }) {
  const config = useAsync(useCallback(() => client.webhookConfig(), [client]), [client])
  const [endpoint, setEndpoint] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [revealedSecret, setRevealedSecret] = useState<string | undefined>(undefined)

  async function act(action: () => Promise<{ signingSecret?: string } | unknown>) {
    setError(undefined)
    setBusy(true)
    try {
      const result = (await action()) as { signingSecret?: string } | undefined
      if (result?.signingSecret) setRevealedSecret(result.signingSecret)
      config.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Webhooks</h1>
        <button type="button" className="btn-primary" onClick={config.reload}>Refresh</button>
      </div>

      <section className="glass-panel panel">
        <h2 className="panel-title">Current configuration</h2>
        <AsyncSection {...config} onRetry={config.reload}>
          {(data) => (
            <dl className="detail-list">
              <div>
                <dt>State</dt>
                <dd>
                  <span className={`badge ${data.enabled ? 'success' : 'default'}`}>
                    {data.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </dd>
              </div>
              <div><dt>Endpoint</dt><dd className="mono">{data.endpoint ?? '—'}</dd></div>
              <div>
                <dt>Signing secret</dt>
                <dd>{data.signingSecretConfigured ? 'Configured' : 'Not configured'}</dd>
              </div>
              <div><dt>Secret rotated</dt><dd>{formatWhen(data.secretRotatedAt)}</dd></div>
            </dl>
          )}
        </AsyncSection>
      </section>

      <section className="glass-panel panel">
        <h2 className="panel-title">Manage</h2>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault()
            void act(async () => {
              const result = await client.setWebhookEndpoint(endpoint.trim())
              setEndpoint('')
              return result
            })
          }}
        >
          <label className="field" style={{ flex: '1 1 320px' }}>
            <span>Endpoint URL</span>
            <input
              aria-label="Endpoint URL"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://merchant.example/webhooks/cherito"
              required
            />
          </label>
          <button type="submit" className="btn-primary" disabled={busy}>Save endpoint</button>
        </form>

        <div className="row-actions" style={{ marginTop: '1rem' }}>
          <button type="button" className="btn-icon" disabled={busy} onClick={() => act(() => client.disableWebhook())}>
            Disable webhook
          </button>
          <button type="button" className="btn-icon" disabled={busy} onClick={() => act(() => client.rotateWebhookSecret())}>
            Rotate signing secret
          </button>
        </div>

        {error ? <p role="alert" className="form-error">{error}</p> : null}

        {revealedSecret ? (
          <div className="secret-reveal" role="alert">
            <p style={{ margin: 0, fontWeight: 700 }}>Copy this signing secret now</p>
            <p style={{ margin: '0.35rem 0' }}>
              It is shown once and cannot be retrieved again. Cherito only stores a form it can
              verify against, never the value in a way this dashboard can read back.
            </p>
            <code className="mono secret-value">{revealedSecret}</code>
            <button
              type="button"
              className="btn-icon"
              style={{ marginTop: '0.75rem' }}
              onClick={() => setRevealedSecret(undefined)}
            >
              I have stored it
            </button>
          </div>
        ) : null}
      </section>
    </div>
  )
}
