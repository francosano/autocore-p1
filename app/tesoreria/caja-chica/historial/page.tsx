// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/caja-chica/historial/page.tsx
// AutoCore NPA — Caja Chica · HISTORIAL + REPORTE
//
// 2026-06-06. Lista todos los movimientos de Caja Chica (gastos, reposiciones,
// arqueos) con filtros por categoría y rango de fechas, más un reporte de
// gastos por categoría para el período filtrado.
//
// Gate de vista: tesoreria_can_register_cc_gasto OR tesoreria_admin OR npa_can_admin.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../../supabase'
import { useNPAPermissions } from '../../../components/useNPAPermissions'
import AdminShell from '../../../components/AdminShell'
import { ArrowLeft, Coffee, Paperclip, Bike, Sparkles, Wrench, Package, Wallet, Calculator, Pencil, Trash2, X } from 'lucide-react'

const fmt = (n: number) =>
  `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Etiquetas + iconos por categoría. CC_* = gastos; otras = movimientos del módulo.
const CAT_META: Record<string, { label: string; Icon: any; gasto: boolean }> = {
  CC_CAFE_COMIDA:   { label: 'Café / Comida',           Icon: Coffee,     gasto: true },
  CC_PAPELERIA:     { label: 'Papelería / Oficina',     Icon: Paperclip,  gasto: true },
  CC_MENSAJERIA:    { label: 'Mensajería / Transporte', Icon: Bike,       gasto: true },
  CC_LIMPIEZA:      { label: 'Limpieza / Aseo',         Icon: Sparkles,   gasto: true },
  CC_MANTENIMIENTO: { label: 'Mantenimiento menor',     Icon: Wrench,     gasto: true },
  CC_OTRO:          { label: 'Otro',                     Icon: Package,    gasto: true },
  CAJA_CHICA_REPO:  { label: 'Reposición',              Icon: Wallet,     gasto: false },
  ARQUEO:           { label: 'Arqueo',                   Icon: Calculator, gasto: false },
}
const metaFor = (c: string | null) => CAT_META[c || 'CC_OTRO'] || { label: c || 'Otro', Icon: Package, gasto: true }

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif', paddingBottom: 40 },
  topBar: { background: '#BB162B', color: '#fff', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10, position: 'sticky', top: 0, zIndex: 50, boxShadow: '0 2px 6px rgba(0,0,0,0.15)' },
  backBtn: { background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: 4, display: 'flex' },
  title: { fontSize: 15, fontWeight: 700, letterSpacing: 0.3 },
  content: { padding: '16px 14px 24px', maxWidth: 560, margin: '0 auto' },

  filters: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 14, marginBottom: 14 },
  filterRow: { display: 'flex', gap: 8, marginBottom: 10 },
  fcol: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 },
  flabel: { fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1 },
  input: { padding: '9px 10px', background: 'var(--bg-input, var(--bg-deep))', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' },
  select: { padding: '9px 10px', background: 'var(--bg-input, var(--bg-deep))', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' },

  reporte: { background: 'linear-gradient(135deg, #0A0F1E 0%, #0D2257 100%)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 12, padding: '14px 16px', marginBottom: 14, color: '#fff' },
  reporteTitle: { fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', marginBottom: 8 },
  repRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '4px 0' },
  repCat: { color: 'rgba(255,255,255,0.85)' },
  repVal: { fontFamily: 'monospace', fontWeight: 700 },
  repTotal: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 14, fontWeight: 800, borderTop: '1px solid rgba(255,255,255,0.15)', marginTop: 6, paddingTop: 8 },

  list: { display: 'flex', flexDirection: 'column', gap: 7 },
  row: { display: 'flex', alignItems: 'center', gap: 11, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 12px' },
  concepto: { fontSize: 13, color: 'var(--text-primary)' },
  meta: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 },
  monto: (pos: boolean) => ({ fontSize: 14, fontWeight: 700, fontFamily: 'monospace', color: pos ? '#2ecc8a' : '#e88' }),
  empty: { padding: '24px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 },
  loading: { padding: 40, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 },
  err: { padding: '10px 14px', borderRadius: 8, background: 'rgba(187,22,43,0.1)', border: '1px solid #BB162B44', color: '#BB162B', fontSize: 13, marginBottom: 14 },
}

interface Mov { id: string; monto_usd: number; signo: number; categoria: string | null; descripcion: string | null; created_at: string; tipo: string | null; comprobante_id: string | null; registered_by: string | null }
interface Compr { id: string; estado: string; solicitado_by: string | null; solicitado_at: string; concepto: string | null; categoria: string | null; notas: string | null; monto_usd: number }
const CC_CATS = ['CC_CAFE_COMIDA','CC_PAPELERIA','CC_MENSAJERIA','CC_LIMPIEZA','CC_MANTENIMIENTO','CC_OTRO']

export default function CajaChicaHistorialPage() {
  const router = useRouter()
  const { permissions, loading: permsLoading, userId } = useNPAPermissions()
  const isAdmin = permissions.tesoreria_admin || permissions.npa_can_admin

  const [movs, setMovs] = useState<Mov[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [comprMap, setComprMap] = useState<Record<string, Compr>>({})
  const [editId, setEditId] = useState<string | null>(null)   // comprobante_id being edited
  const [eMonto, setEMonto] = useState(''); const [eCat, setECat] = useState('CC_OTRO'); const [eConcepto, setEConcepto] = useState(''); const [eNotas, setENotas] = useState('')
  const [delId, setDelId] = useState<string | null>(null)     // comprobante_id being voided
  const [delMotivo, setDelMotivo] = useState('')
  const [busy, setBusy] = useState(false)

  const [cat, setCat]   = useState('ALL')
  const [from, setFrom] = useState('')
  const [to, setTo]     = useState('')

  const canView = !permsLoading && (
    permissions.tesoreria_can_register_cc_gasto || permissions.tesoreria_admin || permissions.npa_can_admin
  )

  useEffect(() => {
    if (permsLoading) return
    if (!canView) { router.replace('/tesoreria/home'); return }
    load()
  // eslint-disable-next-line
  }, [permsLoading, canView])

  async function load() {
    setLoading(true); setErr(null)
    const { data: c } = await supabase
      .from('tesoreria_ubicaciones').select('id').eq('codigo', 'CAJA_CHICA').eq('activa', true).single()
    if (!c) { setErr('No se encontró Caja Chica.'); setLoading(false); return }
    const { data, error } = await supabase
      .from('tesoreria_movimientos')
      .select('id, monto_usd, signo, categoria, descripcion, created_at, tipo, comprobante_id, registered_by')
      .eq('ubicacion_id', (c as any).id)
      .order('created_at', { ascending: false })
    if (error) { setErr('Error cargando movimientos.'); setLoading(false); return }
    setMovs((data || []) as Mov[])
    const { data: cs } = await supabase
      .from('tesoreria_comprobantes')
      .select('id, estado, solicitado_by, solicitado_at, concepto, categoria, notas, monto_usd')
      .eq('egreso_tipo', 'CAJA_CHICA_GASTO')
    const map: Record<string, Compr> = {}
    ;(cs || []).forEach((c: any) => { map[c.id] = c as Compr })
    setComprMap(map)
    setLoading(false)
  }

  const filtered = useMemo(() => {
    return movs.filter(m => {
      if (cat !== 'ALL' && (m.categoria || '') !== cat) return false
      const d = m.created_at.slice(0, 10)
      if (from && d < from) return false
      if (to && d > to) return false
      return true
    })
  }, [movs, cat, from, to])

  // Reporte: gastos por categoría (solo CC_*; excluye reposiciones y arqueos).
  const reporte = useMemo(() => {
    const acc: Record<string, number> = {}
    let total = 0
    filtered.forEach(m => {
      const meta = metaFor(m.categoria)
      if (meta.gasto && m.signo === -1) {
        acc[m.categoria || 'CC_OTRO'] = (acc[m.categoria || 'CC_OTRO'] || 0) + Number(m.monto_usd)
        total += Number(m.monto_usd)
      }
    })
    const rows = Object.entries(acc).sort((a, b) => b[1] - a[1])
    return { rows, total }
  }, [filtered])

  function within24h(iso: string) { return (Date.now() - new Date(iso).getTime()) < 24 * 60 * 60 * 1000 }
  // A row is an editable/voidable gasto only if it's the original debit of a live gasto.
  function comprFor(m: Mov): Compr | null { return m.comprobante_id ? (comprMap[m.comprobante_id] || null) : null }
  function canActOn(m: Mov): boolean {
    if (m.tipo !== 'CAJA_CHICA_GASTO' || m.signo !== -1 || !m.comprobante_id) return false
    const c = comprFor(m); if (!c || c.estado === 'REVERTIDO') return false
    if (isAdmin) return true
    return c.solicitado_by === userId && within24h(c.solicitado_at)
  }
  function openEdit(m: Mov) {
    const c = comprFor(m); if (!c) return
    setEditId(c.id); setEMonto(String(c.monto_usd)); setECat(c.categoria || 'CC_OTRO')
    setEConcepto(c.concepto || ''); setENotas(c.notas || ''); setErr(null)
  }
  async function saveEdit() {
    if (!editId) return
    const m = parseFloat(eMonto) || 0
    if (!m || m <= 0) { setErr('Monto inválido'); return }
    if (!eConcepto.trim()) { setErr('El concepto es obligatorio'); return }
    setBusy(true)
    const { error } = await supabase.rpc('caja_chica_edit_gasto', { p_comprobante_id: editId, p_monto: m, p_categoria: eCat, p_concepto: eConcepto.trim(), p_notas: eNotas.trim() || null })
    setBusy(false)
    if (error) { setErr('No se pudo editar: ' + error.message); return }
    setEditId(null); await load()
  }
  async function confirmVoid() {
    if (!delId) return
    if (delMotivo.trim().length < 10) { setErr('El motivo debe tener al menos 10 caracteres'); return }
    setBusy(true)
    const { error } = await supabase.rpc('caja_chica_void_gasto', { p_comprobante_id: delId, p_motivo: delMotivo.trim() })
    setBusy(false)
    if (error) { setErr('No se pudo anular: ' + error.message); return }
    setDelId(null); setDelMotivo(''); await load()
  }
  if (permsLoading || loading) {
    return (<AdminShell active="caja-chica"><div style={s.topBar}><div style={s.title}>Historial Caja Chica</div></div><div style={s.loading}>Cargando…</div></AdminShell>)
  }
  if (!canView) return null

  return (
    <AdminShell active="caja-chica">
      <div style={s.topBar}>
        <button style={s.backBtn} onClick={() => router.push('/tesoreria/caja-chica')} aria-label="Volver"><ArrowLeft size={20} strokeWidth={2.4} /></button>
        <div style={s.title}>Historial · Caja Chica</div>
      </div>

      <div style={s.content}>
        {err && <div style={s.err}>{err}</div>}

        <div style={s.filters}>
          <div style={s.filterRow}>
            <div style={s.fcol}>
              <label style={s.flabel}>Desde</label>
              <input style={s.input} type="date" value={from} onChange={e => setFrom(e.target.value)} />
            </div>
            <div style={s.fcol}>
              <label style={s.flabel}>Hasta</label>
              <input style={s.input} type="date" value={to} onChange={e => setTo(e.target.value)} />
            </div>
          </div>
          <div style={s.fcol}>
            <label style={s.flabel}>Categoría</label>
            <select style={s.select} value={cat} onChange={e => setCat(e.target.value)}>
              <option value="ALL">Todas</option>
              {Object.entries(CAT_META).map(([val, m]) => <option key={val} value={val}>{m.label}</option>)}
            </select>
          </div>
        </div>

        {reporte.rows.length > 0 && (
          <div style={s.reporte}>
            <div style={s.reporteTitle}>Gastos por categoría {from || to ? '(período)' : ''}</div>
            {reporte.rows.map(([c, v]) => (
              <div key={c} style={s.repRow}>
                <span style={s.repCat}>{metaFor(c).label}</span>
                <span style={s.repVal}>{fmt(v)}</span>
              </div>
            ))}
            <div style={s.repTotal}><span>Total gastado</span><span style={{ fontFamily: 'monospace' }}>{fmt(reporte.total)}</span></div>
          </div>
        )}

        {filtered.length === 0 ? (
          <div style={s.empty}>No hay movimientos para este filtro.</div>
        ) : (
          <div style={s.list}>
            {filtered.map(m => {
              const meta = metaFor(m.categoria)
              const Icon = meta.Icon
              const d = new Date(m.created_at)
              const fecha = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
              const pos = m.signo === 1
              return (
                <div key={m.id} style={s.row}>
                  <Icon size={18} color="var(--text-secondary)" strokeWidth={2} />
                  <div style={{ flex: 1 }}>
                    <div style={s.concepto}>{m.descripcion || meta.label}</div>
                    <div style={s.meta}>{meta.label} · {fecha}</div>
                  </div>
                  <div style={s.monto(pos)}>{pos ? '+' : '−'}{fmt(Number(m.monto_usd))}</div>
                  {canActOn(m) && (
                    <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
                      <button title="Editar" onClick={() => openEdit(m)} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: 5, cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex' }}><Pencil size={15} /></button>
                      <button title="Anular" onClick={() => { setDelId(m.comprobante_id); setDelMotivo(''); setErr(null) }} style={{ background: 'transparent', border: '1px solid rgba(187,22,43,0.3)', borderRadius: 6, padding: 5, cursor: 'pointer', color: '#BB162B', display: 'flex' }}><Trash2 size={15} /></button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {editId && (
          <div onClick={() => !busy && setEditId(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div onClick={e => e.stopPropagation()} style={{ width: 'min(440px, calc(100vw - 32px))', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <strong style={{ color: 'var(--text-primary)', fontSize: 15 }}>Editar gasto</strong>
                <button onClick={() => setEditId(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={18} /></button>
              </div>
              {err && <div style={s.err}>{err}</div>}
              <label style={s.flabel}>Monto (USD)</label>
              <input style={s.input} type="number" inputMode="decimal" step="0.01" min="0.01" value={eMonto} onChange={e => setEMonto(e.target.value)} />
              <label style={{ ...s.flabel, marginTop: 10 }}>Categoría</label>
              <select style={s.select} value={eCat} onChange={e => setECat(e.target.value)}>
                {CC_CATS.map(c => <option key={c} value={c}>{metaFor(c).label}</option>)}
              </select>
              <label style={{ ...s.flabel, marginTop: 10 }}>Concepto</label>
              <input style={s.input} type="text" value={eConcepto} onChange={e => setEConcepto(e.target.value)} />
              <label style={{ ...s.flabel, marginTop: 10 }}>Notas (opcional)</label>
              <input style={s.input} type="text" value={eNotas} onChange={e => setENotas(e.target.value)} />
              <button onClick={saveEdit} disabled={busy} style={{ width: '100%', marginTop: 14, padding: 11, borderRadius: 8, border: 'none', background: busy ? '#ccc' : '#BB162B', color: '#fff', fontWeight: 700, fontSize: 14, cursor: busy ? 'not-allowed' : 'pointer' }}>{busy ? 'Guardando…' : 'Guardar cambios'}</button>
            </div>
          </div>
        )}

        {delId && (
          <div onClick={() => !busy && setDelId(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div onClick={e => e.stopPropagation()} style={{ width: 'min(440px, calc(100vw - 32px))', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong style={{ color: '#BB162B', fontSize: 15 }}>Anular gasto</strong>
                <button onClick={() => setDelId(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={18} /></button>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>Se revierte el movimiento y el saldo se corrige. El registro queda marcado como anulado (auditable).</div>
              {err && <div style={s.err}>{err}</div>}
              <label style={s.flabel}>Motivo (mínimo 10 caracteres)</label>
              <textarea style={{ ...s.input, minHeight: 70, resize: 'vertical' as const }} value={delMotivo} onChange={e => setDelMotivo(e.target.value)} placeholder="¿Por qué se anula?" />
              <button onClick={confirmVoid} disabled={busy} style={{ width: '100%', marginTop: 14, padding: 11, borderRadius: 8, border: 'none', background: busy ? '#ccc' : '#BB162B', color: '#fff', fontWeight: 700, fontSize: 14, cursor: busy ? 'not-allowed' : 'pointer' }}>{busy ? 'Anulando…' : 'Anular gasto'}</button>
            </div>
          </div>
        )}
      </div>
    </AdminShell>
  )
}