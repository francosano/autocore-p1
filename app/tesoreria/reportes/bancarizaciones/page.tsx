// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/reportes/bancarizaciones/page.tsx
// v1 (2026-05-26) — Bancarización report
//
// KPIs:
//   - Total despachado (cash sent out)
//   - Total recibido en banco
//   - En tránsito (handed to bancarizador, not yet deposited)
//   - Discrepancia neta (positive = surplus owed to bancarizadores)
//
// Breakdowns:
//   - Por banco (motocentro / roframi / panama / UNKNOWN)
//   - Por bancarizador (saldo + counts)
//
// List: all bancarización comprobantes with their bank-side data.
// Excel export available.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, Download, ExternalLink, AlertTriangle } from 'lucide-react'
import { useAuthGate } from '../../../components/useAuthGate'
import SessionErrorScreen from '../../../components/SessionErrorScreen'
import AdminShell from '../../../components/AdminShell'
import {
  type BancarizacionRow, type Bancarizador,
  loadBancarizaciones, loadBancarizadores, computeKPIs, summarizeByBank,
  fmtUSD, fmtUSDsigned, fmtDateDMY, fmtHours, BANK_LABEL,
} from '../../../lib/bancarizaciones'
import {
  type DateRange, getDefaultRange, rangeForPreset, toISODate,
  exportExcel,
} from '../../../lib/tesoreriaReports'

const NAVY = '#0D2257'
const GOLD = '#C49A2A'
const RED  = '#BB162B'
const GRN  = '#16A34A'
const AMB  = '#D97706'
const MUTED = '#71717A'

const ESTADO_COLOR: Record<string, string> = {
  SOLICITADO: '#71717A',
  EN_PODER_MIRLA: '#7C3AED',
  ENTREGADO_BANCARIZADOR: '#D97706',
  DEPOSITADO_PARCIAL: '#b8720a',
  DEPOSITADO: '#16A34A',
  ANULADO: '#EF4444',
  REVERTIDO: '#EF4444',
}
const ESTADO_LABEL: Record<string, string> = {
  SOLICITADO: 'Solicitado',
  EN_PODER_MIRLA: 'En poder Mirla',
  ENTREGADO_BANCARIZADOR: 'Entregado',
  DEPOSITADO_PARCIAL: 'Depósito parcial',
  DEPOSITADO: 'Depositado',
  ANULADO: 'Anulado',
  REVERTIDO: 'Revertido',
}

