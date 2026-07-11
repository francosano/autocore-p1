// TARGET: autocore-npa/app/components/NavBar.tsx

// ═══════════════════════════════════════════════════════════════════════════

// TARGET: autocore-npa/app/components/NavBar.tsx

// CRM-only fork: global nav covers Dashboard, CRM, Inventario, Clientes and

// Configuración. Financial modules (deals/tesorería/banco/cobranza/reportes)

// were removed from this fork; the global search covers leads + inventory.

// ═══════════════════════════════════════════════════════════════════════════

'use client'

import { useRouter, usePathname } from 'next/navigation'

import { useEffect, useState, useRef, useCallback } from 'react'

import { supabase } from '../supabase'

import { useNPAPermissions } from './useNPAPermissions'

import RatesBanner from './RatesBanner'



// ────────────────────────────────────────────────────────────────────────────

// Global Search Overlay (unchanged from v4 — kept verbatim)

// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────

// Global Search — CRM-only: searches crm_leads (sales pipeline) and

// inventory_units (vehicle stock, VIN/placa) in parallel.

//

// Click routing:

//   • Inventory: /inventario?vin=XXX

//   • Lead: /crm?search_lead=ID

//

// Recent searches: last 5 queries stored in localStorage. Shown when search

// opens empty.

// ────────────────────────────────────────────────────────────────────────────

interface LeadResult {

  id: string

  type: 'lead'

  nombre: string

  apellidos: string

  telefono: string

  email?: string

  modelo_interes?: string

  etapa: string

  heat_score: number

  asignado_nombre?: string

}

interface InventoryResult {

  id: string

  type: 'inventory'

  vin: string

  placa?: string

  modelo: string

  estado?: string

  ano?: number

  color?: string

}

type AnyResult = LeadResult | InventoryResult



const ETAPA_COLORS: Record<string, string> = {

  nuevo: '#6B7280', contactado: '#3B82F6', cita_agendada: '#8B5CF6',

  visita_showroom: '#F59E0B', oferta_presentada: '#EC4899',

  financiamiento: '#10B981', cerrado_ganado: '#059669', cerrado_perdido: '#EF4444',

}

const ETAPA_LABELS: Record<string, string> = {

  nuevo: 'Nuevo', contactado: 'Contactado', cita_agendada: 'Cita',

  visita_showroom: 'Showroom', oferta_presentada: 'Oferta',

  financiamiento: 'Financiamiento', cerrado_ganado: 'Cerrado ✓', cerrado_perdido: 'Perdido',

}

const heatColor = (s: number) => s >= 75 ? '#EF4444' : s >= 50 ? '#F59E0B' : s >= 25 ? '#3B82F6' : '#6B7280'



// Type-specific accents

const TYPE_META: Record<string, { label: string; color: string; icon: string }> = {

  lead:       { label: 'LEAD',        color: '#3B82F6', icon: '🎯' },

  inventory:  { label: 'INVENTARIO',  color: '#F59E0B', icon: '🚗' },

}



// ─── localStorage helpers for recent searches ──────────────────────────────

const RECENT_KEY = 'autocore.recent_searches.v1'

const loadRecent = (): string[] => {

  if (typeof window === 'undefined') return []

  try {

    const raw = window.localStorage.getItem(RECENT_KEY)

    return raw ? (JSON.parse(raw) as string[]).filter(Boolean).slice(0, 5) : []

  } catch { return [] }

}

const saveRecent = (q: string) => {

  if (typeof window === 'undefined' || !q.trim() || q.length < 2) return

  try {

    const existing = loadRecent().filter(x => x.toLowerCase() !== q.toLowerCase())

    const updated = [q, ...existing].slice(0, 5)

    window.localStorage.setItem(RECENT_KEY, JSON.stringify(updated))

  } catch {}

}



