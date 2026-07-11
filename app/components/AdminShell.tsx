// TARGET: autocore-npa/app/components/AdminShell.tsx
'use client'
// ═══════════════════════════════════════════════════════════════════════════
// ADMIN module shell — DealerCenter-style navy sidebar for the back-office
// pages (Administración, Auditoría, Inicial Diferida, Pagos por Confirmar,
// Ingresos, Banco, Conciliación) + links into the Tesorería module.
//
// PERMISSION-AWARE: each item declares the same visibility rule as the NavBar
// ADMIN dropdown, so an auditor (Deisi) sees only her sections. Purely
// presentational — every page keeps its own gate.
//
// RESPONSIVE (2026-07-10): bajo 1024px la columna fija desaparece (teléfonos
// en horizontal reportan 900-930px y la barra apretaba el contenido y cortaba
// el menú). En su lugar: una barra compacta del módulo con hamburguesa que
// abre el MISMO menú como drawer superpuesto, scrolleable, cerrable tocando
// afuera. En impresión no sale nada del chrome del módulo.
//
// Usage: <AdminShell active="auditoria">...page content...</AdminShell>
// ═══════════════════════════════════════════════════════════════════════════
import { ReactNode, useEffect, useState } from 'react'
import NavBar from './NavBar'
import { supabase } from '../supabase'
import { useNPAPermissions, NPAPermissions } from './useNPAPermissions'

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
  'admin': <Icon><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></Icon>,
  'auditoria': <Icon><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></Icon>,
  'inicial-diferida': <Icon><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /><path d="M9 16l2 2 4-4" /></Icon>,
  'por-confirmar': <Icon><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></Icon>,
  'ingresos': <Icon><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></Icon>,
  'banco': <Icon><rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" /></Icon>,
  'conciliacion': <Icon><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></Icon>,
  'tesoreria': <Icon><path d="M21 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" /><path d="M22 8h-7a2 2 0 0 0 0 8h7z" /><circle cx="17" cy="12" r="1" /></Icon>,
  'tesoreria-confirmar': <Icon><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></Icon>,
  'caja-chica': <Icon><path d="M20 7h-3V5a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" /><path d="M9 7V5h6v2" /></Icon>,
}

interface AdminItem {
  key: string
  label: string
  path: string
  show: (p: NPAPermissions) => boolean
}

// Visibility mirrors the NavBar ADMIN dropdown (never weaken these).
const GROUPS: { title: string; items: AdminItem[] }[] = [
  {
    title: 'Negocios',
    items: [
      { key: 'admin',            label: 'Administración',      path: '/admin',              show: p => p.npa_can_admin },
      { key: 'auditoria',        label: 'Auditoría',           path: '/auditoria',          show: p => p.npa_can_audit_deals },
      { key: 'inicial-diferida', label: 'Inicial Diferida',    path: '/inicial-diferida',   show: p => p.npa_can_audit_deals || p.npa_can_admin },
      { key: 'por-confirmar',    label: 'Pagos por Confirmar', path: '/admin/por-confirmar', show: p => p.npa_can_admin || p.npa_can_approve_deals },
    ],
  },
  {
    title: 'Finanzas',
    items: [
      { key: 'ingresos',     label: 'Ingresos',     path: '/ingresos',     show: p => p.npa_can_admin || p.npa_can_audit_deals || p.npa_can_approve_deals || p.tesoreria_admin || p.tesoreria_can_view_balance },
      { key: 'banco',        label: 'Banco',        path: '/banco',        show: p => p.npa_can_admin },
      { key: 'conciliacion', label: 'Conciliación', path: '/conciliacion', show: p => p.npa_can_admin },
    ],
  },
  {
    title: 'Tesorería',
    items: [
      { key: 'tesoreria',           label: 'Tesorería',     path: '/tesoreria',           show: p => p.tesoreria_can_view_balance || p.tesoreria_can_pickup || p.tesoreria_can_dispatch || p.tesoreria_can_approve_salida || p.tesoreria_admin },
      { key: 'tesoreria-confirmar', label: 'Por Confirmar', path: '/tesoreria/confirmar', show: p => p.tesoreria_can_confirm_fx || p.tesoreria_admin },
      { key: 'caja-chica',          label: 'Caja Chica',    path: '/tesoreria/caja-chica', show: p => p.tesoreria_can_register_cc_gasto || p.tesoreria_admin },
    ],
  },
]

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrador', administrador: 'Administrador', manager: 'Manager',
  gerente: 'Gerente', auditoria: 'Auditoría', gte_cobranza: 'Gte. Cobranza',
  asist_cobranza: 'Asist. Cobranza', tesoreria: 'Tesorería', facturacion: 'Facturación',
}

