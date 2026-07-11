'use client'
// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/ingresos/page.tsx
// AutoCore NPA — Ingresos (unified view of all pagos registered by auditoría)
//
// Phase 1 (2026-05-15):
//   • Flattens deals.pagos[] across every deal into one row per pago
//   • Two independent verification signals:
//       🟢 Banco ✓   (auto, from /banco autoMatch or /admin quick-recon)
//       🔵 Admin ✓   (manual, from this page — admin/manager click toggle)
//   • Both signals carry timestamps + actor for audit
//   • Sortable: fecha desc, monto desc, etc.
//   • Filters: date range, método, status (banco/admin/both/none), banco, search
//   • Row click → opens parent deal (admin if admin perm, else auditoría)
//
// Permissions:
//   • Admin/manager/auditoría/tesoreria_admin/balance → can view
//   • Admin or approver → can toggle 🔵 Admin ✓
//   • Cobranza-only → blocked (redirected to /dashboard)
// ═══════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '../supabase'
import AdminShell from '../components/AdminShell'
import { useNPAPermissions } from '../components/useNPAPermissions'

const fmt$ = (n: number) => `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtBs = (n: number) => `Bs ${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (iso?: string | null) => { if (!iso) return '—'; const [y, m, d] = iso.split('T')[0].split('-'); return `${d}/${m}/${y}` }
const fmtDateTime = (iso?: string | null) => {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  } catch { return iso }
}

// One flattened row = one pago, from ANY of 3 sources
interface IngresoRow {
  // Discriminator
  source: 'deal' | 'cobranza' | 'diferida'
  row_key: string             // unique key for React (e.g. "deal:abc:0", "cobranza:xyz", "diferida:def")

  // Common pago fields
  fecha: string | null
  metodo: string
  monto_usd: number
  monto_bs: number
  referencia: string | null
  comprobante_url: string | null

  // Verification stamps (deals only have these in jsonb; cobranza/diferida have bank_tx_id col)
  verified_by_bank: boolean
  verified_at: string | null
  bank_match_strength: string | null
  admin_checked: boolean
  admin_checked_at: string | null
  admin_checked_by_name: string | null

  // Parent record — varies by source
  parent_id: string                    // deal.id OR contrato.id OR compromiso.id
  parent_label: string                 // negocio#, factura#, or compromiso ref
  cliente_nombre: string
  cliente_apellidos: string
  banco: string | null
  parent_created_at: string | null
  vehiculo_modelo: string | null
  auditor_name: string | null

  // Source-specific
  pago_idx?: number                    // only for source=deal (position in deals.pagos[])
  deal_id_for_admin_route?: string     // for cobranza: the underlying deal_id (if any) for routing
  cobranza_pago_id?: string
  diferida_pago_id?: string
  cobranza_status?: string             // pending_review|approved|paid|rejected — for source=cobranza
  deal_status?: string                 // BORRADOR|APROBADO — for source=deal
}

const METODO_COLOR: Record<string, string> = {
  'Zelle Roframi': '#10B981',
  'Zelle Motocentro': '#10B981',
  'Zelle Externo': '#34D399',
  'Wire Transfer Roframi': '#3B82F6',
  'Wire Transfer Motocentro': '#3B82F6',
  'Wire Transfer Panama': '#6366F1',
  'Efectivo Caja': '#F59E0B',
  'Efectivo USD': '#F59E0B',
  'Bolívar': '#EC4899',
  'Saldo a Financiar': '#8B5CF6',
  'Retención': '#6B7280',
  'PIVCA': '#A855F7',
}
const colorFor = (m: string) => METODO_COLOR[m] || '#6B7280'

