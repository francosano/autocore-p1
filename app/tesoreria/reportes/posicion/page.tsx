// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/reportes/posicion/page.tsx
// AutoCore NPA — Tesorería Reports — Cash position over time
//
// Native SVG line chart (no recharts). One line per ubicación. Toggle
// granularity: dia / semana / mes. Top movers side panel.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthGate } from '../../../components/useAuthGate'
import SessionErrorScreen from '../../../components/SessionErrorScreen'
import ReportShell from '../../../components/ReportShell'
import {
  type DateRange, type MovimientoRow, type Ubicacion, type SaldoPoint, type Granularity,
  getDefaultRange,
  loadUbicaciones, loadMovimientos,
  buildSaldoSeries, topMovers,
  recomputeSaldosDefensive,
  fmtUSD, fmtDateDMY,
  exportExcel,
} from '../../../lib/tesoreriaReports'

const NAVY = '#0D2257'
const GOLD = '#C49A2A'
const RED  = '#BB162B'
const GRN  = '#16A34A'

// Distinct line colors per ubicación.
const UBIC_PALETTE = ['#0D2257', '#C49A2A', '#16A34A', '#BB162B', '#7C3AED', '#0EA5E9', '#F97316', '#14B8A6']

export default function CashPositionPage() {
  const router = useRouter()
  const gate = useAuthGate(p =>
    p.tesoreria_can_view_balance || p.tesoreria_can_pickup ||
    p.tesoreria_admin || p.npa_can_admin
  )

  const [range, setRange] = useState<DateRange>(getDefaultRange())
  const [ubicaciones, setUbicaciones] = useState<Ubicacion[]>([])
  const [selectedUbicIds, setSelectedUbicIds] = useState<string[]>([])
  const [movs, setMovs] = useState<MovimientoRow[]>([])
  const [granularity, setGranularity] = useState<Granularity>('dia')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (gate.status === 'denied') router.replace('/tesoreria/home')
  }, [gate.status, router])

  useEffect(() => {
    if (gate.status !== 'ok') return
    loadUbicaciones().then(setUbicaciones).catch(e => setErr(e.message))
  }, [gate.status])

  useEffect(() => {
    if (gate.status !== 'ok') return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        await recomputeSaldosDefensive()
        // For cash position chart, we need ALL ubicaciones' history (to compute starting saldo),
        // then we slice by selected for display. Pass null to loader.
        const data = await loadMovimientos(range, null)
        if (!cancelled) setMovs(data)
      } catch (e: any) {
        if (!cancelled) setErr(e.message || 'Error cargando movimientos')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [gate.status, range.from, range.to])

  // Build series for display
  const series = useMemo(() => {
    if (movs.length === 0 || ubicaciones.length === 0) return [] as SaldoPoint[]
    return buildSaldoSeries(movs, ubicaciones, range, granularity)
  }, [movs, ubicaciones, range, granularity])

  // Filter series by selection
  const displaySeries = useMemo(() => {
    if (selectedUbicIds.length === 0) return series
    return series.filter(p => selectedUbicIds.includes(p.ubicacion_id))
  }, [series, selectedUbicIds])

  // Top movers (over the displayed range, all ubicaciones unless filtered)
  const filteredForMovers = useMemo(() => {
    if (selectedUbicIds.length === 0) return movs
    return movs.filter(m => selectedUbicIds.includes(m.ubicacion_id))
  }, [movs, selectedUbicIds])
  const topIngresos = useMemo(() => topMovers(filteredForMovers, 'ingreso', 5), [filteredForMovers])
  const topEgresos  = useMemo(() => topMovers(filteredForMovers, 'egreso',  5), [filteredForMovers])

  function handleExportExcel() {
    if (displaySeries.length === 0) {
      alert('No hay datos en el rango seleccionado.')
      return
    }
    exportExcel(`tesoreria_posicion_${range.from}_${range.to}.xlsx`, [
      {
        name: 'Saldos',
        rows: displaySeries.map(p => ({
          'Fecha':     p.date,
          'Ubicación': p.ubicacion_codigo,
          'Saldo':     Number(p.saldo.toFixed(2)),
        })),
        colWidths: [14, 14, 14],
      },
      {
        name: 'Top Ingresos',
        rows: topIngresos.map(t => ({
          'Fecha':       fmtDateDMY(t.created_at),
          'Ubicación':   t.ubicacion_codigo,
          'Monto':       Number(t.monto_usd.toFixed(2)),
          'Comprobante': t.comprobante_numero || '',
          'Descripción': t.descripcion || '',
        })),
        colWidths: [12, 12, 14, 16, 40],
      },
      {
        name: 'Top Egresos',
        rows: topEgresos.map(t => ({
          'Fecha':       fmtDateDMY(t.created_at),
          'Ubicación':   t.ubicacion_codigo,
          'Monto':       Number(t.monto_usd.toFixed(2)),
          'Comprobante': t.comprobante_numero || '',
          'Descripción': t.descripcion || '',
        })),
        colWidths: [12, 12, 14, 16, 40],
      },
    ])
  }

  if (gate.status === 'error') return <SessionErrorScreen homeHref="/tesoreria/home" />
  if (gate.status !== 'ok') return <div style={{ padding: 60, textAlign: 'center' }}>Cargando…</div>

  return (
    <ReportShell
      title="Posición de Caja"
      subtitle={`Evolución de saldos · granularidad ${granularity}`}
      range={range}
      onRangeChange={setRange}
      ubicaciones={ubicaciones}
      selectedUbicacionIds={selectedUbicIds}
      onUbicacionChange={setSelectedUbicIds}
      onExportExcel={handleExportExcel}
    >
      {err && (
        <div style={{ background: '#FEE', border: '1px solid ' + RED, color: RED, padding: 12, borderRadius: 6, marginBottom: 16 }}>
          {err}
        </div>
      )}

      {/* Granularity toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#71717A', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>
          Granularidad
        </span>
        {(['dia','semana','mes'] as Granularity[]).map(g => (
          <button
            key={g}
            onClick={() => setGranularity(g)}
            style={{
              padding: '6px 14px',
              background: granularity === g ? NAVY : 'transparent',
              color: granularity === g ? '#fff' : NAVY,
              border: '1px solid ' + NAVY,
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {g === 'dia' ? 'Diaria' : g === 'semana' ? 'Semanal' : 'Mensual'}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 16, alignItems: 'start' }}>
        {/* Chart */}
        <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 11, color: '#71717A', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, marginBottom: 8 }}>
            Saldo USD por ubicación
          </div>
          {loading ? (
            <div style={{ padding: 80, textAlign: 'center', color: '#71717A' }}>Cargando…</div>
          ) : displaySeries.length === 0 ? (
            <div style={{ padding: 80, textAlign: 'center', color: '#71717A' }}>Sin datos en el rango.</div>
          ) : (
            <SaldoLineChart points={displaySeries} ubicaciones={ubicaciones} selectedIds={selectedUbicIds} />
          )}
        </div>

        {/* Top movers */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <MoversPanel title="Top Ingresos" rows={topIngresos} color={GRN} />
          <MoversPanel title="Top Egresos"  rows={topEgresos}  color={RED} />
        </div>
      </div>
    </ReportShell>
  )
}

