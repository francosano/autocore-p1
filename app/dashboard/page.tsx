// ═══════════════════════════════════════════════════════════════════════════

// TARGET: autocore-npa/app/dashboard/page.tsx

// Dashboard Hub — CRM-only fork.

//

// Layout B: KPI banner up top + department cards grid below.

// KPI matrix (role-aware): admin/manager/gerente → Inventario Stock.

// Departments: CRM, Inventario, Clientes (financial modules removed).

//

// Dept cards are permission-gated. No emojis — Lucide icons, monochrome.

// INSTALL: npm i lucide-react

// ═══════════════════════════════════════════════════════════════════════════

'use client'

import { useEffect, useState } from 'react'

import { useRouter } from 'next/navigation'

import { supabase } from '../supabase'

import NavBar from '../components/NavBar'

import { useNPAPermissions } from '../components/useNPAPermissions'

import { Target, Car, Users } from 'lucide-react'



// ─── Format helpers ───────────────────────────────────────────────────────

const fmt = (n: number) =>

  `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

const fmt2 = (n: number) =>

  `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtNum = (n: number) =>

  (n || 0).toLocaleString('en-US')



// ─── Styles ───────────────────────────────────────────────────────────────

const s: any = {

  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },

  content: { padding: '32px', maxWidth: '1500px', margin: '0 auto' },

  greeting: { marginBottom: 28 },

  greetingLabel: { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 2, marginBottom: 4 },

  greetingTitle: { fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 },

  greetingDate: { fontSize: 13, color: 'var(--text-secondary)' },



  // KPI banner

  kpiBanner: {

    display: 'grid',

    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',

    gap: 14,

    marginBottom: 32,

  },

  kpiCard: {

    background: 'var(--bg-card)',

    border: '1px solid var(--border)',

    borderRadius: 6,

    padding: '16px 18px',

    transition: 'border-color 0.15s',

  },

  kpiLabel: {

    fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)',

    textTransform: 'uppercase' as const, letterSpacing: 1.5,

    marginBottom: 8,

  },

  kpiValue: {

    fontSize: 26, fontWeight: 800, color: 'var(--text-primary)',

    fontVariantNumeric: 'tabular-nums' as const, letterSpacing: '-0.5px',

    lineHeight: 1.1,

  },

  kpiSub: {

    fontSize: 11, color: 'var(--text-muted)', marginTop: 6,

  },



  // Dept cards

  sectionLabel: {

    fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)',

    textTransform: 'uppercase' as const, letterSpacing: 2,

    marginBottom: 14,

  },

  cardGrid: {

    display: 'grid',

    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',

    gap: 14,

  },

  card: {

    background: 'var(--bg-card)',

    border: '1px solid var(--border)',

    borderRadius: 6,

    padding: 22,

    cursor: 'pointer',

    transition: 'all 0.18s',

    display: 'flex',

    flexDirection: 'column' as const,

    gap: 10,

    minHeight: 130,

    position: 'relative' as const,

  },

  cardIconWrap: {

    width: 44, height: 44,

    borderRadius: 6,

    background: 'rgba(187,22,43,0.08)',

    color: '#BB162B',

    display: 'flex', alignItems: 'center', justifyContent: 'center',

    transition: 'all 0.18s',

  },

  cardTitle: {

    fontSize: 15, fontWeight: 700, color: 'var(--text-primary)',

    letterSpacing: '-0.2px',

  },

  cardSub: {

    fontSize: 12, color: 'var(--text-secondary)',

    lineHeight: 1.4,

  },

  cardExtIcon: {

    position: 'absolute' as const, top: 18, right: 18,

    color: 'var(--text-muted)',

    opacity: 0.6,

  },

  loadingBox: {

    padding: 60, textAlign: 'center' as const, color: 'var(--text-secondary)',

  },

}



interface KPI {

  key: string

  label: string

  value: string

  sub?: string

  onClick?: () => void

  alert?: boolean

}



interface DeptCard {

  key: string

  title: string

  description: string

  icon: any

  external?: boolean

  show: boolean

  onClick: () => void

}



