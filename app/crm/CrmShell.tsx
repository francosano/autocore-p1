// TARGET: autocore-npa/app/crm/CrmShell.tsx
'use client'
// ═══════════════════════════════════════════════════════════════════════════
// CRM module shell — DealerCenter-style navy sidebar shared by every CRM page.
//
// Usage: wrap the page content (replaces the old per-page Shell/<NavBar/>):
//   <CrmShell active="pipeline">{content}</CrmShell>
//   <CrmShell active="chats" fluid>...full-height content...</CrmShell>
//
// Pages keep their own permission gates; the sidebar is presentation only
// (every route here is already gated by npa_can_view_crm or stricter).
// Navigation uses window.location.href (static export convention).
//
// RESPONSIVE (2026-07-10): bajo 1024px la columna fija desaparece (los
// teléfonos en horizontal reportan 900-930px y la barra apretaba el contenido
// y cortaba el menú). En su lugar: barra compacta del módulo con hamburguesa
// que abre el MISMO menú como drawer superpuesto, scrolleable, cerrable
// tocando afuera. En impresión no sale nada del chrome del módulo.
// ═══════════════════════════════════════════════════════════════════════════
import { ReactNode, useState } from 'react'
import NavBar from '../components/NavBar'

const NAVY = '#16283E'
const NAVY_ACCENT = '#3B82F6'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {children}
    </svg>
  )
}

const ICONS: Record<string, ReactNode> = {
  dashboard: <Icon><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></Icon>,
  pipeline: <Icon><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></Icon>,
  tareas: <Icon><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></Icon>,
  calendario: <Icon><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></Icon>,
  chats: <Icon><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Icon>,
  recepcion: <Icon><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Icon>,
  'walk-ins': <Icon><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></Icon>,
  campanas: <Icon><path d="M3 11l18-8-8 18-2.5-7.5L3 11z" /></Icon>,
  pendientes: <Icon><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></Icon>,
  alertas: <Icon><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></Icon>,
  pulso: <Icon><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></Icon>,
  reportes: <Icon><line x1="12" y1="20" x2="12" y2="10" /><line x1="18" y1="20" x2="18" y2="4" /><line x1="6" y1="20" x2="6" y2="16" /></Icon>,
}

const GROUPS: { title: string; items: { key: string; label: string; path: string }[] }[] = [
  {
    title: 'Principal',
    items: [
      { key: 'dashboard',  label: 'Dashboard',  path: '/crm/dashboard' },
      { key: 'pipeline',   label: 'Pipeline',   path: '/crm' },
      { key: 'tareas',     label: 'Tareas',     path: '/crm/tareas' },
      { key: 'calendario', label: 'Calendario', path: '/crm/calendario' },
      { key: 'chats',      label: 'Chats',      path: '/crm/chats' },
    ],
  },
  {
    title: 'Captación',
    items: [
      { key: 'recepcion', label: 'Recepción', path: '/crm/recepcion' },
      { key: 'walk-ins',  label: 'Walk-ins',  path: '/crm/walk-ins' },
      { key: 'campanas',  label: 'Campañas',  path: '/crm/campanas' },
    ],
  },
  {
    title: 'Supervisión',
    items: [
      { key: 'pendientes', label: 'Pendientes', path: '/crm/pendientes' },
      { key: 'alertas',    label: 'Alertas',    path: '/crm/alertas' },
      { key: 'pulso',      label: 'Pulso',      path: '/crm/pulso' },
      { key: 'reportes',   label: 'Reportes',   path: '/crm/reportes' },
    ],
  },
]

