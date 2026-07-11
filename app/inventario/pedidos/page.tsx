// TARGET: autocore-npa/app/inventario/pedidos/page.tsx
// ═══════════════════════════════════════════════════════════════════════════
// AutoCore NPA — Inventario · Pipeline de Pedidos (Phase 1)
//
// Replaces the "2026_Inventario_Kia.xlsx" workbook: tracks vehicle orders
// from factory (COREA proformas / ECUADOR VENEKIA) until they become physical
// stock. Upstream of inventory_units — the two link softly via placa.
//
// Tabs (query-string routing, static-export safe):
//   ?tab=tubo         PIPELINE units, grouped/filterable by proforma + canal
//   ?tab=disponibles  RECIBIDO + DISPONIBLE units
//   ?tab=reservados   RESERVADO units (liberar / open deal)
//   ?tab=vendidos     read-only, joined with the linked deal
//   ?tab=mezcla       mezcla_inventario view — capital dashboard
//   ?tab=proformas    proforma list + detail (?id=N)
//
// Permissions:
//   can_view_inventory             → read access
//   can_manage_inventory           → all write actions
//   npa_can_view_inventory_finance → cost columns, capital KPIs, abonado edit
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useState, useEffect, useMemo, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '../../supabase'
import NavBar from '../../components/NavBar'
import { useNPAPermissions } from '../../components/useNPAPermissions'
import { useIsMobile } from '../../components/useIsMobile'

const PLACA_RE = /^[A-Z]{2}[0-9]{3}[A-Z]{2}$/

const fmtMoney = (n: number | null | undefined) =>
  n == null || isNaN(Number(n)) ? '—'
    : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

const todayISO = () => new Date().toISOString().slice(0, 10)

const diasDesde = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const start = new Date(iso + 'T00:00:00')
  return Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000))
}

// ─── Estado catalogs ─────────────────────────────────────────────────────────
const CANALES = ['COREA', 'ECUADOR', 'NA']

const ESTADOS_UNIDAD = [
  { value: 'POR_RECIBIR', label: 'POR RECIBIR', color: '#6b7280' },
  { value: 'EN_TRANSITO', label: 'EN TRANSITO', color: '#e67e22' },
  { value: 'RECIBIDO',    label: 'RECIBIDO',    color: '#1a7a4a' },
]
const ESTADOS_VENTA = [
  { value: 'PIPELINE',   label: 'PIPELINE',   color: '#8b5cf6' },
  { value: 'DISPONIBLE', label: 'DISPONIBLE', color: '#1a7a4a' },
  { value: 'RESERVADO',  label: 'RESERVADO',  color: '#e67e22' },
  { value: 'VENDIDO',    label: 'VENDIDO',    color: '#3b82f6' },
]
const unidadMeta = (v: string) => ESTADOS_UNIDAD.find(e => e.value === v) ?? { value: v, label: v, color: '#6b7280' }
const ventaMeta  = (v: string) => ESTADOS_VENTA.find(e => e.value === v)  ?? { value: v, label: v, color: '#6b7280' }

const TABS = [
  { key: 'tubo',        label: 'Tubo' },
  { key: 'disponibles', label: 'Disponibles' },
  { key: 'reservados',  label: 'Reservados' },
  { key: 'vendidos',    label: 'Vendidos' },
  { key: 'mezcla',      label: 'Mezcla' },
  { key: 'proformas',   label: 'Proformas' },
]

// ─── Types ───────────────────────────────────────────────────────────────────
interface Proforma {
  id: number
  nro: string
  canal: string
  fecha_pedido: string | null
  fecha_pedido_texto: string | null
  total_proforma: number | null
  abonado: number | null
  notas: string | null
  created_at: string
}
interface Pedido {
  id: number
  proforma_id: number | null
  canal: string
  modelo: string
  color: string | null
  placa: string | null
  costo_proforma: number | null
  costo_factura: number | null
  mes_estimado_recepcion: string | null
  fecha_recepcion: string | null
  estado_pedido: string
  estado_unidad: string
  estado_venta: string
  vendedor: string | null
  cliente_reserva: string | null
  fecha_reserva: string | null
  deal_id: number | null
  notas: string | null
  created_at: string
  updated_at: string
}
interface DealLite {
  id: number
  negocio_num: string | null
  cliente_nombre: string | null
  cliente_apellidos: string | null
  vendedor: string | null
  fecha_entrega: string | null
  fecha_factura: string | null
  status: string | null
  created_at: string
}
interface MezclaRow {
  modelo: string
  disponibles: number
  reservados: number
  en_tubo: number
  costo_ref: number | null
  capital_disponible: number | null
}