export default function AdminShell({ active, children }: { active: string; children: ReactNode }) {
  const { permissions, ready, role } = useNPAPermissions()
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Burbujas de pendientes (un count por cola al montar el shell, solo para
  // quienes pueden aprobar; best-effort — si falla, simplemente no hay burbuja):
  //   · Administración → negocios por aprobar (deals sin status APROBADO)
  //   · Pagos por Confirmar → pagos_recibidos en PENDING_REVIEW
  const [pagosPendientes, setPagosPendientes] = useState(0)
  const [dealsPendientes, setDealsPendientes] = useState(0)
  const canApprovePagos = permissions.npa_can_admin || permissions.npa_can_approve_deals
  useEffect(() => {
    if (!ready || !canApprovePagos) { setPagosPendientes(0); setDealsPendientes(0); return }
    let alive = true
    ;(async () => {
      try {
        const { count } = await supabase
          .from('pagos_recibidos')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'PENDING_REVIEW')
        if (alive) setPagosPendientes(count || 0)
      } catch { /* badge es best-effort */ }
      try {
        // "por aprobar" = status distinto de APROBADO, incluyendo NULL
        // (neq solo excluye no-nulos en PostgREST, por eso el or con is.null).
        const { count } = await supabase
          .from('deals')
          .select('id', { count: 'exact', head: true })
          .or('status.neq.APROBADO,status.is.null')
        if (alive) setDealsPendientes(count || 0)
      } catch { /* badge es best-effort */ }
    })()
    return () => { alive = false }
  }, [ready, canApprovePagos])

  // Tesorería → Por Confirmar: misma cuenta que el badge del NavBar
  // (comprobantes INGRESO pendientes + cuotas/diferidas en pending_review,
  // deduplicadas contra los comprobantes ya contados por referencia).
  const [fxPendientes, setFxPendientes] = useState(0)
  const canConfirmFx = permissions.tesoreria_can_confirm_fx || permissions.tesoreria_admin
  useEffect(() => {
    if (!ready || !canConfirmFx) { setFxPendientes(0); return }
    let alive = true
    ;(async () => {
      try {
        const [compRes, cuotaRes, difRes] = await Promise.all([
          (supabase.from('tesoreria_comprobantes').select('numero').eq('tipo', 'INGRESO').eq('revision_estado', 'pendiente') as any),
          (supabase.from('cobranza_cuota_pagos').select('referencia_pago').eq('status', 'pending_review').eq('is_reversal', false) as any),
          (supabase.from('compromisos_inicial_diferida_pagos').select('referencia').eq('status', 'pending_review').eq('is_reversal', false) as any),
        ])
        const compRows = Array.isArray(compRes.data) ? compRes.data : []
        const pendingNums = new Set(compRows.map((c: any) => c.numero).filter(Boolean))
        const cuotas = Array.isArray(cuotaRes.data) ? cuotaRes.data : []
        const difs = Array.isArray(difRes.data) ? difRes.data : []
        const sc = cuotas.filter((p: any) => !(p.referencia_pago && pendingNums.has(p.referencia_pago))).length
        const sd = difs.filter((p: any) => !(p.referencia && pendingNums.has(p.referencia))).length
        if (alive) setFxPendientes(compRows.length + sc + sd)
      } catch { /* badge es best-effort */ }
    })()
    return () => { alive = false }
  }, [ready, canConfirmFx])

  const badges: Record<string, number> = {
    'por-confirmar': pagosPendientes,
    'admin': dealsPendientes,
    'tesoreria-confirmar': fxPendientes,
  }

  const groups = ready
    ? GROUPS.map(g => ({ ...g, items: g.items.filter(i => i.show(permissions)) })).filter(g => g.items.length > 0)
    : []
  const activeLabel = GROUPS.flatMap(g => g.items).find(i => i.key === active)?.label || 'Administración'

  // El mismo menú se renderiza en la columna de escritorio y en el drawer móvil.
  const menu = (
    <>
      {groups.map(g => (
        <div key={g.title} style={{ padding: '8px 0 4px' }}>
          <div style={{ padding: '4px 16px 5px', fontSize: '9.5px', fontWeight: 700, letterSpacing: '1.5px', color: 'rgba(255,255,255,0.38)', textTransform: 'uppercase' }}>{g.title}</div>
          {g.items.map(item => {
            const isActive = active === item.key
            return (
              <button
                key={item.key}
                className={isActive ? undefined : 'adm-item'}
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
                <span style={{ flex: 1 }}>{item.label}</span>
                {(badges[item.key] || 0) > 0 && (
                  <span style={{ minWidth: '18px', height: '18px', padding: '0 5px', borderRadius: '999px', background: '#BB162B', color: '#fff', fontSize: '10px', fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
                    {badges[item.key]}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ))}
      {!ready && (
        <div style={{ padding: '14px 16px', fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>Cargando…</div>
      )}
    </>
  )

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-page)' }}>
      {/* hover needs CSS (inline styles can't express :hover); active items skip
          the class. Bajo 1024px la columna fija se oculta y aparece la barra
          compacta del módulo (los teléfonos en horizontal reportan 900-930px).
          En impresión no sale nada del chrome del módulo. */}
      <style>{`
        .adm-item:hover { background: rgba(255,255,255,0.07) !important; color: #fff !important; }
        .adm-mobilebar { display: none; }
        @media (max-width: 1023px) {
          .adm-aside { display: none !important; }
          .adm-mobilebar { display: flex; }
        }
        @media print {
          .adm-aside, .adm-mobilebar, .adm-drawer { display: none !important; }
        }
      `}</style>
      <NavBar />

      {/* ── Barra compacta del módulo (solo móvil/tablet) ─────────────────── */}
      <div
        className="adm-mobilebar"
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
          <div style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '1.5px', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' }}>Administración</div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeLabel}</div>
        </div>
      </div>

      {/* ── Drawer móvil (mismo menú, superpuesto y scrolleable) ──────────── */}
      {drawerOpen && (
        <div className="adm-drawer" style={{ position: 'fixed', inset: 0, zIndex: 1000 }} onClick={() => setDrawerOpen(false)}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(9,17,28,0.6)' }} />
          <div
            onClick={e => e.stopPropagation()}
            style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: '272px', maxWidth: '84vw', background: NAVY, overflowY: 'auto', boxShadow: '6px 0 24px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column' }}
          >
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
              <div>
                <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '2px', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase' }}>Módulo</div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: '#fff', marginTop: '2px' }}>Administración</div>
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
            {ready && role && (
              <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.08)', fontSize: '10px', fontWeight: 700, letterSpacing: '1px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>
                {ROLE_LABEL[role] || role}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'stretch' }}>

        {/* ── Sidebar de escritorio ─────────────────────────────────────────── */}
        <aside className="adm-aside" style={{ width: '204px', flexShrink: 0, background: NAVY, display: 'flex', flexDirection: 'column' }}>
          <div style={{ position: 'sticky', top: 0, display: 'flex', flexDirection: 'column', maxHeight: '100vh', overflowY: 'auto', minHeight: 'calc(100vh - 80px)' }}>
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '2px', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase' }}>Módulo</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#fff', marginTop: '2px' }}>Administración</div>
            </div>
            <div style={{ flex: 1 }}>{menu}</div>
            {ready && role && (
              <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.08)', fontSize: '10px', fontWeight: 700, letterSpacing: '1px', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>
                {ROLE_LABEL[role] || role}
              </div>
            )}
          </div>
        </aside>

        {/* ── Content (pages keep their own containers) ───────────────────── */}
        <main style={{ flex: 1, minWidth: 0 }}>
          {children}
        </main>
      </div>
    </div>
  )
}
