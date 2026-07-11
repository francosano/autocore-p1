// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/consultas/page.tsx
// AutoCore NPA — Consultas de Tesorería (unified comprobante search)
//
// ONE place to look anything up. Searches ALL tesoreria_comprobantes
// (ingresos + egresos + FX + pickups) by número, concepto, contraparte,
// referencia (source_label) or exact monto. Filter pills by tipo. Tap a row
// to open the comprobante detail. Replaces the old "which sub-page does this
// live in?" hunt — Historial stays for handoff batches only.
//
// Search strategy: default view is the latest 50 comprobantes. Typing a term
// re-queries Supabase server-side with ilike across the text columns; if the
// term parses as a number it also matches monto_usd exactly. Commas are
// stripped from the term (they break PostgREST .or() syntax).
//
// 2026-07-02
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'
import AdminShell from '../../components/AdminShell'
import { useAuthGate } from '../../components/useAuthGate'
import { useIsMobile } from '../../components/useIsMobile'
import SessionErrorScreen from '../../components/SessionErrorScreen'

type TipoFilter = 'todos' | 'ingresos' | 'egresos' | 'otros'

interface ComprobanteRow {
  id: string
  numero: string
  tipo: string
  estado: string
  monto_usd: number
  concepto: string
  categoria: string | null
  egreso_tipo: string | null
  pago_fijo_concepto: string | null
  contraparte_nombre: string | null
  source_label: string | null
  solicitado_at: string
  egreso_documento_url: string | null
}

// ── Labels & colors ──────────────────────────────────────────────────────────
const TIPO_LABEL: Record<string, string> = {
  INGRESO: 'Ingreso',
  EGRESO: 'Egreso',
  PICKUP: 'Pickup',
  SALIDA: 'Salida',
  FX: 'Cambio',
  REPLENISHMENT: 'Reposición',
}
const TIPO_COLOR: Record<string, string> = {
  INGRESO: '#1a7a4a',
  EGRESO: '#BB162B',
  PICKUP: '#4a9eff',
  SALIDA: '#BB162B',
  FX: '#b8720a',
  REPLENISHMENT: '#6b7280',
}
const ESTADO_LABEL: Record<string, string> = {
  PENDIENTE_PICKUP: 'Por recoger',
  PICKUP_CONFIRMADO: 'Recogido',
  PENDIENTE_BS: 'Pendiente Bs',
  BS_CONFIRMADO: 'Bs confirmados',
  SOLICITADO: 'Solicitado',
  EN_PODER_MIRLA: 'En poder de Admon',
  ENTREGADO_BANCARIZADOR: 'Con bancarizador',
  DEPOSITADO_PARCIAL: 'Depósito parcial',
  DEPOSITADO: 'Depositado',
  EJECUTADO: 'Ejecutado',
  COMPLETADO: 'Completado',
  ANULADO: 'Anulado',
  REVERTIDO: 'Revertido',
  PENDIENTE_BANCO: 'Pendiente banco',
  CONCILIADO_BANCO: 'Conciliado',
}
const ESTADO_COLOR: Record<string, string> = {
  PENDIENTE_PICKUP: '#e67e22',
  PICKUP_CONFIRMADO: '#1a7a4a',
  PENDIENTE_BS: '#e67e22',
  BS_CONFIRMADO: '#1a7a4a',
  SOLICITADO: '#e67e22',
  EN_PODER_MIRLA: '#4a9eff',
  ENTREGADO_BANCARIZADOR: '#4a9eff',
  DEPOSITADO_PARCIAL: '#b8720a',
  DEPOSITADO: '#1a7a4a',
  EJECUTADO: '#1a7a4a',
  COMPLETADO: '#1a7a4a',
  ANULADO: '#BB162B',
  REVERTIDO: '#BB162B',
  PENDIENTE_BANCO: '#e67e22',
  CONCILIADO_BANCO: '#1a7a4a',
}

