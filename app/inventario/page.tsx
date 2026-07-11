// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/inventario/page.tsx
// AutoCore NPA — Inventory Module · Phase 1
//
// Desktop list view for inventory_units. Permissions:
//   - can_view_inventory             → read access (KPIs counts + table)
//   - can_manage_inventory           → create/edit units (Nueva Unidad button)
//   - npa_can_view_inventory_finance → see costo column + capital tied up KPIs
//
// Phase 1 scope: manual unit entry, list, filter, edit. No AI scanning, no
// CSV import, no auto-link to deals (that's Phase 2 & 3).
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useState, useEffect, useMemo, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '../supabase'
import NavBar from '../components/NavBar'
import { useNPAPermissions } from '../components/useNPAPermissions'

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

// Multi-brand used-car inventory: modelo is free text (no brand catalog).
const COLORES = [
  'BLANCO', 'NEGRO', 'PLATA', 'GRIS', 'AZUL', 'ROJO', 'VERDE',
]

const ESTADOS = [
  { value: 'EN_STOCK', label: 'En Stock', color: '#1a7a4a' },
  { value: 'ASIGNADO', label: 'Asignado', color: '#e67e22' },
  { value: 'VENDIDO',  label: 'Vendido',  color: '#3b82f6' },
  { value: 'ENTREGADO',label: 'Entregado',color: '#6b7280' },
  { value: 'VOIDED',   label: 'Anulado',  color: '#ef4444' },
]
const estadoLabel = (v: string) => ESTADOS.find(e => e.value === v)?.label ?? v
const estadoColor = (v: string) => ESTADOS.find(e => e.value === v)?.color ?? '#6b7280'

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif', transition: 'background 0.35s ease' },
  content: { padding: '32px', maxWidth: '1500px', margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', gap: '16px', flexWrap: 'wrap' as const },
  title: { fontSize: '24px', fontWeight: 700, color: 'var(--text-primary)' },
  subtitle: { fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: '4px' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', padding: '20px', marginBottom: '16px' },
  btnRed: { padding: '10px 24px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  btnGreen: { padding: '10px 24px', background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  btnGray: { padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  kpiBar: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '20px' },
  kpi: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', padding: '16px 18px' },
  kpiLabel: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px', marginBottom: '6px' },
  kpiValue: { fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' as const },
  kpiSub: { fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' },
  filterBar: { display: 'flex', gap: '12px', flexWrap: 'wrap' as const, marginBottom: '16px' },
  input: { padding: '10px 14px', background: 'var(--bg-input, var(--bg-card))', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '13px', color: 'var(--text-primary)', minWidth: '160px' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' },
  th: { padding: '10px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px', borderBottom: '2px solid var(--border)' },
  td: { padding: '10px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' },
  badge: { display: 'inline-block', padding: '3px 10px', borderRadius: '3px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '1px' },
  empty: { padding: '60px 20px', textAlign: 'center' as const, color: 'var(--text-secondary)', fontSize: '13px' },
}

// ─── Days held calculation ─────────────────────────────────────────────────
function diasEnStock(unit: any): number {
  if (!unit.fecha_entrada) return 0
  const ref = unit.fecha_entrega || unit.fecha_venta || new Date().toISOString().slice(0, 10)
  const start = new Date(unit.fecha_entrada)
  const end = new Date(ref)
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)))
}

// ═══════════════════════════════════════════════════════════════════════════
// MODAL: Nueva / Editar Unidad
// ═══════════════════════════════════════════════════════════════════════════
function UnidadModal({
  unidad, canEditCost, onSave, onCancel,
}: {
  unidad: any | null  // null = new, object = edit
  canEditCost: boolean
  onSave: (data: any) => Promise<void>
  onCancel: () => void
}) {
  const isNew = !unidad
  const [form, setForm] = useState({
    vin: unidad?.vin || '',
    modelo: unidad?.modelo || '',
    año: unidad?.año || new Date().getFullYear(),
    color: unidad?.color || '',
    motor_serial: unidad?.motor_serial || '',
    placa: unidad?.placa || '',
    factura_compra_num: unidad?.factura_compra_num || '',
    factura_compra_control_num: unidad?.factura_compra_control_num || '',
    factura_compra_fecha: unidad?.factura_compra_fecha || new Date().toISOString().slice(0, 10),
    costo_unidad_usd: unidad?.costo_unidad_usd ?? '',
    costo_placa_certificado_usd: unidad?.costo_placa_certificado_usd ?? '',
    costo_total_factura_usd: unidad?.costo_total_factura_usd ?? '',
    notas: unidad?.notas || '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setField = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    setError(null)
    // Basic validation
    if (!form.vin || form.vin.trim().length < 11) { setError('VIN inválido (mínimo 11 caracteres)'); return }
    if (!form.modelo) { setError('Selecciona un modelo'); return }
    if (!form.año || form.año < 2000 || form.año > 2030) { setError('Año inválido'); return }
    if (!form.factura_compra_num) { setError('Número de factura requerido'); return }
    if (!form.factura_compra_fecha) { setError('Fecha de factura requerida'); return }
    if (canEditCost) {
      if (form.costo_unidad_usd === '' || isNaN(Number(form.costo_unidad_usd))) {
        setError('Costo en USD requerido'); return
      }
    }
    setSaving(true)
    try {
      await onSave({
        ...form,
        vin: form.vin.trim().toUpperCase(),
        año: Number(form.año),
        costo_unidad_usd: form.costo_unidad_usd === '' ? 0 : Number(form.costo_unidad_usd),
        costo_placa_certificado_usd: form.costo_placa_certificado_usd === '' ? 0 : Number(form.costo_placa_certificado_usd),
        costo_total_factura_usd: form.costo_total_factura_usd === '' ? null : Number(form.costo_total_factura_usd),
      })
    } catch (e: any) {
      setError(e?.message || 'Error al guardar')
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', overflow: 'auto' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '32px', maxWidth: '720px', width: '100%', maxHeight: '90vh', overflowY: 'auto' as const }}>
        <div style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
          {isNew ? '➕ Nueva Unidad' : '✏️ Editar Unidad'}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '24px' }}>
          {isNew ? 'Registra una unidad nueva del inventario.' : `VIN: ${unidad.vin}`}
        </div>

        {/* Vehicle identity */}
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#e67e22', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '12px' }}>Vehículo</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>VIN *</label>
            <input
              type="text" value={form.vin} disabled={!isNew}
              onChange={e => setField('vin', e.target.value.toUpperCase())}
              placeholder="KNAPV81D3T7497327"
              style={{ ...s.input, width: '100%', marginTop: '4px', fontFamily: 'monospace', textTransform: 'uppercase' as const, opacity: isNew ? 1 : 0.6 }}
            />
          </div>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Modelo *</label>
            <input
              type="text" value={form.modelo}
              onChange={e => setField('modelo', e.target.value.toUpperCase())}
              placeholder="Ej: TOYOTA COROLLA"
              style={{ ...s.input, width: '100%', marginTop: '4px' }}
            />
          </div>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Año *</label>
            <input
              type="number" value={form.año} min={2000} max={2030}
              onChange={e => setField('año', e.target.value)}
              style={{ ...s.input, width: '100%', marginTop: '4px' }}
            />
          </div>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Color</label>
            <select
              value={form.color}
              onChange={e => setField('color', e.target.value)}
              style={{ ...s.input, width: '100%', marginTop: '4px' }}
            >
              <option value="">Selecciona...</option>
              {COLORES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Serial Motor</label>
            <input
              type="text" value={form.motor_serial}
              onChange={e => setField('motor_serial', e.target.value.toUpperCase())}
              placeholder="G4FLPV676392"
              style={{ ...s.input, width: '100%', marginTop: '4px', fontFamily: 'monospace', textTransform: 'uppercase' as const }}
            />
          </div>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Placa</label>
            <input
              type="text" value={form.placa}
              onChange={e => setField('placa', e.target.value.toUpperCase())}
              placeholder="AO269BB"
              style={{ ...s.input, width: '100%', marginTop: '4px', fontFamily: 'monospace', textTransform: 'uppercase' as const }}
            />
          </div>
        </div>

        {/* Factura de compra */}
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#e67e22', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '12px' }}>Factura de Compra</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '20px' }}>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Factura Nro. *</label>
            <input
              type="text" value={form.factura_compra_num}
              onChange={e => setField('factura_compra_num', e.target.value)}
              placeholder="00-1073"
              style={{ ...s.input, width: '100%', marginTop: '4px' }}
            />
          </div>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Nº Control</label>
            <input
              type="text" value={form.factura_compra_control_num}
              onChange={e => setField('factura_compra_control_num', e.target.value)}
              placeholder="00-1084"
              style={{ ...s.input, width: '100%', marginTop: '4px' }}
            />
          </div>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Fecha Factura *</label>
            <input
              type="date" value={form.factura_compra_fecha}
              onChange={e => setField('factura_compra_fecha', e.target.value)}
              style={{ ...s.input, width: '100%', marginTop: '4px' }}
            />
          </div>
        </div>

        {/* Costos — only if user can see/edit them */}
        {canEditCost && (
          <>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#e67e22', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '12px' }}>Costos USD</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '20px' }}>
              <div>
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Precio de Venta USD *</label>
                <input
                  type="number" step="0.01" value={form.costo_unidad_usd}
                  onChange={e => setField('costo_unidad_usd', e.target.value)}
                  placeholder="34440.00"
                  style={{ ...s.input, width: '100%', marginTop: '4px' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Placa y Certificado</label>
                <input
                  type="number" step="0.01" value={form.costo_placa_certificado_usd}
                  onChange={e => setField('costo_placa_certificado_usd', e.target.value)}
                  placeholder="402.00"
                  style={{ ...s.input, width: '100%', marginTop: '4px' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Total a Pagar USD</label>
                <input
                  type="number" step="0.01" value={form.costo_total_factura_usd}
                  onChange={e => setField('costo_total_factura_usd', e.target.value)}
                  placeholder="40352.40"
                  style={{ ...s.input, width: '100%', marginTop: '4px' }}
                />
              </div>
            </div>
          </>
        )}

        {/* Notas */}
        <div>
          <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Notas (opcional)</label>
          <textarea
            value={form.notas}
            onChange={e => setField('notas', e.target.value)}
            rows={2}
            placeholder="Observaciones internas, daños recibidos, accesorios, etc."
            style={{ ...s.input, width: '100%', marginTop: '4px', fontFamily: 'inherit', resize: 'vertical' as const }}
          />
        </div>

        {error && (
          <div style={{ marginTop: '16px', padding: '10px 14px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '8px', color: '#ef4444', fontSize: '12px', fontWeight: 600 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '24px' }}>
          <button onClick={onCancel} style={s.btnGray} disabled={saving}>Cancelar</button>
          <button onClick={handleSave} style={s.btnGreen} disabled={saving}>
            {saving ? 'Guardando...' : (isNew ? '➕ Crear Unidad' : '💾 Guardar Cambios')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════
function InventarioPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { permissions, loading: permsLoading, userId } = useNPAPermissions()

  const [units, setUnits] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editingUnit, setEditingUnit] = useState<any | null>(null)
  const [showNew, setShowNew] = useState(false)

  // Filters
  const [filterEstado, setFilterEstado] = useState<string>('ALL')
  const [filterModelo, setFilterModelo] = useState<string>('ALL')
  const [search, setSearch] = useState('')

  const canManage = permissions.can_manage_inventory
  const canViewFinance = permissions.npa_can_view_inventory_finance

  // ─── Permission gate ─────────────────────────────────────────────────────
  useEffect(() => {
    if (permsLoading) return
    if (!permissions.can_view_inventory && !permissions.can_manage_inventory) {
      router.replace('/dashboard')
    }
  }, [permsLoading, permissions, router])

  // ─── Initial load ────────────────────────────────────────────────────────
  useEffect(() => {
    if (permsLoading) return
    if (!permissions.can_view_inventory && !permissions.can_manage_inventory) return
    loadUnits()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permsLoading, permissions.can_view_inventory, permissions.can_manage_inventory])

  // ─── Handle ?vin=XXX from global search ─────────────────────────────────
  useEffect(() => {
    const vin = searchParams?.get('vin')
    if (vin) {
      setSearch(vin)
      // Once units load, also auto-open the editor for that VIN
      // (handled in the next effect once units is non-empty)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const vin = searchParams?.get('vin')
    if (vin && units.length > 0 && !editingUnit) {
      const match = units.find((u: any) => (u.vin || '').toUpperCase() === vin.toUpperCase())
      if (match) {
        setEditingUnit(match)
        window.history.replaceState({}, '', '/inventario')
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units])

  async function loadUnits() {
    setLoading(true)
    const { data, error } = await supabase
      .from('inventory_units')
      .select('*')
      .order('fecha_entrada', { ascending: false })
    if (!error && data) setUnits(data)
    setLoading(false)
  }

  // ─── Save (insert or update) ─────────────────────────────────────────────
  async function saveUnit(data: any) {
    const isEdit = !!editingUnit
    const payload: any = {
      vin: data.vin,
      modelo: data.modelo,
      año: data.año,
      color: data.color || null,
      motor_serial: data.motor_serial || null,
      placa: data.placa || null,
      factura_compra_num: data.factura_compra_num,
      factura_compra_control_num: data.factura_compra_control_num || null,
      factura_compra_fecha: data.factura_compra_fecha,
      costo_unidad_usd: data.costo_unidad_usd,
      costo_placa_certificado_usd: data.costo_placa_certificado_usd,
      costo_total_factura_usd: data.costo_total_factura_usd,
      notas: data.notas || null,
      updated_by: userId,
    }
    if (!isEdit) {
      payload.created_by = userId
      // estado defaults to EN_STOCK in the DB
    }
    const q = isEdit
      ? supabase.from('inventory_units').update(payload).eq('vin', editingUnit.vin)
      : supabase.from('inventory_units').insert(payload)
    const { error } = await q
    if (error) throw new Error(error.message)
    setEditingUnit(null)
    setShowNew(false)
    await loadUnits()
  }

  // ─── Filters + search ────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return units.filter(u => {
      if (filterEstado !== 'ALL' && u.estado !== filterEstado) return false
      if (filterModelo !== 'ALL' && u.modelo !== filterModelo) return false
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        const hay = [u.vin, u.modelo, u.factura_compra_num, u.placa, u.color, u.motor_serial]
          .filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [units, filterEstado, filterModelo, search])

  // ─── KPI math ────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const enStock = units.filter(u => u.estado === 'EN_STOCK')
    const asignados = units.filter(u => u.estado === 'ASIGNADO')
    const thisMonthStart = new Date(); thisMonthStart.setDate(1); thisMonthStart.setHours(0, 0, 0, 0)
    const vendidosMes = units.filter(u => {
      if (u.estado !== 'VENDIDO' && u.estado !== 'ENTREGADO') return false
      if (!u.fecha_venta) return false
      return new Date(u.fecha_venta) >= thisMonthStart
    })
    const capitalEnStock = enStock.reduce((sum, u) => sum + (parseFloat(u.costo_unidad_usd) || 0), 0)
    const promDias = enStock.length === 0 ? 0
      : Math.round(enStock.reduce((sum, u) => sum + diasEnStock(u), 0) / enStock.length)
    return {
      enStockCount: enStock.length,
      asignadosCount: asignados.length,
      vendidosMesCount: vendidosMes.length,
      capitalEnStock,
      promDias,
    }
  }, [units])

  if (permsLoading || loading) {
    return (
      <div style={s.page}>
        <NavBar />
        <div style={s.content}>
          <div style={s.empty}>Cargando inventario...</div>
        </div>
      </div>
    )
  }

  if (!permissions.can_view_inventory && !permissions.can_manage_inventory) {
    // useEffect already redirected; render nothing while it does
    return <div style={s.page}><NavBar /></div>
  }

  return (
    <div style={s.page}>
      <NavBar />
      <div style={s.content}>
        {/* Header */}
        <div style={s.header}>
          <div>
            <div style={s.subtitle}>Módulo</div>
            <div style={s.title}>Inventario de Unidades</div>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => { window.location.href = '/inventario/pedidos' }} style={s.btnGray}>
              Pipeline de Pedidos
            </button>
            {canManage && (
              <button onClick={() => setShowNew(true)} style={s.btnRed}>
                ➕ Nueva Unidad
              </button>
            )}
          </div>
        </div>

        {/* KPI bar */}
        <div style={s.kpiBar}>
          <div style={s.kpi}>
            <div style={s.kpiLabel}>En Stock</div>
            <div style={s.kpiValue}>{kpis.enStockCount}</div>
            {canViewFinance && (
              <div style={s.kpiSub}>{fmt(kpis.capitalEnStock)} capital</div>
            )}
          </div>
          <div style={s.kpi}>
            <div style={s.kpiLabel}>Asignados a Negocio</div>
            <div style={s.kpiValue}>{kpis.asignadosCount}</div>
            <div style={s.kpiSub}>vendidos sin entregar</div>
          </div>
          <div style={s.kpi}>
            <div style={s.kpiLabel}>Vendidos Este Mes</div>
            <div style={s.kpiValue}>{kpis.vendidosMesCount}</div>
          </div>
          <div style={s.kpi}>
            <div style={s.kpiLabel}>Días Promedio en Stock</div>
            <div style={s.kpiValue}>{kpis.promDias}</div>
            <div style={s.kpiSub}>unidades en stock</div>
          </div>
        </div>

        {/* Filter bar */}
        <div style={s.card}>
          <div style={s.filterBar}>
            <select value={filterEstado} onChange={e => setFilterEstado(e.target.value)} style={s.input}>
              <option value="ALL">Todos los Estados</option>
              {ESTADOS.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
            </select>
            <select value={filterModelo} onChange={e => setFilterModelo(e.target.value)} style={s.input}>
              <option value="ALL">Todos los Modelos</option>
              {[...new Set(units.map((u: any) => u.modelo).filter(Boolean))].sort().map(m => <option key={String(m)} value={String(m)}>{String(m)}</option>)}
            </select>
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Buscar VIN, factura, placa, motor..."
              style={{ ...s.input, flex: 1, minWidth: '240px' }}
            />
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <div style={s.empty}>
              {units.length === 0
                ? '📦 No hay unidades registradas. Comienza con "Nueva Unidad".'
                : 'Ninguna unidad coincide con los filtros aplicados.'}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' as const }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>VIN</th>
                    <th style={s.th}>Modelo</th>
                    <th style={s.th}>Año</th>
                    <th style={s.th}>Color</th>
                    <th style={s.th}>Factura</th>
                    <th style={s.th}>Fecha Entrada</th>
                    <th style={s.th}>Días</th>
                    {canViewFinance && <th style={{ ...s.th, textAlign: 'right' as const }}>Costo USD</th>}
                    <th style={s.th}>Estado</th>
                    {canManage && <th style={{ ...s.th, textAlign: 'right' as const }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(u => (
                    <tr key={u.vin} style={{ transition: 'background 0.1s' }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
                      <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '11px' }}>{u.vin}</td>
                      <td style={s.td}>{u.modelo}</td>
                      <td style={s.td}>{u.año}</td>
                      <td style={s.td}>{u.color || '—'}</td>
                      <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '11px' }}>{u.factura_compra_num}</td>
                      <td style={s.td}>{fmtDate(u.fecha_entrada)}</td>
                      <td style={s.td}>{diasEnStock(u)}</td>
                      {canViewFinance && (
                        <td style={{ ...s.td, textAlign: 'right' as const, fontWeight: 600 }}>
                          {fmt(parseFloat(u.costo_unidad_usd) || 0)}
                        </td>
                      )}
                      <td style={s.td}>
                        <span style={{
                          ...s.badge,
                          background: estadoColor(u.estado) + '22',
                          color: estadoColor(u.estado),
                          border: `1px solid ${estadoColor(u.estado)}55`,
                        }}>
                          {estadoLabel(u.estado)}
                        </span>
                      </td>
                      {canManage && (
                        <td style={{ ...s.td, textAlign: 'right' as const }}>
                          <button onClick={() => setEditingUnit(u)}
                                  style={{ ...s.btnGray, padding: '6px 14px', fontSize: '11px' }}>
                            ✏️ Editar
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Result count footer */}
          {filtered.length > 0 && (
            <div style={{ marginTop: '14px', fontSize: '11px', color: 'var(--text-secondary)' }}>
              {filtered.length} {filtered.length === 1 ? 'unidad' : 'unidades'}
              {filtered.length !== units.length && ` (de ${units.length} total)`}
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showNew && (
        <UnidadModal
          unidad={null}
          canEditCost={canViewFinance}
          onSave={saveUnit}
          onCancel={() => setShowNew(false)}
        />
      )}
      {editingUnit && (
        <UnidadModal
          unidad={editingUnit}
          canEditCost={canViewFinance}
          onSave={saveUnit}
          onCancel={() => setEditingUnit(null)}
        />
      )}
    </div>
  )
}


export default function InventarioPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--bg-page)' }} />}>
      <InventarioPageInner />
    </Suspense>
  )
}