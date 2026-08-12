import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  Bitcoin,
  Key,
  LayoutDashboard,
  Link2,
  LogOut,
  Menu,
  Receipt,
  Settings,
  Webhook,
  X,
} from 'lucide-react'
import type { ReactNode } from 'react'

const NAV_ITEMS = [
  { path: '/', label: 'Overview', icon: LayoutDashboard },
  { path: '/transactions', label: 'Transactions', icon: Receipt },
  { path: '/payment-links', label: 'Payment Links', icon: Link2 },
  { path: '/webhooks', label: 'Webhooks', icon: Webhook },
  { path: '/api-keys', label: 'API Keys', icon: Key },
  { path: '/settings', label: 'Settings', icon: Settings },
]

export function Sidebar({ onNavigate, onDisconnect }: { onNavigate?: () => void; onDisconnect: () => void }) {
  const location = useLocation()

  return (
    <>
      <div className="brand">
        <div className="brand-mark">
          <Bitcoin size={26} />
        </div>
        <h2 className="text-gradient" style={{ fontSize: '1.4rem', margin: 0 }}>Cherito</h2>
      </div>

      <nav className="nav">
        {NAV_ITEMS.map((item) => {
          const isActive = location.pathname === item.path
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`nav-item${isActive ? ' active' : ''}`}
              onClick={onNavigate}
            >
              <item.icon size={19} />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <button type="button" className="nav-item disconnect" onClick={onDisconnect}>
        <LogOut size={19} />
        Disconnect
      </button>
    </>
  )
}

export function AppShell({
  gatewayUrl,
  onDisconnect,
  children,
}: {
  gatewayUrl: string
  onDisconnect: () => void
  children: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="app-container">
      <button
        type="button"
        className="mobile-menu-button"
        aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {menuOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <Sidebar onNavigate={() => setMenuOpen(false)} onDisconnect={onDisconnect} />
      </aside>

      <main className="main-content">
        <div className="gateway-strip">
          Gateway: <code>{gatewayUrl}</code>
        </div>
        {children}
      </main>
    </div>
  )
}
