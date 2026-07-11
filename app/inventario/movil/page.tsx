// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-p1/app/inventario/movil/page.tsx
// AutoCore P1 — Inventario · PWA móvil
//
// Pantalla móvil de operación de inventario. Dos flujos:
//   1. Ver stock: lista en tarjetas, búsqueda y filtro por estado.
//   2. Detalle de unidad: cambiar estado (ciclo de vida) y editar datos básicos.
// (El registro por escaneo de factura del fork NPA fue removido: dependía del
// Worker de comprobantes de Motocentro. Las unidades se registran en desktop.)
//
// Permisos (igual que el módulo desktop):
//   can_view_inventory            → ver stock
//   can_manage_inventory          → registrar / editar / cambiar estado
//   npa_can_view_inventory_finance→ ver y editar costos
//
// Reutiliza el MISMO shape de insert que app/inventario/page.tsx (probado en
// producción): PK = vin, estado por defecto EN_STOCK. fecha_entrada se fija a la
// fecha de la factura de compra (aging desde la compra).
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useState, useEffect, useMemo, useRef, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'
import { useNPAPermissions } from '../../components/useNPAPermissions'
import { ArrowLeft, Search, Check, X, Package, ChevronRight, RefreshCw } from 'lucide-react'

const COLORES = ['BLANCO', 'NEGRO', 'PLATA', 'GRIS', 'AZUL', 'ROJO', 'VERDE']

const ESTADOS = [
  { value: 'EN_STOCK', label: 'En Stock', color: '#1a7a4a' },
  { value: 'ASIGNADO', label: 'Asignado', color: '#e67e22' },
  { value: 'VENDIDO',  label: 'Vendido',  color: '#3b82f6' },
  { value: 'ENTREGADO', label: 'Entregado', color: '#6b7280' },
  { value: 'VOIDED',   label: 'Anulado',  color: '#ef4444' },
]
const estadoLabel = (v: string) => ESTADOS.find(e => e.value === v)?.label ?? v
const estadoColor = (v: string) => ESTADOS.find(e => e.value === v)?.color ?? '#6b7280'