const PAGO_FIJO_LABEL: Record<string, string> = {
  PAGO_ROBERTO: 'Pago Roberto (bono)',
  ALQUILER: 'Alquiler del local',
  META: 'META — facturas',
  COMISIONES: 'Comisiones del mes',
  OTROS: 'Otros',
}

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  back: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', marginBottom: 12, padding: 0 },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14 },
  title: { fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 6 },
  subtitle: { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 },
  search: {
    width: '100%', boxSizing: 'border-box' as const, padding: '12px 16px',
    background: 'var(--bg-input, var(--bg-deep))', border: '1px solid var(--border)',
    borderRadius: 10, fontSize: 15, color: 'var(--text-primary)', marginBottom: 12,
  },
  pillRow: { display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' as const },
  pill: (active: boolean) => ({
    padding: '6px 14px', borderRadius: 999, fontSize: 12, fontWeight: 700,
    border: '1px solid ' + (active ? '#1a7a4a' : 'var(--border)'),
    background: active ? '#1a7a4a' : 'transparent',
    color: active ? '#fff' : 'var(--text-primary)',
    cursor: 'pointer',
  }),
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  // Desktop table
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: { textAlign: 'left' as const, fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1, padding: '8px 10px', borderBottom: '1px solid var(--border)' },
  td: { padding: '10px', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border)', cursor: 'pointer' },
  tdMono: { padding: '10px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border)', fontFamily: 'monospace', cursor: 'pointer' },
  // Mobile cards
  mCard: { padding: 12, background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 8, cursor: 'pointer' },
  mTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 },
  mNumero: { fontSize: 13, fontFamily: 'monospace', fontWeight: 800, color: 'var(--text-primary)' },
  mMid: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 4 },
  mConcepto: { fontSize: 13, color: 'var(--text-primary)', flex: 1, minWidth: 0 },
  mMeta: { fontSize: 11, color: 'var(--text-secondary)' },
  emptyState: { padding: 40, textAlign: 'center' as const, color: 'var(--text-secondary)', fontSize: 13 },
  err: { padding: '10px 14px', borderRadius: 8, background: 'rgba(187,22,43,0.1)', border: '1px solid #BB162B44', color: '#BB162B', fontSize: 13, marginBottom: 14 },
}

function fmt(n: number): string {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' })
}

// The signed amount for display: EGRESO/SALIDA reduce cash, everything else adds.
const isOutflow = (tipo: string) => tipo === 'EGRESO' || tipo === 'SALIDA'

