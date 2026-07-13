// TARGET: autocore-p1/app/comisiones/page.tsx
// ═══════════════════════════════════════════════════════════════════════════
// Comisiones — the broker's commission ledger (table: comisiones). One row
// per closed sale: vehicle, client, sale price, commission (% and/or flat
// USD) and collection status: pendiente → facturada → pagada (anulada for
// reversals). Admin-gated (compensation data).
//
// Deep link: /comisiones?lead=<uuid> opens the create modal prefilled from
// that CRM lead (used by the "Registrar comisión" button on won leads).
// useSearchParams is wrapped in <Suspense> (static-export constraint).
//
// Requires migrations/005_comisiones.sql — until applied, loading shows a
// clear error instead of data.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useState, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '../supabase'
import NavBar from '../components/NavBar'
import { useNPAPermissions } from '../components/useNPAPermissions'

interface Comision {
  id: string
  lead_id: string | null
  inventory_vin: string | null
  vehiculo: string
  cliente: string | null
  precio_venta_usd: number | null
  comision_pct: number | null
  comision_usd: number
  estado: 'pendiente' | 'facturada' | 'pagada' | 'anulada'
  fecha_venta: string
  fecha_pago: string | null
  notas: string | null
  created_at: string
  updated_at: string
}

const ESTADOS: Record<Comision['estado'], { label: string; color: string }> = {
  pendiente: { label: 'Pendiente', color: '#E0A23C' },
  facturada: { label: 'Facturada', color: 'var(--brand-primary)' },
  pagada:    { label: 'Pagada',    color: 'var(--brand-success)' },
  anulada:   { label: 'Anulada',   color: '#E5556A' },
}
const ESTADO_ORDER: Comision['estado'][] = ['pendiente', 'facturada', 'pagada', 'anulada']