const fmt = (n: number) => `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const todayISO = () => new Date().toISOString().slice(0, 10)
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}
function diasEnStock(u: any): number {
  if (!u.fecha_entrada) return 0
  const ref = u.fecha_entrega || u.fecha_venta || todayISO()
  const ms = new Date(ref).getTime() - new Date(u.fecha_entrada).getTime()
  return Math.max(0, Math.floor(ms / 86400000))
}
const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif', paddingBottom: 40 },
  topBar: { background: '#BB162B', color: '#fff', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10, position: 'sticky', top: 0, zIndex: 50, boxShadow: '0 2px 6px rgba(0,0,0,0.15)' },
  backBtn: { background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: 4, display: 'flex' },
  title: { fontSize: 15, fontWeight: 700, letterSpacing: 0.3 },
  content: { padding: '14px 14px 24px', maxWidth: 560, margin: '0 auto' },

  kpiRow: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 },
  kpi: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', textAlign: 'center' },
  kpiVal: { fontSize: 20, fontWeight: 800, color: 'var(--text-primary)' },
  kpiLab: { fontSize: 9.5, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 },

  primaryBtn: { width: '100%', padding: 15, borderRadius: 12, border: 'none', background: '#BB162B', color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginBottom: 14 },

  searchWrap: { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '0 12px', marginBottom: 10 },
  searchInput: { flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 15, padding: '12px 0', outline: 'none' },
  chipRow: { display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 4, marginBottom: 12 },
  chip: (active: boolean, color: string) => ({ flexShrink: 0, padding: '7px 13px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${active ? color : 'var(--border)'}`, background: active ? color + '22' : 'transparent', color: active ? color : 'var(--text-secondary)' }),

  unitCard: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '13px 15px', marginBottom: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 },
  unitMain: { flex: 1, minWidth: 0 },
  unitTitle: { fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' },
  unitSub: { fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, fontFamily: 'monospace' },
  unitMeta: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 },
  badge: (c: string) => ({ display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.6, background: c + '22', color: c, border: `1px solid ${c}55` }),

  empty: { padding: '50px 20px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 },
  loading: { padding: 40, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 },

  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  sheet: { background: 'var(--bg-card)', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, width: '100%', maxWidth: 560, maxHeight: '92vh', overflowY: 'auto' },
  sheetHead: { display: 'flex', alignItems: 'center', marginBottom: 16 },
  sheetTitle: { fontSize: 17, fontWeight: 800, color: 'var(--text-primary)' },
  closeBtn: { marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex' },

  field: { marginBottom: 13 },
  label: { fontSize: 10.5, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1, display: 'block', marginBottom: 5 },
  input: { width: '100%', padding: '12px 13px', background: 'var(--bg-input, var(--bg-deep))', border: '1px solid var(--border)', borderRadius: 9, color: 'var(--text-primary)', fontSize: 15, boxSizing: 'border-box' },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 },

  estadoGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 6 },
  estadoBtn: (active: boolean, color: string) => ({ padding: '11px', borderRadius: 9, fontWeight: 700, fontSize: 13, cursor: 'pointer', border: `2px solid ${active ? color : 'var(--border)'}`, background: active ? color + '1a' : 'transparent', color: active ? color : 'var(--text-primary)' }),

  err: { background: 'rgba(187,22,43,0.1)', border: '1px solid rgba(187,22,43,0.3)', borderRadius: 8, padding: '10px 13px', fontSize: 12.5, color: '#e88', marginBottom: 13 },
  ok: { background: 'rgba(46,204,138,0.1)', border: '1px solid #2ecc8a55', borderRadius: 8, padding: '10px 13px', fontSize: 12.5, color: '#2ecc8a', marginBottom: 13 },
  saveBtn: { width: '100%', padding: 14, borderRadius: 10, border: 'none', background: '#BB162B', color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer', marginTop: 6 },
  secBtn: { width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', marginTop: 8 },

  draftCard: (state: string) => ({ border: `1px solid ${state === 'dup' ? '#e0894a55' : 'var(--border)'}`, borderRadius: 11, padding: 13, marginBottom: 11, background: state === 'dup' ? 'rgba(230,137,74,0.06)' : 'var(--bg-deep)' }),
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIT DETAIL — change estado + edit basics
// ═══════════════════════════════════════════════════════════════════════════
function DetalleModal({ unit, userId, canManage, canFinance, onSaved, onClose }: {
  unit: any, userId: string | null, canManage: boolean, canFinance: boolean, onSaved: () => void, onClose: () => void
}) {
  const [estado, setEstado] = useState(unit.estado || 'EN_STOCK')
  const [color, setColor] = useState(unit.color || '')
  const [placa, setPlaca] = useState(unit.placa || '')
  const [notas, setNotas] = useState(unit.notas || '')
  const [costo, setCosto] = useState(unit.costo_unidad_usd ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    if (!canManage) { onClose(); return }
    setError(''); setSaving(true)
    const patch: any = { estado, color: color || null, placa: placa || null, notas: notas || null, updated_by: userId }
    if (canFinance && costo !== '' && !isNaN(Number(costo))) patch.costo_unidad_usd = Number(costo)
    // Freeze aging on lifecycle transitions.
    if (estado === 'VENDIDO' && !unit.fecha_venta) patch.fecha_venta = todayISO()
    if (estado === 'ENTREGADO' && !unit.fecha_entrega) patch.fecha_entrega = todayISO()
    const { error: upErr } = await supabase.from('inventory_units').update(patch).eq('vin', unit.vin)
    if (upErr) { setError(upErr.message); setSaving(false); return }
    onSaved()
  }

  return (
    <div style={s.overlay} onClick={() => !saving && onClose()}>
      <div style={s.sheet} onClick={e => e.stopPropagation()}>
        <div style={s.sheetHead}>
          <div>
            <div style={s.sheetTitle}>{unit.modelo} {unit.año}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontFamily: 'monospace', marginTop: 2 }}>{unit.vin}</div>
          </div>
          <button style={s.closeBtn} onClick={onClose} aria-label="Cerrar"><X size={20} /></button>
        </div>

        {error && <div style={s.err}>{error}</div>}

        <div style={{ display: 'flex', gap: 16, marginBottom: 16, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          <div>Factura <b style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{unit.factura_compra_num || '—'}</b></div>
          <div>Entrada <b style={{ color: 'var(--text-primary)' }}>{fmtDate(unit.fecha_entrada)}</b></div>
          <div>Días <b style={{ color: 'var(--text-primary)' }}>{diasEnStock(unit)}</b></div>
        </div>

        <label style={s.label}>Estado</label>
        <div style={s.estadoGrid}>
          {ESTADOS.map(e => (
            <div key={e.value} style={s.estadoBtn(estado === e.value, e.color)}
              onClick={() => canManage && setEstado(e.value)}>
              {e.label}
            </div>
          ))}
        </div>

        <div style={{ ...s.row2, marginTop: 14 }}>
          <div style={s.field}>
            <label style={s.label}>Color</label>
            <select style={s.input} value={COLORES.includes(color) ? color : ''} disabled={!canManage}
              onChange={e => setColor(e.target.value)}>
              <option value="">—</option>
              {COLORES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={s.field}>
            <label style={s.label}>Placa</label>
            <input style={s.input} value={placa} disabled={!canManage} onChange={e => setPlaca(e.target.value.toUpperCase())} />
          </div>
        </div>

        {canFinance && (
          <div style={s.field}>
            <label style={s.label}>Costo unidad USD</label>
            <input style={s.input} type="number" value={costo} disabled={!canManage} onChange={e => setCosto(e.target.value)} />
          </div>
        )}

        <div style={s.field}>
          <label style={s.label}>Notas</label>
          <input style={s.input} value={notas} disabled={!canManage} onChange={e => setNotas(e.target.value)} placeholder="Observaciones…" />
        </div>

        {canManage
          ? <button style={s.saveBtn} onClick={handleSave} disabled={saving}>{saving ? 'Guardando…' : 'Guardar cambios'}</button>
          : <button style={s.secBtn} onClick={onClose}>Cerrar</button>}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
function InventarioMovilInner() {
  const router = useRouter()
  const { permissions, loading: permsLoading, userId } = useNPAPermissions()

  const canView = permissions.can_view_inventory || permissions.can_manage_inventory
  const canManage = permissions.can_manage_inventory
  const canFinance = permissions.npa_can_view_inventory_finance

  const [units, setUnits] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterEstado, setFilterEstado] = useState('ALL')
  const [detalle, setDetalle] = useState<any | null>(null)
  const [flash, setFlash] = useState('')

  useEffect(() => {
    if (permsLoading) return
    if (!canView) { router.replace('/inventario'); return }
    loadUnits()
    // eslint-disable-next-line
  }, [permsLoading, canView])

  async function loadUnits() {
    setLoading(true)
    const { data } = await supabase
      .from('inventory_units')
      .select('*')
      .order('fecha_entrada', { ascending: false })
    setUnits(Array.isArray(data) ? data : [])
    setLoading(false)
  }

  const kpis = useMemo(() => {
    const enStock = units.filter(u => u.estado === 'EN_STOCK')
    const asignados = units.filter(u => u.estado === 'ASIGNADO')
    const capital = enStock.reduce((sum, u) => sum + (parseFloat(u.costo_unidad_usd) || 0), 0)
    return { enStock: enStock.length, asignados: asignados.length, capital }
  }, [units])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return units.filter(u => {
      if (filterEstado !== 'ALL' && u.estado !== filterEstado) return false
      if (!q) return true
      return [u.vin, u.modelo, u.placa, u.factura_compra_num, u.motor_serial, u.color]
        .some(v => (v || '').toString().toLowerCase().includes(q))
    })
  }, [units, search, filterEstado])

  if (permsLoading || loading) {
    return (
      <div style={s.page}>
        <div style={s.topBar}><div style={s.title}>Inventario</div></div>
        <div style={s.loading}>Cargando…</div>
      </div>
    )
  }
  if (!canView) return null

  return (
    <div style={s.page}>
      <div style={s.topBar}>
        <button style={s.backBtn} onClick={() => router.push('/inventario')} aria-label="Volver"><ArrowLeft size={20} strokeWidth={2.4} /></button>
        <Package size={18} strokeWidth={2.2} />
        <div style={s.title}>Inventario</div>
        <button style={{ ...s.backBtn, marginLeft: 'auto' }} onClick={loadUnits} aria-label="Refrescar"><RefreshCw size={18} strokeWidth={2.2} /></button>
      </div>

      <div style={s.content}>
        {flash && <div style={s.ok}>{flash}</div>}

        <div style={s.kpiRow}>
          <div style={s.kpi}><div style={s.kpiVal}>{kpis.enStock}</div><div style={s.kpiLab}>En Stock</div></div>
          <div style={s.kpi}><div style={s.kpiVal}>{kpis.asignados}</div><div style={s.kpiLab}>Asignados</div></div>
          {canFinance
            ? <div style={s.kpi}><div style={{ ...s.kpiVal, fontSize: 15, fontFamily: 'monospace' }}>{fmt(kpis.capital)}</div><div style={s.kpiLab}>Capital stock</div></div>
            : <div style={s.kpi}><div style={s.kpiVal}>{units.length}</div><div style={s.kpiLab}>Total</div></div>}
        </div>

        <div style={s.searchWrap}>
          <Search size={16} color="var(--text-secondary)" />
          <input style={s.searchInput} value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar VIN, modelo, placa, factura…" />
          {search && <button style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex' }} onClick={() => setSearch('')}><X size={16} /></button>}
        </div>

        <div style={s.chipRow}>
          <div style={s.chip(filterEstado === 'ALL', '#888')} onClick={() => setFilterEstado('ALL')}>Todos</div>
          {ESTADOS.map(e => (
            <div key={e.value} style={s.chip(filterEstado === e.value, e.color)} onClick={() => setFilterEstado(e.value)}>{e.label}</div>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div style={s.empty}>
            {units.length === 0 ? '📦 No hay unidades registradas todavía.' : 'Ninguna unidad coincide con la búsqueda.'}
          </div>
        ) : (
          filtered.map(u => (
            <div key={u.vin} style={s.unitCard} onClick={() => setDetalle(u)}>
              <div style={s.unitMain}>
                <div style={s.unitTitle}>{u.modelo} <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>{u.año}</span></div>
                <div style={s.unitSub}>{u.vin}</div>
                <div style={s.unitMeta}>{u.color || 's/color'} · {diasEnStock(u)} días{u.factura_compra_num ? ` · Fact ${u.factura_compra_num}` : ''}</div>
              </div>
              <span style={s.badge(estadoColor(u.estado))}>{estadoLabel(u.estado)}</span>
              <ChevronRight size={18} color="var(--text-secondary)" />
            </div>
          ))
        )}

        {filtered.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'center' }}>
            {filtered.length} {filtered.length === 1 ? 'unidad' : 'unidades'}{filtered.length !== units.length ? ` de ${units.length}` : ''}
          </div>
        )}
      </div>

      {detalle && (
        <DetalleModal
          unit={detalle}
          userId={userId}
          canManage={canManage}
          canFinance={canFinance}
          onClose={() => setDetalle(null)}
          onSaved={() => { setDetalle(null); setFlash('Unidad actualizada.'); loadUnits(); setTimeout(() => setFlash(''), 3000) }}
        />
      )}
    </div>
  )
}

export default function InventarioMovilPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--bg-page)' }} />}>
      <InventarioMovilInner />
    </Suspense>
  )
}