export default function BancarizacionesReport() {
  const router = useRouter()
  const gate = useAuthGate(p =>
    p.tesoreria_can_view_balance ||
    p.tesoreria_can_pickup ||
    p.tesoreria_admin ||
    p.npa_can_admin
  )

  const [range, setRange] = useState<DateRange>(getDefaultRange())
  const [rows, setRows] = useState<BancarizacionRow[]>([])
  const [bancs, setBancs] = useState<Bancarizador[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [estadoFilter, setEstadoFilter] = useState<string>('all')
  const [bankFilter, setBankFilter] = useState<string>('all')
  const [bancarizadorFilter, setBancarizadorFilter] = useState<string>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (gate.status === 'denied') router.replace('/tesoreria/home')
  }, [gate.status, router])

  useEffect(() => {
    if (gate.status !== 'ok') return
    let cancelled = false
    setLoading(true); setErr(null)
    Promise.all([loadBancarizaciones(range), loadBancarizadores()])
      .then(([r, b]) => { if (!cancelled) { setRows(r); setBancs(b) } })
      .catch(e => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [gate.status, range])

  // ── Derived ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (estadoFilter !== 'all' && r.estado !== estadoFilter) return false
      if (bankFilter !== 'all') {
        const c = r.bank_cuenta || 'UNKNOWN'
        if (bankFilter === 'UNCLASSIFIED' && c !== 'UNKNOWN') return false
        else if (bankFilter !== 'UNCLASSIFIED' && c !== bankFilter) return false
      }
      if (bancarizadorFilter !== 'all' && (r.bancarizador_nombre || '') !== bancarizadorFilter) return false
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        const hay = [
          r.numero, r.bancarizador_nombre, r.concepto, r.bank_referencia,
        ].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, estadoFilter, bankFilter, bancarizadorFilter, search])

  const kpis = useMemo(() => computeKPIs(filtered), [filtered])
  const byBank = useMemo(() => summarizeByBank(filtered), [filtered])
  const bancNames = useMemo(() =>
    Array.from(new Set(rows.map(r => r.bancarizador_nombre).filter(Boolean) as string[])).sort()
  , [rows])

  // ── Excel export ───────────────────────────────────────────────────────
  const handleExport = () => {
    const sheetRows = filtered.map(r => ({
      'N° Comprobante':       r.numero,
      'Estado':               ESTADO_LABEL[r.estado] || r.estado,
      'Ruta':                 r.bancarizacion_ruta || '',
      'Bancarizador':         r.bancarizador_nombre || '',
      'Monto despachado USD': r.monto_usd,
      'Monto en banco USD':   r.bank_monto ?? '',
      'Discrepancia USD':     r.bank_monto != null ? (r.bank_monto - r.monto_usd) : '',
      'Banco':                BANK_LABEL[r.bank_cuenta || 'UNKNOWN'] || (r.bank_cuenta || ''),
      'Referencia':           r.bank_referencia || '',
      'Creado':               r.creado_at ? new Date(r.creado_at).toLocaleString() : '',
      'Entregado al banc.':   r.entregado_at ? new Date(r.entregado_at).toLocaleString() : '',
      'Depositado':           r.depositado_at ? new Date(r.depositado_at).toLocaleString() : '',
      'Concepto':             r.concepto || '',
    }))
    const bancRows = bancs.map(b => ({
      'Bancarizador': b.nombre,
      'Saldo USD':    b.saldo_usd,
      'Estado':       b.saldo_usd > 0 ? 'Nos debe' : b.saldo_usd < 0 ? 'Le debemos' : 'En cero',
      'Activo':       b.activo ? 'Sí' : 'No',
      'Contacto':     b.contacto || '',
    }))
    const bankRows = byBank.map(b => ({
      'Banco':    BANK_LABEL[b.cuenta] || b.cuenta,
      'Cuenta':   b.cuenta,
      'Depósitos': b.count,
      'Total recibido USD': b.total_recibido,
    }))
    exportExcel(`bancarizaciones_${range.from}_${range.to}.xlsx`, [
      { name: 'Comprobantes', rows: sheetRows },
      { name: 'Por banco',    rows: bankRows },
      { name: 'Bancarizadores saldos', rows: bancRows },
    ])
  }

  if (gate.status === 'loading') {
    return <AdminShell active="tesoreria">
      <div style={{ padding: 60, textAlign: 'center', color: MUTED }}>Cargando…</div>
    </AdminShell>
  }
  if (gate.status === 'error') return <SessionErrorScreen homeHref="/tesoreria/home" />
  if (gate.status !== 'ok') return null

  return (
    <AdminShell active="tesoreria">
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 20px 80px' }}>

        {/* Header */}
        <button onClick={() => router.push('/tesoreria/reportes')}
          style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: NAVY, fontSize: 13, cursor: 'pointer', marginBottom: 16 }}>
          <ChevronLeft size={16} /> Volver a Reportes
        </button>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: GOLD, textTransform: 'uppercase', letterSpacing: 2, fontWeight: 700 }}>Tesorería · Reportes</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: NAVY }}>Bancarizaciones</div>
            <div style={{ fontSize: 13, color: '#52525B', marginTop: 4 }}>Cash despachado · wires recibidos · saldos por bancarizador</div>
          </div>
          <button onClick={handleExport}
            style={{ padding: '9px 16px', borderRadius: 6, background: NAVY, color: '#fff', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Download size={14} /> Excel
          </button>
        </div>

        {/* Date range picker */}
        <DateRangeBar range={range} onChange={setRange} />

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
          <Kpi label="Total despachado" value={fmtUSD(kpis.totalDespachado)} sub={`${kpis.countTotal - kpis.countAnulado} bancarizaciones`} color={NAVY} />
          <Kpi label="Total recibido" value={fmtUSD(kpis.totalRecibido)} sub={`${kpis.countDepositado} depositadas`} color={GRN} />
          <Kpi label="En tránsito" value={fmtUSD(kpis.enTransito)} sub={`${kpis.enTransitoCount} pendientes de depósito`} color={AMB} />
          <Kpi label="Discrepancia neta"
               value={fmtUSDsigned(kpis.discrepanciaNeta)}
               sub={kpis.discrepanciaNeta > 0 ? 'Bancs. depositaron de más' : kpis.discrepanciaNeta < 0 ? 'Bancs. depositaron de menos' : 'Sin discrepancia'}
               color={kpis.discrepanciaNeta > 0 ? GRN : kpis.discrepanciaNeta < 0 ? RED : MUTED} />
          <Kpi label="Tiempo en tránsito" value={fmtHours(kpis.avgTransitHours)} sub="promedio entrega → depósito" color={NAVY} />
        </div>

        {kpis.countSinClasificar > 0 && (
          <div style={{ padding: '10px 14px', background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 6, marginBottom: 16, fontSize: 13, color: '#92400E', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={16} />
            <span><b>{kpis.countSinClasificar}</b> depósito{kpis.countSinClasificar === 1 ? '' : 's'} sin clasificar (cuenta: UNKNOWN). Asígnales el banco correcto en /banco.</span>
          </div>
        )}

        {/* Per-bank summary */}
        <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderRadius: 8, padding: 18, marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: GOLD, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, marginBottom: 12 }}>Por banco</div>
          {byBank.length === 0 ? (
            <div style={{ fontSize: 13, color: MUTED }}>Sin depósitos en este período</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              {byBank.map(b => (
                <div key={b.cuenta} style={{ padding: '12px 14px', background: b.cuenta === 'UNKNOWN' ? '#FEF3C7' : '#F9F7F0', borderRadius: 6, borderLeft: '3px solid ' + (b.cuenta === 'UNKNOWN' ? AMB : NAVY) }}>
                  <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6 }}>{BANK_LABEL[b.cuenta] || b.cuenta}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: NAVY, marginTop: 2 }}>{fmtUSD(b.total_recibido)}</div>
                  <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{b.count} depósito{b.count === 1 ? '' : 's'}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Per-bancarizador summary */}
        {bancs.length > 0 && (
          <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderRadius: 8, padding: 18, marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: GOLD, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700 }}>Saldos por bancarizador</div>
              <button onClick={() => router.push('/tesoreria/bancarizadores')}
                style={{ background: 'transparent', border: 'none', color: NAVY, fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                Ver todos <ExternalLink size={12} />
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
              {bancs.filter(b => b.activo).sort((a, b) => Math.abs(b.saldo_usd) - Math.abs(a.saldo_usd)).map(b => (
                <div key={b.id}
                  onClick={() => router.push('/tesoreria/bancarizadores/detail?id=' + b.id)}
                  style={{ padding: '10px 12px', background: '#F9F7F0', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: '3px solid ' + (b.saldo_usd === 0 ? MUTED : b.saldo_usd > 0 ? GRN : RED) }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: NAVY }}>{b.nombre}</div>
                    <div style={{ fontSize: 10, color: MUTED }}>{b.saldo_usd > 0 ? 'Nos debe' : b.saldo_usd < 0 ? 'Le debemos' : 'En cero'}</div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: b.saldo_usd > 0 ? GRN : b.saldo_usd < 0 ? RED : MUTED, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtUSDsigned(b.saldo_usd)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Filters */}
        <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderRadius: 8, padding: 14, marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <FilterSelect label="Estado" value={estadoFilter} onChange={setEstadoFilter}
            options={[
              { v: 'all', l: 'Todos' },
              { v: 'SOLICITADO', l: 'Solicitado' },
              { v: 'EN_PODER_MIRLA', l: 'En poder Mirla' },
              { v: 'ENTREGADO_BANCARIZADOR', l: 'Entregado' },
              { v: 'DEPOSITADO_PARCIAL', l: 'Dep. parcial' },
              { v: 'DEPOSITADO', l: 'Depositado' },
              { v: 'ANULADO', l: 'Anulado' },
            ]} />
          <FilterSelect label="Banco" value={bankFilter} onChange={setBankFilter}
            options={[
              { v: 'all', l: 'Todos' },
              { v: 'motocentro', l: 'BofA Motocentro' },
              { v: 'roframi', l: 'BofA Roframi' },
              { v: 'roframi_regions', l: 'Regions Roframi' },
              { v: 'panama', l: 'Mercantil Panamá' },
              { v: 'UNCLASSIFIED', l: '⚠ Sin clasificar' },
            ]} />
          <FilterSelect label="Bancarizador" value={bancarizadorFilter} onChange={setBancarizadorFilter}
            options={[{ v: 'all', l: 'Todos' }, ...bancNames.map(n => ({ v: n, l: n }))]} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar # / ref / concepto…"
            style={{ flex: 1, minWidth: 180, padding: '7px 10px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 12, fontFamily: 'inherit' }} />
        </div>

        {/* Table */}
        <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderRadius: 8, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: MUTED, fontSize: 13 }}>Cargando…</div>
          ) : err ? (
            <div style={{ padding: 24, color: RED, fontSize: 13 }}>{err}</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: MUTED, fontSize: 13 }}>Sin bancarizaciones en el rango / filtros seleccionados</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#F5F1E8', color: NAVY }}>
                    <Th>N°</Th>
                    <Th>Estado</Th>
                    <Th>Bancarizador</Th>
                    <Th align="right">Despachado</Th>
                    <Th align="right">Recibido</Th>
                    <Th align="right">Δ</Th>
                    <Th>Banco</Th>
                    <Th>Ref</Th>
                    <Th>Creado</Th>
                    <Th>Depositado</Th>
                    <Th></Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const delta = r.bank_monto != null ? r.bank_monto - r.monto_usd : null
                    const bankLabel = r.bank_cuenta ? (BANK_LABEL[r.bank_cuenta] || r.bank_cuenta) : '—'
                    return (
                      <tr key={r.id} style={{ borderTop: '1px solid #E5E2D8' }}>
                        <Td><b style={{ color: NAVY }}>{r.numero}</b></Td>
                        <Td>
                          <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: (ESTADO_COLOR[r.estado] || MUTED) + '22', color: ESTADO_COLOR[r.estado] || MUTED, textTransform: 'uppercase' }}>
                            {ESTADO_LABEL[r.estado] || r.estado}
                          </span>
                        </Td>
                        <Td>{r.bancarizador_nombre || '—'}</Td>
                        <Td align="right" mono>{fmtUSD(r.monto_usd)}</Td>
                        <Td align="right" mono>{r.bank_monto != null ? fmtUSD(r.bank_monto) : '—'}</Td>
                        <Td align="right" mono color={delta == null ? MUTED : delta > 0 ? GRN : delta < 0 ? RED : MUTED}>
                          {delta != null && delta !== 0 ? fmtUSDsigned(delta) : delta === 0 ? '$0.00' : '—'}
                        </Td>
                        <Td>
                          {r.bank_cuenta === 'UNKNOWN' ? <span style={{ color: AMB, fontWeight: 600 }}>⚠ {bankLabel}</span> : bankLabel}
                        </Td>
                        <Td mono small>{r.bank_referencia || '—'}</Td>
                        <Td small>{fmtDateDMY(r.creado_at)}</Td>
                        <Td small>{fmtDateDMY(r.depositado_at)}</Td>
                        <Td>
                          <button onClick={() => router.push('/tesoreria/comprobante?id=' + r.id)}
                            style={{ padding: '4px 9px', borderRadius: 4, border: '1px solid ' + NAVY, background: 'transparent', color: NAVY, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                            Ver
                          </button>
                        </Td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AdminShell>
  )
}

// ─── Small components ────────────────────────────────────────────────────────

function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderLeft: '4px solid ' + color, borderRadius: 6, padding: '14px 16px' }}>
      <div style={{ fontSize: 10, color: '#71717A', textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#71717A', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 10, color: '#71717A', textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 700 }}>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', background: '#fff' }}>
        {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </div>
  )
}

function Th({ children, align }: { children?: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return <th style={{ padding: '10px 12px', textAlign: align || 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, whiteSpace: 'nowrap' }}>{children}</th>
}

function Td({ children, align, mono, small, color }: { children?: React.ReactNode; align?: 'left' | 'right' | 'center'; mono?: boolean; small?: boolean; color?: string }) {
  return <td style={{ padding: '9px 12px', textAlign: align || 'left', fontFamily: mono ? 'monospace' : 'inherit', fontSize: small ? 11 : 12, color: color || undefined, whiteSpace: 'nowrap', fontVariantNumeric: mono ? 'tabular-nums' : 'normal' }}>{children}</td>
}

// ─── Date range bar ──────────────────────────────────────────────────────────

function DateRangeBar({ range, onChange }: { range: DateRange; onChange: (r: DateRange) => void }) {
  const presets: { key: any; label: string }[] = [
    { key: 'hoy', label: 'Hoy' },
    { key: 'semana', label: '7 días' },
    { key: 'quincena', label: 'Quincena' },
    { key: 'mes', label: 'Este mes' },
    { key: 'mes_pasado', label: 'Mes pasado' },
  ]
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderRadius: 8, padding: 12, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {presets.map(p => (
        <button key={p.key}
          onClick={() => onChange(rangeForPreset(p.key))}
          style={{
            padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            border: '1px solid ' + (range.preset === p.key ? NAVY : '#D1D5DB'),
            background: range.preset === p.key ? NAVY : 'transparent',
            color: range.preset === p.key ? '#fff' : '#52525B',
            fontFamily: 'inherit',
          }}>
          {p.label}
        </button>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
        <input type="date" value={range.from} onChange={e => onChange({ ...range, from: e.target.value, preset: 'custom' })}
          style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 12, fontFamily: 'inherit' }} />
        <span style={{ color: '#71717A', fontSize: 12 }}>→</span>
        <input type="date" value={range.to} onChange={e => onChange({ ...range, to: e.target.value, preset: 'custom' })}
          style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 12, fontFamily: 'inherit' }} />
      </div>
    </div>
  )
}