export default function CrmShell({ active, children, maxWidth = 1200, fluid = false }: {
  active: string
  children: ReactNode
  /** content max width when not fluid (px) */
  maxWidth?: number
  /** fluid: no width cap / padding — for full-height layouts like Chats */
  fluid?: boolean
}) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const activeLabel = GROUPS.flatMap(g => g.items).find(i => i.key === active)?.label || 'CRM'

  // El mismo menú se renderiza en la columna de escritorio y en el drawer móvil.
  const menu = (
    <>
      {GROUPS.map(g => (
        <div key={g.title} style={{ padding: '8px 0 4px' }}>
          <div style={{ padding: '4px 16px 5px', fontSize: '9.5px', fontWeight: 700, letterSpacing: '1.5px', color: 'rgba(255,255,255,0.38)', textTransform: 'uppercase' }}>{g.title}</div>
          {g.items.map(item => {
            const isActive = active === item.key
            return (
              <button
                key={item.key}
                className={isActive ? undefined : 'crm-item'}
                onClick={() => { if (!isActive) window.location.href = item.path; else setDrawerOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '9px', width: '100%',
                  padding: '10px 16px', border: 'none', cursor: isActive ? 'default' : 'pointer', textAlign: 'left',
                  fontSize: '12.5px', fontWeight: 600,
                  background: isActive ? 'rgba(59,130,246,0.16)' : 'transparent',
                  color: isActive ? '#fff' : 'rgba(255,255,255,0.66)',
                  boxShadow: isActive ? `inset 3px 0 0 ${NAVY_ACCENT}` : 'none',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {ICONS[item.key]}
                {item.label}
              </button>
            )
          })}
        </div>
      ))}
    </>
  )

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-page)' }}>
      <style>{`
        .crm-item:hover { background: rgba(255,255,255,0.07) !important; color: #fff !important; }
        .crm-mobilebar { display: none; }
        @media (max-width: 1023px) {
          .crm-aside { display: none !important; }
          .crm-mobilebar { display: flex; }
        }
        @media print {
          .crm-aside, .crm-mobilebar, .crm-drawer { display: none !important; }
        }
      `}</style>
      <NavBar />

      {/* ── Barra compacta del módulo (solo móvil/tablet) ─────────────────── */}
      <div
        className="crm-mobilebar"
        style={{ alignItems: 'center', gap: '12px', background: NAVY, padding: '10px 14px', position: 'sticky', top: 0, zIndex: 90 }}
      >
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Abrir menú del módulo"
          style={{ background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: '6px', padding: '8px 10px', cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center' }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '1.5px', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' }}>CRM</div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeLabel}</div>
        </div>
      </div>

      {/* ── Drawer móvil (mismo menú, superpuesto y scrolleable) ──────────── */}
      {drawerOpen && (
        <div className="crm-drawer" style={{ position: 'fixed', inset: 0, zIndex: 1000 }} onClick={() => setDrawerOpen(false)}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(9,17,28,0.6)' }} />
          <div
            onClick={e => e.stopPropagation()}
            style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: '272px', maxWidth: '84vw', background: NAVY, overflowY: 'auto', boxShadow: '6px 0 24px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column' }}
          >
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
              <div>
                <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '2px', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase' }}>Módulo</div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: '#fff', marginTop: '2px' }}>CRM</div>
              </div>
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="Cerrar menú"
                style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', padding: '6px', display: 'flex' }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div style={{ flex: 1 }}>{menu}</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'stretch' }}>

        {/* ── Sidebar de escritorio ─────────────────────────────────────────── */}
        <aside className="crm-aside" style={{ width: '200px', flexShrink: 0, background: NAVY, display: 'flex', flexDirection: 'column' }}>
          <div style={{ position: 'sticky', top: 0, maxHeight: '100vh', overflowY: 'auto' }}>
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '2px', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase' }}>Módulo</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#fff', marginTop: '2px' }}>CRM</div>
            </div>
            {menu}
          </div>
        </aside>

        {/* ── Content ─────────────────────────────────────────────────────── */}
        <main style={{ flex: 1, minWidth: 0 }}>
          {fluid
            ? children
            : <div style={{ maxWidth: `${maxWidth}px`, margin: '0 auto', padding: '20px 24px 60px' }}>{children}</div>}
        </main>
      </div>
    </div>
  )
}