function GlobalSearch({ onClose }: { onClose: () => void }) {

  const router   = useRouter()

  const pathname = usePathname()



  const [query, setQuery]     = useState('')

  const [leads, setLeads]     = useState<LeadResult[]>([])

  const [inventory, setInventory] = useState<InventoryResult[]>([])

  const [loading, setLoading] = useState(false)

  const [selected, setSelected] = useState(0)

  const [recents, setRecents] = useState<string[]>([])

  const inputRef  = useRef<HTMLInputElement>(null)

  const timerRef  = useRef<any>(null)



  const inCRM       = pathname.startsWith('/crm')



  useEffect(() => {

    inputRef.current?.focus()

    setRecents(loadRecent())

  }, [])



  // Order results by section. Leads first — the CRM is the primary surface.

  const allResults: AnyResult[] = [...leads, ...inventory]



  useEffect(() => {

    const handler = (e: KeyboardEvent) => {

      if (e.key === 'Escape') onClose()

      if (e.key === 'ArrowDown') setSelected(s => Math.min(s + 1, allResults.length - 1))

      if (e.key === 'ArrowUp') setSelected(s => Math.max(s - 1, 0))

      if (e.key === 'Enter' && allResults[selected]) openResult(allResults[selected])

    }

    window.addEventListener('keydown', handler)

    return () => window.removeEventListener('keydown', handler)

    // eslint-disable-next-line

  }, [allResults, selected])



  const search = useCallback(async (q: string) => {

    if (!q.trim() || q.length < 2) {

      setLeads([]); setInventory([])

      return

    }

    setLoading(true)

    const clean = q.trim()

    const cleanDigits = clean.replace(/\D/g, '')

    const isPhone  = /^[\d\+\-\s]+$/.test(clean) && cleanDigits.length >= 4

    const isEmail  = clean.includes('@')

    const isVin    = /^[A-Za-z0-9]{17}$/.test(clean)

    const words = clean.split(/\s+/).filter(w => w.length >= 2)



    // ── Leads ─────────────────────────────────────────────────────────────

    const leadsPromise = (async () => {

      let lq = supabase.from('crm_leads')

        .select('id, nombre, apellidos, telefono, email, modelo_interes, etapa, heat_score, asignado_nombre')

      if (isPhone) lq = lq.ilike('telefono', `%${cleanDigits.slice(-8)}%`)

      else if (isEmail) lq = lq.ilike('email', `%${clean}%`)

      else {

        for (const word of words) lq = lq.or(`nombre.ilike.%${word}%,apellidos.ilike.%${word}%,modelo_interes.ilike.%${word}%,telefono.ilike.%${word}%`)

      }

      const { data } = await lq.order('heat_score', { ascending: false }).limit(6)

      return (data || []).map((d: any) => ({ ...d, type: 'lead' as const }))

    })()



    // ── Inventory ─────────────────────────────────────────────────────────

    const inventoryPromise = (async () => {

      let iq = (supabase.from('inventory_units').select('vin, placa, modelo, estado, ano, color') as any)

      if (isVin) iq = iq.eq('vin', clean.toUpperCase())

      else {

        for (const word of words) iq = iq.or(`vin.ilike.%${word}%,placa.ilike.%${word}%,modelo.ilike.%${word}%`)

      }

      const { data } = await iq.limit(6)

      // VIN is the primary key — use it as 'id' for the result

      return (data || []).map((u: any) => ({ ...u, id: u.vin, type: 'inventory' as const }))

    })()



    const [lD, iD] = await Promise.all([

      leadsPromise, inventoryPromise

    ])

    setLeads(lD)

    setInventory(iD)

    setSelected(0)

    setLoading(false)

  }, [])



  useEffect(() => {

    clearTimeout(timerRef.current)

    timerRef.current = setTimeout(() => search(query), 250)

    return () => clearTimeout(timerRef.current)

  }, [query, search])



  // ── Routing ─────────────────────────────────────────────────────────────

  const openResult = (result: AnyResult) => {

    saveRecent(query)

    onClose()

    if (result.type === 'lead') {

      router.push('/crm?search_lead=' + result.id)

    } else if (result.type === 'inventory') {

      router.push('/inventario?vin=' + encodeURIComponent(result.vin))

    }

  }

  const totalResults = allResults.length

  const showRecents = !query.trim() && recents.length > 0



  return (

    <div

      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '80px' }}

      onClick={e => { if (e.target === e.currentTarget) onClose() }}

    >

      <div style={{ width: '100%', maxWidth: '660px', background: 'var(--bg-card)', borderRadius: '14px', border: '1px solid var(--border)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)', overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 20px', borderBottom: totalResults > 0 || loading ? '1px solid var(--border)' : 'none' }}>

          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5">

            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>

          </svg>

          <input

            ref={inputRef}

            value={query}

            onChange={e => setQuery(e.target.value)}

            placeholder={inCRM ? 'Buscar leads, clientes...' : 'Buscar leads, inventario: cliente, VIN, modelo...'}

            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '16px', color: 'var(--text-primary)', fontFamily: 'inherit' }}

          />

          {loading && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Buscando...</div>}

          <kbd style={{ fontSize: '10px', color: 'var(--text-muted)', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '4px', padding: '2px 6px', fontFamily: 'monospace' }}>ESC</kbd>

        </div>



        {/* Recent searches when empty */}

        {showRecents && (

          <div style={{ padding: '12px 0' }}>

            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1.5, padding: '0 20px 8px' }}>

              Búsquedas recientes

            </div>

            {recents.map((r, idx) => (

              <div key={idx}

                onClick={() => setQuery(r)}

                style={{ padding: '10px 20px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-primary)', fontSize: 13, transition: 'background 0.1s' }}

                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(187,22,43,0.05)' }}

                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>

                <span style={{ color: 'var(--text-muted)' }}>↻</span>

                <span>{r}</span>

              </div>

            ))}

          </div>

        )}



        {/* No results hint */}

        {!showRecents && query.trim().length >= 2 && totalResults === 0 && !loading && (

          <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>

            Sin resultados para "<strong style={{ color: 'var(--text-primary)' }}>{query}</strong>"

          </div>

        )}



        {/* Results, grouped by category with headers */}

        {totalResults > 0 && (

          <div style={{ maxHeight: '480px', overflowY: 'auto' }}>

            {(() => {

              // Group results by type in the same order as allResults

              const grouped: { type: string; items: AnyResult[]; startIdx: number }[] = []

              let cursor = 0

              for (const r of allResults) {

                const lastGroup = grouped[grouped.length - 1]

                if (lastGroup && lastGroup.type === r.type) {

                  lastGroup.items.push(r)

                } else {

                  grouped.push({ type: r.type, items: [r], startIdx: cursor })

                }

                cursor++

              }

              return grouped.map((group, gIdx) => {

                const meta = TYPE_META[group.type]

                return (

                  <div key={gIdx}>

                    <div style={{

                      fontSize: 10, fontWeight: 700, color: meta.color,

                      textTransform: 'uppercase', letterSpacing: 1.5,

                      padding: '10px 20px 6px', background: 'var(--bg-deep)',

                      borderTop: gIdx > 0 ? '1px solid var(--border)' : 'none',

                      display: 'flex', alignItems: 'center', gap: 6,

                    }}>

                      <span>{meta.icon}</span>

                      <span>{meta.label}</span>

                      <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontWeight: 500 }}>{group.items.length}</span>

                    </div>

                    {group.items.map((result, localIdx) => {

                      const idx = group.startIdx + localIdx

                      const isSelected = idx === selected

                      return (

                        <div

                          key={`${result.type}-${result.id}`}

                          onClick={() => openResult(result)}

                          onMouseEnter={() => setSelected(idx)}

                          style={{

                            padding: '12px 20px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px',

                            background: isSelected ? 'rgba(187,22,43,0.08)' : 'transparent',

                            borderLeft: isSelected ? `3px solid ${meta.color}` : '3px solid transparent',

                            borderBottom: '1px solid var(--border)',

                          }}

                        >

                          {(() => {

                            switch (result.type) {

                              case 'lead': {

                                const r = result as LeadResult

                                return (<>

                                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: heatColor(r.heat_score) + '22', display: 'flex', alignItems: 'center', justifyContent: 'center', color: heatColor(r.heat_score), fontSize: '13px', fontWeight: 800 }}>

                                    {r.heat_score}

                                  </div>

                                  <div style={{ flex: 1, minWidth: 0 }}>

                                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>

                                      {r.nombre} {r.apellidos}

                                    </div>

                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>

                                      {ETAPA_LABELS[r.etapa] || r.etapa} · {r.modelo_interes || '—'} · {r.asignado_nombre || 'Sin asignar'}

                                    </div>

                                  </div>

                                </>)

                              }

                              case 'inventory': {

                                const r = result as InventoryResult

                                return (<>

                                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: meta.color + '22', color: meta.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>

                                    🚗

                                  </div>

                                  <div style={{ flex: 1, minWidth: 0 }}>

                                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>

                                      {r.modelo} {r.ano ? `· ${r.ano}` : ''} {r.color ? `· ${r.color}` : ''}

                                    </div>

                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>

                                      VIN {r.vin} {r.placa ? ` · ${r.placa}` : ''} {r.estado ? ` · ${r.estado}` : ''}

                                    </div>

                                  </div>

                                </>)

                              }

                            }

                          })()}

                        </div>

                      )

                    })}

                  </div>

                )

              })

            })()}

          </div>

        )}

      </div>

    </div>

  )

}



