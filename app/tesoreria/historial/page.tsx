// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/historial/page.tsx
// AutoCore NPA — Historial de Entregas (handoff batches)
//
// Lists every handoff batch (most-recent first) with totals, state and date.
// Tap a row to open the detail page. Mobile-first card layout, desktop table.
//
// Filter pills: Todos / Pendientes (PREPARADO) / Recibidos / Anulados.
//
// 2026-05-21 (Phase 5, #10)
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import AdminShell from '../../components/AdminShell'
import { useAuthGate } from '../../components/useAuthGate'
import { useIsMobile } from '../../components/useIsMobile'
import SessionErrorScreen from '../../components/SessionErrorScreen'
import { listHandoffBatches, type BatchListRow, type HandoffEstado } from '../../handoff'

type Filter = 'todos' | 'pendientes' | 'recibidos' | 'anulados'

const ESTADO_LABEL: Record<string, string> = {
  PREPARADO: 'Preparado',
  RECIBIDO: 'Recibido',
  ANULADO: 'Anulado',
}
const ESTADO_COLOR: Record<string, string> = {
  PREPARADO: '#e67e22',
  RECIBIDO: '#1a7a4a',
  ANULADO: '#BB162B',
}

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  back: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', marginBottom: 12, padding: 0 },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14 },
  title: { fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 6 },
  subtitle: { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 },
  pillRow: { display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' as const },
  pill: (active: boolean) => ({
    padding: '6px 14px', borderRadius: 999, fontSize: 12, fontWeight: 700,
    border: '1px solid ' + (active ? '#1a7a4a' : 'var(--border)'),
    background: active ? '#1a7a4a' : 'transparent',
    color: active ? '#fff' : 'var(--text-primary)',
    cursor: 'pointer',
  }),
  badge: { display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  // Desktop table
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: { textAlign: 'left' as const, fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1, padding: '8px 10px', borderBottom: '1px solid var(--border)' },
  td: { padding: '10px', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border)', cursor: 'pointer' },
  tdMono: { padding: '10px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border)', fontFamily: 'monospace', cursor: 'pointer' },
  // Mobile cards
  mCard: { padding: 12, background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 8, cursor: 'pointer' },
  mTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 },
  mNumero: { fontSize: 14, fontFamily: 'monospace', fontWeight: 800, color: 'var(--text-primary)' },
  mMid: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  mMeta: { fontSize: 11, color: 'var(--text-secondary)' },
  mMonto: { fontSize: 17, fontFamily: 'monospace', fontWeight: 800, color: '#1a7a4a' },
  mBottom: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 },
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