// ──────────────────────────────────────────────────────────────────────────
// Concurrent-safe pago mutation (mirrors the pattern in /banco/page.tsx).
// Read deal.pagos fresh from DB, mutate the array, write back.
// ──────────────────────────────────────────────────────────────────────────
async function mutatePago(
  dealId: string,
  pagoIdx: number,
  mutate: (pago: any) => any
): Promise<{ ok: boolean; error?: string; newPagos?: any[] }> {
  const { data: fresh, error: readErr } = await supabase
    .from('deals')
    .select('pagos, total_recibido')
    .eq('id', dealId)
    .single()
  if (readErr || !fresh) return { ok: false, error: readErr?.message || 'No se pudo leer el deal' }

  const pagos: any[] = Array.isArray(fresh.pagos) ? [...fresh.pagos] : []
  if (pagoIdx < 0 || pagoIdx >= pagos.length) return { ok: false, error: 'Pago no encontrado en la base de datos' }

  pagos[pagoIdx] = mutate(pagos[pagoIdx])

  const total_recibido = pagos.reduce((s, p: any) => s + (parseFloat(p.monto_usd) || 0), 0)
  const { error: writeErr } = await supabase
    .from('deals')
    .update({ pagos, total_recibido })
    .eq('id', dealId)
  if (writeErr) return { ok: false, error: writeErr.message }
  return { ok: true, newPagos: pagos }
}

function IngresosPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { permissions, loading: permsLoading } = useNPAPermissions()

  const [deals, setDeals] = useState<any[]>([])
  // Phase 5 cross-app: cobranza pagos (Portal) + diferida pagos (NPA) joined here
  const [cobranzaPagos, setCobranzaPagos] = useState<any[]>([])
  const [diferidaPagos, setDiferidaPagos] = useState<any[]>([])
  const [contratosMap, setContratosMap] = useState<Map<string, any>>(new Map())
  const [compromisosMap, setCompromisosMap] = useState<Map<string, any>>(new Map())
  const [userMap, setUserMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [currentUserId, setCurrentUserId] = useState<string>('')

  // Filters
  const [search, setSearch] = useState('')
  const [filterMetodo, setFilterMetodo] = useState<string>('ALL')
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'BANCO' | 'ADMIN' | 'BOTH' | 'NONE'>('ALL')
  const [filterDealStatus, setFilterDealStatus] = useState<'ALL' | 'BORRADOR' | 'APROBADO'>('ALL')
  const [filterBanco, setFilterBanco] = useState<string>('ALL')
  const [filterTipo, setFilterTipo] = useState<'ALL' | 'deal' | 'cobranza' | 'diferida'>('ALL')
  const [fechaDesde, setFechaDesde] = useState<string>('')
  const [fechaHasta, setFechaHasta] = useState<string>('')
  const [sortBy, setSortBy] = useState<'fecha' | 'monto' | 'cliente'>('fecha')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const canToggleAdmin = permissions.npa_can_admin || permissions.npa_can_approve_deals
  const canView = permissions.npa_can_admin
    || permissions.npa_can_audit_deals
    || permissions.npa_can_approve_deals
    || permissions.tesoreria_admin
    || permissions.tesoreria_can_view_balance
  const isAdmin = !!permissions.npa_can_admin

  // ── Permission gate ───────────────────────────────────────────────────
  useEffect(() => {
    if (permsLoading) return
    if (!canView) router.replace('/dashboard')
  }, [permsLoading, canView, router])

  // ── Load all 3 sources ────────────────────────────────────────────────
  const load = async () => {
    setLoading(true)
    const { data: authData } = await supabase.auth.getUser()
    if (authData.user) setCurrentUserId(authData.user.id)

    const [{ data: dealsData }, { data: ccp }, { data: dfp }] = await Promise.all([
      supabase
        .from('deals')
        .select('id, negocio_num, cliente_nombre, cliente_apellidos, banco, status, created_at, created_by, pagos, vendedor, vehiculo_modelo')
        .order('created_at', { ascending: false }),
      supabase
        .from('cobranza_cuota_pagos')
        .select('id, cuota_id, contrato_id, monto_usd, fecha_pago, metodo_pago, referencia_pago, comprobante_url, status, source_app, is_reversal, bank_tx_id, bank_match_strength, registered_by, created_at')
        .eq('is_reversal', false)
        .order('fecha_pago', { ascending: false }),
      supabase
        .from('compromisos_inicial_diferida_pagos')
        .select('id, compromiso_id, deal_id, monto_usd, fecha, metodo, referencia, comentario, is_reversal, bank_tx_id, bank_match_strength, registered_by, created_at')
        .eq('is_reversal', false)
        .order('fecha', { ascending: false }),
    ])

    setDeals(dealsData || [])
    setCobranzaPagos(ccp || [])
    setDiferidaPagos(dfp || [])

    // Parent lookups for cobranza / diferida
    const contratoIds = Array.from(new Set((ccp || []).map((p: any) => p.contrato_id).filter(Boolean)))
    const compromisoIds = Array.from(new Set((dfp || []).map((p: any) => p.compromiso_id).filter(Boolean)))
    let contratosM = new Map<string, any>()
    let compromisosM = new Map<string, any>()
    if (contratoIds.length > 0) {
      const { data: contratos } = await supabase
        .from('cobranza_contratos')
        .select('id, cliente_nombre, cliente_cedula, modelo, placa, factura_numero, banco, status')
        .in('id', contratoIds)
      for (const c of (contratos || [])) contratosM.set(c.id, c)
    }
    if (compromisoIds.length > 0) {
      const { data: compromisos } = await supabase
        .from('compromisos_inicial_diferida')
        .select('id, cliente_nombre, cliente_rif, deal_id, estado')
        .in('id', compromisoIds)
      for (const c of (compromisos || [])) compromisosM.set(c.id, c)
    }
    setContratosMap(contratosM)
    setCompromisosMap(compromisosM)

    // User-name map: deals.created_by + admin_checked_by + cobranza registered_by + diferida registered_by
    const userIds = new Set<string>()
    for (const d of (dealsData || [])) {
      if (d.created_by) userIds.add(d.created_by)
      const pagos: any[] = Array.isArray(d.pagos) ? d.pagos : []
      for (const p of pagos) {
        if (p._admin_checked_by) userIds.add(p._admin_checked_by)
      }
    }
    for (const p of (ccp || [])) { if (p.registered_by) userIds.add(p.registered_by) }
    for (const p of (dfp || [])) { if (p.registered_by) userIds.add(p.registered_by) }
    const idsArr = Array.from(userIds)
    let nameMap = new Map<string, string>()
    if (idsArr.length > 0) {
      const { data: roleRows } = await supabase
        .from('user_roles')
        .select('user_id, nombre, role')
        .in('user_id', idsArr)
      for (const r of (roleRows || [])) {
        nameMap.set(r.user_id, r.nombre || r.role || '—')
      }
    }
    setUserMap(nameMap)
    setLoading(false)
  }

  useEffect(() => { if (!permsLoading && canView) load() }, [permsLoading, canView])

  // ── Flatten all 3 sources into rows ───────────────────────────────────
  const allRows: IngresoRow[] = useMemo(() => {
    const rows: IngresoRow[] = []

    // -- deals.pagos[]
    for (const d of deals) {
      const pagos: any[] = Array.isArray(d.pagos) ? d.pagos : []
      pagos.forEach((p: any, idx: number) => {
        // Skip diferida-derived pagos (those are also in compromisos_inicial_diferida_pagos —
        // including both would double-count). The auditoria flow tags them with _inicial_diferida_pago.
        if (p._inicial_diferida_pago) return
        rows.push({
          source: 'deal',
          row_key: `deal:${d.id}:${idx}`,
          pago_idx: idx,
          fecha: p.fecha || null,
          metodo: p.metodo || '—',
          monto_usd: parseFloat(p.monto_usd) || 0,
          monto_bs: parseFloat(p.monto_bs) || 0,
          referencia: p.referencia || null,
          comprobante_url: p.comprobante_url || null,
          verified_by_bank: !!p._verified_by_bank,
          verified_at: p._verified_at || null,
          bank_match_strength: p._match_strength || null,
          admin_checked: !!p._admin_checked,
          admin_checked_at: p._admin_checked_at || null,
          admin_checked_by_name: p._admin_checked_by ? (userMap.get(p._admin_checked_by) || '—') : null,
          parent_id: d.id,
          parent_label: `#${d.negocio_num}`,
          cliente_nombre: d.cliente_nombre || '',
          cliente_apellidos: d.cliente_apellidos || '',
          banco: d.banco,
          parent_created_at: d.created_at,
          vehiculo_modelo: d.vehiculo_modelo,
          auditor_name: d.created_by ? (userMap.get(d.created_by) || '—') : null,
          deal_status: d.status,
        })
      })
    }

    // -- cobranza_cuota_pagos (one row per Yoselin submit)
    for (const cp of cobranzaPagos) {
      const contrato = contratosMap.get(cp.contrato_id)
      rows.push({
        source: 'cobranza',
        row_key: `cobranza:${cp.id}`,
        fecha: cp.fecha_pago,
        metodo: cp.metodo_pago || '—',
        monto_usd: parseFloat(cp.monto_usd) || 0,
        monto_bs: 0,
        referencia: cp.referencia_pago,
        comprobante_url: cp.comprobante_url || null,
        verified_by_bank: !!cp.bank_tx_id,
        verified_at: null,             // cobranza doesn't carry a stamp yet — bank_tx_id presence implies match
        bank_match_strength: cp.bank_match_strength || null,
        admin_checked: cp.status === 'approved' || cp.status === 'paid',
        admin_checked_at: null,
        admin_checked_by_name: null,
        parent_id: cp.contrato_id,
        parent_label: contrato?.factura_numero ? `FAC ${contrato.factura_numero}` : 'Cobranza',
        cliente_nombre: contrato?.cliente_nombre || '—',
        cliente_apellidos: '',
        banco: contrato?.banco || null,
        parent_created_at: cp.created_at,
        vehiculo_modelo: contrato?.modelo || null,
        auditor_name: cp.registered_by ? (userMap.get(cp.registered_by) || '—') : null,
        cobranza_pago_id: cp.id,
        cobranza_status: cp.status,
      })
    }

    // -- compromisos_inicial_diferida_pagos
    for (const dp of diferidaPagos) {
      const compromiso = compromisosMap.get(dp.compromiso_id)
      rows.push({
        source: 'diferida',
        row_key: `diferida:${dp.id}`,
        fecha: dp.fecha,
        metodo: dp.metodo || '—',
        monto_usd: parseFloat(dp.monto_usd) || 0,
        monto_bs: 0,
        referencia: dp.referencia,
        comprobante_url: null,
        verified_by_bank: !!dp.bank_tx_id,
        verified_at: null,
        bank_match_strength: dp.bank_match_strength || null,
        admin_checked: false,           // diferida doesn't currently track admin-checked
        admin_checked_at: null,
        admin_checked_by_name: null,
        parent_id: dp.compromiso_id,
        parent_label: 'Diferida',
        cliente_nombre: compromiso?.cliente_nombre || '—',
        cliente_apellidos: '',
        banco: null,
        parent_created_at: dp.created_at,
        vehiculo_modelo: null,
        auditor_name: dp.registered_by ? (userMap.get(dp.registered_by) || '—') : null,
        diferida_pago_id: dp.id,
        deal_id_for_admin_route: compromiso?.deal_id || dp.deal_id || undefined,
      })
    }

    return rows
  }, [deals, cobranzaPagos, diferidaPagos, contratosMap, compromisosMap, userMap])

  // ── Filter ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let out = allRows
    if (filterTipo !== 'ALL')        out = out.filter(r => r.source === filterTipo)
    if (filterMetodo !== 'ALL')      out = out.filter(r => r.metodo === filterMetodo)
    if (filterBanco !== 'ALL')       out = out.filter(r => r.banco === filterBanco)
    if (filterDealStatus !== 'ALL')  out = out.filter(r => r.source !== 'deal' || r.deal_status === filterDealStatus)
    if (filterStatus === 'BANCO')    out = out.filter(r => r.verified_by_bank && !r.admin_checked)
    if (filterStatus === 'ADMIN')    out = out.filter(r => r.admin_checked && !r.verified_by_bank)
    if (filterStatus === 'BOTH')     out = out.filter(r => r.verified_by_bank && r.admin_checked)
    if (filterStatus === 'NONE')     out = out.filter(r => !r.verified_by_bank && !r.admin_checked)
    if (fechaDesde)                  out = out.filter(r => r.fecha && r.fecha >= fechaDesde)
    if (fechaHasta)                  out = out.filter(r => r.fecha && r.fecha <= fechaHasta)
    if (search.trim()) {
      const q = search.toLowerCase()
      out = out.filter(r =>
        r.cliente_nombre.toLowerCase().includes(q)
        || r.cliente_apellidos.toLowerCase().includes(q)
        || r.parent_label.toLowerCase().includes(q)
        || (r.referencia || '').toLowerCase().includes(q)
        || (r.vehiculo_modelo || '').toLowerCase().includes(q)
      )
    }
    // Sort
    const cmp = (a: IngresoRow, b: IngresoRow): number => {
      if (sortBy === 'fecha') {
        const af = a.fecha || '0000-00-00'
        const bf = b.fecha || '0000-00-00'
        if (af !== bf) return sortDir === 'desc' ? (af < bf ? 1 : -1) : (af < bf ? -1 : 1)
        const ac = a.parent_created_at || ''
        const bc = b.parent_created_at || ''
        return sortDir === 'desc' ? bc.localeCompare(ac) : ac.localeCompare(bc)
      }
      if (sortBy === 'monto') return sortDir === 'desc' ? b.monto_usd - a.monto_usd : a.monto_usd - b.monto_usd
      if (sortBy === 'cliente') {
        const an = (a.cliente_nombre + ' ' + a.cliente_apellidos).toLowerCase()
        const bn = (b.cliente_nombre + ' ' + b.cliente_apellidos).toLowerCase()
        return sortDir === 'desc' ? bn.localeCompare(an) : an.localeCompare(bn)
      }
      return 0
    }
    return [...out].sort(cmp)
  }, [allRows, filterTipo, filterMetodo, filterBanco, filterDealStatus, filterStatus, fechaDesde, fechaHasta, search, sortBy, sortDir])

  // ── Stats ─────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]
    const thisMonth = today.slice(0, 7)
    const sum = filtered.reduce((s, r) => s + r.monto_usd, 0)
    const hoy = filtered.filter(r => r.fecha === today).reduce((s, r) => s + r.monto_usd, 0)
    const mes = filtered.filter(r => r.fecha && r.fecha.startsWith(thisMonth)).reduce((s, r) => s + r.monto_usd, 0)
    const banco = filtered.filter(r => r.verified_by_bank).length
    const admin = filtered.filter(r => r.admin_checked).length
    const sinVerif = filtered.filter(r => !r.verified_by_bank && !r.admin_checked).length
    return { sum, hoy, mes, banco, admin, sinVerif, total: filtered.length }
  }, [filtered])

  // Unique métodos + bancos for dropdowns
  const allMetodos = useMemo(() => Array.from(new Set(allRows.map(r => r.metodo).filter(Boolean))).sort(), [allRows])
  const allBancos = useMemo(() => Array.from(new Set(allRows.map(r => r.banco).filter(Boolean) as string[])).sort(), [allRows])

  // ── Toggle Admin ✓ (deal-pagos only — cobranza has its own approval flow in Portal) ──
  const toggleAdminCheck = async (row: IngresoRow) => {
    if (!canToggleAdmin) return
    if (row.source !== 'deal' || row.pago_idx === undefined) {
      alert('Los pagos de Cobranza y Diferida se aprueban en sus módulos correspondientes.')
      return
    }
    if (row.admin_checked) {
      if (!window.confirm('¿Quitar verificación manual de este pago?')) return
    }
    const setting = !row.admin_checked
    const res = await mutatePago(row.parent_id, row.pago_idx, (p: any) => ({
      ...p,
      _admin_checked: setting,
      _admin_checked_at: setting ? new Date().toISOString() : null,
      _admin_checked_by: setting ? currentUserId : null,
    }))
    if (!res.ok) { alert('Error: ' + res.error); return }
    setDeals(prev => prev.map(d => d.id === row.parent_id ? { ...d, pagos: res.newPagos } : d))
  }

  // ── Click row → route by source ──────────────────────────────────────
  const openRow = (row: IngresoRow) => {
    if (row.source === 'deal') {
      const dest = isAdmin ? '/admin' : '/auditoria'
      router.push(`${dest}?open_deal=${row.parent_id}`)
    } else if (row.source === 'cobranza') {
      // Per user spec: opens Portal /prestamo/detail in new tab
      window.open(`https://portal.motocentro2.com/prestamo/detail?id=${row.parent_id}`, '_blank', 'noopener')
    } else if (row.source === 'diferida') {
      router.push(`/inicial-diferida?id=${row.parent_id}`)
    }
  }

  if (permsLoading || loading) return (
    <AdminShell active="ingresos">
      <div style={{ padding: 40, color: 'var(--text-secondary)' }}>Cargando ingresos…</div>
    </AdminShell>
  )

  return (
    <AdminShell active="ingresos">

      {/* Header */}
      <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: 0, letterSpacing: 0.3 }}>Ingresos</h1>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
              Todos los pagos registrados por auditoría · Conciliación manual y bancaria
            </div>
          </div>
          <button onClick={load} style={{ ...s.btn, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
            ↻ Refrescar
          </button>
        </div>

        {/* Stats banner */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginTop: 16 }}>
          <Stat label="TOTAL"        value={fmt$(stats.sum)} sub={`${stats.total} pagos`} color="#FFFFFF" />
          <Stat label="HOY"          value={fmt$(stats.hoy)} color="#10B981" />
          <Stat label="ESTE MES"     value={fmt$(stats.mes)} color="#3B82F6" />
          <Stat label="🟢 BANCO"      value={String(stats.banco)} sub={`de ${stats.total}`} color="#10B981" />
          <Stat label="🔵 ADMIN"      value={String(stats.admin)} sub={`de ${stats.total}`} color="#3B82F6" />
          <Stat label="○ SIN VERIF." value={String(stats.sinVerif)} sub={`de ${stats.total}`} color="#F59E0B" />
        </div>
      </div>

      {/* Filters */}
      <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', background: 'var(--bg-deep)' }}>
        <input
          placeholder="Buscar cliente, ref, negocio, modelo…"
          value={search} onChange={e => setSearch(e.target.value)}
          style={s.inp(220)}
        />
        <select value={filterTipo} onChange={e => setFilterTipo(e.target.value as any)} style={s.inp(140)}>
          <option value="ALL">Todos los tipos</option>
          <option value="deal">📦 Negocio</option>
          <option value="cobranza">💰 Cobranza</option>
          <option value="diferida">📋 Diferida</option>
        </select>
        <select value={filterMetodo} onChange={e => setFilterMetodo(e.target.value)} style={s.inp(160)}>
          <option value="ALL">Todos los métodos</option>
          {allMetodos.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)} style={s.inp(160)}>
          <option value="ALL">Todas verificaciones</option>
          <option value="BOTH">🟢🔵 Ambas</option>
          <option value="BANCO">🟢 Solo banco</option>
          <option value="ADMIN">🔵 Solo admin</option>
          <option value="NONE">○ Sin verificar</option>
        </select>
        <select value={filterDealStatus} onChange={e => setFilterDealStatus(e.target.value as any)} style={s.inp(120)}>
          <option value="ALL">Cualquier estado</option>
          <option value="BORRADOR">Borrador</option>
          <option value="APROBADO">Aprobado</option>
        </select>
        <select value={filterBanco} onChange={e => setFilterBanco(e.target.value)} style={s.inp(140)}>
          <option value="ALL">Todos los bancos</option>
          {allBancos.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Desde</span>
          <input type="date" value={fechaDesde} onChange={e => setFechaDesde(e.target.value)} style={s.inp(135)} />
          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Hasta</span>
          <input type="date" value={fechaHasta} onChange={e => setFechaHasta(e.target.value)} style={s.inp(135)} />
          {(fechaDesde || fechaHasta) && (
            <button onClick={() => { setFechaDesde(''); setFechaHasta('') }} style={{ ...s.btn, padding: '5px 10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>×</button>
          )}
        </div>
        {(search || filterTipo !== 'ALL' || filterMetodo !== 'ALL' || filterStatus !== 'ALL' || filterDealStatus !== 'ALL' || filterBanco !== 'ALL' || fechaDesde || fechaHasta) && (
          <button onClick={() => { setSearch(''); setFilterTipo('ALL'); setFilterMetodo('ALL'); setFilterStatus('ALL'); setFilterDealStatus('ALL'); setFilterBanco('ALL'); setFechaDesde(''); setFechaHasta('') }}
            style={{ ...s.btn, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', marginLeft: 'auto' }}>
            Limpiar filtros
          </button>
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100 }}>
          <thead style={{ background: 'var(--bg-card)', position: 'sticky' as const, top: 0, zIndex: 10 }}>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <SortHeader label="Fecha"     col="fecha"   sortBy={sortBy} sortDir={sortDir} setSortBy={setSortBy} setSortDir={setSortDir} />
              <Th>Tipo</Th>
              <SortHeader label="Cliente"   col="cliente" sortBy={sortBy} sortDir={sortDir} setSortBy={setSortBy} setSortDir={setSortDir} />
              <Th>Origen</Th>
              <Th>Método</Th>
              <Th>Referencia</Th>
              <SortHeader label="USD" col="monto" sortBy={sortBy} sortDir={sortDir} setSortBy={setSortBy} setSortDir={setSortDir} right />
              <Th>Banco</Th>
              <Th>Verificación</Th>
              <Th>Auditor</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={11} style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
                Sin resultados con los filtros actuales.
              </td></tr>
            )}
            {filtered.map((r, i) => {
              const tipoMeta = r.source === 'deal'
                ? { icon: '📦', label: 'NEGOCIO', color: '#BB162B' }
                : r.source === 'cobranza'
                ? { icon: '💰', label: 'COBRANZA', color: '#14B8A6' }
                : { icon: '📋', label: 'DIFERIDA', color: '#8B5CF6' }
              const statusBadge = r.source === 'deal' && r.deal_status
                ? { label: r.deal_status, color: r.deal_status === 'APROBADO' ? '#10B981' : '#b8720a' }
                : r.source === 'cobranza' && r.cobranza_status
                ? { label: r.cobranza_status.toUpperCase(), color: r.cobranza_status === 'approved' || r.cobranza_status === 'paid' ? '#10B981' : '#b8720a' }
                : null
              return (
              <tr key={r.row_key} style={{
                borderBottom: '1px solid var(--border)',
                background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
              }}>
                <td style={s.td} onClick={() => openRow(r)}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{fmtDate(r.fecha)}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{fmtDateTime(r.parent_created_at)}</div>
                </td>
                <td style={s.td} onClick={() => openRow(r)}>
                  <div style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, background: tipoMeta.color + '22', color: tipoMeta.color, fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 3, letterSpacing: 1 }}>
                    <span>{tipoMeta.icon}</span><span>{tipoMeta.label}</span>
                  </div>
                </td>
                <td style={s.td} onClick={() => openRow(r)}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{r.cliente_nombre} {r.cliente_apellidos}</div>
                  {r.vehiculo_modelo && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{r.vehiculo_modelo}</div>}
                </td>
                <td style={s.td} onClick={() => openRow(r)}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#3B82F6' }}>{r.parent_label}</span>
                  {statusBadge && (
                    <span style={{ marginLeft: 6, fontSize: 9, padding: '1px 6px', borderRadius: 3, background: statusBadge.color + '22', color: statusBadge.color, fontWeight: 700 }}>
                      {statusBadge.label}
                    </span>
                  )}
                </td>
                <td style={s.td}>
                  <span style={{
                    fontSize: 10, padding: '3px 8px', borderRadius: 4,
                    background: colorFor(r.metodo) + '22',
                    color: colorFor(r.metodo), fontWeight: 700,
                  }}>{r.metodo}</span>
                </td>
                <td style={{ ...s.td, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>
                  {r.referencia || '—'}
                </td>
                <td style={{ ...s.td, textAlign: 'right' as const, fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {fmt$(r.monto_usd)}
                  {r.monto_bs > 0 && <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400 }}>{fmtBs(r.monto_bs)}</div>}
                </td>
                <td style={{ ...s.td, fontSize: 11, color: 'var(--text-secondary)' }}>{r.banco || '—'}</td>
                <td style={s.td}>
                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                    {/* Bank ✓ */}
                    <div title={r.verified_by_bank ? `Verificado por banco · ${r.bank_match_strength || 'match'}${r.verified_at ? ' · ' + fmtDateTime(r.verified_at) : ''}` : 'No conciliado con banco'}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 4,
                        background: r.verified_by_bank ? 'rgba(16,185,129,0.15)' : 'transparent',
                        border: r.verified_by_bank ? '1px solid rgba(16,185,129,0.4)' : '1px solid var(--border)',
                        color: r.verified_by_bank ? '#10B981' : 'var(--text-muted)',
                        fontSize: 10, fontWeight: 700,
                        width: 'fit-content',
                      }}>
                      {r.verified_by_bank ? '🟢 Banco ✓' : '○ Banco'}
                      {r.verified_by_bank && r.verified_at && (
                        <span style={{ color: '#10B981', opacity: 0.7, marginLeft: 2, fontWeight: 400 }}>auto · {fmtDate(r.verified_at)}</span>
                      )}
                    </div>
                    {/* Admin ✓ */}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleAdminCheck(r) }}
                      disabled={!canToggleAdmin}
                      title={
                        r.admin_checked
                          ? `Verificado manualmente${r.admin_checked_by_name ? ` por ${r.admin_checked_by_name}` : ''}${r.admin_checked_at ? ' · ' + fmtDateTime(r.admin_checked_at) : ''}`
                          : canToggleAdmin
                          ? 'Click para marcar como verificado manualmente'
                          : 'Solo admin/manager puede marcar manualmente'
                      }
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 4,
                        background: r.admin_checked ? 'rgba(59,130,246,0.15)' : 'transparent',
                        border: r.admin_checked ? '1px solid rgba(59,130,246,0.4)' : '1px solid var(--border)',
                        color: r.admin_checked ? '#3B82F6' : 'var(--text-muted)',
                        fontSize: 10, fontWeight: 700,
                        cursor: canToggleAdmin ? 'pointer' : 'not-allowed',
                        opacity: canToggleAdmin ? 1 : 0.55,
                        width: 'fit-content',
                      }}>
                      {r.admin_checked ? '🔵 Admin ✓' : '○ Admin'}
                      {r.admin_checked && r.admin_checked_by_name && (
                        <span style={{ color: '#3B82F6', opacity: 0.7, marginLeft: 2, fontWeight: 400 }}>
                          {r.admin_checked_by_name}{r.admin_checked_at ? ` · ${fmtDate(r.admin_checked_at)}` : ''}
                        </span>
                      )}
                    </button>
                  </div>
                </td>
                <td style={{ ...s.td, fontSize: 10, color: 'var(--text-muted)' }}>{r.auditor_name || '—'}</td>
                <td style={{ ...s.td, textAlign: 'right' as const }}>
                  {r.comprobante_url && (
                    <a href={r.comprobante_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                      style={{ fontSize: 11, color: '#3B82F6', textDecoration: 'none' }}>
                      📎 Ver
                    </a>
                  )}
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ padding: '12px 24px', fontSize: 10, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
        {filtered.length} pagos mostrados · {fmt$(stats.sum)} total
      </div>
    </AdminShell>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────
function Th({ children }: { children?: any }) {
  return <th style={{ padding: '10px 12px', textAlign: 'left' as const, fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.5 }}>{children}</th>
}
function SortHeader({ label, col, sortBy, sortDir, setSortBy, setSortDir, right }: {
  label: string; col: 'fecha' | 'monto' | 'cliente';
  sortBy: string; sortDir: string;
  setSortBy: (v: any) => void; setSortDir: (v: any) => void;
  right?: boolean;
}) {
  const active = sortBy === col
  return (
    <th
      onClick={() => {
        if (active) setSortDir(sortDir === 'desc' ? 'asc' : 'desc')
        else { setSortBy(col); setSortDir('desc') }
      }}
      style={{
        padding: '10px 12px', textAlign: (right ? 'right' : 'left') as 'right' | 'left',
        fontSize: 10, fontWeight: 700,
        color: active ? '#BB162B' : 'var(--text-secondary)',
        textTransform: 'uppercase' as const, letterSpacing: 1.5,
        cursor: 'pointer', userSelect: 'none' as const,
      }}>
      {label} {active && (sortDir === 'desc' ? '↓' : '↑')}
    </th>
  )
}
function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div style={{ background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: 1.5 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color, fontFamily: 'monospace', marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

const s = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', color: 'var(--text-primary)', fontFamily: 'Inter, system-ui, sans-serif' } as const,
  td: { padding: '10px 12px', cursor: 'pointer' as const, verticalAlign: 'middle' as const } as const,
  inp: (w: number) => ({
    padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 12,
    outline: 'none', minWidth: w, fontFamily: 'inherit',
  }) as const,
  btn: { padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 700, cursor: 'pointer' } as const,
}

export default function IngresosPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--bg-page)' }} />}>
      <IngresosPageInner />
    </Suspense>
  )
}