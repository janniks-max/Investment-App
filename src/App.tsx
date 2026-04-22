import { useState } from 'react'
import Dashboard    from './pages/Dashboard'
import Fundamentals from './pages/Fundamentals'
import Signals      from './pages/Signals'
import StockDetail  from './pages/StockDetail'

type Page = 'dashboard' | 'fundamentals' | 'signals' | { detail: string }

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')

  const goDetail = (ticker: string) => setPage({ detail: ticker })
  const goBack   = () => setPage('dashboard')

  const navItems = [
    { id: 'dashboard',    label: 'Dashboard',    icon: '▦' },
    { id: 'fundamentals', label: 'Fundamentals', icon: '⊞' },
    { id: 'signals',      label: 'Signals',      icon: '◈' },
  ] as const

  const activePage = typeof page === 'string' ? page : 'none'

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--ink-950)' }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col w-56 flex-shrink-0 border-r border-ink-700"
        style={{ background: 'var(--ink-900)' }}
      >
        {/* Logo */}
        <div className="px-5 py-5 border-b border-ink-700">
          <div className="flex items-center gap-2">
            <span className="text-lg" style={{ color: 'var(--signal-blue)' }}>◈</span>
            <span className="font-display font-bold text-base tracking-widest text-white">
              STOCKPULSE
            </span>
          </div>
          <p
            className="text-xs mt-1"
            style={{ color: '#475569', fontFamily: 'JetBrains Mono' }}
          >
            Market Intelligence
          </p>
        </div>

        {/* Nav links */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(item => {
            const active = activePage === item.id
            return (
              <button
                key={item.id}
                onClick={() => setPage(item.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all"
                style={{
                  background: active ? 'rgba(61,142,255,0.12)' : 'transparent',
                  color:      active ? 'var(--signal-blue)' : '#94a3b8',
                  fontFamily: 'DM Sans',
                  fontWeight: active ? 500 : 400,
                  border:     active
                    ? '1px solid rgba(61,142,255,0.25)'
                    : '1px solid transparent',
                }}
              >
                <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{item.icon}</span>
                {item.label}
              </button>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-ink-700">
          <p className="text-xs" style={{ color: '#334155', fontFamily: 'JetBrains Mono' }}>
            v1.0.0
          </p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {typeof page === 'object' && 'detail' in page ? (
          <StockDetail ticker={page.detail} onBack={goBack} />
        ) : page === 'fundamentals' ? (
          <Fundamentals onSelectTicker={goDetail} />
        ) : page === 'signals' ? (
          <Signals onSelectTicker={goDetail} />
        ) : (
          <Dashboard onSelectTicker={goDetail} />
        )}
      </main>
    </div>
  )
}
