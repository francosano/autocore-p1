// ═══════════════════════════════════════════════════════════════════════════

// TARGET: autocore-npa/app/dashboard/page.tsx

// AutoCore NPA — Dashboard Hub (redesigned)

//

// Layout B: KPI banner up top + department cards grid below.

// KPI matrix (role-aware):

//   admin/manager/gerente → 5 KPIs: Posición Total, P&L Mes, Cuotas Vencidas,

//                                    Negocios sin Aprobar, Inventario Stock

//   auditoria             → 2 KPIs: Negocios sin Aprobar, Inventario Stock

//   tesoreria             → 1 KPI:  Posición Total

//   facturacion           → 1 KPI:  Caja Chica

//   bdc / vendedor        → no KPIs (just dept cards)

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

import {

  Target, Car, Users, CreditCard, ClipboardList, Wallet,

  DollarSign, Landmark, BarChart3, Folders, ExternalLink,

} from 'lucide-react'



// ─── Format helpers ───────────────────────────────────────────────────────

const fmt = (n: number) =>

  `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

const fmt2 = (n: number) =>

  `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtNum = (n: number) =>

  (n || 0).toLocaleString('en-US')



const COBRANZA_URL = 'https://portal.motocentro2.com'



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

  const [posicionTotal, setPosicionTotal] = useState(0)

  const [pnlMes, setPnlMes] = useState(0)

  const [cuotasVencidas, setCuotasVencidas] = useState(0)

  const [cuotasVencidasMonto, setCuotasVencidasMonto] = useState(0)

  const [negociosSinAprobar, setNegociosSinAprobar] = useState(0)

  const [inventarioStock, setInventarioStock] = useState(0)

  const [cajaChicaBalance, setCajaChicaBalance] = useState(0)

  const [pagosPorConfirmar, setPagosPorConfirmar] = useState(0)



  const isAdmin = role === 'admin' || role === 'manager' || role === 'gerente' || role === 'administrador'

  const isAuditoria = role === 'auditoria' || role === 'Auditoria'

  const isTesoreria = role === 'tesoreria'

  const isFacturacion = role === 'facturacion'



  // ── Determine which KPIs to show ───────────────────────────────────────

  const showPosicion       = isAdmin || isTesoreria

  const showPnlMes         = isAdmin

  const showCuotasVencidas = isAdmin

  const showNegocios       = isAdmin || isAuditoria

  const showInventario     = isAdmin || isAuditoria

  const showCajaChica      = isFacturacion

  // Bank ingresos (Zelle/Wire) awaiting Mirla's confirmation. Confirmers only.

  const showPagosPorConfirmar = permissions.tesoreria_can_confirm_fx || permissions.tesoreria_admin



  const showAnyKPI = showPosicion || showPnlMes || showCuotasVencidas || showNegocios || showInventario || showCajaChica || showPagosPorConfirmar



  useEffect(() => {

    if (permsLoading) return



    // v6 (2026-05-13): Role-route on entry. Tesorería-only users should never

    // see the admin dashboard — they live in /tesoreria/home. Heuristic: they

    // have a tesoreria_* flag but no admin/audit/CRM/inventory permission.

    const hasAnyTesoreriaPerm =

      permissions.tesoreria_can_pickup ||

      permissions.tesoreria_can_dispatch ||

      permissions.tesoreria_can_view_balance ||

      permissions.tesoreria_can_replenish_cc ||

      permissions.tesoreria_can_confirm_fx ||

      permissions.tesoreria_can_request_salida ||

      permissions.tesoreria_can_approve_salida ||

      permissions.tesoreria_can_register_cc_gasto ||

      permissions.tesoreria_admin ||

      (permissions as any).tesoreria_can_register_ingreso === true

    const hasAnyNonTesoreriaPerm =

      permissions.npa_can_admin ||

      permissions.npa_can_audit_deals ||

      permissions.npa_can_view_crm ||

      permissions.npa_can_view_clientes ||

      permissions.npa_can_view_management_pnl ||

      permissions.can_view_inventory ||

      permissions.can_manage_inventory

    if (hasAnyTesoreriaPerm && !hasAnyNonTesoreriaPerm) {

      router.replace('/tesoreria/home')

      return

    }



    loadKPIs()

  // eslint-disable-next-line

  }, [permsLoading, role])



  async function loadKPIs() {

    setKpiLoading(true)

    const now = new Date()

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)

    const today = now.toISOString().slice(0, 10)



    const promises: Promise<void>[] = []



    // Posición Total (sum of all tesoreria_ubicaciones)

    if (showPosicion) {

      promises.push((async () => {

        const { data } = await supabase

          .from('tesoreria_ubicaciones')

          .select('saldo_actual_usd')

          .eq('activa', true)

        const total = (data || []).reduce((sum: number, u: any) => sum + Number(u.saldo_actual_usd || 0), 0)

        setPosicionTotal(total)

      })())

    }



    // Caja Chica balance only

    if (showCajaChica) {

      promises.push((async () => {

        const { data } = await supabase

          .from('tesoreria_ubicaciones')

          .select('saldo_actual_usd')

          .eq('codigo', 'CAJA_CHICA')

          .single()

        setCajaChicaBalance(Number(data?.saldo_actual_usd || 0))

      })())

    }



    // Negocios sin Aprobar (deals not yet APROBADO)

    if (showNegocios) {

      promises.push((async () => {

        const { count } = await supabase

          .from('deals')

          .select('id', { count: 'exact', head: true })

          .neq('status', 'APROBADO')

        setNegociosSinAprobar(count || 0)

      })())

    }



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



    // P&L del Mes — admin-only, sum gross profit of deals approved this month

    if (showPnlMes) {

      promises.push((async () => {

        const { data } = await supabase

          .from('deals')

          .select('au_precio, au_gastos_admin, factura_compra_body_neto, factura_venta_body_neto, status, fecha_entrega')

          .eq('status', 'APROBADO')

          .gte('fecha_entrega', monthStart)

        let pnl = 0

        for (const d of (data || [])) {

          // Body-only ops gross: factura_venta_body − factura_compra_body + gastos_admin

          const fv = Number(d.factura_venta_body_neto || 0)

          const fc = Number(d.factura_compra_body_neto || 0)

          const ga = Number(d.au_gastos_admin || 0)

          pnl += fv - fc + ga

        }

        setPnlMes(pnl)

      })())

    }



    // Cuotas Vencidas — query Portal's cobranza_cuotas (shared backend)

    if (showCuotasVencidas) {

      promises.push((async () => {

        const { data, count } = await supabase

          .from('cobranza_cuotas')

          .select('monto_cuota', { count: 'exact' })

          .lt('fecha_vencimiento', today)

          .is('fecha_pago', null)

        setCuotasVencidas(count || 0)

        const totalMonto = (data || []).reduce((sum: number, c: any) => sum + Number(c.monto_cuota || 0), 0)

        setCuotasVencidasMonto(totalMonto)

      })())

    }



    // Pagos por confirmar — mirrors /tesoreria/confirmar's "Pendientes" count:

    // pending tesorería comprobantes PLUS cobranza pagos (cuota + diferida)

    // still pending_review that aren't already linked to a still-pending

    // comprobante (those are merged into the comprobante card, not double-counted).

    if (showPagosPorConfirmar) {

      promises.push((async () => {

        const [compRes, cuotaRes, difRes] = await Promise.all([

          supabase.from('tesoreria_comprobantes').select('numero').eq('tipo', 'INGRESO').eq('revision_estado', 'pendiente'),

          supabase.from('cobranza_cuota_pagos').select('referencia_pago').eq('status', 'pending_review').eq('is_reversal', false),

          supabase.from('compromisos_inicial_diferida_pagos').select('referencia').eq('status', 'pending_review').eq('is_reversal', false),

        ])

        const compRows = Array.isArray(compRes.data) ? compRes.data : []

        const pendingNums = new Set(compRows.map((c: any) => c.numero).filter(Boolean))

        const cuotas = Array.isArray(cuotaRes.data) ? cuotaRes.data : []

        const difs = Array.isArray(difRes.data) ? difRes.data : []

        const standaloneCuotas = cuotas.filter((p: any) => !(p.referencia_pago && pendingNums.has(p.referencia_pago))).length

        const standaloneDifs = difs.filter((p: any) => !(p.referencia && pendingNums.has(p.referencia))).length

        setPagosPorConfirmar(compRows.length + standaloneCuotas + standaloneDifs)

      })())

    }



    await Promise.allSettled(promises)

    setKpiLoading(false)

  }



  // ── Build KPI list ─────────────────────────────────────────────────────

  const kpis: KPI[] = []

  if (showPagosPorConfirmar) {

    kpis.push({

      key: 'porconfirmar', label: 'Pagos por Confirmar',

      value: kpiLoading ? '…' : fmtNum(pagosPorConfirmar),

      sub: pagosPorConfirmar > 0 ? 'Requieren tu confirmación' : 'Al día',

      alert: pagosPorConfirmar > 0,

      onClick: () => router.push('/tesoreria/confirmar'),

    })

  }

  if (showPosicion) {

    kpis.push({

      key: 'posicion', label: 'Posición Total',

      value: kpiLoading ? '…' : fmt(posicionTotal),

      sub: 'Caja + Punto Cobro + Caja Chica',

    })

  }

  if (showPnlMes) {

    kpis.push({

      key: 'pnl', label: 'P&L del Mes',

      value: kpiLoading ? '…' : fmt(pnlMes),

      sub: 'Utilidad bruta operativa',

    })

  }

  if (showCuotasVencidas) {

    kpis.push({

      key: 'cuotas', label: 'Cuotas Vencidas',

      value: kpiLoading ? '…' : fmtNum(cuotasVencidas),

      sub: cuotasVencidas > 0 ? fmt(cuotasVencidasMonto) + ' por cobrar' : 'Al día',

    })

  }

  if (showNegocios) {

    kpis.push({

      key: 'negocios', label: 'Negocios Pendientes',

      value: kpiLoading ? '…' : fmtNum(negociosSinAprobar),

      sub: 'Sin aprobación',

    })

  }

  if (showInventario) {

    kpis.push({

      key: 'stock', label: 'Inventario en Stock',

      value: kpiLoading ? '…' : fmtNum(inventarioStock),

      sub: 'Unidades disponibles',

    })

  }

  if (showCajaChica) {

    kpis.push({

      key: 'cc', label: 'Caja Chica',

      value: kpiLoading ? '…' : fmt2(cajaChicaBalance),

      sub: 'Balance actual',

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

    {

      key: 'cobranza', title: 'Cobranza', description: 'Préstamos y cuotas (Portal)',

      icon: CreditCard, external: true, show: true,

      onClick: () => window.open(COBRANZA_URL, '_blank', 'noopener,noreferrer'),

    },

    {

      key: 'auditoria', title: 'Auditoría', description: 'Revisión de negocios y documentos',

      icon: ClipboardList, show: permissions.npa_can_audit_deals,

      onClick: () => router.push('/auditoria'),

    },

    {

      key: 'tesoreria', title: 'Tesorería', description: 'Caja, ingresos y salidas',

      icon: Wallet,

      // FIX (2026-06-08): include tesoreria_can_register_ingreso so ingreso-only

      // staff (role auditoria_ingresos, e.g. Ángeles) see this tile. Their perm

      // lives in user_permissions and was simply never added to this gate when

      // the granular flag shipped on 2026-05-25.

      show: permissions.tesoreria_can_view_balance

         || permissions.tesoreria_can_pickup

         || permissions.tesoreria_can_dispatch

         || permissions.tesoreria_can_approve_salida

         || permissions.tesoreria_admin

         || (permissions as any).tesoreria_can_register_ingreso === true,

      // Full-treasury users -> /tesoreria. Ingreso-only users -> /tesoreria/home,

      // which shows them the single 'Nuevo Ingreso' tile. /tesoreria itself

      // bounces register-ingreso-only users back to /dashboard, so we must

      // never route them there.

      onClick: () => {

        const fullTreasury =

          permissions.tesoreria_can_view_balance ||

          permissions.tesoreria_can_pickup ||

          permissions.tesoreria_can_dispatch ||

          permissions.tesoreria_can_approve_salida ||

          permissions.tesoreria_admin

        router.push(fullTreasury ? '/tesoreria' : '/tesoreria/home')

      },

    },

    {

      key: 'cajachica', title: 'Caja Chica', description: 'Gastos menores y reposiciones',

      icon: DollarSign,

      show: permissions.tesoreria_can_register_cc_gasto || permissions.tesoreria_admin,

      onClick: () => router.push('/tesoreria/caja-chica'),

    },

    {

      key: 'banco', title: 'Banco', description: 'Movimientos bancarios',

      icon: Landmark, show: permissions.npa_can_admin,

      onClick: () => router.push('/banco'),

    },

    {

      key: 'reportes', title: 'Reportes', description: 'P&L, impuestos y forex',

      icon: BarChart3, show: permissions.npa_can_view_management_pnl,

      onClick: () => router.push('/reportes/'),

    },

    {

      key: 'admin', title: 'Administración de Negocios', description: 'Revisión y aprobación de deals',

      icon: Folders, show: permissions.npa_can_admin,

      onClick: () => router.push('/admin'),

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

          <div style={s.greetingLabel}>AutoCore NPA</div>

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

                    {c.external && (

                      <ExternalLink size={14} style={s.cardExtIcon} />

                    )}

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