export default function ConsultasPage() {
  const router = useRouter()
  const isMobile = useIsMobile()
  const gate = useAuthGate(p =>
    p.tesoreria_can_view_balance ||
    p.tesoreria_can_pickup ||
    p.tesoreria_can_dispatch ||
    p.tesoreria_can_approve_salida ||
    p.tesoreria_admin ||
    p.npa_can_admin
  )

  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<ComprobanteRow[]>([])
  const [q, setQ] = useState('')
  const [tipoFilter, setTipoFilter] = useState<TipoFilter>('todos')
  const [err, setErr] = useState<string | null>(null)
  // Debounce timer — re-query 350ms after the user stops typing.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { if (gate.status === 'denied') router.replace('/tesoreria') }, [gate.status, router])
  useEffect(() => {
    if (gate.status === 'ok') search('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.status])

  async function search(term: string) {
    setLoading(true); setErr(null)
    try {
      // Strip commas — they break the PostgREST .or() filter string.
      const t = term.trim().replace(/,/g, ' ').trim()
      let query = supabase
        .from('tesoreria_comprobantes')
        .select('id, numero, tipo, estado, monto_usd, concepto, categoria, egreso_tipo, pago_fijo_concepto, contraparte_nombre, source_label, solicitado_at, egreso_documento_url')
        .order('solicitado_at', { ascending: false })
        .limit(t ? 100 : 50)
      if (t) {
        const like = '%' + t + '%'
        const ors = [
          'numero.ilike.' + like,
          'concepto.ilike.' + like,
          'contraparte_nombre.ilike.' + like,
          'source_label.ilike.' + like,
          'egreso_dirigido_a.ilike.' + like,
          'bancarizador_nombre.ilike.' + like,
        ]
        // Exact monto match when the term parses as a number ("3350" finds $3,350.00).
        const num = parseFloat(t)
        if (!isNaN(num) && num > 0 && /^\d+(\.\d+)?$/.test(t)) {
          ors.push('monto_usd.eq.' + num)
        }
        query = query.or(ors.join(','))
      }
      const { data, error } = await query
      if (error) throw new Error(error.message)
      setRows((data || []) as ComprobanteRow[])
    } catch (e: any) {
      setErr(e?.message || 'Error buscando comprobantes')
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  function onType(v: string) {
    setQ(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(v), 350)
  }

  const filtered = useMemo(() => {
    if (tipoFilter === 'todos') return rows
    if (tipoFilter === 'ingresos') return rows.filter(r => r.tipo === 'INGRESO')
    if (tipoFilter === 'egresos') return rows.filter(r => r.tipo === 'EGRESO' || r.tipo === 'SALIDA')
    return rows.filter(r => r.tipo !== 'INGRESO' && r.tipo !== 'EGRESO' && r.tipo !== 'SALIDA')
  }, [rows, tipoFilter])

  const counts = useMemo(() => ({
    todos: rows.length,
    ingresos: rows.filter(r => r.tipo === 'INGRESO').length,
    egresos: rows.filter(r => r.tipo === 'EGRESO' || r.tipo === 'SALIDA').length,
    otros: rows.filter(r => r.tipo !== 'INGRESO' && r.tipo !== 'EGRESO' && r.tipo !== 'SALIDA').length,
  }), [rows])

  const open = (r: ComprobanteRow) => router.push('/tesoreria/comprobante?id=' + r.id)

  // Secondary line: who / what the comprobante is about.
  const detailLine = (r: ComprobanteRow): string => {
    const bits: string[] = []
    if (r.contraparte_nombre) bits.push(r.contraparte_nombre)
    if (r.tipo === 'EGRESO' && r.egreso_tipo === 'PAGO_FIJO' && r.pago_fijo_concepto) {
      bits.push(PAGO_FIJO_LABEL[r.pago_fijo_concepto] || r.pago_fijo_concepto)
    } else if (r.egreso_tipo) {
      bits.push(r.egreso_tipo.replace(/_/g, ' '))
    }
    if (r.source_label) bits.push(r.source_label)
    return bits.join(' · ')
  }

  if (gate.status === 'loading') {
    return <div style={{ ...s.page, padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>Cargando…</div>
  }
  if (gate.status === 'error') return <SessionErrorScreen homeHref="/tesoreria" />
  if (gate.status === 'denied') return null

  return (
    <AdminShell active="tesoreria">
      <div style={{
        padding: isMobile ? '14px' : '32px',
        maxWidth: isMobile ? '100%' : 1000,
        margin: '0 auto',
      }}>
        <button style={s.back} onClick={() => router.push('/tesoreria')}>← Volver al Dashboard</button>

        <div style={s.card}>
          <div style={s.title}>Consultas</div>
          <div style={s.subtitle}>
            Busca cualquier comprobante de Tesorería — ingresos, egresos, cambios y pickups.
            Por número, concepto, nombre, referencia o monto exacto. Toca un resultado para abrir el detalle.
          </div>

          {err && <div style={s.err}>{err}</div>}

          <input
            style={s.search}
            type="text"
            value={q}
            onChange={e => onType(e.target.value)}
            placeholder="Ej: EGR-0064, comisiones, Josefina, 3350…"
            autoFocus={!isMobile}
          />

          <div style={s.pillRow}>
            <button style={s.pill(tipoFilter === 'todos')} onClick={() => setTipoFilter('todos')}>
              Todos ({counts.todos})
            </button>
            <button style={s.pill(tipoFilter === 'ingresos')} onClick={() => setTipoFilter('ingresos')}>
              Ingresos ({counts.ingresos})
            </button>
            <button style={s.pill(tipoFilter === 'egresos')} onClick={() => setTipoFilter('egresos')}>
              Egresos ({counts.egresos})
            </button>
            <button style={s.pill(tipoFilter === 'otros')} onClick={() => setTipoFilter('otros')}>
              Otros ({counts.otros})
            </button>
          </div>

          {loading ? (
            <div style={s.emptyState}>Buscando…</div>
          ) : filtered.length === 0 ? (
            <div style={s.emptyState}>
              {q.trim() ? 'Sin resultados para "' + q.trim() + '".' : 'No hay comprobantes registrados todavía.'}
            </div>
          ) : isMobile ? (
            <div>
              {filtered.map(r => {
                const tc = TIPO_COLOR[r.tipo] || '#6b7280'
                const ec = ESTADO_COLOR[r.estado] || '#6b7280'
                const outflow = isOutflow(r.tipo)
                const dl = detailLine(r)
                return (
                  <div key={r.id} style={s.mCard} onClick={() => open(r)}>
                    <div style={s.mTop}>
                      <div style={s.mNumero}>{r.numero}</div>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                        <span style={{ ...s.badge, background: tc + '22', color: tc, border: `1px solid ${tc}66` }}>
                          {TIPO_LABEL[r.tipo] || r.tipo}
                        </span>
                        <span style={{ ...s.badge, background: ec + '22', color: ec, border: `1px solid ${ec}66` }}>
                          {ESTADO_LABEL[r.estado] || r.estado}
                        </span>
                      </div>
                    </div>
                    <div style={s.mMid}>
                      <div style={s.mConcepto}>
                        {r.concepto}
                        {dl && <div style={s.mMeta}>{dl}</div>}
                      </div>
                      <div style={{ fontSize: 16, fontFamily: 'monospace', fontWeight: 800, color: outflow ? '#BB162B' : '#1a7a4a', whiteSpace: 'nowrap' }}>
                        {outflow ? '−' : '+'}{fmt(r.monto_usd)}
                      </div>
                    </div>
                    <div style={s.mMeta}>
                      {fmtDate(r.solicitado_at)}
                      {r.egreso_documento_url ? ' · 📎 soporte' : ''}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Número</th>
                  <th style={s.th}>Tipo</th>
                  <th style={s.th}>Estado</th>
                  <th style={s.th}>Concepto</th>
                  <th style={{ ...s.th, textAlign: 'right' as const }}>Monto</th>
                  <th style={s.th}>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const tc = TIPO_COLOR[r.tipo] || '#6b7280'
                  const ec = ESTADO_COLOR[r.estado] || '#6b7280'
                  const outflow = isOutflow(r.tipo)
                  const dl = detailLine(r)
                  return (
                    <tr key={r.id} onClick={() => open(r)} style={{ cursor: 'pointer' }}>
                      <td style={s.tdMono}>{r.numero}{r.egreso_documento_url ? ' 📎' : ''}</td>
                      <td style={s.td}>
                        <span style={{ ...s.badge, background: tc + '22', color: tc, border: `1px solid ${tc}66` }}>
                          {TIPO_LABEL[r.tipo] || r.tipo}
                        </span>
                      </td>
                      <td style={s.td}>
                        <span style={{ ...s.badge, background: ec + '22', color: ec, border: `1px solid ${ec}66` }}>
                          {ESTADO_LABEL[r.estado] || r.estado}
                        </span>
                      </td>
                      <td style={s.td}>
                        {r.concepto}
                        {dl && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{dl}</div>}
                      </td>
                      <td style={{ ...s.tdMono, textAlign: 'right' as const, fontWeight: 800, color: outflow ? '#BB162B' : '#1a7a4a' }}>
                        {outflow ? '−' : '+'}{fmt(r.monto_usd)}
                      </td>
                      <td style={s.td}>{fmtDate(r.solicitado_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AdminShell>
  )
}