// ─── Styles (mirrors app/inventario/page.tsx) ───────────────────────────────
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
  btnMini: { padding: '5px 12px', fontSize: '11px', fontWeight: 700, borderRadius: '4px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' },
  kpiBar: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '20px' },
  kpi: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', padding: '16px 18px' },
  kpiLabel: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px', marginBottom: '6px' },
  kpiValue: { fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' as const },
  kpiSub: { fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' },
  tabBar: { display: 'flex', gap: '4px', flexWrap: 'wrap' as const, borderBottom: '1px solid var(--border)', marginBottom: '16px' },
  tabBtn: (active: boolean) => ({
    padding: '10px 18px', border: 'none', borderBottom: active ? '2px solid #BB162B' : '2px solid transparent',
    background: 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const,
    cursor: 'pointer', marginBottom: '-1px',
  }),
  filterBar: { display: 'flex', gap: '12px', flexWrap: 'wrap' as const, marginBottom: '16px' },
  input: { padding: '10px 14px', background: 'var(--bg-input, var(--bg-card))', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '13px', color: 'var(--text-primary)', minWidth: '160px' },
  label: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' },
  th: { padding: '10px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px', borderBottom: '2px solid var(--border)' },
  td: { padding: '10px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' },
  tdNum: { padding: '10px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const },
  badge: (color: string) => ({
    display: 'inline-block', padding: '3px 10px', borderRadius: '3px', fontSize: '10px', fontWeight: 700,
    textTransform: 'uppercase' as const, letterSpacing: '1px',
    background: color + '22', color, border: `1px solid ${color}55`,
  }),
  empty: { padding: '60px 20px', textAlign: 'center' as const, color: 'var(--text-secondary)', fontSize: '13px' },
  modalWrap: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', overflow: 'auto' },
  modal: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '32px', maxWidth: '640px', width: '100%', maxHeight: '90vh', overflowY: 'auto' as const },
  modalTitle: { fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' },
  modalSub: { fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '24px' },
  errBox: { marginTop: '16px', padding: '10px 14px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '8px', color: '#ef4444', fontSize: '12px', fontWeight: 600 },
}

const Field = ({ label, children }: { label: string; children: any }) => (
  <div>
    <label style={s.label}>{label}</label>
    <div style={{ marginTop: '4px' }}>{children}</div>
  </div>
)

// ═══════════════════════════════════════════════════════════════════════════
// MODAL: Nueva Proforma
// ═══════════════════════════════════════════════════════════════════════════
function ProformaModal({ canFinance, onSave, onCancel }: {
  canFinance: boolean
  onSave: (data: any) => Promise<void>
  onCancel: () => void
}) {
  const isMobile = useIsMobile()
  const [form, setForm] = useState({ nro: '', canal: 'COREA', mes: '', total_proforma: '', abonado: '', notas: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    setError(null)
    if (!form.nro.trim()) { setError('Número de proforma requerido'); return }
    setSaving(true)
    try {
      await onSave({
        nro: form.nro.trim(),
        canal: form.canal,
        fecha_pedido: form.mes ? form.mes + '-01' : null,
        fecha_pedido_texto: form.mes || null,
        total_proforma: canFinance && form.total_proforma !== '' ? Number(form.total_proforma) : null,
        abonado: canFinance && form.abonado !== '' ? Number(form.abonado) : 0,
        notas: form.notas.trim() || null,
      })
    } catch (e: any) {
      setError(e?.message || 'Error al guardar')
      setSaving(false)
    }
  }

  return (
    <div style={s.modalWrap}>
      <div style={{ ...s.modal, padding: isMobile ? '20px' : '32px' }}>
        <div style={s.modalTitle}>Nueva Proforma</div>
        <div style={s.modalSub}>Registra un pedido al proveedor (una proforma agrupa N unidades).</div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
          <Field label="Proforma Nro. *">
            <input type="text" value={form.nro} onChange={e => set('nro', e.target.value)}
              placeholder="00-0091" style={{ ...s.input, width: '100%', fontFamily: 'monospace' }} />
          </Field>
          <Field label="Canal *">
            <select value={form.canal} onChange={e => set('canal', e.target.value)} style={{ ...s.input, width: '100%' }}>
              {CANALES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Mes del Pedido">
            <input type="month" value={form.mes} onChange={e => set('mes', e.target.value)} style={{ ...s.input, width: '100%' }} />
          </Field>
          {canFinance && (
            <Field label="Total Proforma USD">
              <input type="number" step="0.01" value={form.total_proforma}
                onChange={e => set('total_proforma', e.target.value)} placeholder="450000.00" style={{ ...s.input, width: '100%' }} />
            </Field>
          )}
          {canFinance && (
            <Field label="Abonado USD">
              <input type="number" step="0.01" value={form.abonado}
                onChange={e => set('abonado', e.target.value)} placeholder="225000.00" style={{ ...s.input, width: '100%' }} />
            </Field>
          )}
        </div>
        <Field label="Notas (opcional)">
          <textarea value={form.notas} onChange={e => set('notas', e.target.value)} rows={2}
            style={{ ...s.input, width: '100%', fontFamily: 'inherit', resize: 'vertical' as const }} />
        </Field>
        {error && <div style={s.errBox}>{error}</div>}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '24px' }}>
          <button onClick={onCancel} style={s.btnGray} disabled={saving}>Cancelar</button>
          <button onClick={handleSave} style={s.btnGreen} disabled={saving}>
            {saving ? 'Guardando...' : 'Crear Proforma'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// MODAL: Agregar / Editar Pedido(s)
//   pedido = null  → add mode (cantidad N identical units)
//   pedido = row   → edit mode
// ═══════════════════════════════════════════════════════════════════════════
function PedidoModal({ pedido, proformas, fixedProformaId, canFinance, onSave, onCancel }: {
  pedido: Pedido | null
  proformas: Proforma[]
  fixedProformaId: number | null
  canFinance: boolean
  onSave: (data: any, cantidad: number) => Promise<void>
  onCancel: () => void
}) {
  const isMobile = useIsMobile()
  const isNew = !pedido
  const initialProformaId = pedido ? pedido.proforma_id : fixedProformaId
  const [form, setForm] = useState({
    proforma_id: initialProformaId != null ? String(initialProformaId) : '',
    canal: pedido?.canal || (initialProformaId != null
      ? (proformas.find(p => p.id === initialProformaId)?.canal || 'COREA')
      : 'COREA'),
    modelo: pedido?.modelo || '',
    color: pedido?.color || '',
    costo_proforma: pedido?.costo_proforma != null ? String(pedido.costo_proforma) : '',
    costo_factura: pedido?.costo_factura != null ? String(pedido.costo_factura) : '',
    mes_estimado_recepcion: pedido?.mes_estimado_recepcion || '',
    estado_pedido: pedido?.estado_pedido || 'CONFIRMADO',
    notas: pedido?.notas || '',
  })
  const [cantidad, setCantidad] = useState(1)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }))

  const onProformaChange = (v: string) => {
    const pf = proformas.find(p => String(p.id) === v)
    setForm(f => ({ ...f, proforma_id: v, canal: pf ? pf.canal : f.canal }))
  }

  const handleSave = async () => {
    setError(null)
    if (!form.modelo.trim()) { setError('Modelo requerido'); return }
    if (isNew && (cantidad < 1 || cantidad > 50)) { setError('Cantidad debe estar entre 1 y 50'); return }
    setSaving(true)
    try {
      await onSave({
        proforma_id: form.proforma_id ? Number(form.proforma_id) : null,
        canal: form.canal,
        modelo: form.modelo.trim().toUpperCase(),
        color: form.color.trim() ? form.color.trim().toUpperCase() : null,
        costo_proforma: form.costo_proforma !== '' ? Number(form.costo_proforma) : null,
        costo_factura: canFinance && form.costo_factura !== '' ? Number(form.costo_factura) : (pedido?.costo_factura ?? null),
        mes_estimado_recepcion: form.mes_estimado_recepcion.trim() ? form.mes_estimado_recepcion.trim().toUpperCase() : null,
        estado_pedido: form.estado_pedido.trim() ? form.estado_pedido.trim().toUpperCase().replace(/\s+/g, '_') : 'CONFIRMADO',
        notas: form.notas.trim() || null,
      }, isNew ? cantidad : 1)
    } catch (e: any) {
      setError(e?.message || 'Error al guardar')
      setSaving(false)
    }
  }

  return (
    <div style={s.modalWrap}>
      <div style={{ ...s.modal, padding: isMobile ? '20px' : '32px' }}>
        <div style={s.modalTitle}>{isNew ? 'Agregar Pedido(s)' : 'Editar Pedido'}</div>
        <div style={s.modalSub}>
          {isNew
            ? 'Agrega una o varias unidades idénticas al pipeline.'
            : `Pedido #${pedido!.id} — ${pedido!.modelo}`}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
          <Field label="Proforma">
            <select value={form.proforma_id} onChange={e => onProformaChange(e.target.value)}
              disabled={fixedProformaId != null && isNew}
              style={{ ...s.input, width: '100%', opacity: fixedProformaId != null && isNew ? 0.6 : 1 }}>
              <option value="">Sin proforma</option>
              {proformas.map(p => <option key={p.id} value={String(p.id)}>{p.nro} ({p.canal})</option>)}
            </select>
          </Field>
          <Field label="Canal *">
            <select value={form.canal} onChange={e => set('canal', e.target.value)}
              disabled={!!form.proforma_id}
              style={{ ...s.input, width: '100%', opacity: form.proforma_id ? 0.6 : 1 }}>
              {CANALES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Modelo *">
            <input type="text" value={form.modelo} onChange={e => set('modelo', e.target.value.toUpperCase())}
              placeholder="SOLUTO AT" style={{ ...s.input, width: '100%', textTransform: 'uppercase' as const }} />
          </Field>
          <Field label="Color">
            <input type="text" value={form.color} onChange={e => set('color', e.target.value.toUpperCase())}
              placeholder="PLATA TITANIUM" style={{ ...s.input, width: '100%', textTransform: 'uppercase' as const }} />
          </Field>
          <Field label="Costo Proforma USD">
            <input type="number" step="0.01" value={form.costo_proforma}
              onChange={e => set('costo_proforma', e.target.value)} placeholder="18465.52" style={{ ...s.input, width: '100%' }} />
          </Field>
          {canFinance && (
            <Field label="Costo Factura USD">
              <input type="number" step="0.01" value={form.costo_factura}
                onChange={e => set('costo_factura', e.target.value)} placeholder="18466.00" style={{ ...s.input, width: '100%' }} />
            </Field>
          )}
          <Field label="Mes Estimado Recepción">
            <input type="text" value={form.mes_estimado_recepcion}
              onChange={e => set('mes_estimado_recepcion', e.target.value.toUpperCase())}
              placeholder="OCTUBRE" style={{ ...s.input, width: '100%', textTransform: 'uppercase' as const }} />
          </Field>
          <Field label="Estado Pedido">
            <select value={form.estado_pedido} onChange={e => set('estado_pedido', e.target.value)} style={{ ...s.input, width: '100%' }}>
              <option value="CONFIRMADO">CONFIRMADO</option>
              <option value="NO_CONFIRMADO">NO CONFIRMADO</option>
            </select>
          </Field>
          {isNew && (
            <Field label="Cantidad de Unidades">
              <input type="number" min={1} max={50} value={cantidad}
                onChange={e => setCantidad(Number(e.target.value))} style={{ ...s.input, width: '100%' }} />
            </Field>
          )}
        </div>
        <Field label="Notas (opcional)">
          <textarea value={form.notas} onChange={e => set('notas', e.target.value)} rows={2}
            style={{ ...s.input, width: '100%', fontFamily: 'inherit', resize: 'vertical' as const }} />
        </Field>
        {error && <div style={s.errBox}>{error}</div>}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '24px' }}>
          <button onClick={onCancel} style={s.btnGray} disabled={saving}>Cancelar</button>
          <button onClick={handleSave} style={s.btnGreen} disabled={saving}>
            {saving ? 'Guardando...' : (isNew ? (cantidad > 1 ? `Agregar ${cantidad} Unidades` : 'Agregar Unidad') : 'Guardar Cambios')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// MODAL: Marcar Recibido (requires valid placa)
// ═══════════════════════════════════════════════════════════════════════════
function RecibirModal({ pedido, onSave, onCancel }: {
  pedido: Pedido
  onSave: (placa: string) => Promise<void>
  onCancel: () => void
}) {
  const isMobile = useIsMobile()
  const [placa, setPlaca] = useState(pedido.placa || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    setError(null)
    const p = placa.trim().toUpperCase()
    if (!PLACA_RE.test(p)) {
      setError('Placa inválida — formato requerido: 2 letras + 3 números + 2 letras (ej. AE351AR). Verifica confusiones 0/O.')
      return
    }
    setSaving(true)
    try { await onSave(p) } catch (e: any) { setError(e?.message || 'Error al guardar'); setSaving(false) }
  }

  return (
    <div style={s.modalWrap}>
      <div style={{ ...s.modal, maxWidth: '440px', padding: isMobile ? '20px' : '32px' }}>
        <div style={s.modalTitle}>Marcar Recibido</div>
        <div style={s.modalSub}>{pedido.modelo}{pedido.color ? ` · ${pedido.color}` : ''} — al recibir, la unidad requiere placa nacionalizada.</div>
        <Field label="Placa *">
          <input type="text" value={placa} maxLength={7} autoFocus
            onChange={e => setPlaca(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            placeholder="AE351AR"
            style={{ ...s.input, width: '100%', fontFamily: 'monospace', fontSize: '18px', letterSpacing: '3px', textTransform: 'uppercase' as const }} />
        </Field>
        {error && <div style={s.errBox}>{error}</div>}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '24px' }}>
          <button onClick={onCancel} style={s.btnGray} disabled={saving}>Cancelar</button>
          <button onClick={handleSave} style={s.btnGreen} disabled={saving}>
            {saving ? 'Guardando...' : 'Confirmar Recepción'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// MODAL: Reservar
// ═══════════════════════════════════════════════════════════════════════════
function ReservarModal({ pedido, onSave, onCancel }: {
  pedido: Pedido
  onSave: (data: { vendedor: string; cliente: string; fecha: string }) => Promise<void>
  onCancel: () => void
}) {
  const isMobile = useIsMobile()
  const [form, setForm] = useState({ vendedor: '', cliente: '', fecha: todayISO() })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    setError(null)
    if (!form.vendedor.trim()) { setError('Vendedor requerido'); return }
    if (!form.cliente.trim()) { setError('Cliente requerido'); return }
    if (!form.fecha) { setError('Fecha requerida'); return }
    setSaving(true)
    try {
      await onSave({ vendedor: form.vendedor.trim().toUpperCase(), cliente: form.cliente.trim().toUpperCase(), fecha: form.fecha })
    } catch (e: any) { setError(e?.message || 'Error al guardar'); setSaving(false) }
  }

  return (
    <div style={s.modalWrap}>
      <div style={{ ...s.modal, maxWidth: '480px', padding: isMobile ? '20px' : '32px' }}>
        <div style={s.modalTitle}>Reservar Unidad</div>
        <div style={s.modalSub}>
          {pedido.modelo}{pedido.color ? ` · ${pedido.color}` : ''}{pedido.placa ? ` · ${pedido.placa}` : ''}
        </div>
        <div style={{ display: 'grid', gap: '12px' }}>
          <Field label="Vendedor *">
            <input type="text" value={form.vendedor} onChange={e => set('vendedor', e.target.value.toUpperCase())}
              placeholder="MAURICE RODRIGUEZ" style={{ ...s.input, width: '100%', textTransform: 'uppercase' as const }} />
          </Field>
          <Field label="Cliente *">
            <input type="text" value={form.cliente} onChange={e => set('cliente', e.target.value.toUpperCase())}
              placeholder="CARLA CORREA" style={{ ...s.input, width: '100%', textTransform: 'uppercase' as const }} />
          </Field>
          <Field label="Fecha de Reserva *">
            <input type="date" value={form.fecha} onChange={e => set('fecha', e.target.value)} style={{ ...s.input, width: '100%' }} />
          </Field>
        </div>
        {error && <div style={s.errBox}>{error}</div>}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '24px' }}>
          <button onClick={onCancel} style={s.btnGray} disabled={saving}>Cancelar</button>
          <button onClick={handleSave} style={s.btnGreen} disabled={saving}>
            {saving ? 'Guardando...' : 'Reservar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════
function PedidosPageInner() {
  const searchParams = useSearchParams()
  const { permissions, ready } = useNPAPermissions()
  const isMobile = useIsMobile()

  // Mobile layout overrides (phone-first usage, like tesorería)
  const contentStyle = { ...s.content, padding: isMobile ? '16px 12px' : '32px' }
  const kpiBarStyle = { ...s.kpiBar, gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fit, minmax(180px, 1fr))' }
  const tabBarStyle = { ...s.tabBar, flexWrap: isMobile ? ('nowrap' as const) : ('wrap' as const), overflowX: 'auto' as const }
  const cardStyle = { ...s.card, padding: isMobile ? '12px' : '20px' }
  const titleStyle = { ...s.title, fontSize: isMobile ? '20px' : '24px' }
  const btnPad = isMobile ? { padding: '10px 14px' } : {}

  const canView = permissions.can_view_inventory || permissions.can_manage_inventory
  const canManage = permissions.can_manage_inventory
  const canFinance = permissions.npa_can_view_inventory_finance

  const [tab, setTab] = useState<string>(() => {
    const t = searchParams?.get('tab')
    return TABS.some(x => x.key === t) ? (t as string) : 'tubo'
  })
  const [proformaDetailId, setProformaDetailId] = useState<number | null>(() => {
    const id = searchParams?.get('id')
    return id && /^\d+$/.test(id) ? Number(id) : null
  })

  const [pedidos, setPedidos] = useState<Pedido[]>([])
  const [proformas, setProformas] = useState<Proforma[]>([])
  const [mezcla, setMezcla] = useState<MezclaRow[]>([])
  const [deals, setDeals] = useState<Record<number, DealLite>>({})
  const [loading, setLoading] = useState(true)
  const [actionError, setActionError] = useState<string | null>(null)

  // Filters (Tubo)
  const [filterProforma, setFilterProforma] = useState('ALL')
  const [filterCanal, setFilterCanal] = useState('ALL')

  // Modals
  const [showNewProforma, setShowNewProforma] = useState(false)
  const [pedidoModal, setPedidoModal] = useState<{ pedido: Pedido | null; fixedProformaId: number | null } | null>(null)
  const [recibirTarget, setRecibirTarget] = useState<Pedido | null>(null)
  const [reservarTarget, setReservarTarget] = useState<Pedido | null>(null)

  // Abonado inline edit (proforma detail)
  const [abonadoEdit, setAbonadoEdit] = useState<string>('')
  const [abonadoSaving, setAbonadoSaving] = useState(false)

  // ─── Permission gate ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return
    if (!canView) window.location.href = '/dashboard'
  }, [ready, canView])

  // ─── URL sync (query-string routing, static-export safe) ─────────────────
  const goTab = (t: string, id: number | null = null) => {
    setTab(t)
    setProformaDetailId(id)
    const qs = id != null ? `?tab=${t}&id=${id}` : `?tab=${t}`
    window.history.replaceState({}, '', '/inventario/pedidos' + qs)
  }

  // ─── Data load ─────────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setLoading(true)
    const [pedRes, proRes, mezRes] = await Promise.all([
      supabase.from('inventory_pedidos').select('*').order('id', { ascending: true }),
      supabase.from('proformas').select('*').order('nro', { ascending: true }),
      supabase.from('mezcla_inventario').select('*').order('modelo', { ascending: true }),
    ])
    const ped = (Array.isArray(pedRes.data) ? pedRes.data : []) as Pedido[]
    setPedidos(ped)
    setProformas((Array.isArray(proRes.data) ? proRes.data : []) as Proforma[])
    setMezcla((Array.isArray(mezRes.data) ? mezRes.data : []) as MezclaRow[])

    const dealIds = Array.from(new Set(ped.map(p => p.deal_id).filter((x): x is number => x != null)))
    if (dealIds.length > 0) {
      const { data: dData } = await supabase
        .from('deals')
        .select('id, negocio_num, cliente_nombre, cliente_apellidos, vendedor, fecha_entrega, fecha_factura, status, created_at')
        .in('id', dealIds)
      const map: Record<number, DealLite> = {}
      if (Array.isArray(dData)) for (const d of dData as DealLite[]) map[d.id] = d
      setDeals(map)
    } else {
      setDeals({})
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!ready || !canView) return
    loadAll()
  }, [ready, canView, loadAll])

  // ─── Write helpers ─────────────────────────────────────────────────────────
  const updatePedido = async (id: number, patch: Record<string, any>) => {
    setActionError(null)
    const { error } = await supabase.from('inventory_pedidos').update(patch).eq('id', id)
    if (error) { setActionError(error.message); throw new Error(error.message) }
    await loadAll()
  }

  const marcarEnTransito = (p: Pedido) =>
    updatePedido(p.id, { estado_unidad: 'EN_TRANSITO' }).catch(() => {})

  const marcarRecibido = async (p: Pedido, placa: string) => {
    await updatePedido(p.id, {
      estado_unidad: 'RECIBIDO',
      placa,
      fecha_recepcion: todayISO(),
      // A received unit enters the sales floor unless already reserved/sold.
      ...(p.estado_venta === 'PIPELINE' ? { estado_venta: 'DISPONIBLE' } : {}),
    })
    setRecibirTarget(null)
  }

  const reservar = async (p: Pedido, data: { vendedor: string; cliente: string; fecha: string }) => {
    await updatePedido(p.id, {
      estado_venta: 'RESERVADO',
      vendedor: data.vendedor,
      cliente_reserva: data.cliente,
      fecha_reserva: data.fecha,
    })
    setReservarTarget(null)
  }

  const liberar = async (p: Pedido) => {
    if (!window.confirm(`Liberar la reserva de ${p.cliente_reserva || 'cliente'} sobre ${p.modelo}?`)) return
    await updatePedido(p.id, {
      estado_venta: p.estado_unidad === 'RECIBIDO' ? 'DISPONIBLE' : 'PIPELINE',
      vendedor: null,
      cliente_reserva: null,
      fecha_reserva: null,
    }).catch(() => {})
  }

  const savePedido = async (data: any, cantidad: number) => {
    setActionError(null)
    if (pedidoModal?.pedido) {
      await updatePedido(pedidoModal.pedido.id, data)
    } else {
      const rows = Array.from({ length: cantidad }, () => ({ ...data }))
      const { error } = await supabase.from('inventory_pedidos').insert(rows)
      if (error) { setActionError(error.message); throw new Error(error.message) }
      await loadAll()
    }
    setPedidoModal(null)
  }

  const saveProforma = async (data: any) => {
    setActionError(null)
    const { error } = await supabase.from('proformas').insert(data)
    if (error) { setActionError(error.message); throw new Error(error.message) }
    await loadAll()
    setShowNewProforma(false)
  }

  const saveAbonado = async (proforma: Proforma) => {
    if (abonadoEdit === '' || isNaN(Number(abonadoEdit))) return
    setAbonadoSaving(true)
    const { error } = await supabase.from('proformas').update({ abonado: Number(abonadoEdit) }).eq('id', proforma.id)
    if (error) setActionError(error.message)
    else await loadAll()
    setAbonadoSaving(false)
    setAbonadoEdit('')
  }

  // ─── Derived data ──────────────────────────────────────────────────────────
  const proformasById = useMemo(() => {
    const m: Record<number, Proforma> = {}
    for (const p of proformas) m[p.id] = p
    return m
  }, [proformas])

  const pedidosByProforma = useMemo(() => {
    const m: Record<number, Pedido[]> = {}
    for (const p of pedidos) {
      if (p.proforma_id == null) continue
      ;(m[p.proforma_id] ||= []).push(p)
    }
    return m
  }, [pedidos])

  const tubo        = useMemo(() => pedidos.filter(p => p.estado_venta === 'PIPELINE'), [pedidos])
  const disponibles = useMemo(() => pedidos.filter(p => p.estado_venta === 'DISPONIBLE'), [pedidos])
  const reservados  = useMemo(() => pedidos.filter(p => p.estado_venta === 'RESERVADO'), [pedidos])
  const vendidos    = useMemo(() => pedidos.filter(p => p.estado_venta === 'VENDIDO'), [pedidos])

  const tuboFiltered = useMemo(() => tubo.filter(p => {
    if (filterCanal !== 'ALL' && p.canal !== filterCanal) return false
    if (filterProforma !== 'ALL') {
      if (filterProforma === 'NONE') { if (p.proforma_id != null) return false }
      else if (String(p.proforma_id) !== filterProforma) return false
    }
    return true
  }), [tubo, filterCanal, filterProforma])

  const kpis = useMemo(() => {
    const capital = disponibles.reduce((sum, p) => sum + (Number(p.costo_factura ?? p.costo_proforma) || 0), 0)
    const year = new Date().getFullYear()
    const vendidasYear = vendidos.filter(p => {
      const d = p.deal_id != null ? deals[p.deal_id] : null
      const fecha = d ? (d.fecha_entrega || d.fecha_factura || d.created_at) : p.updated_at
      return fecha ? new Date(fecha).getFullYear() === year : false
    }).length
    return { disponibles: disponibles.length, capital, reservas: reservados.length, tubo: tubo.length, vendidasYear, year }
  }, [disponibles, reservados, tubo, vendidos, deals])

  // ─── Render helpers ────────────────────────────────────────────────────────
  const badgeUnidad = (v: string) => <span style={s.badge(unidadMeta(v).color)}>{unidadMeta(v).label}</span>
  const badgeVenta  = (v: string) => <span style={s.badge(ventaMeta(v).color)}>{ventaMeta(v).label}</span>
  const proformaNro = (p: Pedido) => (p.proforma_id != null && proformasById[p.proforma_id]) ? proformasById[p.proforma_id].nro : '—'
  const dealLabel = (d: DealLite) =>
    `#${d.negocio_num || d.id} · ${[d.cliente_nombre, d.cliente_apellidos].filter(Boolean).join(' ') || '—'}`

  if (!ready || (canView && loading)) {
    return (
      <div style={s.page}>
        <NavBar />
        <div style={contentStyle}><div style={s.empty}>Cargando pipeline de inventario...</div></div>
      </div>
    )
  }
  if (!canView) return <div style={s.page}><NavBar /></div>

  const detailProforma = proformaDetailId != null ? proformasById[proformaDetailId] : null

  return (
    <div style={s.page}>
      <NavBar />
      <div style={contentStyle}>
        {/* Header */}
        <div style={s.header}>
          <div>
            <div style={s.subtitle}>Inventario</div>
            <div style={titleStyle}>Pipeline de Pedidos</div>
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' as const }}>
            <button onClick={() => { window.location.href = '/inventario' }} style={{ ...s.btnGray, ...btnPad }}>Stock Fisico</button>
            {canManage && (
              <>
                <button onClick={() => setPedidoModal({ pedido: null, fixedProformaId: null })} style={{ ...s.btnGray, ...btnPad }}>Agregar Pedido</button>
                <button onClick={() => setShowNewProforma(true)} style={{ ...s.btnRed, ...btnPad }}>Nueva Proforma</button>
              </>
            )}
          </div>
        </div>

        {/* KPI bar */}
        <div style={kpiBarStyle}>
          <div style={s.kpi}>
            <div style={s.kpiLabel}>Disponibles</div>
            <div style={s.kpiValue}>{kpis.disponibles}</div>
            {canFinance && <div style={s.kpiSub}>{fmtMoney(kpis.capital)} capital</div>}
          </div>
          <div style={s.kpi}>
            <div style={s.kpiLabel}>Reservas</div>
            <div style={s.kpiValue}>{kpis.reservas}</div>
          </div>
          <div style={s.kpi}>
            <div style={s.kpiLabel}>Tubo</div>
            <div style={s.kpiValue}>{kpis.tubo}</div>
            <div style={s.kpiSub}>unidades en pipeline</div>
          </div>
          <div style={s.kpi}>
            <div style={s.kpiLabel}>Vendidas {kpis.year}</div>
            <div style={s.kpiValue}>{kpis.vendidasYear}</div>
          </div>
        </div>

        {actionError && <div style={{ ...s.errBox, marginTop: 0, marginBottom: '16px' }}>{actionError}</div>}

        {/* Tabs */}
        <div style={tabBarStyle}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => goTab(t.key)} style={s.tabBtn(tab === t.key)}>
              {t.label}
              {t.key === 'tubo' && ` (${tubo.length})`}
              {t.key === 'disponibles' && ` (${disponibles.length})`}
              {t.key === 'reservados' && ` (${reservados.length})`}
              {t.key === 'vendidos' && ` (${vendidos.length})`}
            </button>
          ))}
        </div>

        {/* ══ TAB: TUBO ══════════════════════════════════════════════════════ */}
        {tab === 'tubo' && (
          <div style={cardStyle}>
            <div style={s.filterBar}>
              <select value={filterCanal} onChange={e => setFilterCanal(e.target.value)}
                style={{ ...s.input, ...(isMobile ? { flex: 1, minWidth: '120px' } : {}) }}>
                <option value="ALL">Todos los Canales</option>
                {CANALES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={filterProforma} onChange={e => setFilterProforma(e.target.value)}
                style={{ ...s.input, ...(isMobile ? { flex: 1, minWidth: '150px' } : {}) }}>
                <option value="ALL">Todas las Proformas</option>
                <option value="NONE">Sin proforma</option>
                {proformas.map(p => <option key={p.id} value={String(p.id)}>{p.nro} ({p.canal})</option>)}
              </select>
            </div>
            {tuboFiltered.length === 0 ? (
              <div style={s.empty}>No hay unidades en el tubo con estos filtros.</div>
            ) : (
              <div style={{ overflowX: 'auto' as const }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Proforma</th>
                      <th style={s.th}>Canal</th>
                      <th style={s.th}>Modelo</th>
                      <th style={s.th}>Color</th>
                      <th style={s.th}>Mes Estimado</th>
                      {canFinance && <th style={{ ...s.th, textAlign: 'right' as const }}>Costo Proforma</th>}
                      <th style={s.th}>Estado Unidad</th>
                      {canManage && <th style={{ ...s.th, textAlign: 'right' as const }}>Acciones</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {tuboFiltered.map(p => (
                      <tr key={p.id}>
                        <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '11px' }}>{proformaNro(p)}</td>
                        <td style={s.td}>{p.canal}</td>
                        <td style={s.td}>{p.modelo}</td>
                        <td style={s.td}>{p.color || '—'}</td>
                        <td style={s.td}>{p.mes_estimado_recepcion || '—'}</td>
                        {canFinance && <td style={s.tdNum}>{fmtMoney(p.costo_proforma)}</td>}
                        <td style={s.td}>{badgeUnidad(p.estado_unidad)}</td>
                        {canManage && (
                          <td style={{ ...s.td, textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
                            {p.estado_unidad === 'POR_RECIBIR' && (
                              <button onClick={() => marcarEnTransito(p)} style={{ ...s.btnMini, marginRight: '6px' }}>En Transito</button>
                            )}
                            {p.estado_unidad !== 'RECIBIDO' && (
                              <button onClick={() => setRecibirTarget(p)} style={{ ...s.btnMini, color: '#1a7a4a', borderColor: '#1a7a4a55', marginRight: '6px' }}>Recibido</button>
                            )}
                            <button onClick={() => setPedidoModal({ pedido: p, fixedProformaId: null })} style={s.btnMini}>Editar</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══ TAB: DISPONIBLES ═══════════════════════════════════════════════ */}
        {tab === 'disponibles' && (
          <div style={cardStyle}>
            {disponibles.length === 0 ? (
              <div style={s.empty}>No hay unidades disponibles.</div>
            ) : (
              <div style={{ overflowX: 'auto' as const }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Placa</th>
                      <th style={s.th}>Modelo</th>
                      <th style={s.th}>Color</th>
                      <th style={s.th}>Canal</th>
                      {canFinance && <th style={{ ...s.th, textAlign: 'right' as const }}>Costo Factura</th>}
                      <th style={s.th}>Recepción</th>
                      <th style={s.th}>Días en Inventario</th>
                      {canManage && <th style={{ ...s.th, textAlign: 'right' as const }}>Acciones</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {disponibles.map(p => {
                      const dias = diasDesde(p.fecha_recepcion)
                      return (
                        <tr key={p.id}>
                          <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '12px' }}>{p.placa || '—'}</td>
                          <td style={s.td}>{p.modelo}</td>
                          <td style={s.td}>{p.color || '—'}</td>
                          <td style={s.td}>{p.canal}</td>
                          {canFinance && <td style={s.tdNum}>{fmtMoney(p.costo_factura ?? p.costo_proforma)}</td>}
                          <td style={s.td}>{fmtDate(p.fecha_recepcion)}</td>
                          <td style={s.td}>{dias == null ? '—' : dias}</td>
                          {canManage && (
                            <td style={{ ...s.td, textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
                              <button onClick={() => setReservarTarget(p)} style={{ ...s.btnMini, color: '#e67e22', borderColor: '#e67e2255', marginRight: '6px' }}>Reservar</button>
                              <button onClick={() => setPedidoModal({ pedido: p, fixedProformaId: null })} style={s.btnMini}>Editar</button>
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══ TAB: RESERVADOS ════════════════════════════════════════════════ */}
        {tab === 'reservados' && (
          <div style={cardStyle}>
            {reservados.length === 0 ? (
              <div style={s.empty}>No hay unidades reservadas.</div>
            ) : (
              <div style={{ overflowX: 'auto' as const }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Modelo</th>
                      <th style={s.th}>Color</th>
                      <th style={s.th}>Placa</th>
                      <th style={s.th}>Estado Unidad</th>
                      <th style={s.th}>Cliente</th>
                      <th style={s.th}>Vendedor</th>
                      <th style={s.th}>Fecha Reserva</th>
                      {canManage && <th style={{ ...s.th, textAlign: 'right' as const }}>Acciones</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {reservados.map(p => (
                      <tr key={p.id}>
                        <td style={s.td}>{p.modelo}</td>
                        <td style={s.td}>{p.color || '—'}</td>
                        <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '12px' }}>{p.placa || '—'}</td>
                        <td style={s.td}>{badgeUnidad(p.estado_unidad)}</td>
                        <td style={s.td}>{p.cliente_reserva || '—'}</td>
                        <td style={s.td}>{p.vendedor || '—'}</td>
                        <td style={s.td}>{fmtDate(p.fecha_reserva)}</td>
                        {canManage && (
                          <td style={{ ...s.td, textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
                            {p.estado_unidad !== 'RECIBIDO' && (
                              <button onClick={() => setRecibirTarget(p)} style={{ ...s.btnMini, color: '#1a7a4a', borderColor: '#1a7a4a55', marginRight: '6px' }}>Recibido</button>
                            )}
                            <button onClick={() => liberar(p)} style={{ ...s.btnMini, color: '#ef4444', borderColor: '#ef444455' }}>Liberar</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══ TAB: VENDIDOS ══════════════════════════════════════════════════ */}
        {tab === 'vendidos' && (
          <div style={cardStyle}>
            {vendidos.length === 0 ? (
              <div style={s.empty}>No hay unidades vendidas registradas en el pipeline.</div>
            ) : (
              <div style={{ overflowX: 'auto' as const }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Placa</th>
                      <th style={s.th}>Modelo</th>
                      <th style={s.th}>Color</th>
                      <th style={s.th}>Negocio</th>
                      <th style={s.th}>Cliente</th>
                      <th style={s.th}>Vendedor</th>
                      <th style={s.th}>Fecha Entrega</th>
                      <th style={{ ...s.th, textAlign: 'right' as const }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendidos.map(p => {
                      const d = p.deal_id != null ? deals[p.deal_id] : null
                      return (
                        <tr key={p.id}>
                          <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '12px' }}>{p.placa || '—'}</td>
                          <td style={s.td}>{p.modelo}</td>
                          <td style={s.td}>{p.color || '—'}</td>
                          <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '11px' }}>{d ? `#${d.negocio_num || d.id}` : '—'}</td>
                          <td style={s.td}>{d ? ([d.cliente_nombre, d.cliente_apellidos].filter(Boolean).join(' ') || '—') : (p.cliente_reserva || '—')}</td>
                          <td style={s.td}>{d?.vendedor || p.vendedor || '—'}</td>
                          <td style={s.td}>{fmtDate(d?.fecha_entrega)}</td>
                          <td style={{ ...s.td, textAlign: 'right' as const }}></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══ TAB: MEZCLA ════════════════════════════════════════════════════ */}
        {tab === 'mezcla' && (
          <div style={cardStyle}>
            {mezcla.length === 0 ? (
              <div style={s.empty}>Sin datos de mezcla — el pipeline está vacío.</div>
            ) : (
              <div style={{ overflowX: 'auto' as const }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Modelo</th>
                      <th style={{ ...s.th, textAlign: 'right' as const }}>Disponibles</th>
                      <th style={{ ...s.th, textAlign: 'right' as const }}>Reservados</th>
                      <th style={{ ...s.th, textAlign: 'right' as const }}>En Tubo</th>
                      {canFinance && <th style={{ ...s.th, textAlign: 'right' as const }}>Costo Ref.</th>}
                      {canFinance && <th style={{ ...s.th, textAlign: 'right' as const }}>Capital Disponible</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {mezcla.map(m => (
                      <tr key={m.modelo}>
                        <td style={s.td}>{m.modelo}</td>
                        <td style={s.tdNum}>{m.disponibles}</td>
                        <td style={s.tdNum}>{m.reservados}</td>
                        <td style={s.tdNum}>{m.en_tubo}</td>
                        {canFinance && <td style={s.tdNum}>{fmtMoney(m.costo_ref)}</td>}
                        {canFinance && <td style={{ ...s.tdNum, fontWeight: 700 }}>{fmtMoney(m.capital_disponible)}</td>}
                      </tr>
                    ))}
                    <tr>
                      <td style={{ ...s.td, fontWeight: 800, borderTop: '2px solid var(--border)' }}>TOTAL</td>
                      <td style={{ ...s.tdNum, fontWeight: 800, borderTop: '2px solid var(--border)' }}>{mezcla.reduce((a, m) => a + Number(m.disponibles || 0), 0)}</td>
                      <td style={{ ...s.tdNum, fontWeight: 800, borderTop: '2px solid var(--border)' }}>{mezcla.reduce((a, m) => a + Number(m.reservados || 0), 0)}</td>
                      <td style={{ ...s.tdNum, fontWeight: 800, borderTop: '2px solid var(--border)' }}>{mezcla.reduce((a, m) => a + Number(m.en_tubo || 0), 0)}</td>
                      {canFinance && <td style={{ ...s.tdNum, borderTop: '2px solid var(--border)' }}></td>}
                      {canFinance && <td style={{ ...s.tdNum, fontWeight: 800, borderTop: '2px solid var(--border)' }}>{fmtMoney(mezcla.reduce((a, m) => a + Number(m.capital_disponible || 0), 0))}</td>}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══ TAB: PROFORMAS (list) ══════════════════════════════════════════ */}
        {tab === 'proformas' && !detailProforma && (
          <div style={cardStyle}>
            {proformas.length === 0 ? (
              <div style={s.empty}>No hay proformas registradas.</div>
            ) : (
              <div style={{ overflowX: 'auto' as const }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Nro</th>
                      <th style={s.th}>Canal</th>
                      <th style={s.th}>Fecha Pedido</th>
                      <th style={{ ...s.th, textAlign: 'right' as const }}>Unidades</th>
                      {canFinance && <th style={{ ...s.th, textAlign: 'right' as const }}>Total</th>}
                      {canFinance && <th style={{ ...s.th, textAlign: 'right' as const }}>Abonado</th>}
                      {canFinance && <th style={{ ...s.th, textAlign: 'right' as const }}>Saldo</th>}
                      <th style={{ ...s.th, textAlign: 'right' as const }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {proformas.map(pf => {
                      const units = pedidosByProforma[pf.id] || []
                      const total = pf.total_proforma ?? units.reduce((a, u) => a + (Number(u.costo_proforma) || 0), 0)
                      const saldo = total - (Number(pf.abonado) || 0)
                      return (
                        <tr key={pf.id} style={{ cursor: 'pointer' }} onClick={() => goTab('proformas', pf.id)}>
                          <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '12px', fontWeight: 700 }}>{pf.nro}</td>
                          <td style={s.td}>{pf.canal}</td>
                          <td style={s.td}>{pf.fecha_pedido_texto || fmtDate(pf.fecha_pedido)}</td>
                          <td style={s.tdNum}>{units.length}</td>
                          {canFinance && <td style={s.tdNum}>{fmtMoney(total)}</td>}
                          {canFinance && <td style={s.tdNum}>{fmtMoney(pf.abonado)}</td>}
                          {canFinance && <td style={{ ...s.tdNum, fontWeight: 700, color: saldo > 0 ? '#e67e22' : '#1a7a4a' }}>{fmtMoney(saldo)}</td>}
                          <td style={{ ...s.td, textAlign: 'right' as const }}>
                            <button onClick={e => { e.stopPropagation(); goTab('proformas', pf.id) }} style={s.btnMini}>Detalle</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══ TAB: PROFORMAS (detail) ════════════════════════════════════════ */}
        {tab === 'proformas' && detailProforma && (() => {
          const pf = detailProforma
          const units = pedidosByProforma[pf.id] || []
          const total = pf.total_proforma ?? units.reduce((a, u) => a + (Number(u.costo_proforma) || 0), 0)
          const saldo = total - (Number(pf.abonado) || 0)
          return (
            <div style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' as const, gap: '10px', marginBottom: '16px' }}>
                <div>
                  <button onClick={() => goTab('proformas')} style={{ ...s.btnMini, marginBottom: '10px' }}>&lsaquo; Proformas</button>
                  <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{pf.nro}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {pf.canal} · Pedido: {pf.fecha_pedido_texto || fmtDate(pf.fecha_pedido)} · {units.length} unidades
                  </div>
                  {pf.notas && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>{pf.notas}</div>}
                </div>
                {canManage && (
                  <button onClick={() => setPedidoModal({ pedido: null, fixedProformaId: pf.id })} style={s.btnRed}>Agregar Pedidos</button>
                )}
              </div>

              {canFinance && (
                <div style={{ ...s.kpiBar, gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                  <div style={s.kpi}>
                    <div style={s.kpiLabel}>Total Proforma</div>
                    <div style={s.kpiValue}>{fmtMoney(total)}</div>
                  </div>
                  <div style={s.kpi}>
                    <div style={s.kpiLabel}>Abonado</div>
                    <div style={s.kpiValue}>{fmtMoney(pf.abonado)}</div>
                    {canManage && (
                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                        <input type="number" step="0.01" value={abonadoEdit} placeholder="Nuevo abonado"
                          onChange={e => setAbonadoEdit(e.target.value)}
                          style={{ ...s.input, minWidth: 0, flex: 1, padding: '6px 10px', fontSize: '12px' }} />
                        <button onClick={() => saveAbonado(pf)} disabled={abonadoSaving || abonadoEdit === ''}
                          style={{ ...s.btnMini, color: '#1a7a4a', borderColor: '#1a7a4a55' }}>
                          {abonadoSaving ? '...' : 'Guardar'}
                        </button>
                      </div>
                    )}
                  </div>
                  <div style={s.kpi}>
                    <div style={s.kpiLabel}>Saldo Restante</div>
                    <div style={{ ...s.kpiValue, color: saldo > 0 ? '#e67e22' : '#1a7a4a' }}>{fmtMoney(saldo)}</div>
                  </div>
                </div>
              )}

              {units.length === 0 ? (
                <div style={s.empty}>Esta proforma no tiene unidades registradas.</div>
              ) : (
                <div style={{ overflowX: 'auto' as const }}>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        <th style={s.th}>Modelo</th>
                        <th style={s.th}>Color</th>
                        <th style={s.th}>Placa</th>
                        <th style={s.th}>Mes Estimado</th>
                        {canFinance && <th style={{ ...s.th, textAlign: 'right' as const }}>Costo Proforma</th>}
                        {canFinance && <th style={{ ...s.th, textAlign: 'right' as const }}>Costo Factura</th>}
                        <th style={s.th}>Unidad</th>
                        <th style={s.th}>Venta</th>
                        {canManage && <th style={{ ...s.th, textAlign: 'right' as const }}></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {units.map(p => (
                        <tr key={p.id}>
                          <td style={s.td}>{p.modelo}</td>
                          <td style={s.td}>{p.color || '—'}</td>
                          <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '12px' }}>{p.placa || '—'}</td>
                          <td style={s.td}>{p.mes_estimado_recepcion || '—'}</td>
                          {canFinance && <td style={s.tdNum}>{fmtMoney(p.costo_proforma)}</td>}
                          {canFinance && <td style={s.tdNum}>{fmtMoney(p.costo_factura)}</td>}
                          <td style={s.td}>{badgeUnidad(p.estado_unidad)}</td>
                          <td style={s.td}>{badgeVenta(p.estado_venta)}</td>
                          {canManage && (
                            <td style={{ ...s.td, textAlign: 'right' as const }}>
                              <button onClick={() => setPedidoModal({ pedido: p, fixedProformaId: null })} style={s.btnMini}>Editar</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })()}
      </div>

      {/* Modals */}
      {showNewProforma && (
        <ProformaModal canFinance={canFinance} onSave={saveProforma} onCancel={() => setShowNewProforma(false)} />
      )}
      {pedidoModal && (
        <PedidoModal
          pedido={pedidoModal.pedido}
          proformas={proformas}
          fixedProformaId={pedidoModal.fixedProformaId}
          canFinance={canFinance}
          onSave={savePedido}
          onCancel={() => setPedidoModal(null)}
        />
      )}
      {recibirTarget && (
        <RecibirModal pedido={recibirTarget} onSave={placa => marcarRecibido(recibirTarget, placa)} onCancel={() => setRecibirTarget(null)} />
      )}
      {reservarTarget && (
        <ReservarModal pedido={reservarTarget} onSave={data => reservar(reservarTarget, data)} onCancel={() => setReservarTarget(null)} />
      )}
    </div>
  )
}

export default function PedidosPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--bg-page)' }} />}>
      <PedidosPageInner />
    </Suspense>
  )
}