// ────────────────────────────────────────────────────────────────────────────

// Dropdown item shape (used by the CRM badge aggregation)

// ────────────────────────────────────────────────────────────────────────────

interface DropdownItem {

  label: string

  path: string

  show: boolean

  badge?: number

}



// ────────────────────────────────────────────────────────────────────────────

// MAIN NAVBAR

// ────────────────────────────────────────────────────────────────────────────

export default function NavBar() {

  const router   = useRouter()

  const pathname = usePathname()

  const [email, setEmail] = useState<string>('')

  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  const [searchOpen, setSearchOpen] = useState(false)

  const { permissions, loading: permsLoading } = useNPAPermissions()

  // ── CRM "Tareas" badge: due/overdue reminders for the current rep. ──────────
  const [tareasDue, setTareasDue] = useState(0)
  useEffect(() => {
    if (!permissions.npa_can_view_crm) { setTareasDue(0); return }
    let alive = true
    ;(async () => {
      try {
        const { data } = await supabase.rpc('crm_tareas_pendientes_count')
        if (alive) setTareasDue(typeof data === 'number' ? data : 0)
      } catch { /* non-fatal — badge just won't show */ }
    })()
    return () => { alive = false }
  }, [permissions.npa_can_view_crm])



  // ── Top-level items ──────────────────────────────────────────────────────

  const TOP_NAV = [

    { label: 'Dashboard',   path: '/dashboard',  show: permissions.npa_can_view_dashboard },

    { label: 'CRM',         path: '/crm',        show: permissions.npa_can_view_crm },

    { label: 'Inventario',  path: '/inventario', show: permissions.can_view_inventory || permissions.can_manage_inventory },

    { label: 'Clientes',    path: '/clientes',   show: permissions.npa_can_view_clientes },

    { label: 'Configuración', path: '/settings', show: permissions.npa_can_admin },

  ]

  // ── CRM dropdown items ───────────────────────────────────────────────────
  const CRM_ITEMS: DropdownItem[] = [
    { label: 'Dashboard',  path: '/crm/dashboard',  show: permissions.npa_can_view_crm },
    { label: 'Pipeline',   path: '/crm',            show: permissions.npa_can_view_crm },
    { label: 'Campañas',   path: '/crm/campanas',   show: permissions.npa_can_view_crm },
    { label: 'Calendario', path: '/crm/calendario', show: permissions.npa_can_view_crm },
    { label: 'Tareas',     path: '/crm/tareas',     show: permissions.npa_can_view_crm, badge: tareasDue },
    { label: 'Recepción',  path: '/crm/recepcion',  show: permissions.npa_can_view_crm },
    { label: 'Reportes',   path: '/crm/reportes',   show: permissions.npa_can_view_crm },
    { label: 'Pulso',      path: '/crm/pulso',      show: permissions.npa_can_view_crm },
    { label: 'Pendientes', path: '/crm/pendientes', show: permissions.npa_can_view_crm },
    { label: 'Walk-ins', path: '/crm/walk-ins', show: permissions.npa_can_view_crm },
  ]
  const crmActive = pathname === '/crm' || pathname.startsWith('/crm/')

  // CRM es un LINK directo al dashboard del módulo (sidebar CrmShell navega
  // dentro). El badge de tareas vencidas se conserva sobre el botón.
  const crmBadgeTotal = CRM_ITEMS.reduce((n, i) => n + ((i.show && i.badge) || 0), 0)



  useEffect(() => {

    const saved = (localStorage.getItem('autocore-theme') as 'dark' | 'light') || 'dark'

    setTheme(saved)

    document.documentElement.setAttribute('data-theme', saved)

  }, [])



  useEffect(() => {

    supabase.auth.getUser().then(({ data }) => {

      if (data.user?.email) setEmail(data.user.email)

    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {

      if (event === 'SIGNED_IN' && session?.user) {

        await supabase.from('activity_log').insert({

          user_id: session.user.id, user_email: session.user.email,

          action: 'user_login', target_type: 'session', target_id: session.user.id,

          details: { email: session.user.email, login_at: new Date().toISOString() },

        })

      }

    })

    return () => subscription.unsubscribe()

  }, [])



  useEffect(() => {

    const handler = (e: KeyboardEvent) => {

      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {

        e.preventDefault()

        setSearchOpen(true)

      }

    }

    window.addEventListener('keydown', handler)

    return () => window.removeEventListener('keydown', handler)

  }, [])



  const toggleTheme = () => {

    const next = theme === 'dark' ? 'light' : 'dark'

    setTheme(next)

    document.documentElement.setAttribute('data-theme', next)

    localStorage.setItem('autocore-theme', next)

  }



  // bfcache guard: when this page is restored from the browser's back/forward

  // cache, force a fresh load so auth re-bootstraps instead of restoring a

  // frozen, half-permissioned snapshot (the empty-dashboard-on-back symptom).

  useEffect(() => {

    const onPageShow = (e: PageTransitionEvent) => {

      if (e.persisted) window.location.reload()

    }

    window.addEventListener('pageshow', onPageShow)

    return () => window.removeEventListener('pageshow', onPageShow)

  }, [])



  const handleLogout = async () => {

    // Clear the local session FIRST so logout always takes effect even if the

    // network signOut stalls under multi-tab Web-Lock contention — the bug where

    // "Salir" looked dead and left you on the same page. Then fire signOut

    // time-boxed, and hard-REPLACE to '/' so this page leaves history and a

    // browser-back can't return into a stale/half-loaded screen.

    try {

      Object.keys(localStorage).forEach(k => {

        if (k.startsWith('sb-')) localStorage.removeItem(k)

      })

    } catch {}

    try {

      await Promise.race([

        supabase.auth.signOut(),

        new Promise(res => setTimeout(res, 1500)),

      ])

    } catch { /* ignore */ }

    window.location.replace('/')

  }



  const handleBack = () => {

    // Universal "go back" that survives the permission-gated nav being hidden.

    // Uses in-app history when there is somewhere to return to, else falls back

    // to the dashboard (e.g. opened via a deep link or a fresh tab).

    if (typeof window !== 'undefined' && window.history.length > 1) {

      window.history.back()

    } else {

      window.location.href = '/dashboard'

    }

  }



  const navBtnStyle = (isActive: boolean) => ({

    fontFamily: 'Rajdhani, sans-serif',

    fontWeight: 600, fontSize: '12px', letterSpacing: '0.08em',

    textTransform: 'uppercase' as const,

    padding: '5px 14px',

    border: isActive ? '1px solid rgba(187,22,43,0.35)' : '1px solid transparent',

    background: isActive ? 'rgba(187,22,43,0.12)' : 'transparent',

    color: isActive ? '#BB162B' : 'var(--text-secondary)',

    cursor: 'pointer', transition: 'all 0.15s',

    borderRadius: '6px',

    display: 'flex', alignItems: 'center',

  })



  return (

    <>

      {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}



      <nav style={{

        background: 'var(--bg-nav)', borderBottom: '1px solid var(--border)',

        padding: '0 28px', display: 'flex', alignItems: 'center',

        height: '52px', gap: '24px', position: 'sticky', top: 0, zIndex: 100,

        transition: 'background 0.35s ease, border-color 0.35s ease',

      }}>

        <button

          onClick={() => router.push('/dashboard')}

          title="Ir al Dashboard"

          style={{

            fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '18px',

            letterSpacing: '0.04em', color: 'var(--text-primary)', whiteSpace: 'nowrap',

            flexShrink: 0, background: 'transparent', border: 'none',

            padding: '4px 6px', borderRadius: '4px', cursor: 'pointer',

            transition: 'opacity 0.15s ease, background 0.15s ease',

          }}

          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(187,22,43,0.08)' }}

          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}

        >

          AUTOCORE <span style={{ color: '#BB162B' }}>NPA</span>

        </button>



        <div style={{ width: '1px', height: '22px', background: 'var(--border)', flexShrink: 0 }} />



        {/* Universal back button — NOT permission-gated, so it works even when

            the nav menu is hidden / permissions are still settling. Hidden on

            the dashboard (home) where "back" has no meaning. */}

        {pathname !== '/dashboard' && (

          <button

            onClick={handleBack}

            title="Atrás"

            aria-label="Atrás"

            style={{

              flexShrink: 0, display: 'flex', alignItems: 'center', gap: '5px',

              background: 'transparent', border: '1px solid var(--border)',

              color: 'var(--text-secondary)', borderRadius: '7px',

              padding: '6px 11px', cursor: 'pointer', fontSize: '13px', fontWeight: 600,

              fontFamily: 'var(--font-inter), Inter, sans-serif',

              transition: 'background 0.15s ease',

            }}

            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(187,22,43,0.08)' }}

            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}

          >

            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">

              <path d="M19 12H5" />

              <path d="M12 19l-7-7 7-7" />

            </svg>

            Atrás

          </button>

        )}



        <div style={{ display: 'flex', gap: '4px', flex: 1, alignItems: 'center' }}>

          {!permsLoading && (

            <>

              {/* Dashboard */}

              {TOP_NAV[0].show && (

                <button onClick={() => router.push('/dashboard')}

                  style={navBtnStyle(pathname === '/dashboard')}>

                  Dashboard

                </button>

              )}

              {/* CRM — link directo al dashboard del módulo (sidebar CrmShell navega dentro) */}
              {TOP_NAV[1].show && (
                <button
                  onClick={() => router.push('/crm/dashboard')}
                  style={{ ...navBtnStyle(crmActive), display: 'flex', alignItems: 'center', gap: 6 }}>
                  CRM
                  {crmBadgeTotal > 0 && (
                    <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, background: '#BB162B', color: '#fff', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>{crmBadgeTotal}</span>
                  )}
                </button>
              )}
              {/* Inventario */}

              {TOP_NAV[2].show && (

                <button onClick={() => router.push('/inventario')}

                  style={navBtnStyle(pathname === '/inventario' || pathname.startsWith('/inventario/'))}>

                  Inventario

                </button>

              )}

              {/* Clientes */}

              {TOP_NAV[3].show && (

                <button onClick={() => router.push('/clientes')}

                  style={navBtnStyle(pathname === '/clientes' || pathname.startsWith('/clientes/'))}>

                  Clientes

                </button>

              )}

              {/* Configuración */}

              {TOP_NAV[4].show && (

                <button onClick={() => router.push('/settings')}

                  style={navBtnStyle(pathname === '/settings' || pathname.startsWith('/settings/'))}>

                  Configuración

                </button>

              )}

            </>

          )}

        </div>



        {/* Right side */}

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginLeft: 'auto' }}>

          <button

            onClick={() => setSearchOpen(true)}

            style={{

              display: 'flex', alignItems: 'center', gap: '8px',

              background: 'var(--bg-deep)', border: '1px solid var(--border)',

              borderRadius: '8px', padding: '5px 12px', cursor: 'pointer',

              color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'Rajdhani, sans-serif',

              letterSpacing: '0.05em', transition: 'all 0.2s',

            }}

            onMouseEnter={e => { e.currentTarget.style.borderColor = '#BB162B44'; e.currentTarget.style.color = 'var(--text-primary)' }}

            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}

          >

            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">

              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>

            </svg>

            <span>Buscar</span>

            <kbd style={{

              fontSize: '9px', background: 'var(--bg-card)', border: '1px solid var(--border)',

              borderRadius: '3px', padding: '1px 5px', fontFamily: 'monospace', color: 'var(--text-muted)',

            }}>⌘K</kbd>

          </button>



          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>

            {email}

          </span>



          <button className="theme-toggle" onClick={toggleTheme} title="Cambiar tema">

            <span className="theme-toggle-icon" style={{ opacity: theme === 'dark' ? 1 : 0.3 }}>🌙</span>

            <div className="theme-toggle-track"><div className="theme-toggle-thumb" /></div>

            <span className="theme-toggle-label">{theme === 'dark' ? 'OSCURO' : 'CLARO'}</span>

            <span className="theme-toggle-icon" style={{ opacity: theme === 'light' ? 1 : 0.3 }}>☀</span>

          </button>



          <button onClick={handleLogout}

            style={{

              background: 'transparent', border: '1px solid var(--border)',

              borderRadius: '6px', padding: '5px 12px', cursor: 'pointer',

              color: 'var(--text-secondary)', fontSize: '11px',

              fontFamily: 'Rajdhani, sans-serif', fontWeight: 600,

              letterSpacing: '0.05em', textTransform: 'uppercase',

              transition: 'all 0.15s',

            }}

            onMouseEnter={e => { e.currentTarget.style.borderColor = '#BB162B'; e.currentTarget.style.color = '#BB162B' }}

            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)' }}

          >

            Salir

          </button>

        </div>

      </nav>



      <RatesBanner />

    </>

  )

}