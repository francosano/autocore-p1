// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/reportes/movimientos/page.tsx
// AutoCore NPA — Tesorería Reports — Movimientos ledger
//
// Full ledger of tesoreria_movimientos in the date range, filterable by
// ubicación, searchable by ref / comprobante / descripción. Excel export.
// PDF export is a Phase 4 deliverable.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Search, X } from 'lucide-react'
import { useAuthGate } from '../../../components/useAuthGate'
import SessionErrorScreen from '../../../components/SessionErrorScreen'
import ReportShell from '../../../components/ReportShell'
import {
  type DateRange, type MovimientoRow, type Ubicacion,
  getDefaultRange,
  loadUbicaciones, loadMovimientos,
  recomputeSaldosDefensive,
  fmtUSD, fmtDateDMY, fmtTime,
  exportExcel, movimientosToSheet, exportPDF,
} from '../../../lib/tesoreriaReports'

const NAVY = '#0D2257'
const GOLD = '#C49A2A'
const RED  = '#BB162B'
const GRN  = '#16A34A'

export default function MovimientosLedger() {
  const router = useRouter()
  const gate = useAuthGate(p =>
    p.tesoreria_can_view_balance || p.tesoreria_can_pickup ||
    p.tesoreria_admin || p.npa_can_admin
  )

  const [range, setRange] = useState<DateRange>(getDefaultRange())
  const [ubicaciones, setUbicaciones] = useState<Ubicacion[]>([])
  const [selectedUbicIds, setSelectedUbicIds] = useState<string[]>([])
  const [movs, setMovs] = useState<MovimientoRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [dirFilter, setDirFilter] = useState<'todos' | 'ingreso' | 'egreso'>('todos')

  useEffect(() => {
    if (gate.status === 'denied') router.replace('/tesoreria/home')
  }, [gate.status, router])

  // Load ubicaciones once
  useEffect(() => {
    if (gate.status !== 'ok') return
    loadUbicaciones().then(setUbicaciones).catch(e => setErr(e.message))
  }, [gate.status])

  // Load movimientos when range or filter changes
  useEffect(() => {
    if (gate.status !== 'ok') return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        await recomputeSaldosDefensive()
        const data = await loadMovimientos(
          range,
          selectedUbicIds.length > 0 ? selectedUbicIds : null,
        )
        if (!cancelled) setMovs(data)
      } catch (e: any) {
        if (!cancelled) setErr(e.message || 'Error cargando movimientos')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [gate.status, range.from, range.to, selectedUbicIds.join(',')])

  // Search filter
  const filteredMovs = useMemo(() => {
    const q = search.trim().toLowerCase()
    return movs.filter(m => {
      if (dirFilter === 'ingreso' && m.signo <= 0) return false
      if (dirFilter === 'egreso'  && m.signo > 0)  return false
      if (!q) return true
      return (
        (m.comprobante_numero || '').toLowerCase().includes(q) ||
        (m.descripcion || '').toLowerCase().includes(q) ||
        (m.source_label || '').toLowerCase().includes(q) ||
        (m.tipo || '').toLowerCase().includes(q) ||
        (m.categoria || '').toLowerCase().includes(q)
      )
    })
  }, [movs, search, dirFilter])

  // Totals (over filteredMovs)
  const totals = useMemo(() => {
    let ing = 0, eg = 0
    filteredMovs.forEach(m => {
      if (m.signo > 0) ing += m.monto_usd
      else eg += m.monto_usd
    })
    return { ingresos: ing, egresos: eg, net: ing - eg, count: filteredMovs.length }
  }, [filteredMovs])

  // Saldo per ubicacion at end of period (from currently-displayed movs)
  const saldosFinal = useMemo(() => {
    const out: Record<string, { codigo: string; ingresos: number; egresos: number; net: number }> = {}
    filteredMovs.forEach(m => {
      if (!out[m.ubicacion_id]) {
        out[m.ubicacion_id] = { codigo: m.ubicacion_codigo, ingresos: 0, egresos: 0, net: 0 }
      }
      if (m.signo > 0) out[m.ubicacion_id].ingresos += m.monto_usd
      else out[m.ubicacion_id].egresos += m.monto_usd
      out[m.ubicacion_id].net = out[m.ubicacion_id].ingresos - out[m.ubicacion_id].egresos
    })
    return Object.values(out).sort((a, b) => a.codigo.localeCompare(b.codigo))
  }, [filteredMovs])

  function handleExportExcel() {
    if (filteredMovs.length === 0) {
      alert('No hay movimientos en el rango seleccionado.')
      return
    }
    const filename = `tesoreria_movimientos_${range.from}_${range.to}.xlsx`
    exportExcel(filename, [
      {
        name: 'Movimientos',
        rows: movimientosToSheet(filteredMovs),
        colWidths: [12, 8, 14, 22, 6, 14, 14, 18, 18, 40, 10],
      },
      {
        name: 'Resumen',
        rows: saldosFinal.map(s => ({
          'Ubicación':   s.codigo,
          'Ingresos':    Number(s.ingresos.toFixed(2)),
          'Egresos':     Number(s.egresos.toFixed(2)),
          'Net':         Number(s.net.toFixed(2)),
        })),
        colWidths: [14, 14, 14, 14],
      },
    ])
  }

  function handleExportPDF() {
    if (filteredMovs.length === 0) {
      alert('No hay movimientos en el rango seleccionado.')
      return
    }
    const filename = `tesoreria_movimientos_${range.from}_${range.to}.pdf`
    const rows = filteredMovs.map(m => ({
      fecha: `${fmtDateDMY(m.created_at)} ${fmtTime(m.created_at)}`,
      ubic:  m.ubicacion_codigo,
      tipo:  m.tipo + (m.is_reversal ? ' (REV)' : ''),
      cat:   m.categoria || '',
      compr: m.comprobante_numero || '',
      desc:  m.descripcion || m.source_label || '',
      monto: (m.signo > 0 ? '+' : '-') + fmtUSD(m.monto_usd),
    }))
    exportPDF(filename, {
      title: 'Movimientos de Tesoreria',
      subtitle: `${range.from} a ${range.to}  -  ${filteredMovs.length} operacion${filteredMovs.length === 1 ? '' : 'es'}`,
      meta: `Generado ${fmtDateDMY(new Date().toISOString())}`,
      rows,
      columns: [
        { header: 'Fecha',       key: 'fecha', width: 20 },
        { header: 'Ubicacion',   key: 'ubic',  width: 13 },
        { header: 'Tipo',        key: 'tipo',  width: 18 },
        { header: 'Categoria',   key: 'cat',   width: 18 },
        { header: 'Comprobante', key: 'compr', width: 18 },
        { header: 'Descripcion', key: 'desc',  width: 40 },
        { header: 'Monto',       key: 'monto', width: 15, align: 'right' as const },
      ],
      totals: [
        { label: 'Ingresos', value: '+' + fmtUSD(totals.ingresos), tone: 'pos' as const },
        { label: 'Egresos',  value: '-' + fmtUSD(totals.egresos),  tone: 'neg' as const },
        { label: 'Neto', value: (totals.net >= 0 ? '+' : '-') + fmtUSD(Math.abs(totals.net)), tone: (totals.net >= 0 ? 'pos' : 'neg') as 'pos' | 'neg' },
        { label: 'Operaciones', value: String(totals.count), tone: 'plain' as const },
      ],
    })
  }

  if (gate.status === 'error') return <SessionErrorScreen homeHref="/tesoreria/home" />
  if (gate.status === 'loading' || gate.status !== 'ok') {
    return <div style={{ padding: 60, textAlign: 'center' }}>Cargando…</div>
  }

  return (
    <ReportShell
      title="Movimientos"
      subtitle={`${filteredMovs.length} operación${filteredMovs.length === 1 ? '' : 'es'} en el periodo`}
      range={range}
      onRangeChange={setRange}
      ubicaciones={ubicaciones}
      selectedUbicacionIds={selectedUbicIds}
      onUbicacionChange={setSelectedUbicIds}
      onExportExcel={handleExportExcel}
      onExportPDF={handleExportPDF}
    >
      {err && (
        <div style={{ background: '#FEE', border: '1px solid ' + RED, color: RED, padding: 12, borderRadius: 6, marginBottom: 16 }}>
          {err}
        </div>
      )}

      {/* Totals strip */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12,
        marginBottom: 16,
      }}>
        <Card label="Ingresos" value={fmtUSD(totals.ingresos)} color={GRN} />
        <Card label="Egresos"  value={fmtUSD(totals.egresos)}  color={RED} />
        <Card label="Neto"     value={fmtUSD(totals.net)}      color={totals.net >= 0 ? GRN : RED} />
        <Card label="Operaciones" value={String(totals.count)}  color={NAVY} />
      </div>

      {/* Per-ubicacion strip */}
      {saldosFinal.length > 1 && (
        <div style={{
          background: '#fff', border: '1px solid #E5E2D8', borderRadius: 8, padding: 14, marginBottom: 16,
        }}>
          <div style={{ fontSize: 11, color: '#71717A', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, marginBottom: 8 }}>
            Neto del periodo por ubicación
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {saldosFinal.map(s => (
              <div key={s.codigo} style={{ minWidth: 140 }}>
                <div style={{ fontSize: 11, color: '#52525B' }}>{s.codigo}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: s.net >= 0 ? GRN : RED, fontFamily: 'monospace' }}>
                  {fmtUSD(s.net)}
                </div>
                <div style={{ fontSize: 10, color: '#71717A' }}>
                  +{fmtUSD(s.ingresos)} · −{fmtUSD(s.egresos)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Direction filter chips */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {(([['todos', 'Todos'], ['ingreso', 'Ingresos'], ['egreso', 'Egresos']]) as [typeof dirFilter, string][]).map(([key, label]) => {
          const active = dirFilter === key
          const color = key === 'ingreso' ? GRN : key === 'egreso' ? RED : NAVY
          return (
            <button
              key={key}
              onClick={() => setDirFilter(key)}
              style={{
                padding: '7px 16px',
                borderRadius: 999,
                border: '1px solid ' + (active ? color : '#E5E2D8'),
                background: active ? color : '#fff',
                color: active ? '#fff' : '#52525B',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >{label}</button>
          )
        })}
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#71717A' }} />
        <input
          type="text"
          placeholder="Buscar por número, descripción, categoría…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%',
            padding: '10px 36px 10px 36px',
            border: '1px solid #E5E2D8',
            borderRadius: 6,
            fontSize: 13,
            boxSizing: 'border-box',
          }}
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', color: '#71717A' }}
          ><X size={14} /></button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#71717A' }}>Cargando…</div>
      ) : filteredMovs.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#71717A', background: '#fff', borderRadius: 8 }}>
          Sin movimientos en este rango.
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: NAVY, color: '#fff' }}>
                  <th style={th}>Fecha</th>
                  <th style={th}>Ubicación</th>
                  <th style={th}>Movimiento</th>
                  <th style={th}>Comprobante</th>
                  <th style={{ ...th, textAlign: 'right' }}>Monto</th>
                </tr>
              </thead>
              <tbody>
                {filteredMovs.map((m, idx) => {
                  const isIng = m.signo > 0
                  const dirColor = isIng ? GRN : RED
                  return (
                    <tr
                      key={m.id}
                      style={{
                        background: idx % 2 === 0 ? '#fff' : '#FAF8F2',
                        borderTop: '1px solid #F0EDE2',
                      }}
                    >
                      {/* Fecha + hora */}
                      <td style={td}>
                        <div style={{ fontWeight: 600, color: '#27272A' }}>{fmtDateDMY(m.created_at)}</div>
                        <div style={{ fontSize: 10, color: '#A1A1AA', fontFamily: 'monospace' }}>{fmtTime(m.created_at)}</div>
                      </td>
                      {/* Ubicación */}
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: 11, color: '#52525B' }}>{m.ubicacion_codigo}</td>
                      {/* Movimiento: tipo pill + descripción + categoría */}
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                            background: isIng ? 'rgba(22,163,74,0.10)' : 'rgba(187,22,43,0.10)',
                            color: dirColor,
                          }}>
                            {isIng ? '▲' : '▼'} {m.tipo}
                          </span>
                          {m.is_reversal && (
                            <span style={{ fontSize: 9, color: GOLD, fontWeight: 800, letterSpacing: 0.5 }}>REV</span>
                          )}
                          {m.categoria && (
                            <span style={{ fontSize: 10, color: '#A1A1AA', background: '#F4F4F5', padding: '1px 6px', borderRadius: 4 }}>{m.categoria}</span>
                          )}
                        </div>
                        {(m.descripcion || m.source_label) && (
                          <div style={{ fontSize: 11, color: '#52525B', marginTop: 3 }}>{m.descripcion || m.source_label}</div>
                        )}
                      </td>
                      {/* Comprobante */}
                      <td style={td}>
                        {m.comprobante_numero
                          ? (
                              <a
                                href={`/tesoreria/comprobante?id=${m.comprobante_id}`}
                                style={{ color: NAVY, textDecoration: 'none', fontFamily: 'monospace', fontSize: 11, fontWeight: 600, background: '#EEF2FB', padding: '3px 8px', borderRadius: 6, whiteSpace: 'nowrap' }}
                              >{m.comprobante_numero}</a>
                            )
                          : <span style={{ color: '#D4D4D8' }}>—</span>}
                      </td>
                      {/* Monto (signed, colored) */}
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: dirColor, fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {isIng ? '+' : '−'}{fmtUSD(m.monto_usd)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </ReportShell>
  )
}

function Card({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #E5E2D8',
      borderLeft: '4px solid ' + color,
      borderRadius: 8,
      padding: '14px 16px',
    }}>
      <div style={{ fontSize: 10, color: '#71717A', textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, fontFamily: 'monospace', marginTop: 4 }}>{value}</div>
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '10px 12px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  position: 'sticky',
  top: 0,
  background: NAVY,
  zIndex: 1,
}
const td: React.CSSProperties = { padding: '8px 12px', verticalAlign: 'top' }