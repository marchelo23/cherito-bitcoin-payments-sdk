import { useCallback, useState } from 'react'
import type { CheritoClient } from '../api/cherito-client'
import type { CreatePaymentLinkInput, PaymentLinkMode } from '../api/types'
import { AsyncSection, EmptyState } from '../components/AsyncSection'
import { useAsync } from '../hooks/useAsync'
import { describeError } from '../api/errors'
import { formatSats, formatWhen } from '../format'

const MODES: PaymentLinkMode[] = ['fixed', 'open_amount', 'donation']

export function PaymentLinksPage({ client }: { client: CheritoClient }) {
  const links = useAsync(useCallback(() => client.listPaymentLinks({ limit: 50 }), [client]), [client])
  const [mode, setMode] = useState<PaymentLinkMode>('fixed')
  const [title, setTitle] = useState('')
  const [productId, setProductId] = useState('')
  const [minAmountSats, setMinAmountSats] = useState('')
  const [maxAmountSats, setMaxAmountSats] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  async function act(action: () => Promise<unknown>) {
    setError(undefined)
    setBusy(true)
    try {
      await action()
      links.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault()
    const input: CreatePaymentLinkInput = { mode, title: title.trim() }
    if (mode === 'fixed') {
      input.productId = productId.trim()
    } else {
      if (minAmountSats.trim()) input.minAmountSats = minAmountSats.trim()
      if (maxAmountSats.trim()) input.maxAmountSats = maxAmountSats.trim()
    }
    await act(async () => {
      await client.createPaymentLink(input)
      setTitle('')
      setProductId('')
      setMinAmountSats('')
      setMaxAmountSats('')
    })
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Payment Links</h1>
        <button type="button" className="btn-primary" onClick={links.reload}>Refresh</button>
      </div>

      <section className="glass-panel panel">
        <h2 className="panel-title">Create a link</h2>
        <form className="inline-form" onSubmit={create}>
          <label className="field">
            <span>Mode</span>
            <select aria-label="Mode" value={mode} onChange={(event) => setMode(event.target.value as PaymentLinkMode)}>
              {MODES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>

          <label className="field">
            <span>Title</span>
            <input aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>

          {mode === 'fixed' ? (
            <label className="field">
              <span>Product ID</span>
              <input
                aria-label="Product ID"
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
                placeholder="cherito-coffee-001"
                required
              />
            </label>
          ) : (
            <>
              <label className="field">
                <span>Min sats</span>
                <input aria-label="Min sats" value={minAmountSats} onChange={(event) => setMinAmountSats(event.target.value)} />
              </label>
              <label className="field">
                <span>Max sats</span>
                <input aria-label="Max sats" value={maxAmountSats} onChange={(event) => setMaxAmountSats(event.target.value)} />
              </label>
            </>
          )}

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Working…' : 'Create link'}
          </button>
        </form>
        {error ? <p role="alert" className="form-error">{error}</p> : null}
        <p className="fine-print">
          Pricing, slugs and use limits stay owned by the gateway. This form only submits the
          fields the existing API accepts.
        </p>
      </section>

      <section className="glass-panel panel">
        <AsyncSection
          {...links}
          onRetry={links.reload}
          isEmpty={(page) => page.items.length === 0}
          empty={<EmptyState title="No payment links yet" hint="Create one above to share a hosted checkout." />}
        >
          {(page) => (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Title</th><th>Mode</th><th>State</th><th>Uses</th>
                    <th>Slug</th><th>Expires</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((link) => (
                    <tr key={link.id}>
                      <td>{link.title}</td>
                      <td>{link.mode}</td>
                      <td>
                        <span className={`badge ${link.active ? 'success' : 'default'}`}>
                          {link.active ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td>
                        {link.useCount}
                        {link.maxUses === null ? '' : ` / ${link.maxUses}`}
                        {link.mode === 'fixed' ? '' : ` · ${formatSats(link.minAmountSats ?? '0')}–${formatSats(link.maxAmountSats ?? '0')}`}
                      </td>
                      <td className="mono">{link.slug}</td>
                      <td>{formatWhen(link.expiresAt)}</td>
                      <td className="row-actions">
                        <button
                          type="button"
                          className="btn-icon"
                          disabled={busy || !link.active}
                          onClick={() => act(() => client.disablePaymentLink(link.id))}
                        >
                          Disable
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          disabled={busy}
                          onClick={() => act(() => client.rotatePaymentLinkSlug(link.id))}
                        >
                          Rotate slug
                        </button>
                      </td>
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