const fmtUsd = (n: number | null | undefined) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtDate = (iso: string | null) => {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  content: { padding: '28px 32px', maxWidth: '1280px', margin: '0 auto' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '14px' },
  kpi: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '14px 16px' },
  kpiLabel: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px', marginBottom: '6px' },
  kpiValue: { fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' as const },
  chip: (active: boolean, color: string) => ({ padding: '5px 12px', borderRadius: 999, fontSize: '11px', fontWeight: 700, cursor: 'pointer', border: `1px solid ${active ? color : 'var(--border)'}`, background: active ? 'var(--bg-deep)' : 'transparent', color: active ? color : 'var(--text-muted)' }),
  th: { padding: '9px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '1px', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' as const },
  td: { padding: '10px 12px', fontSize: '12.5px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' as const },
  badge: (color: string) => ({ display: 'inline-block', padding: '2px 9px', borderRadius: '4px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.5px', color, border: `1px solid ${color}55`, whiteSpace: 'nowrap' as const }),
  btnMini: (color: string) => ({ padding: '4px 10px', background: 'transparent', color, border: `1px solid ${color}55`, borderRadius: '6px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const }),
  btnPrimary: { padding: '9px 18px', background: 'var(--brand-primary)', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' },
  btnGhost: { padding: '9px 18px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' },
  input: { width: '100%', padding: '9px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  label: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.2px', display: 'block', marginBottom: '5px' },
  overlay: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' },
  modal: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', width: '100%', maxWidth: '620px', maxHeight: '90vh', overflowY: 'auto' as const },
  err: { background: 'rgba(240,85,106,0.1)', border: '1px solid rgba(240,85,106,0.3)', borderRadius: '8px', padding: '10px 13px', fontSize: '12.5px', color: 'var(--danger)', marginBottom: '12px' },
}

// ── Create/edit modal ────────────────────────────────────────────────────────
function ComisionModal({ comision, prefill, userId, onClose, onSaved }: {
  comision: Comision | null           // null = new
  prefill: { leadId: string | null; vehiculo: string; cliente: string } | null
  userId: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = !comision
  const [form, setForm] = useState({
    vehiculo: comision?.vehiculo || prefill?.vehiculo || '',
    cliente: comision?.cliente || prefill?.cliente || '',
    inventory_vin: comision?.inventory_vin || '',
    precio_venta_usd: comision?.precio_venta_usd == null ? '' : String(comision.precio_venta_usd),
    comision_pct: comision?.comision_pct == null ? '' : String(comision.comision_pct),
    comision_usd: comision == null ? '' : String(comision.comision_usd),
    fecha_venta: comision?.fecha_venta?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    notas: comision?.notas || '',
  })
  const [inv, setInv] = useState<{ vin: string; modelo: string; año: number }[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    ;(async () => {
      const { data } = await (supabase
        .from('inventory_units')
        .select('vin, modelo, año')
        .order('modelo', { ascending: true }) as any)
      setInv(Array.isArray(data) ? data : [])
    })()
  }, [])

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  // % and price entered → recompute the USD amount (still editable after).
  const recompute = (precio: string, pct: string) => {
    const p = Number(precio), c = Number(pct)
    if (precio !== '' && pct !== '' && Number.isFinite(p) && Number.isFinite(c)) {
      setForm(f => ({ ...f, comision_usd: (Math.round(p * c) / 100).toFixed(2) }))
    }
  }

  const save = async () => {
    const vehiculo = form.vehiculo.trim()
    if (!vehiculo) { setError('El vehículo es obligatorio.'); return }
    const monto = Number(form.comision_usd)
    if (form.comision_usd === '' || !Number.isFinite(monto) || monto < 0) {
      setError('Indica el monto de la comisión en USD (puede calcularse con precio × %).'); return
    }
    const precio = form.precio_venta_usd === '' ? null : Number(form.precio_venta_usd)
    if (precio != null && (!Number.isFinite(precio) || precio < 0)) { setError('Precio de venta inválido.'); return }
    const pct = form.comision_pct === '' ? null : Number(form.comision_pct)
    if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) { setError('Porcentaje inválido (0–100).'); return }

    setSaving(true); setError('')
    const payload: any = {
      vehiculo,
      cliente: form.cliente.trim() || null,
      inventory_vin: form.inventory_vin || null,
      precio_venta_usd: precio,
      comision_pct: pct,
      comision_usd: monto,
      fecha_venta: form.fecha_venta,
      notas: form.notas.trim() || null,
    }
    if (isNew) {
      payload.lead_id = prefill?.leadId || null
      payload.created_by = userId || null
    }
    const q = isNew
      ? supabase.from('comisiones').insert(payload)
      : supabase.from('comisiones').update(payload).eq('id', comision!.id)
    const { error: e } = await (q as any)
    setSaving(false)
    if (e) { setError('No se pudo guardar: ' + e.message); return }
    onSaved()
  }

  return (
    <div style={s.overlay} onClick={() => !saving && onClose()}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px' }}>
          {isNew ? 'Registrar comisión' : 'Editar comisión'}
        </div>
        {error && <div style={s.err}>{error}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div style={{ gridColumn: 'span 2' }}>
            <label style={s.label}>Vehículo *</label>
            <input style={s.input} value={form.vehiculo} onChange={e => set('vehiculo', e.target.value)} placeholder="Ej: 2022 CHEVROLET EQUINOX" />
          </div>
          <div>
            <label style={s.label}>Cliente</label>
            <input style={s.input} value={form.cliente} onChange={e => set('cliente', e.target.value)} placeholder="Nombre del comprador" />
          </div>
          <div>
            <label style={s.label}>Unidad de inventario (opcional)</label>
            <select style={s.input} value={form.inventory_vin} onChange={e => set('inventory_vin', e.target.value)}>
              <option value="">Sin unidad</option>
              {inv.map(u => <option key={u.vin} value={u.vin}>{u.modelo} {u.año} · {u.vin}</option>)}
            </select>
          </div>
          <div>
            <label style={s.label}>Precio de venta (USD)</label>
            <input style={s.input} type="number" min={0} value={form.precio_venta_usd}
              onChange={e => { set('precio_venta_usd', e.target.value); recompute(e.target.value, form.comision_pct) }} placeholder="18800" />
          </div>
          <div>
            <label style={s.label}>Comisión %</label>
            <input style={s.input} type="number" min={0} max={100} step="0.1" value={form.comision_pct}
              onChange={e => { set('comision_pct', e.target.value); recompute(form.precio_venta_usd, e.target.value) }} placeholder="3" />
          </div>
          <div>
            <label style={s.label}>Comisión (USD) *</label>
            <input style={s.input} type="number" min={0} step="0.01" value={form.comision_usd}
              onChange={e => set('comision_usd', e.target.value)} placeholder="564.00" />
          </div>
          <div>
            <label style={s.label}>Fecha de venta</label>
            <input style={s.input} type="date" value={form.fecha_venta} onChange={e => set('fecha_venta', e.target.value)} />
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <label style={s.label}>Notas</label>
            <textarea style={{ ...s.input, minHeight: '70px', resize: 'vertical' as const }} value={form.notas}
              onChange={e => set('notas', e.target.value)} placeholder="Acuerdo, referencia de factura al dealer, etc." />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '18px' }}>
          <button style={s.btnGhost} onClick={onClose} disabled={saving}>Cancelar</button>
          <button style={s.btnPrimary} onClick={save} disabled={saving}>{saving ? 'Guardando...' : 'Guardar'}</button>
        </div>
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
function ComisionesInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { permissions, loading: permsLoading, userId } = useNPAPermissions()
  const [rows, setRows] = useState<Comision[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState<'all' | Comision['estado']>('all')
  const [modal, setModal] = useState<{ open: boolean; comision: Comision | null; prefill: any } | null>(null)
  const [acting, setActing] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    const { data, error } = await (supabase
      .from('comisiones')
      .select('*')
      .order('fecha_venta', { ascending: false })
      .order('created_at', { ascending: false }) as any)
    if (error) {
      setLoadError('No se pudieron cargar las comisiones: ' + error.message +
        ' (si la tabla no existe, falta la migración 005_comisiones.sql en Supabase).')
      setRows([])
    } else {
      setRows(Array.isArray(data) ? data : [])
    }
    setLoading(false)
  }, [])

  // ?lead=<uuid> → open the create modal prefilled from that lead.
  const openFromLead = useCallback(async (leadId: string) => {
    const { data } = await (supabase
      .from('crm_leads')
      .select('id, nombre, apellidos, modelo_interes, presupuesto_usd')
      .eq('id', leadId).single() as any)
    setModal({
      open: true,
      comision: null,
      prefill: {
        leadId,
        vehiculo: data?.modelo_interes || '',
        cliente: data ? [data.nombre, data.apellidos].filter(Boolean).join(' ') : '',
      },
    })
  }, [])

  useEffect(() => {
    if (permsLoading) return
    if (!permissions.npa_can_admin) { router.replace('/dashboard'); return }
    load()
    const leadId = searchParams.get('lead')
    if (leadId) openFromLead(leadId)
    // eslint-disable-next-line
  }, [permsLoading])

  const setEstado = async (c: Comision, estado: Comision['estado']) => {
    if (acting) return
    setActing(c.id)
    const patch: any = { estado }
    if (estado === 'pagada') patch.fecha_pago = new Date().toISOString().slice(0, 10)
    if (estado === 'pendiente' || estado === 'facturada') patch.fecha_pago = null
    const { error } = await (supabase.from('comisiones').update(patch).eq('id', c.id) as any)
    setActing(null)
    if (!error) load()
  }

  // KPIs — anuladas excluded from money totals.
  const now = new Date()
  const ymNow = now.toISOString().slice(0, 7)
  const yNow = now.toISOString().slice(0, 4)
  const activas = rows.filter(r => r.estado !== 'anulada')
  const totPendiente = activas.filter(r => r.estado !== 'pagada').reduce((a, r) => a + Number(r.comision_usd || 0), 0)
  const totPagadaMes = activas.filter(r => r.estado === 'pagada' && (r.fecha_pago || '').startsWith(ymNow)).reduce((a, r) => a + Number(r.comision_usd || 0), 0)
  const totPagadaAno = activas.filter(r => r.estado === 'pagada' && (r.fecha_pago || '').startsWith(yNow)).reduce((a, r) => a + Number(r.comision_usd || 0), 0)
  const ventasAno = activas.filter(r => (r.fecha_venta || '').startsWith(yNow)).length

  const filtered = filter === 'all' ? rows : rows.filter(r => r.estado === filter)
  const countBy = (st: Comision['estado']) => rows.filter(r => r.estado === st).length

  const actionsFor = (c: Comision) => {
    switch (c.estado) {
      case 'pendiente': return [
        { label: 'Facturada', to: 'facturada' as const, color: 'var(--brand-primary)' },
        { label: 'Pagada', to: 'pagada' as const, color: 'var(--brand-success)' },
        { label: 'Anular', to: 'anulada' as const, color: '#E5556A' },
      ]
      case 'facturada': return [
        { label: 'Pagada', to: 'pagada' as const, color: 'var(--brand-success)' },
        { label: 'Anular', to: 'anulada' as const, color: '#E5556A' },
      ]
      case 'pagada': return [
        { label: 'Reabrir', to: 'pendiente' as const, color: '#E0A23C' },
      ]
      case 'anulada': return [
        { label: 'Restaurar', to: 'pendiente' as const, color: '#E0A23C' },
      ]
    }
  }

  return (
    <div style={s.page}>
      <NavBar />
      <div style={s.content}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '16px', flexWrap: 'wrap' as const, gap: '10px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: '4px' }}>Módulo</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)' }}>Comisiones</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Registro de comisiones por venta cerrada: pendiente → facturada → pagada.
            </div>
          </div>
          <button style={s.btnPrimary} onClick={() => setModal({ open: true, comision: null, prefill: null })}>Registrar comisión</button>
        </div>

        {/* KPI bar */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          <div style={s.kpi}><div style={s.kpiLabel}>Por cobrar</div><div style={{ ...s.kpiValue, color: '#E0A23C' }}>{fmtUsd(totPendiente)}</div></div>
          <div style={s.kpi}><div style={s.kpiLabel}>Pagado este mes</div><div style={{ ...s.kpiValue, color: 'var(--brand-success)' }}>{fmtUsd(totPagadaMes)}</div></div>
          <div style={s.kpi}><div style={s.kpiLabel}>Pagado {yNow}</div><div style={s.kpiValue}>{fmtUsd(totPagadaAno)}</div></div>
          <div style={s.kpi}><div style={s.kpiLabel}>Ventas {yNow}</div><div style={s.kpiValue}>{ventasAno}</div></div>
        </div>

        {/* Estado chips */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' as const }}>
          <button style={s.chip(filter === 'all', 'var(--accent-solid)')} onClick={() => setFilter('all')}>Todas ({rows.length})</button>
          {ESTADO_ORDER.map(st => (
            <button key={st} style={s.chip(filter === st, ESTADOS[st].color)} onClick={() => setFilter(st)}>
              {ESTADOS[st].label} ({countBy(st)})
            </button>
          ))}
        </div>

        {loadError && <div style={s.err}>{loadError}</div>}

        <div style={{ ...s.card, overflowX: 'auto' as const }}>
          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center' as const, color: 'var(--text-muted)', fontSize: '13px' }}>Cargando...</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center' as const, color: 'var(--text-muted)', fontSize: '13px' }}>
              {rows.length === 0 ? 'Sin comisiones registradas. Usa "Registrar comisión" o el botón en un lead ganado.' : 'Ninguna comisión con este estado.'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
              <thead>
                <tr>
                  <th style={s.th}>Venta</th>
                  <th style={s.th}>Vehículo / Cliente</th>
                  <th style={s.th}>Precio venta</th>
                  <th style={s.th}>Comisión</th>
                  <th style={s.th}>Estado</th>
                  <th style={s.th}>Pago</th>
                  <th style={{ ...s.th, textAlign: 'right' as const }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const busy = acting === c.id
                  return (
                    <tr key={c.id} style={{ opacity: c.estado === 'anulada' ? 0.55 : 1 }}>
                      <td style={{ ...s.td, whiteSpace: 'nowrap' as const }}>{fmtDate(c.fecha_venta)}</td>
                      <td style={{ ...s.td, maxWidth: '260px' }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{c.vehiculo}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {c.cliente || '—'}
                          {c.lead_id && <> · <a href={'/crm?lead=' + c.lead_id} style={{ color: 'var(--brand-primary)' }}>ver lead</a></>}
                        </div>
                      </td>
                      <td style={{ ...s.td, fontVariantNumeric: 'tabular-nums' as const }}>{fmtUsd(c.precio_venta_usd)}</td>
                      <td style={{ ...s.td, fontVariantNumeric: 'tabular-nums' as const }}>
                        <span style={{ fontWeight: 700 }}>{fmtUsd(c.comision_usd)}</span>
                        {c.comision_pct != null && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}> ({c.comision_pct}%)</span>}
                      </td>
                      <td style={s.td}><span style={s.badge(ESTADOS[c.estado].color)}>{ESTADOS[c.estado].label}</span></td>
                      <td style={{ ...s.td, fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' as const }}>{fmtDate(c.fecha_pago)}</td>
                      <td style={{ ...s.td, textAlign: 'right' as const }}>
                        <span style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap' as const, justifyContent: 'flex-end' }}>
                          {c.estado !== 'anulada' && (
                            <button style={s.btnMini('var(--text-secondary)')} disabled={busy}
                              onClick={() => setModal({ open: true, comision: c, prefill: null })}>Editar</button>
                          )}
                          {actionsFor(c).map(a => (
                            <button key={a.to} style={s.btnMini(a.color)} disabled={busy} onClick={() => setEstado(c, a.to)}>{a.label}</button>
                          ))}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {modal?.open && (
        <ComisionModal
          comision={modal.comision}
          prefill={modal.prefill}
          userId={userId}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}
    </div>
  )
}

export default function ComisionesPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--bg-page)' }} />}>
      <ComisionesInner />
    </Suspense>
  )
}
