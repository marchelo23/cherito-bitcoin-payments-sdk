import { useCallback, useMemo, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { CheritoClient, type Credentials } from './api/cherito-client'
import { AppShell } from './components/AppShell'
import { ConnectPage } from './pages/ConnectPage'
import { OverviewPage } from './pages/OverviewPage'
import { TransactionsPage } from './pages/TransactionsPage'
import { PaymentLinksPage } from './pages/PaymentLinksPage'
import { WebhooksPage } from './pages/WebhooksPage'
import { ApiKeysPage } from './pages/ApiKeysPage'
import { SettingsPage } from './pages/SettingsPage'
import { clearSession, loadSession, saveSession } from './session'

export default function App() {
  const [credentials, setCredentials] = useState<Credentials | undefined>(() => loadSession())
  const navigate = useNavigate()

  const client = useMemo(
    () => (credentials ? new CheritoClient(credentials) : undefined),
    [credentials],
  )

  const connect = useCallback((next: Credentials, remember: boolean) => {
    if (remember) saveSession(next)
    setCredentials(next)
    navigate('/')
  }, [navigate])

  const disconnect = useCallback(() => {
    clearSession()
    setCredentials(undefined)
    navigate('/')
  }, [navigate])

  if (!client) return <ConnectPage onConnect={connect} />

  return (
    <AppShell gatewayUrl={client.gatewayUrl} onDisconnect={disconnect}>
      <Routes>
        <Route path="/" element={<OverviewPage client={client} />} />
        <Route path="/transactions" element={<TransactionsPage client={client} />} />
        <Route path="/payment-links" element={<PaymentLinksPage client={client} />} />
        <Route path="/webhooks" element={<WebhooksPage client={client} />} />
        <Route path="/api-keys" element={<ApiKeysPage client={client} />} />
        <Route path="/settings" element={<SettingsPage client={client} onDisconnect={disconnect} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