// ── SVG line chart ─────────────────────────────────────────────────────────
function SaldoLineChart({
  points, ubicaciones, selectedIds,
}: {
  points: SaldoPoint[]
  ubicaciones: Ubicacion[]
  selectedIds: string[]
}) {
  // Group by ubicacion
  const byUbic: Record<string, SaldoPoint[]> = {}
  points.forEach(p => {
    if (!byUbic[p.ubicacion_id]) byUbic[p.ubicacion_id] = []
    byUbic[p.ubicacion_id].push(p)
  })

  // Distinct sorted dates
  const dates = Array.from(new Set(points.map(p => p.date))).sort()
  if (dates.length === 0) return null

  // Y-axis range
  const allValues = points.map(p => p.saldo)
  const yMin = Math.min(0, ...allValues)
  const yMax = Math.max(0, ...allValues)
  const yPad = (yMax - yMin) * 0.1 || 1000

  // SVG dimensions
  const W = 760, H = 320
  const padL = 70, padR = 20, padT = 20, padB = 50
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const xFor = (i: number) => padL + (i / Math.max(1, dates.length - 1)) * plotW
  const yFor = (v: number) => padT + plotH - ((v - (yMin - yPad)) / ((yMax + yPad) - (yMin - yPad))) * plotH

  // Active ubicaciones (skip those without points OR not in selection)
  const activeUbics = ubicaciones.filter(u =>
    byUbic[u.id] && byUbic[u.id].length > 0 &&
    (selectedIds.length === 0 || selectedIds.includes(u.id))
  )

  // Build polylines
  function pathFor(ubicId: string): string {
    const pts = byUbic[ubicId] || []
    // Build a quick lookup by date for this ubicación so order matches `dates`.
    const byDate: Record<string, number> = {}
    pts.forEach(p => { byDate[p.date] = p.saldo })
    let last = 0
    return dates.map((d, i) => {
      if (byDate[d] != null) last = byDate[d]
      const x = xFor(i)
      const y = yFor(last)
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    }).join(' ')
  }

  // Y-axis grid lines (5 ticks)
  const yTicks: number[] = []
  for (let i = 0; i <= 4; i++) {
    yTicks.push((yMin - yPad) + (((yMax + yPad) - (yMin - yPad)) * i / 4))
  }

  // X-axis labels (max 8 to avoid overlap)
  const xLabelEvery = Math.max(1, Math.ceil(dates.length / 8))

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
        {/* Grid */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line
              x1={padL} x2={W - padR}
              y1={yFor(v)} y2={yFor(v)}
              stroke="#E5E2D8" strokeWidth={1} strokeDasharray={i === yTicks.length - 1 ? '0' : '2 4'}
            />
            <text x={padL - 8} y={yFor(v) + 4} fontSize={10} fill="#71717A" textAnchor="end">
              {fmtUSD(v)}
            </text>
          </g>
        ))}
        {/* Zero axis */}
        {yMin < 0 && yMax > 0 && (
          <line x1={padL} x2={W - padR} y1={yFor(0)} y2={yFor(0)} stroke="#52525B" strokeWidth={1} />
        )}
        {/* X labels */}
        {dates.map((d, i) => i % xLabelEvery === 0 && (
          <text
            key={d} x={xFor(i)} y={H - padB + 14}
            fontSize={10} fill="#71717A" textAnchor="middle"
          >
            {d.length === 7 ? d : d.slice(5)}
          </text>
        ))}
        {/* Lines */}
        {activeUbics.map((u, idx) => (
          <path
            key={u.id}
            d={pathFor(u.id)}
            fill="none"
            stroke={UBIC_PALETTE[idx % UBIC_PALETTE.length]}
            strokeWidth={2.2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      </svg>
      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, fontSize: 11 }}>
        {activeUbics.map((u, idx) => (
          <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              display: 'inline-block', width: 12, height: 3,
              background: UBIC_PALETTE[idx % UBIC_PALETTE.length],
            }} />
            <span style={{ fontFamily: 'monospace', color: '#52525B' }}>{u.codigo}</span>
            <span style={{ color: '#71717A' }}>· {fmtUSD(u.saldo_actual_usd)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MoversPanel({ title, rows, color }: { title: string; rows: any[]; color: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderLeft: '3px solid ' + color, borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 11, color: '#71717A', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, marginBottom: 8 }}>
        {title}
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: '#71717A' }}>—</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ fontSize: 11, paddingBottom: 6, borderBottom: i < rows.length - 1 ? '1px solid #F0EDE2' : 'none' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontFamily: 'monospace', color: NAVY, fontWeight: 700 }}>
                  {r.comprobante_numero || '—'}
                </span>
                <span style={{ color, fontFamily: 'monospace', fontWeight: 800 }}>
                  {fmtUSD(r.monto_usd)}
                </span>
              </div>
              <div style={{ color: '#52525B', marginTop: 2 }}>
                {r.descripcion}
              </div>
              <div style={{ fontSize: 10, color: '#71717A', marginTop: 2 }}>
                {fmtDateDMY(r.created_at)} · {r.ubicacion_codigo}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}