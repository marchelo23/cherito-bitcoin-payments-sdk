import { useState } from 'react'
import { Bitcoin } from 'lucide-react'
import { CheritoClient, normalizeGatewayUrl, type Credentials } from '../api/cherito-client'
import { describeError } from '../api/errors'

export function ConnectPage({ onConnect }: { onConnect: (credentials: Credentials, remember: boolean) => void }) {
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(undefined)

    const form = new FormData(event.currentTarget)
    const gatewayUrl = String(form.get('gatewayUrl') ?? '')
    const apiKey = String(form.get('apiKey') ?? '')
    const remember = form.get('remember') === 'on'

    let normalized: string
    try {
      normalized = normalizeGatewayUrl(gatewayUrl)
    } catch {
      setError('Enter a valid gateway URL, for example http://localhost:3100')
      return
    }
    if (apiKey.trim().length === 0) {
      setError('A merchant API key is required')
      return
    }

    const credentials: Credentials = { gatewayUrl: normalized, apiKey: apiKey.trim() }
    setBusy(true)
    try {
      await new CheritoClient(credentials).node()
      onConnect(credentials, remember)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="connect-screen">
      <form className="glass-panel connect-card" onSubmit={submit}>
        <div className="brand" style={{ justifyContent: 'center' }}>
          <div className="brand-mark"><Bitcoin size={26} /></div>
          <h1 className="text-gradient" style={{ fontSize: '1.5rem', margin: 0 }}>Cherito</h1>
        </div>

        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', marginTop: 0 }}>
          Connect to your Cherito gateway with a merchant API key.
        </p>

        <label className="field">
          <span>Gateway URL</span>
          <input
            name="gatewayUrl"
            aria-label="Gateway URL"
            defaultValue="http://localhost:3100"
            placeholder="http://localhost:3100"
          />
        </label>

        <label className="field">
          <span>Merchant API key</span>
          <input
            name="apiKey"
            aria-label="Merchant API key"
            type="password"
            placeholder="sk_live_…"
            autoComplete="off"
          />
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            name="remember"
            aria-label="Keep me connected for this browser session"
          />
          <span>Keep me connected for this browser session</span>
        </label>

        {error ? <p role="alert" className="form-error">{error}</p> : null}

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>

        <p className="fine-print">
          The key stays in this tab. It is never written to localStorage and never sent anywhere
          except this gateway as a bearer token.
        </p>
      </form>
    </div>
  )
}