export default function DashboardPage() {

  const router = useRouter()

  const { permissions, role, loading: permsLoading } = useNPAPermissions()



  // ── KPI data state ─────────────────────────────────────────────────────

  const [kpiLoading, setKpiLoading] = useState(true)

  const [inventarioStock, setInventarioStock] = useState(0)



  const isAdmin = role === 'admin' || role === 'manager' || role === 'gerente' || role === 'administrador'



  // ── Determine which KPIs to show ───────────────────────────────────────

  const showInventario = isAdmin



  const showAnyKPI = showInventario



  useEffect(() => {

    if (permsLoading) return



    loadKPIs()

  // eslint-disable-next-line

  }, [permsLoading, role])



  async function loadKPIs() {

    setKpiLoading(true)

    const promises: Promise<void>[] = []



    // Inventario en Stock

    if (showInventario) {

      promises.push((async () => {

        const { count } = await supabase

          .from('inventory_units')

          .select('vin', { count: 'exact', head: true })

          .eq('estado', 'EN_STOCK')

        setInventarioStock(count || 0)

      })())

    }



    await Promise.allSettled(promises)

    setKpiLoading(false)

  }



  // ── Build KPI list ─────────────────────────────────────────────────────

  const kpis: KPI[] = []

  if (showInventario) {

    kpis.push({

      key: 'stock', label: 'Inventario en Stock',

      value: kpiLoading ? '…' : fmtNum(inventarioStock),

      sub: 'Unidades disponibles',

    })

  }



  // ── Build department cards (permission-gated) ──────────────────────────

  const cards: DeptCard[] = [

    {

      key: 'crm', title: 'CRM', description: 'Leads, oportunidades y seguimiento',

      icon: Target, show: permissions.npa_can_view_crm,

      onClick: () => router.push('/crm'),

    },

    {

      key: 'inventario', title: 'Inventario', description: 'Stock de unidades nuevas',

      icon: Car, show: permissions.can_view_inventory || permissions.can_manage_inventory,

      onClick: () => router.push('/inventario'),

    },

    {

      key: 'clientes', title: 'Clientes', description: 'Cartera de clientes',

      icon: Users, show: permissions.npa_can_view_clientes,

      onClick: () => router.push('/clientes'),

    },

  ]



  const visibleCards = cards.filter(c => c.show)



  if (permsLoading) {

    return (

      <div style={s.page}>

        <NavBar />

        <div style={s.loadingBox}>Cargando…</div>

      </div>

    )

  }



  // Date label (DD/MM/YYYY)

  const now = new Date()

  const dayLabel = now.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })



  return (

    <div style={s.page}>

      <NavBar />

      <div style={s.content}>



        {/* Greeting */}

        <div style={s.greeting}>

          <div style={s.greetingLabel}>AutoCore P1 — Prime One Auto Sales</div>

          <h1 style={s.greetingTitle}>Panel de Control</h1>

          <div style={s.greetingDate}>{dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1)}</div>

        </div>



        {/* KPI Banner */}

        {showAnyKPI && (

          <div style={s.kpiBanner}>

            {kpis.map(k => (

              <div key={k.key}

                style={{

                  ...s.kpiCard,

                  position: 'relative',

                  ...(k.alert ? { borderColor: '#BB162B' } : {}),

                  ...(k.onClick ? { cursor: 'pointer' } : {}),

                }}

                onClick={k.onClick}>

                {k.alert && !kpiLoading && (

                  <span style={{ position: 'absolute', top: -10, right: -10, minWidth: 24, height: 24, padding: '0 7px', borderRadius: 999, background: '#BB162B', color: '#fff', fontSize: 12.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(187,22,43,0.45)', border: '2px solid var(--bg-page, #fff)' }}>

                    {k.value}

                  </span>

                )}

                <div style={s.kpiLabel}>{k.label}</div>

                <div style={{ ...s.kpiValue, ...(k.alert ? { color: '#BB162B' } : {}) }}>{k.value}</div>

                {k.sub && <div style={s.kpiSub}>{k.sub}</div>}

              </div>

            ))}

          </div>

        )}



        {/* Department Cards */}

        <div>

          <div style={s.sectionLabel}>Departamentos</div>

          {visibleCards.length === 0 ? (

            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>

              No tienes acceso a ningún departamento. Contacta a un administrador.

            </div>

          ) : (

            <div style={s.cardGrid}>

              {visibleCards.map(c => {

                const Icon = c.icon

                return (

                  <div

                    key={c.key}

                    style={s.card}

                    onClick={c.onClick}

                    onMouseEnter={e => {

                      e.currentTarget.style.borderColor = '#BB162B'

                      e.currentTarget.style.transform = 'translateY(-1px)'

                      const wrap = e.currentTarget.querySelector('[data-icon-wrap]') as HTMLDivElement

                      if (wrap) {

                        wrap.style.background = '#BB162B'

                        wrap.style.color = '#fff'

                      }

                    }}

                    onMouseLeave={e => {

                      e.currentTarget.style.borderColor = 'var(--border)'

                      e.currentTarget.style.transform = 'translateY(0)'

                      const wrap = e.currentTarget.querySelector('[data-icon-wrap]') as HTMLDivElement

                      if (wrap) {

                        wrap.style.background = 'rgba(187,22,43,0.08)'

                        wrap.style.color = '#BB162B'

                      }

                    }}

                  >

                    <div data-icon-wrap="1" style={s.cardIconWrap}>

                      <Icon size={22} strokeWidth={1.75} />

                    </div>

                    <div style={s.cardTitle}>{c.title}</div>

                    <div style={s.cardSub}>{c.description}</div>

                  </div>

                )

              })}

            </div>

          )}

        </div>



      </div>

    </div>

  )

}