export default function HistorialPage() {
  const router = useRouter()
  const isMobile = useIsMobile()
  const gate = useAuthGate(p => p.tesoreria_can_pickup || p.tesoreria_admin || p.npa_can_admin)

  const [loading, setLoading] = useState(true)
  const [batches, setBatches] = useState<BatchListRow[]>([])
  const [filter, setFilter] = useState<Filter>('todos')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { if (gate.status === 'denied') router.replace('/tesoreria/home') }, [gate.status, router])
  useEffect(() => { if (gate.status === 'ok') load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.status])

  async function load() {
    setLoading(true); setErr(null)
    try {
      const list = await listHandoffBatches(100)
      setBatches(list)
    } catch (e: any) {
      setErr(e?.message || 'Error cargando historial')
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    if (filter === 'todos')      return batches
    if (filter === 'pendientes') return batches.filter(b => b.estado === 'PREPARADO')
    if (filter === 'recibidos')  return batches.filter(b => b.estado === 'RECIBIDO')
    if (filter === 'anulados')   return batches.filter(b => b.estado === 'ANULADO')
    return batches
  }, [batches, filter])

  const counts = useMemo(() => ({
    todos:      batches.length,
    pendientes: batches.filter(b => b.estado === 'PREPARADO').length,
    recibidos:  batches.filter(b => b.estado === 'RECIBIDO').length,
    anulados:   batches.filter(b => b.estado === 'ANULADO').length,
  }), [batches])

  function open(b: BatchListRow) {
    router.push('/tesoreria/handoff?id=' + b.id)
  }

  if (gate.status === 'loading') {
    return <div style={{ ...s.page, padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>Cargando…</div>
  }
  if (gate.status === 'error') return <SessionErrorScreen homeHref="/tesoreria/home" />
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
          <div style={s.title}>Historial de Entregas</div>
          <div style={s.subtitle}>
            Todas las entregas a Tesorería. Toca cualquier entrega para ver el detalle, reimprimir el QR o confirmar items pendientes.
          </div>

          {err && <div style={s.err}>{err}</div>}

          <div style={s.pillRow}>
            <button style={s.pill(filter === 'todos')} onClick={() => setFilter('todos')}>
              Todos ({counts.todos})
            </button>
            <button style={s.pill(filter === 'pendientes')} onClick={() => setFilter('pendientes')}>
              Pendientes ({counts.pendientes})
            </button>
            <button style={s.pill(filter === 'recibidos')} onClick={() => setFilter('recibidos')}>
              Recibidos ({counts.recibidos})
            </button>
            <button style={s.pill(filter === 'anulados')} onClick={() => setFilter('anulados')}>
              Anulados ({counts.anulados})
            </button>
          </div>

          {loading ? (
            <div style={s.emptyState}>Cargando…</div>
          ) : filtered.length === 0 ? (
            <div style={s.emptyState}>
              {filter === 'todos'
                ? 'No hay entregas registradas todavía.'
                : 'No hay entregas en este estado.'}
            </div>
          ) : isMobile ? (
            <div>
              {filtered.map(b => {
                const color = ESTADO_COLOR[b.estado] || '#999'
                return (
                  <div key={b.id} style={s.mCard} onClick={() => open(b)}>
                    <div style={s.mTop}>
                      <div style={s.mNumero}>{b.numero}</div>
                      <span style={{ ...s.badge, background: color + '22', color, border: `1px solid ${color}66` }}>
                        {ESTADO_LABEL[b.estado] || b.estado}
                      </span>
                    </div>
                    <div style={s.mMid}>
                      <div style={s.mMeta}>{b.total_count} {b.total_count === 1 ? 'item' : 'items'}</div>
                      <div style={s.mMonto}>{fmt(b.total_usd)}</div>
                    </div>
                    <div style={s.mBottom}>
                      Preparado: {fmtDate(b.preparado_at)}
                      {b.recibido_at && ` · Recibido: ${fmtDate(b.recibido_at)}`}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Numero</th>
                  <th style={s.th}>Estado</th>
                  <th style={{ ...s.th, textAlign: 'right' as const }}>Items</th>
                  <th style={{ ...s.th, textAlign: 'right' as const }}>Total</th>
                  <th style={s.th}>Preparado</th>
                  <th style={s.th}>Recibido</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(b => {
                  const color = ESTADO_COLOR[b.estado] || '#999'
                  return (
                    <tr key={b.id} onClick={() => open(b)} style={{ cursor: 'pointer' }}>
                      <td style={s.tdMono}>{b.numero}</td>
                      <td style={s.td}>
                        <span style={{ ...s.badge, background: color + '22', color, border: `1px solid ${color}66` }}>
                          {ESTADO_LABEL[b.estado] || b.estado}
                        </span>
                      </td>
                      <td style={{ ...s.td, textAlign: 'right' as const }}>{b.total_count}</td>
                      <td style={{ ...s.tdMono, textAlign: 'right' as const, color: '#1a7a4a', fontWeight: 700 }}>{fmt(b.total_usd)}</td>
                      <td style={s.td}>{fmtDate(b.preparado_at)}</td>
                      <td style={s.td}>{fmtDate(b.recibido_at)}</td>
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