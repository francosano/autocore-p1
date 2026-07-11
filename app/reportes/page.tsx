// app/reportes/page.tsx
'use client'

import React, { useEffect, useState, useMemo, useRef, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../supabase'
import NavBar from '../components/NavBar'
import { useNPAPermissions } from '../components/useNPAPermissions'

// ═════════════════════════════════════════════════════════════════════════════
// TYPES
// ═════════════════════════════════════════════════════════════════════════════
interface Deal {
  id: string
  negocio_num: string | null
  cliente_nombre: string | null
  cliente_apellidos: string | null
  cliente_rif: string | null
  cliente_rif_tipo: string | null
  vendedor: string | null
  banco: string | null
  status: string | null
  created_at: string
  approved_at: string | null
  fecha_entrega: string | null
  nota_entrega_at: string | null
  fecha_factura: string | null
  inventory_vin: string | null
  vehiculo_marca: string | null
  vehiculo_modelo: string | null
  vehiculo_color: string | null
  vehiculo_placa: string | null
  vehiculo_año: number | null
  // Auditoría side
  au_precio: number | null
  au_gastos_admin: number | null
  au_seguro: number | null
  au_accesorios: number | null
  au_igtf: number | null
  au_placas: number | null
  au_comision_flat: number | null
  // Factura venta
  factura_venta_numero: string | null
  factura_venta_body_neto: number | null
  factura_venta_iva: number | null
  factura_venta_igtf_real: number | null
  factura_venta_placa: number | null
  factura_venta_total: number | null
  factura_venta_fecha: string | null
  // Factura compra
  factura_compra_body_neto: number | null
  factura_compra_iva: number | null
  factura_compra_igtf: number | null
  factura_compra_placa: number | null
  factura_compra_total: number | null
  factura_compra_fecha: string | null
  // Supplier paid
  seguro_pagado_supplier: number | null
  accesorios_pagado_supplier: number | null
  // Other
  total_cliente: number | null
  pagos: any[] | null
  monto_financiar: number | null
  comision_banco: number | null
  seguro_2do_ano: boolean | null
  // 2026-05-07 — locked P&L model fields
  gastos_admin_cobrado: number | null
  seguro_cobrado: number | null
  accesorios_cobrado: number | null
  pv_igtf: number | null
  comision_cobrada_cliente: number | null
  factura_venta_tasa_bcv: number | null
  factura_compra_tasa_bcv: number | null
  // Forex arbitrage hydration (joined from deal_pnl_management view)
  _forex_arbitrage_usd?: number | null
  _forex_binance_rate?: number | null
  _forex_spread_pct?: number | null
  _forex_arbitrage_venta_usd?: number | null
  _forex_arbitrage_compra_igtf_usd?: number | null
  _forex_binance_compra_rate?: number | null
  _forex_compra_spread_pct?: number | null
  _forex_is_realized?: boolean
  _seniat_due_date?: string | null
  _forex_bs_received?: number | null
  _uncovered_tax_usd?: number | null
  _tax_obligation_usd?: number | null
  _retencion_usd?: number | null
  _tax_after_retencion_usd?: number | null
  _sobrante?: number | null
  _sobrante_gross?: number | null
  // Settlement fields
  total_recibido?: number | null
  ajuste_cuadre?: number | null
  resultado_tipo?: string | null
}

interface InventoryUnit {
  vin: string
  modelo: string | null
  color: string | null
  año: number | null
  estado: string
  factura_compra_numero: string | null
  factura_compra_fecha: string | null
  costo_unidad_usd: number | null
  costo_placa_certificado_usd: number | null
  costo_total_factura_usd: number | null
  fecha_asignacion: string | null
  fecha_venta: string | null
  fecha_entrega: string | null
}

type TabId =
  | 'dashboard'
  | 'velocidad'
  | 'inventario'
  | 'pipeline'
  | 'vendedores'
  | 'utilidad'
  | 'tramites'
  | 'modelos'

type SortDir = 'asc' | 'desc'

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════
const today = new Date().toISOString().slice(0, 10)
const thisMonth = today.slice(0, 7)

const fmtUSD = (n: number | null | undefined): string => {
  if (n == null || isNaN(Number(n))) return '0'
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

const fmtUSD2 = (n: number | null | undefined): string => {
  if (n == null || isNaN(Number(n))) return '0.00'
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const fmtFecha = (d: string | null) => {
  if (!d) return '—'
  const iso = d.slice(0, 10)
  const [y, m, dd] = iso.split('-')
  return `${dd}/${m}/${y}`
}

const fmtMesLabel = (iso: string) => {
  const [y, m] = iso.split('-')
  return new Date(parseInt(y), parseInt(m) - 1, 1)
    .toLocaleDateString('es-VE', { month: 'short', year: '2-digit' })
}

const fmtMesLong = (iso: string) => {
  const [y, m] = iso.split('-')
  return new Date(parseInt(y), parseInt(m) - 1, 1)
    .toLocaleDateString('es-VE', { month: 'long', year: 'numeric' })
}

const dealLabel = (d: Deal): string => {
  const num = d.negocio_num ? `#${d.negocio_num}` : `#${d.id.slice(0, 6)}`
  const name = `${d.cliente_nombre || ''} ${d.cliente_apellidos || ''}`.trim() || 'Sin nombre'
  return `${num} — ${name}`
}

const daysBetween = (a: string, b: string): number => {
  const dA = new Date(a + 'T12:00:00Z').getTime()
  const dB = new Date(b + 'T12:00:00Z').getTime()
  return Math.round((dA - dB) / 86400000)
}

const ageBucket = (days: number): '0-30' | '31-60' | '61-90' | '90+' => {
  if (days <= 30) return '0-30'
  if (days <= 60) return '31-60'
  if (days <= 90) return '61-90'
  return '90+'
}

// ─── DEAL P&L COMPUTATION ──────────────────────────────────────────────────
// Per memory rule:
//   gross = factura_venta_body_neto − factura_compra_body_neto + au_gastos_admin
// Pass-throughs (au_seguro, au_accesorios, placa) net to zero.
// IVA + IGTF on factura = pass-through to SENIAT (final settlement model is
// blocked on tax calendar work — shown separately as "IGTF posición").
// Comisión flat is NOT in deal gross profit; lives in cobranza utilidad financiera.
interface PnL {
  hasFacturaVenta: boolean
  hasFacturaCompra: boolean
  hasGross: boolean

  // Top-line factura totals (raw)
  facturaVentaTotal: number
  facturaCompraTotal: number

  // Layer 1A — Margen Bruto Unidad
  ventaBody: number
  compraBody: number
  igtfCompra: number           // factura_compra_igtf (cost paid to KIA, non-recoverable)
  margenBrutoUnidad: number    // ventaBody − compraBody − igtfCompra

  // Layer 1B — Valores Agregados components
  gastosAdmin: number          // gastos_admin_cobrado (or au_gastos_admin fallback)
  margenSeguro: number         // seguro_cobrado − seguro_pagado_supplier
  margenAccesorios: number     // accesorios_cobrado − accesorios_pagado_supplier
  igtfMarkup: number           // pv_igtf — the double-charge markup, IS profit
  valoresAgregados: number     // sum of the above

  // Layer 1A + 1B
  gananciaOperativa: number    // margenBrutoUnidad + valoresAgregados

  // Layer 2 — Margen Financiero
  comisionCliente: number      // comision_cobrada_cliente
  comisionBanco: number        // comision_banco
  margenFinanciero: number     // comisionCliente − comisionBanco

  // Layer 0 — Sobrante (true overage, no double-count with markup)
  sobrante: number             // MAX(0, total_recibido - total_cliente - pv_igtf)
  sobranteGross: number        // total_recibido - total_cliente (raw, for diagnostic)

  // Layer 3 — Forex Arbitrage
  forexArbitrage: number       // uncovered_tax × (binance / bcv − 1)
  forexIsRealized: boolean
  forexBinanceRate: number | null
  forexSpreadPct: number | null
  forexArbitrageVenta: number   // sale-side arbitrage (uncovered tax)
  forexArbitrageCompra: number  // compra IGTF arbitrage
  forexBinanceCompra: number | null
  forexCompraSpreadPct: number | null
  taxObligationUsd: number     // GROSS: full IVA + IGTF factura
  forexBsReceived: number      // Bs CASH paid by client (Transferencia en Bolívares only)
  retencionUsd: number         // Retención paper form (NOT cash, but covers tax)
  taxAfterRetencionUsd: number // tax obligation − retención (what we still owe SENIAT)
  uncoveredTaxUsd: number      // remaining tax NOT covered by Bs cash

  // Total deal P&L
  totalDealPnl: number         // 0 + 1A + 1B + 2 + 3

  // Margen %
  margenPct: number | null     // gananciaOperativa / ventaBody

  // Legacy fields kept for back-compat with existing UI consumers
  comisionFlat: number
  seguroPosicion: number
  accesoriosPosicion: number
  profitOnCar: number
  grossOperacion: number       // alias for gananciaOperativa
}

// 2026-05-07 — locked P&L formula (see BUILD_SPEC_reportes_pnl.md)
//
// Layer 1A — Margen Bruto Unidad:
//   ventaBody − compraBody − igtfCompra
//
// Layer 1B — Valores Agregados:
//   gastosAdminCobrado
//   + (seguroCobrado − seguroPagadoSupplier)
//   + (accesoriosCobrado − accesoriosPagadoSupplier)
//   + pv_igtf  (the double-charge IGTF markup, IS profit)
//
// factura_venta_igtf_real is PASS-THROUGH to SENIAT (not in operations gross).
//
// Layer 2 — Margen Financiero:
//   comisionCobradaCliente − comisionBanco
//
// Layer 3 — Forex Arbitrage:
//   Computed in deal_pnl_management view using SENIAT due date logic.
//   Surfaced here via d._forex_arbitrage_usd (hydrated from view).

const computePnL = (d: Deal): PnL => {
  const ventaBody  = Number(d.factura_venta_body_neto || 0)
  const compraBody = Number(d.factura_compra_body_neto || 0)
  const igtfCompra = Number(d.factura_compra_igtf || 0)

  // Layer 1B components — prefer the new "cobrado" fields, fall back to au_*
  // so that deals not yet backfilled still show something reasonable.
  const gastosAdmin = Number(d.gastos_admin_cobrado ?? d.au_gastos_admin ?? 0)
  const segCobrado  = Number(d.seguro_cobrado ?? d.au_seguro ?? 0)
  const segPaid     = Number(d.seguro_pagado_supplier || 0)
  const accCobrado  = Number(d.accesorios_cobrado ?? d.au_accesorios ?? 0)
  const accPaid     = Number(d.accesorios_pagado_supplier || 0)
  const igtfMarkup  = Number(d.pv_igtf || 0)  // double-charge markup, IS profit

  const margenBrutoUnidad = ventaBody - compraBody - igtfCompra
  // 2026-05-07: seguro + accesorios margins forced to 0 until we have real
  // supplier-paid data. Otherwise cobrado − 0 inflates utilidad with phantom
  // profit. Re-enable when seguro_pagado_supplier / accesorios_pagado_supplier
  // are reliably populated.
  const margenSeguro      = 0
  const margenAccesorios  = 0
  const valoresAgregados  = gastosAdmin + margenSeguro + margenAccesorios + igtfMarkup
  const gananciaOperativa = margenBrutoUnidad + valoresAgregados

  // Layer 2
  const comisionCliente = Number(d.comision_cobrada_cliente ?? d.au_comision_flat ?? 0)
  const comisionBanco   = Number(d.comision_banco || 0)
  const margenFinanciero = comisionCliente - comisionBanco

  // Layer 3 — hydrated from deal_pnl_management view (uses NET tax obligation)
  const forexArbitrage   = Number(d._forex_arbitrage_usd || 0)
  const forexIsRealized  = Boolean(d._forex_is_realized)
  const forexBinanceRate = d._forex_binance_rate != null ? Number(d._forex_binance_rate) : null
  const forexSpreadPct   = d._forex_spread_pct != null ? Number(d._forex_spread_pct) : null
  const forexArbitrageVenta  = Number(d._forex_arbitrage_venta_usd || 0)
  const forexArbitrageCompra = Number(d._forex_arbitrage_compra_igtf_usd || 0)
  const forexBinanceCompra   = d._forex_binance_compra_rate != null ? Number(d._forex_binance_compra_rate) : null
  const forexCompraSpreadPct = d._forex_compra_spread_pct != null ? Number(d._forex_compra_spread_pct) : null
  const taxObligationUsd = Number(d._tax_obligation_usd || 0)
  const forexBsReceived  = Number(d._forex_bs_received || 0)
  const retencionUsd     = Number(d._retencion_usd || 0)
  const taxAfterRetencionUsd = Number(d._tax_after_retencion_usd || 0)
  const uncoveredTaxUsd  = Number(d._uncovered_tax_usd || 0)

  // Layer 0 — Sobrante (simple: total_cliente already includes pv_igtf)
  const sobrante      = Number(d._sobrante ?? Math.max(0, Number(d.total_recibido || 0) - Number(d.total_cliente || 0)))
  const sobranteGross = Number(d._sobrante_gross ?? (Number(d.total_recibido || 0) - Number(d.total_cliente || 0)))

  // Total deal P&L
  const totalDealPnl = sobrante + gananciaOperativa + margenFinanciero + forexArbitrage

  // Has-data flags
  const hasFacturaVenta  = d.factura_venta_body_neto != null
  const hasFacturaCompra = d.factura_compra_body_neto != null
  const hasGross         = hasFacturaVenta && hasFacturaCompra

  return {
    hasFacturaVenta,
    hasFacturaCompra,
    hasGross,

    facturaVentaTotal: Number(d.factura_venta_total || 0),
    facturaCompraTotal: Number(d.factura_compra_total || 0),

    // Layer 1A
    ventaBody,
    compraBody,
    igtfCompra,
    margenBrutoUnidad,

    // Layer 1B
    gastosAdmin,
    margenSeguro,
    margenAccesorios,
    igtfMarkup,
    valoresAgregados,

    // Layer 1A + 1B
    gananciaOperativa,

    // Layer 2
    comisionCliente,
    comisionBanco,
    margenFinanciero,

    // Layer 0 — Sobrante
    sobrante,
    sobranteGross,

    // Layer 3
    forexArbitrage,
    forexIsRealized,
    forexBinanceRate,
    forexSpreadPct,
    forexArbitrageVenta,
    forexArbitrageCompra,
    forexBinanceCompra,
    forexCompraSpreadPct,
    taxObligationUsd,
    forexBsReceived,
    retencionUsd,
    taxAfterRetencionUsd,
    uncoveredTaxUsd,

    // Total
    totalDealPnl,

    margenPct: ventaBody > 0 && hasGross ? (gananciaOperativa / ventaBody) * 100 : null,

    // Legacy fields (back-compat with existing UI consumers)
    comisionFlat: comisionCliente,
    seguroPosicion: margenSeguro,
    accesoriosPosicion: margenAccesorios,
    profitOnCar: margenBrutoUnidad,
    grossOperacion: gananciaOperativa,
  }
}

const hasPivcaPayment = (d: Deal): boolean => {
  if (!Array.isArray(d.pagos)) return false
  return d.pagos.some(p => p?.metodo === 'Liquidación PIVCA')
}

const printReport = (title: string) => {
  const el = document.getElementById('rpt')
  if (!el) return
  const w = window.open('', '_blank')
  if (!w) return
  w.document.write(`<html><head><title>${title}</title>
  <style>body{font-family:Arial,sans-serif;font-size:12px;padding:24px;max-width:1100px;margin:0 auto;background:#fff;color:#000}
  h1{font-size:18px;font-weight:800}h2{font-size:11px;color:#666;margin-bottom:20px;font-weight:normal}
  table{width:100%;border-collapse:collapse;margin:12px 0}
  th{background:#f4f4f5;padding:7px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;border-bottom:2px solid #e4e4e7;color:#000}
  td{padding:7px 10px;border-bottom:1px solid #f0f0f0;color:#000}
  @media print{body{padding:0}}</style></head><body>
  <h1>Motocentro II C.A. — ${title}</h1>
  <h2>Generado el ${new Date().toLocaleDateString('es-VE',{dateStyle:'full'})}</h2>
  ${el.innerHTML}</body></html>`)
  w.document.close()
  setTimeout(() => w.print(), 400)
}

// ═════════════════════════════════════════════════════════════════════════════
// COMPONENTS — mirror Portal /reportes patterns
// ═════════════════════════════════════════════════════════════════════════════

function KPICard({
  label, value, sub, color, icon, benchmark, benchLabel, onClick,
}: {
  label: string
  value: string
  sub?: string
  color: string
  icon: string
  benchmark?: string
  benchLabel?: string
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '16px 18px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow .15s',
      }}
      onMouseEnter={e => { if (onClick) (e.currentTarget as HTMLDivElement).style.boxShadow = '0 0 0 2px #BB162B' }}
      onMouseLeave={e => { if (onClick) (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          {label}
        </div>
        <span style={{ fontSize: 20 }}>{icon}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color, fontFamily: 'monospace', letterSpacing: '-1px', margin: '6px 0 2px' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{sub}</div>}
      {benchmark && (
        <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
          Benchmark: <strong style={{ color: 'var(--text-primary)' }}>{benchmark}</strong> — {benchLabel}
        </div>
      )}
      {onClick && <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>Clic para ver detalle →</div>}
          </div>
  )
}

function DonutChart({ pct, color, size = 96 }: { pct: number; color: string; size?: number }) {
  const r = size * 0.38
  const circ = 2 * Math.PI * r
  const dash = (Math.min(pct, 100) / 100) * circ
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={size * 0.1} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color}
        strokeWidth={size * 0.1}
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeDashoffset={circ * 0.25}
        strokeLinecap="round"
        style={{ transition: 'stroke-dasharray .8s ease' }}
      />
      <text
        x="50%" y="52%"
        dominantBaseline="middle" textAnchor="middle"
        style={{ fontSize: size * 0.19, fontWeight: 800, fill: color, fontFamily: 'monospace' }}
      >
        {pct}%
      </text>
    </svg>
  )
}

function BarChart({
  data, height = 130, onBarClick,
}: {
  data: { label: string; value: number; color: string; raw?: string }[]
  height?: number
  onBarClick?: (i: number) => void
}) {
  const max = Math.max(...data.map(d => d.value), 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: height + 28 }}>
      {data.map((d, i) => (
        <div
          key={i}
          onClick={() => onBarClick?.(i)}
          style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: 2, height: '100%', cursor: onBarClick ? 'pointer' : 'default',
          }}
          title={d.raw || `${d.label}: ${d.value}`}
        >
          <div style={{ fontSize: 10, fontWeight: 700, color: d.color, minHeight: 14 }}>
            {d.value > 999 ? `$${(d.value / 1000).toFixed(0)}k` : d.value > 0 ? (d.value <= 100 ? `${d.value}` : `$${Math.round(d.value)}`) : ''}
          </div>
          <div style={{ width: '100%', flex: 1, display: 'flex', alignItems: 'flex-end' }}>
            <div style={{
              width: '100%', height: `${Math.max((d.value / max) * 100, 2)}%`,
              background: d.color, borderRadius: '4px 4px 0 0', opacity: 0.85,
              transition: 'height .7s ease', minHeight: 3,
            }} />
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.3, height: 22 }}>
            {d.label}
          </div>
        </div>
      ))}
    </div>
  )
}

function DrillDown({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <tr>
      <td colSpan={99} style={{ padding: 0, background: 'var(--bg-deep)', borderBottom: '2px solid #BB162B' }}>
        <div style={{ padding: '14px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '.08em' }}>{title}</div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-secondary)', lineHeight: 1 }}>✕</button>
          </div>
          {children}
        </div>
      </td>
    </tr>
  )
}

function SortableDrillTable({
  rows, cols, defaultSort = 'asc',
}: {
  rows: Record<string, any>[]
  cols: { key: string; label: string; align?: 'left' | 'right' | 'center'; sortable?: boolean }[]
  defaultSort?: SortDir
}) {
  const [sortDir, setSortDir] = useState<SortDir>(defaultSort)
  const [sortKey, setSortKey] = useState<string | null>(cols.find(c => c.sortable)?.key || null)

  const sorted = sortKey
    ? [...rows].sort((a, b) => {
        const av = a[sortKey + '_raw'] ?? a[sortKey] ?? ''
        const bv = b[sortKey + '_raw'] ?? b[sortKey] ?? ''
        if (typeof av === 'number' && typeof bv === 'number') {
          return sortDir === 'asc' ? av - bv : bv - av
        }
        return sortDir === 'asc'
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av))
      })
    : rows

  if (sorted.length === 0)
    return <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>Sin datos.</div>

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr>
          {cols.map(c => (
            <th
              key={c.key}
              onClick={c.sortable ? () => {
                if (sortKey === c.key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
                else { setSortKey(c.key); setSortDir('asc') }
              } : undefined}
              style={{
                textAlign: c.align ?? 'left',
                padding: '5px 8px',
                fontSize: 10,
                fontWeight: 700,
                color: c.sortable ? '#BB162B' : 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '.06em',
                borderBottom: '1px solid var(--border)',
                cursor: c.sortable ? 'pointer' : 'default',
                userSelect: 'none',
              }}
            >
              {c.label}{c.sortable && sortKey === c.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : c.sortable ? ' ↕' : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
            {cols.map(c => (
              <td key={c.key} style={{ padding: '6px 8px', textAlign: c.align ?? 'left' }}>
                {row[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DrillTable({
  rows, cols,
}: {
  rows: Record<string, any>[]
  cols: { key: string; label: string; align?: 'left' | 'right' | 'center' }[]
}) {
  if (rows.length === 0)
    return <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>Sin datos.</div>
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr>
          {cols.map(c => (
            <th
              key={c.key}
              style={{
                textAlign: c.align ?? 'left',
                padding: '5px 8px',
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '.06em',
                borderBottom: '1px solid var(--border)',
              }}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
            {cols.map(c => (
              <td key={c.key} style={{ padding: '6px 8px', textAlign: c.align ?? 'left' }}>
                {row[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, { c: string; bg: string }> = {
    APROBADO:    { c: '#16A34A', bg: 'rgba(22,163,74,.15)' },
    BORRADOR:    { c: '#D97706', bg: 'rgba(217,119,6,.15)' },
    EN_REVISION: { c: '#2563EB', bg: 'rgba(37,99,235,.15)' },
    RECHAZADO:   { c: '#BB162B', bg: 'rgba(187,22,43,.15)' },
  }
  const s = map[status || ''] || { c: 'var(--text-secondary)', bg: 'var(--bg-deep)' }
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: s.bg, color: s.c, border: `1px solid ${s.c}40` }}>
      {status || '—'}
    </span>
  )
}

function EstadoUnidadBadge({ estado }: { estado: string | null }) {
  const map: Record<string, { c: string; bg: string }> = {
    EN_STOCK:        { c: '#2563EB', bg: 'rgba(37,99,235,.12)' },
    ASIGNADO:        { c: '#D97706', bg: 'rgba(217,119,6,.12)' },
    PENDING_FUNDING: { c: '#7C3AED', bg: 'rgba(124,58,237,.12)' },
    VENDIDO:         { c: '#0891B2', bg: 'rgba(8,145,178,.12)' },
    ENTREGADO:       { c: '#16A34A', bg: 'rgba(22,163,74,.12)' },
    VOIDED:          { c: '#6B7280', bg: 'rgba(107,114,128,.12)' },
  }
  const s = map[estado || ''] || { c: 'var(--text-secondary)', bg: 'var(--bg-deep)' }
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: s.bg, color: s.c, border: `1px solid ${s.c}40` }}>
      {estado || '—'}
    </span>
  )
}

function AgingBadge({ days }: { days: number }) {
  const bucket = ageBucket(days)
  const map: Record<string, { c: string }> = {
    '0-30':  { c: '#16A34A' },
    '31-60': { c: '#D97706' },
    '61-90': { c: '#EA580C' },
    '90+':   { c: '#BB162B' },
  }
  const s = map[bucket]
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: s.c, fontFamily: 'monospace' }}>
      {days}d <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>({bucket})</span>
    </span>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═════════════════════════════════════════════════════════════════════════════
export default function ReportesOperaciones() {
  const router = useRouter()
  const { permissions, role, loading: permsLoading, sessionError } = useNPAPermissions()
  const [showSobranteModal, setShowSobranteModal] = useState(false)

  // AI Agent state
  const [agentRun, setAgentRun] = useState<any>(null)
  const [agentLoading, setAgentLoading] = useState(false)
  const [agentExpanded, setAgentExpanded] = useState(false)
  const [agentEmailing, setAgentEmailing] = useState(false)
  const [agentEmailSent, setAgentEmailSent] = useState(false)
  const [agentMonth, setAgentMonth] = useState(new Date().getMonth() + 1)
  const [agentYear, setAgentYear] = useState(new Date().getFullYear())

  const PNL_AGENT_URL = 'https://autocore-pnl-agent.sano-franco.workers.dev'

  async function runAgent(forceRegenerate = false) {
    setAgentLoading(true)
    setAgentEmailSent(false)
    try {
      const res = await fetch(`${PNL_AGENT_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year: agentYear,
          month: agentMonth,
          force_regenerate: forceRegenerate,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setAgentRun(data.run)
        setAgentExpanded(true)
      } else {
        alert(`Error: ${data.error}`)
      }
    } catch (e: any) {
      alert(`Error contactando al agente: ${e.message}`)
    } finally {
      setAgentLoading(false)
    }
  }

  async function emailAgentReport() {
    if (!agentRun?.id) return
    setAgentEmailing(true)
    try {
      const res = await fetch(`${PNL_AGENT_URL}/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_id: agentRun.id,
          recipients: ['gerencia@motocentro2.com', 'sano.franco@gmail.com'],
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setAgentEmailSent(true)
      } else {
        alert(`Error enviando email: ${data.error}`)
      }
    } catch (e: any) {
      alert(`Error: ${e.message}`)
    } finally {
      setAgentEmailing(false)
    }
  }

  const [tab, setTab] = useState<TabId>('dashboard')
  const [deals, setDeals] = useState<Deal[]>([])
  const [units, setUnits] = useState<InventoryUnit[]>([])
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [feedRun, setFeedRun] = useState<{ running: boolean; done: number; total: number; ok: number; noFactura: number; notRec: number; err: number } | null>(null)

  // ── Filters ─────────────────────────────────────────────────────────────
  const [filterMes, setFilterMes] = useState<string>('todo') // 'todo' or 'YYYY-MM'
  const [filterVendedor, setFilterVendedor] = useState<string>('todos')
  const [filterModelo, setFilterModelo] = useState<string>('todos')
  const [filterBanco, setFilterBanco] = useState<string>('todos')

  // ── Drill state per tab ─────────────────────────────────────────────────
  const [drillDash, setDrillDash] = useState<string | null>(null)
  const [drillVeloc, setDrillVeloc] = useState<string | null>(null)
  const [drillInv, setDrillInv] = useState<string | null>(null)
  const [drillPipe, setDrillPipe] = useState<string | null>(null)
  const [drillVend, setDrillVend] = useState<string | null>(null)
  const [drillUtil, setDrillUtil] = useState<string | null>(null)
  const [drillTram, setDrillTram] = useState<string | null>(null)
  const [drillModel, setDrillModel] = useState<string | null>(null)

  // ── Permission gate (gerente/admin/manager only) ────────────────────────
  // Robust against flaky-network auth blips. The permissions hook can briefly
  // re-read user_roles/user_permissions on a mid-session token refresh; if that
  // read transiently comes back empty it falls to ALL_OFF for one render. We must
  // NOT eject on that. So redirect ONLY on a settled, genuine lack of permission:
  //   • permsLoading false (= hook 'ready', perms truly settled)
  //   • not a recoverable session error (token-refresh hiccup)
  //   • the user was never authorized this session (once granted, a blip can't kick)
  const wasAuthorizedRef = useRef(false)
  useEffect(() => {
    if (permissions.npa_can_view_management_pnl) wasAuthorizedRef.current = true
  }, [permissions])

  useEffect(() => {
    if (permsLoading) return            // not settled yet
    if (sessionError) return            // recoverable auth state — never bounce on this
    if (wasAuthorizedRef.current) return // already granted this session; ignore transient flips
    if (!permissions.npa_can_view_management_pnl) router.replace('/dashboard')
  }, [permsLoading, sessionError, permissions, router])

  // ── Load data ───────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true)
      const [dealsRes, unitsRes, pnlRes] = await Promise.all([
        supabase.from('deals').select('*').order('created_at', { ascending: false }),
        supabase.from('inventory_units').select('*'),
        // 2026-05-07: hydrate forex arbitrage from view
        supabase.from('deal_pnl_management').select('id, forex_arbitrage_usd, forex_binance_rate, forex_spread_pct, forex_arbitrage_venta_usd, forex_arbitrage_compra_igtf_usd, forex_binance_compra_rate, forex_compra_spread_pct, forex_is_realized, seniat_due_date, forex_bs_received, uncovered_tax_usd, tax_obligation_usd, retencion_usd, tax_after_retencion_usd, sobrante, sobrante_gross'),
      ])

      // Merge forex columns into deals so computePnL has them via d._forex_*
      const pnlByDealId: Record<string, any> = {}
      for (const r of (pnlRes?.data || []) as any[]) {
        if (r?.id) pnlByDealId[r.id] = r
      }
      const hydratedDeals = (dealsRes.data || []).map((d: any) => {
        const p = pnlByDealId[d.id]
        if (!p) return d
        return {
          ...d,
          _forex_arbitrage_usd: p.forex_arbitrage_usd,
          _forex_binance_rate: p.forex_binance_rate,
          _forex_spread_pct: p.forex_spread_pct,
          _forex_arbitrage_venta_usd: p.forex_arbitrage_venta_usd,
          _forex_arbitrage_compra_igtf_usd: p.forex_arbitrage_compra_igtf_usd,
          _forex_binance_compra_rate: p.forex_binance_compra_rate,
          _forex_compra_spread_pct: p.forex_compra_spread_pct,
          _forex_is_realized: p.forex_is_realized,
          _seniat_due_date: p.seniat_due_date,
          _forex_bs_received: p.forex_bs_received,
          _uncovered_tax_usd: p.uncovered_tax_usd,
          _tax_obligation_usd: p.tax_obligation_usd,
          _retencion_usd: p.retencion_usd,
          _tax_after_retencion_usd: p.tax_after_retencion_usd,
          _sobrante: p.sobrante,
          _sobrante_gross: p.sobrante_gross,
        }
      })
      setDeals(hydratedDeals as Deal[])
      setUnits((unitsRes.data || []) as InventoryUnit[])
      setLoading(false)
    }
    if (!permsLoading && permissions.npa_can_view_management_pnl) load()
  }, [permsLoading, permissions, reloadKey])

  // ── Filter options (computed from data) ─────────────────────────────────
  const vendedores = useMemo(() => {
    const set = new Set<string>()
    deals.forEach(d => { if (d.vendedor) set.add(d.vendedor) })
    return Array.from(set).sort()
  }, [deals])

  const modelos = useMemo(() => {
    const set = new Set<string>()
    units.forEach(u => { if (u.modelo) set.add(u.modelo) })
    deals.forEach(d => { if (d.vehiculo_modelo) set.add(d.vehiculo_modelo) })
    return Array.from(set).sort()
  }, [units, deals])

  const bancos = useMemo(() => {
    const set = new Set<string>()
    deals.forEach(d => { if (d.banco) set.add(d.banco) })
    return Array.from(set).sort()
  }, [deals])

  // ── Apply filters ───────────────────────────────────────────────────────
  const filteredDeals = useMemo(() => {
    return deals.filter(d => {
      if (filterMes !== 'todo') {
        // Sales are attributed to the FACTURA DE VENTA date (not delivery).
        // A car facturado May 30 but delivered Jun 1 belongs to May.
        // Fall back to entrega/approved/created only when no factura date exists.
        const dateStr = d.factura_venta_fecha || d.fecha_entrega || d.approved_at?.slice(0, 10) || d.created_at.slice(0, 10)
        if (!dateStr.startsWith(filterMes)) return false
      }
      if (filterVendedor !== 'todos' && d.vendedor !== filterVendedor) return false
      if (filterBanco !== 'todos' && d.banco !== filterBanco) return false
      if (filterModelo !== 'todos') {
        const linkedUnit = units.find(u => u.vin === d.inventory_vin)
        const modelo = linkedUnit?.modelo || d.vehiculo_modelo
        if (modelo !== filterModelo) return false
      }
      return true
    })
  }, [deals, units, filterMes, filterVendedor, filterModelo, filterBanco])

  // Inventory respects only the modelo filter (banco/vendedor don't apply)
  const filteredUnits = useMemo(() => {
    return units.filter(u => {
      if (filterModelo !== 'todos' && u.modelo !== filterModelo) return false
      return true
    })
  }, [units, filterModelo])

  // ── Alimentar reportes con IA: read each deal's ALREADY-ATTACHED factura from
  //    storage and write the venta P&L columns. One-time catch-up for deals created
  //    before the scan auto-saved these fields. Reuses the same scan:'auto' extractor
  //    the auditoría scan uses, so body_neto is defined identically. No upload needed.
  // Sign a comprobantes path via the docsign worker (server-side service-role),
  // with a browser-signing fallback guarded by a timeout. Same contract as auditoría's
  // signDoc. Fetching bytes through this signed URL keeps the feeder off the browser
  // Supabase storage client, which hangs on token refresh on slow VE connections.
  async function signDocPath(path: string): Promise<string | null> {
    try {
      const r = await fetch(`https://autocore-docsign.sano-franco.workers.dev/?path=${encodeURIComponent(path)}`)
      if (r.ok) { const j = await r.json(); if (j?.signedUrl) return j.signedUrl as string }
    } catch { /* fall through to client signing */ }
    try {
      const signP = supabase.storage.from('comprobantes').createSignedUrl(path, 3600)
      const toP = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
      const res = await Promise.race([signP, toP]) as { data?: { signedUrl?: string } }
      return res?.data?.signedUrl || null
    } catch { return null }
  }

  async function feedOneDealFromFactura(deal: any): Promise<'ok' | 'no_factura' | 'not_recognized' | 'error'> {
    try {
      let facturaPath: string | null = deal?.documentos_meta?.factura?.path || null
      if (!facturaPath && deal?.negocio_num) {
        // .list() also goes through the browser storage client — race it against a
        // timeout so a token-refresh hang can't freeze the whole bulk run.
        const listP = supabase.storage.from('comprobantes').list(`deals/${deal.negocio_num}`, { limit: 50 })
        const listTo = new Promise<{ data: any[] | null }>(resolve => setTimeout(() => resolve({ data: null }), 8000))
        const { data: files } = await Promise.race([listP, listTo]) as { data: any[] | null }
        const match = files?.find((f: any) => f.name.toLowerCase().startsWith('factura'))
        if (match) facturaPath = `deals/${deal.negocio_num}/${match.name}`
      }
      if (!facturaPath) return 'no_factura'

      // Fetch factura bytes via a server-signed URL (docsign worker) instead of
      // supabase.storage.download(), which hangs on token refresh — the exact bug
      // that froze this feeder at 0/N. Plain fetch on the signed URL never touches
      // the hanging client. 20s abort so a stuck download can't freeze the run.
      const signed = await signDocPath(facturaPath)
      if (!signed) return 'error'
      let blob: Blob
      {
        const dlCtrl = new AbortController()
        const dlTimer = setTimeout(() => dlCtrl.abort(), 20000)
        try {
          const dlRes = await fetch(signed, { signal: dlCtrl.signal })
          if (!dlRes.ok) return 'error'
          blob = await dlRes.blob()
        } catch { return 'error' } finally { clearTimeout(dlTimer) }
      }

      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(((r.result as string) || '').split(',')[1] || '')
        r.onerror = () => reject(r.error)
        r.readAsDataURL(blob)
      })
      const isPdf = facturaPath.toLowerCase().endsWith('.pdf') || blob.type === 'application/pdf'

      // Worker scan with a 45s abort so one slow Sonnet read can't freeze the run.
      let json: any = null
      {
        const scanCtrl = new AbortController()
        const scanTimer = setTimeout(() => scanCtrl.abort(), 45000)
        try {
          const res = await fetch('https://autocore-comprobante.sano-franco.workers.dev', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            signal: scanCtrl.signal,
            body: JSON.stringify({ scan: 'auto', base64: b64, mediaType: isPdf ? 'application/pdf' : (blob.type || 'image/jpeg'), isPdf }),
          })
          json = await res.json().catch(() => null)
        } catch { return 'error' } finally { clearTimeout(scanTimer) }
      }

      const docs = Array.isArray(json?.documents) ? json.documents : []
      const venta = docs.find((dc: any) => dc?.type === 'factura_venta')?.extracted || null
      if (!venta) return 'not_recognized'

      const patch: Record<string, any> = {}
      const setIf = (k: string) => { const v = venta[k]; if (v !== null && v !== undefined && v !== '') patch[k] = v }
      setIf('factura_venta_numero'); setIf('factura_venta_control')
      setIf('factura_venta_body_neto'); setIf('factura_venta_iva')
      setIf('factura_venta_igtf_real'); setIf('factura_venta_tasa_bcv')
      setIf('factura_venta_placa'); setIf('factura_venta_total'); setIf('factura_venta_modo_igtf')
      if (Object.keys(patch).length === 0) return 'not_recognized'

      const { error: upErr } = await supabase.from('deals').update(patch).eq('id', deal.id)
      if (upErr) return 'error'
      return 'ok'
    } catch { return 'error' }
  }

  async function runBulkFeed() {
    // Only deals in the current filter that are MISSING venta data (so we never
    // re-read a deal that already has its numbers — no wasted AI calls).
    const candidates = filteredDeals.filter(d => d.factura_venta_body_neto == null)
    if (candidates.length === 0) {
      alert('No hay negocios pendientes de datos de venta en el filtro actual.')
      return
    }
    if (!window.confirm(`Se leerán con IA las facturas adjuntas de ${candidates.length} negocio(s) que aún no tienen datos de venta. ¿Continuar?`)) return

    let ok = 0, noFactura = 0, notRec = 0, err = 0
    setFeedRun({ running: true, done: 0, total: candidates.length, ok, noFactura, notRec, err })
    for (let i = 0; i < candidates.length; i++) {
      const r = await feedOneDealFromFactura(candidates[i])
      if (r === 'ok') ok++
      else if (r === 'no_factura') noFactura++
      else if (r === 'not_recognized') notRec++
      else err++
      setFeedRun({ running: true, done: i + 1, total: candidates.length, ok, noFactura, notRec, err })
    }
    setFeedRun({ running: false, done: candidates.length, total: candidates.length, ok, noFactura, notRec, err })
    if (ok > 0) setReloadKey(k => k + 1)   // refresh the table only if something changed
  }


  // ── Computed metrics ────────────────────────────────────────────────────

  // Status distribution
  const dealsByStatus = useMemo(() => {
    const out: Record<string, number> = {}
    filteredDeals.forEach(d => {
      const s = d.status || 'OTRO'
      out[s] = (out[s] || 0) + 1
    })
    return out
  }, [filteredDeals])

  const dealsAprobados = filteredDeals.filter(d => d.status === 'APROBADO')
  const dealsEntregados = filteredDeals.filter(d => d.fecha_entrega != null)
  const dealsBorrador = filteredDeals.filter(d => d.status === 'BORRADOR')

  // Volumen (factura_venta_total when present, falls back to total_cliente)
  const volumenUSD = filteredDeals.reduce(
    (s, d) => s + Number(d.factura_venta_total || d.total_cliente || 0),
    0,
  )

  // Aggregate P&L (only deals with full facturas)
  const pnlTotals = useMemo(() => {
    let ventaBody = 0, compraBody = 0, gastosAdmin = 0, profitOnCar = 0, gross = 0
    let segPos = 0, accPos = 0, comisionFlat = 0
    let sobranteNet = 0, sobranteCount = 0, faltanteCount = 0
    let forexArbitrage = 0
    let countWithGross = 0, countWithFacturaVenta = 0, countWithFacturaCompra = 0

    filteredDeals.forEach(d => {
      const p = computePnL(d)
      if (p.hasFacturaVenta) countWithFacturaVenta++
      if (p.hasFacturaCompra) countWithFacturaCompra++
      if (p.hasGross) {
        countWithGross++
        ventaBody += p.ventaBody
        compraBody += p.compraBody
        gastosAdmin += p.gastosAdmin
        profitOnCar += p.profitOnCar
        gross += p.grossOperacion
        segPos += p.seguroPosicion
        accPos += p.accesoriosPosicion
        comisionFlat += p.comisionFlat
        forexArbitrage += p.forexArbitrage
      }
      // Sobrante / faltante metrics — count for ALL filtered deals
      const recibido = Number(d.total_recibido || 0)
      const cliente  = Number(d.total_cliente || 0)
      const net = recibido - cliente
      if (net > 0.5) {
        sobranteNet += net
        sobranteCount++
      } else if (net < -0.5) {
        sobranteNet += net  // negative value = faltante reduces net
        faltanteCount++
      }
    })

    return {
      countWithGross, countWithFacturaVenta, countWithFacturaCompra,
      ventaBody, compraBody, gastosAdmin, profitOnCar, gross,
      segPos, accPos, comisionFlat,
      sobranteNet, sobranteCount, faltanteCount,
      forexArbitrage,
      margenAvg: ventaBody > 0 ? (gross / ventaBody) * 100 : 0,
    }
  }, [filteredDeals])

  // Inventory aging (only EN_STOCK matter for aging — assigned units have moved on)
  const inventoryAging = useMemo(() => {
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }
    let capitalAmarrado = 0
    const stockUnits = filteredUnits.filter(u => u.estado === 'EN_STOCK')
    stockUnits.forEach(u => {
      const fc = u.factura_compra_fecha
      if (fc) {
        const days = daysBetween(today, fc)
        buckets[ageBucket(days)]++
      }
      capitalAmarrado += Number(u.costo_unidad_usd || 0)
    })
    return { buckets, capitalAmarrado, stockUnits }
  }, [filteredUnits])

  // Pipeline metrics
  const pipeline = useMemo(() => {
    let diasBorradorAprobado = 0
    let diasAprobadoEntrega = 0
    let nClosed = 0, nDelivered = 0
    filteredDeals.forEach(d => {
      if (d.approved_at && d.created_at) {
        const days = daysBetween(d.approved_at.slice(0, 10), d.created_at.slice(0, 10))
        diasBorradorAprobado += days
        nClosed++
      }
      if (d.fecha_entrega && d.approved_at) {
        const days = daysBetween(d.fecha_entrega, d.approved_at.slice(0, 10))
        diasAprobadoEntrega += days
        nDelivered++
      }
    })
    return {
      avgDiasCierre: nClosed > 0 ? Math.round(diasBorradorAprobado / nClosed) : 0,
      avgDiasEntrega: nDelivered > 0 ? Math.round(diasAprobadoEntrega / nDelivered) : 0,
    }
  }, [filteredDeals])

  // Vendedor performance
  const vendedorStats = useMemo(() => {
    const map: Record<string, {
      vendedor: string
      total: number
      aprobados: number
      entregados: number
      borrador: number
      volumen: number
      utilidad: number
      utilidadCount: number
      bancoMix: Record<string, number>
      diasCierreSum: number
      diasCierreN: number
    }> = {}
    filteredDeals.forEach(d => {
      const v = d.vendedor || 'Sin asignar'
      if (!map[v]) {
        map[v] = {
          vendedor: v, total: 0, aprobados: 0, entregados: 0, borrador: 0,
          volumen: 0, utilidad: 0, utilidadCount: 0,
          bancoMix: {}, diasCierreSum: 0, diasCierreN: 0,
        }
      }
      map[v].total++
      if (d.status === 'APROBADO') map[v].aprobados++
      if (d.fecha_entrega) map[v].entregados++
      if (d.status === 'BORRADOR') map[v].borrador++
      map[v].volumen += Number(d.factura_venta_total || d.total_cliente || 0)
      const p = computePnL(d)
      if (p.hasGross) {
        map[v].utilidad += p.grossOperacion
        map[v].utilidadCount++
      }
      const banco = d.banco || 'Sin banco'
      map[v].bancoMix[banco] = (map[v].bancoMix[banco] || 0) + 1
      if (d.approved_at && d.created_at) {
        map[v].diasCierreSum += daysBetween(d.approved_at.slice(0, 10), d.created_at.slice(0, 10))
        map[v].diasCierreN++
      }
    })
    return Object.values(map).sort((a, b) => b.total - a.total)
  }, [filteredDeals])

  // Modelo performance
  const modeloStats = useMemo(() => {
    const map: Record<string, {
      modelo: string
      vendidos: number
      enStock: number
      volumen: number
      utilidad: number
      utilidadCount: number
      diasStockSum: number
      diasStockN: number
    }> = {}
    filteredDeals.forEach(d => {
      const linkedUnit = units.find(u => u.vin === d.inventory_vin)
      const modelo = linkedUnit?.modelo || d.vehiculo_modelo || 'Sin modelo'
      if (!map[modelo]) {
        map[modelo] = {
          modelo, vendidos: 0, enStock: 0, volumen: 0,
          utilidad: 0, utilidadCount: 0, diasStockSum: 0, diasStockN: 0,
        }
      }
      map[modelo].vendidos++
      map[modelo].volumen += Number(d.factura_venta_total || d.total_cliente || 0)
      const p = computePnL(d)
      if (p.hasGross) {
        map[modelo].utilidad += p.grossOperacion
        map[modelo].utilidadCount++
      }
    })
    units.forEach(u => {
      if (u.estado === 'EN_STOCK') {
        const m = u.modelo || 'Sin modelo'
        if (!map[m]) {
          map[m] = {
            modelo: m, vendidos: 0, enStock: 0, volumen: 0,
            utilidad: 0, utilidadCount: 0, diasStockSum: 0, diasStockN: 0,
          }
        }
        map[m].enStock++
        if (u.factura_compra_fecha) {
          const days = daysBetween(today, u.factura_compra_fecha)
          map[m].diasStockSum += days
          map[m].diasStockN++
        }
      }
    })
    return Object.values(map).sort((a, b) => b.vendidos - a.vendidos)
  }, [filteredDeals, units])

  // Compliance / Trámites
  const tramites = useMemo(() => {
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const sevenDaysAgoIso = sevenDaysAgo.toISOString().slice(0, 10)
    const sinNotaEntrega: Deal[] = []
    const sinPlaca: Deal[] = []
    const sinPolizaSegundoAno: Deal[] = []
    filteredDeals.forEach(d => {
      if (d.status === 'APROBADO' && !d.nota_entrega_at &&
          d.approved_at && d.approved_at.slice(0, 10) <= sevenDaysAgoIso) {
        sinNotaEntrega.push(d)
      }
      if (d.fecha_entrega && (!d.vehiculo_placa || d.vehiculo_placa.trim() === '')) {
        sinPlaca.push(d)
      }
      if (d.banco === 'FINANCIAMIENTO INTERNO' && d.fecha_entrega && !d.seguro_2do_ano) {
        sinPolizaSegundoAno.push(d)
      }
    })
    return { sinNotaEntrega, sinPlaca, sinPolizaSegundoAno }
  }, [filteredDeals])

  // Monthly velocity (last 6 months)
  const monthlyVelocity = useMemo(() => {
    const out: { mes: string; label: string; unidades: number; volumen: number; utilidad: number; deals: Deal[] }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date()
      d.setDate(1)
      d.setMonth(d.getMonth() - i)
      const m = d.toISOString().slice(0, 7)
      const monthDeals = filteredDeals.filter(x => (x.factura_venta_fecha || x.fecha_entrega)?.startsWith(m))
      const vol = monthDeals.reduce((s, x) => s + Number(x.factura_venta_total || x.total_cliente || 0), 0)
      const util = monthDeals.reduce((s, x) => {
        const p = computePnL(x)
        return s + (p.hasGross ? p.grossOperacion : 0)
      }, 0)
      out.push({
        mes: m, label: fmtMesLabel(m),
        unidades: monthDeals.length,
        volumen: vol, utilidad: util,
        deals: monthDeals,
      })
    }
    return out
  }, [filteredDeals])

  // ── Tabs definition ─────────────────────────────────────────────────────
  const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: 'dashboard',  label: 'Dashboard',          icon: '◈' },
    { id: 'velocidad',  label: 'Velocidad de Ventas', icon: '📈' },
    { id: 'inventario', label: 'Inventario',         icon: '📦' },
    { id: 'pipeline',   label: 'Pipeline',           icon: '🔀' },
    { id: 'vendedores', label: 'Vendedores',         icon: '👥' },
    { id: 'utilidad',   label: 'Utilidad por Negocio', icon: '💰' },
    { id: 'tramites',   label: 'Trámites',           icon: '📋' },
    { id: 'modelos',    label: 'Modelos',            icon: '🚗' },
  ]
  const activeLabel = TABS.find(t => t.id === tab)?.label || 'Reporte'

  // ── Helpers ─────────────────────────────────────────────────────────────
  const card = (extra?: React.CSSProperties): React.CSSProperties => ({
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '18px 20px',
    ...extra,
  })
  const sec = (t: string) => (
    <div style={{
      fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)',
      textTransform: 'uppercase' as const, letterSpacing: '.1em', marginBottom: 12,
    }}>{t}</div>
  )
  const clickableRow: React.CSSProperties = { cursor: 'pointer' }
  const rowHover = (e: React.MouseEvent<HTMLTableRowElement>, enter: boolean) => {
    (e.currentTarget as HTMLTableRowElement).style.background = enter ? 'var(--bg-deep)' : ''
  }

  // ── Reusable: drill-row builder for any list of deals ───────────────────

  // (B) Datos faltantes — three-dot icon row showing what factura state a deal is in.
  // Green = saved, grey ring = missing. Hover/title gives the full label.
  const DocsBadge = ({ d }: { d: Deal }) => {
    const hasCedula = !!d.cliente_rif
    const hasVenta = d.factura_venta_body_neto != null
    const hasCompra = d.factura_compra_body_neto != null
    const Dot = ({ ok, label }: { ok: boolean; label: string }) => (
      <span
        title={`${label}: ${ok ? 'guardada' : 'falta'}`}
        style={{
          display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
          background: ok ? '#16A34A' : 'transparent',
          border: ok ? '1px solid #16A34A' : '1px solid var(--text-secondary)',
          opacity: ok ? 1 : 0.5,
        }}
      />
    )
    return (
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <Dot ok={hasCedula} label="Cédula" />
        <Dot ok={hasVenta}  label="Factura venta" />
        <Dot ok={hasCompra} label="Factura compra" />
      </span>
    )
  }

  // (A) Smart Utilidad cell — distinguishes which side of the data is missing.
  // - both facturas         → green/red dollar (real gross)
  // - only compra (cost)    → amber: "Costo $X · falta venta"
  // - only venta (sale)     → amber: "Venta $X · falta costo"
  // - neither               → grey: "sin facturas"
  // Sort key (utilidad_raw) ranks: complete profit > complete loss > partial > none
  const utilidadCell = (d: Deal, p: PnL): { node: React.ReactNode; raw: number } => {
    if (p.hasGross) {
      return {
        node: <strong style={{ color: p.grossOperacion >= 0 ? '#16A34A' : '#BB162B' }}>
          ${fmtUSD(p.grossOperacion)}
        </strong>,
        raw: p.grossOperacion,
      }
    }
    if (p.hasFacturaCompra) {
      return {
        node: <span style={{ color: '#D97706', fontSize: 10, lineHeight: 1.3 }}>
          <div>Costo: <strong style={{ fontFamily: 'monospace' }}>${fmtUSD(p.compraBody)}</strong></div>
          <div style={{ opacity: 0.8 }}>falta factura venta</div>
        </span>,
        raw: -1e8,  // sort below complete losses
      }
    }
    if (p.hasFacturaVenta) {
      return {
        node: <span style={{ color: '#D97706', fontSize: 10, lineHeight: 1.3 }}>
          <div>Venta: <strong style={{ fontFamily: 'monospace' }}>${fmtUSD(p.ventaBody)}</strong></div>
          <div style={{ opacity: 0.8 }}>falta factura compra</div>
        </span>,
        raw: -1.5e8,  // sort just below "compra only"
      }
    }
    return {
      node: <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>sin facturas</span>,
      raw: -2e8,  // sort last
    }
  }

  const buildDealRows = (list: Deal[]) => list.map(d => {
    const p = computePnL(d)
    const linkedUnit = units.find(u => u.vin === d.inventory_vin)
    const u = utilidadCell(d, p)
    return {
      negocio: <strong>#{d.negocio_num || d.id.slice(0, 6)}</strong>,
      negocio_raw: d.negocio_num || d.id,
      cliente: <span><strong>{d.cliente_nombre || '—'}</strong> {d.cliente_apellidos || ''}</span>,
      cliente_raw: d.cliente_nombre || '',
      vendedor: <span style={{ color: 'var(--text-secondary)' }}>{d.vendedor || '—'}</span>,
      modelo: <span style={{ color: 'var(--text-secondary)' }}>{linkedUnit?.modelo || d.vehiculo_modelo || '—'}</span>,
      banco: <span style={{ fontSize: 11 }}>{d.banco || '—'}</span>,
      status: <StatusBadge status={d.status} />,
      datos: <DocsBadge d={d} />,
      entrega: d.fecha_entrega ? fmtFecha(d.fecha_entrega) : <span style={{ color: 'var(--text-secondary)' }}>—</span>,
      entrega_raw: d.fecha_entrega || '',
      volumen: <strong style={{ color: '#2563EB' }}>${fmtUSD(d.factura_venta_total || d.total_cliente)}</strong>,
      volumen_raw: Number(d.factura_venta_total || d.total_cliente || 0),
      utilidad: u.node,
      utilidad_raw: u.raw,
    }
  })

  const DEAL_COLS = [
    { key: 'negocio',  label: 'Negocio', sortable: true },
    { key: 'cliente',  label: 'Cliente', sortable: true },
    { key: 'vendedor', label: 'Vendedor' },
    { key: 'modelo',   label: 'Modelo' },
    { key: 'banco',    label: 'Banco' },
    { key: 'status',   label: 'Estado' },
    { key: 'datos',    label: 'Datos', align: 'center' as const },
    { key: 'entrega',  label: 'Entrega', sortable: true },
    { key: 'volumen',  label: 'Volumen', align: 'right' as const, sortable: true },
    { key: 'utilidad', label: 'Utilidad', align: 'right' as const, sortable: true },
  ]

  // ─── Per-deal P&L card (used in DrillDown of Utilidad tab) ───────────────
  const PnLCard = ({ d }: { d: Deal }) => {
    const p = computePnL(d)
    const Row = ({ label, value, color, sub, strong }: {
      label: string; value: string; color?: string; sub?: string; strong?: boolean
    }) => (
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '8px 0', borderBottom: '1px solid var(--border)',
      }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-primary)', fontWeight: strong ? 700 : 400 }}>{label}</div>
          {sub && <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{sub}</div>}
        </div>
        <div style={{
          fontSize: strong ? 14 : 12,
          fontWeight: strong ? 800 : 600,
          color: color || 'var(--text-primary)',
          fontFamily: 'monospace',
        }}>
          {value}
        </div>
      </div>
    )

    if (!p.hasFacturaVenta && !p.hasFacturaCompra) {
      return (
        <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-secondary)' }}>
          Este negocio aún no tiene facturas registradas.
          <br />
          <span style={{ fontSize: 11 }}>
            Sube las facturas en <strong>Reportes → Backfill</strong> para calcular la utilidad.
          </span>
        </div>
      )
    }

    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        {/* LEFT: Venta side */}
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: '#16A34A',
            textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8,
          }}>📋 Factura de Venta</div>
          {p.hasFacturaVenta ? (
            <>
              <Row label="Body Neto" value={`$${fmtUSD2(p.ventaBody)}`} color="#16A34A" />
              <Row label="IVA" value={`$${fmtUSD2(d.factura_venta_iva)}`} sub="pass-through SENIAT" />
              <Row label="IGTF cobrado" value={`$${fmtUSD2(d.factura_venta_igtf_real)}`} sub="pass-through" />
              <Row label="Placa" value={`$${fmtUSD2(d.factura_venta_placa)}`} sub="pass-through" />
              <Row label="TOTAL FACTURA" value={`$${fmtUSD2(p.facturaVentaTotal)}`} strong color="#2563EB" />
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 6 }}>
                F#{d.factura_venta_numero || '—'} · {fmtFecha(d.factura_venta_fecha)}
              </div>
            </>
          ) : (
            <div style={{ padding: 10, fontSize: 11, color: 'var(--text-secondary)' }}>Sin factura de venta cargada.</div>
          )}
        </div>

        {/* RIGHT: Compra side */}
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: '#7C3AED',
            textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8,
          }}>🧾 Factura de Compra (KIA)</div>
          {p.hasFacturaCompra ? (
            <>
              <Row label="Body Neto" value={`$${fmtUSD2(p.compraBody)}`} color="#7C3AED" />
              <Row label="IVA" value={`$${fmtUSD2(d.factura_compra_iva)}`} sub="75% retenido SENIAT" />
              <Row label="IGTF pagado" value={`$${fmtUSD2(d.factura_compra_igtf)}`} />
              <Row label="Placa" value={`$${fmtUSD2(d.factura_compra_placa)}`} />
              <Row label="TOTAL COMPRA" value={`$${fmtUSD2(p.facturaCompraTotal)}`} strong color="#BB162B" />
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 6 }}>
                {fmtFecha(d.factura_compra_fecha)}
              </div>
            </>
          ) : (
            <div style={{ padding: 10, fontSize: 11, color: 'var(--text-secondary)' }}>Sin factura de compra cargada.</div>
          )}
        </div>

        {/* FULL WIDTH: Auditoría components */}
        <div style={{ gridColumn: '1 / -1', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: '#D97706',
            textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8,
          }}>🧮 Cuadre de Auditoría</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <Row label="Gastos Admin (cobrado)" value={`$${fmtUSD2(p.gastosAdmin)}`} color="#16A34A" sub="utilidad operacional" />
              <Row label="Comisión flat" value={`$${fmtUSD2(p.comisionFlat)}`} sub="va a cobranza, no a este P&L" />
              <Row label="Seguro posición" value={`$${fmtUSD2(p.seguroPosicion)}`} color={Math.abs(p.seguroPosicion) > 1 ? '#D97706' : '#16A34A'} sub="cobrado − pagado a proveedor" />
              <Row label="Accesorios posición" value={`$${fmtUSD2(p.accesoriosPosicion)}`} color={Math.abs(p.accesoriosPosicion) > 1 ? '#D97706' : '#16A34A'} sub="cobrado − pagado a proveedor" />
            </div>
            <div>

              <Row label="Banco" value={d.banco || '—'} sub={hasPivcaPayment(d) ? 'PIVCA liquidado' : ''} />
              <Row label="Inventory VIN" value={d.inventory_vin || '—'} />
              <Row label="Status" value={d.status || '—'} />
            </div>
          </div>
        </div>

        {/* FULL WIDTH: Utilidad bottom */}
        <div style={{ gridColumn: '1 / -1', background: 'var(--bg-deep)', border: '1px solid #BB162B40', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: '#BB162B',
            textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 10,
          }}>💰 Utilidad del Negocio</div>
          {p.hasGross ? (
            <>
              {/* Layer 1A — Margen Bruto Unidad */}
              <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px dashed var(--border)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#7C3AED', textTransform: 'uppercase' as const, letterSpacing: '.08em', marginBottom: 4 }}>
                  📋 Layer 1A — Margen Bruto Unidad
                </div>
                <Row label="+ Body venta" value={`$${fmtUSD2(p.ventaBody)}`} color="#16A34A" />
                <Row label="− Body compra" value={`-$${fmtUSD2(p.compraBody)}`} color="#BB162B" />
                <Row label="− IGTF compra" value={`-$${fmtUSD2(p.igtfCompra)}`} color="#BB162B" sub="cost paid to KIA, non-recoverable" />
                <Row label="Margen Bruto Unidad" value={`$${fmtUSD2(p.margenBrutoUnidad)}`} strong color="#7C3AED" />
              </div>

              {/* Layer 1B — Valores Agregados */}
              <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px dashed var(--border)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#0EA5E9', textTransform: 'uppercase' as const, letterSpacing: '.08em', marginBottom: 4 }}>
                  💼 Layer 1B — Valores Agregados
                </div>
                <Row label="+ Gastos Admin (cobrado)" value={`$${fmtUSD2(p.gastosAdmin)}`} color="#16A34A" />
                <Row label="+ Margen Seguro" value="$0.00" color="var(--text-secondary)" sub="sin datos de proveedor — descontado" />
                <Row label="+ Margen Accesorios" value="$0.00" color="var(--text-secondary)" sub="sin datos de proveedor — descontado" />
                <Row label="+ IGTF Markup (doble cobro)" value={`$${fmtUSD2(p.igtfMarkup)}`} color="#16A34A" sub="pv_igtf — cobrado al margen, ingreso" />
                <Row label="Valores Agregados" value={`$${fmtUSD2(p.valoresAgregados)}`} strong color="#0EA5E9" />
              </div>

              {/* Total Operativo */}
              <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #16A34A40', background: 'rgba(22,163,74,0.05)', padding: '8px 10px', borderRadius: 6 }}>
                <Row label="► GANANCIA OPERATIVA (1A + 1B)" value={`$${fmtUSD2(p.gananciaOperativa)}`} strong color="#16A34A" />
                {p.margenPct != null && (
                  <Row label="Margen sobre venta body" value={`${p.margenPct.toFixed(1)}%`} color={p.margenPct >= 12 ? '#16A34A' : p.margenPct >= 8 ? '#D97706' : '#BB162B'} />
                )}
              </div>

              {/* Layer 2 — Margen Financiero */}
              {(p.comisionCliente > 0 || p.comisionBanco > 0) && (
                <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px dashed var(--border)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#D97706', textTransform: 'uppercase' as const, letterSpacing: '.08em', marginBottom: 4 }}>
                    💰 Layer 2 — Margen Financiero
                  </div>
                  <Row label="+ Comisión flat cobrada" value={`$${fmtUSD2(p.comisionCliente)}`} color="#16A34A" sub={d.banco === 'PIVCA' ? 'cobrado al cliente' : 'NPA-INTERNO: profit completo'} />
                  {p.comisionBanco > 0 && (
                    <Row label="− Comisión banco PIVCA" value={`-$${fmtUSD2(p.comisionBanco)}`} color="#BB162B" sub="descontado del wire" />
                  )}
                  <Row label="Margen Financiero" value={`$${fmtUSD2(p.margenFinanciero)}`} strong color={p.margenFinanciero >= 0 ? '#16A34A' : '#BB162B'} />
                </div>
              )}

              {/* Layer 3 — Forex Arbitrage (NET tax obligation, with Bs offset) */}
              {p.taxObligationUsd > 0 && (
                <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px dashed var(--border)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#0891B2', textTransform: 'uppercase' as const, letterSpacing: '.08em', marginBottom: 4 }}>
                    💱 Layer 3 — Forex Arbitrage {p.forexIsRealized ? '(realizada)' : '(estimada)'}
                  </div>
                  <Row label="Tax obligation (gross)" value={`$${fmtUSD2(p.taxObligationUsd)}`} sub="IVA + IGTF factura" />
                  {p.retencionUsd > 0 && (
                    <Row label="− Retención (forma papel)" value={`-$${fmtUSD2(p.retencionUsd)}`} sub="ya pagado a SENIAT" color="#16A34A" />
                  )}
                  <Row label="− Bs cash recibido" value={`-$${fmtUSD2(p.forexBsReceived)}`} sub="solo transferencia en bolívares" color="#16A34A" />
                  <Row label="Tax sin cubrir (a comprar Bs)" value={`$${fmtUSD2(p.uncoveredTaxUsd)}`} strong color={p.uncoveredTaxUsd > 0 ? '#0891B2' : 'var(--text-secondary)'} />
                  {p.uncoveredTaxUsd > 0 && (
                    <>
                      <Row label="BCV factura" value={d.factura_venta_tasa_bcv ? d.factura_venta_tasa_bcv.toFixed(4) : '—'} />
                      <Row label="Binance @ SENIAT−1" value={p.forexBinanceRate ? p.forexBinanceRate.toFixed(4) : '—'} sub={d._seniat_due_date ? `due ${fmtFecha(d._seniat_due_date)}` : 'esperando rate'} />
                      <Row label="Spread" value={p.forexSpreadPct != null ? `${(p.forexSpreadPct * 100).toFixed(1)}%` : '—'} color={p.forexSpreadPct && p.forexSpreadPct > 0 ? '#16A34A' : 'var(--text-secondary)'} />
                    </>
                  )}
                  <Row label="Arbitraje venta (SENIAT)" value={`$${fmtUSD2(p.forexArbitrageVenta)}`} strong color={p.forexArbitrageVenta > 0 ? '#16A34A' : 'var(--text-secondary)'} sub={p.uncoveredTaxUsd === 0 ? 'Bs recibidos cubrieron impuestos' : ''} />
                  {p.igtfCompra > 0 && (
                    <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dotted var(--border)' }}>
                      <Row label="IGTF compra (nominal 3%)" value={`-$${fmtUSD2(p.igtfCompra)}`} sub="costo Bs @ BCV compra, ya restado en utilidad" color="#BB162B" />
                      <Row label="BCV compra" value={d.factura_compra_tasa_bcv ? d.factura_compra_tasa_bcv.toFixed(4) : '—'} />
                      <Row label="Binance @ fecha compra" value={p.forexBinanceCompra ? p.forexBinanceCompra.toFixed(4) : '—'} />
                      <Row label="Spread compra" value={p.forexCompraSpreadPct != null ? `${(p.forexCompraSpreadPct * 100).toFixed(1)}%` : '—'} color={p.forexCompraSpreadPct && p.forexCompraSpreadPct > 0 ? '#16A34A' : 'var(--text-secondary)'} />
                      <Row label="Arbitraje IGTF compra" value={`$${fmtUSD2(p.forexArbitrageCompra)}`} strong color={p.forexArbitrageCompra > 0 ? '#16A34A' : 'var(--text-secondary)'} sub="Bs comprados al binance" />
                    </div>
                  )}
                  <Row label="Forex Arbitrage TOTAL" value={`$${fmtUSD2(p.forexArbitrage)}`} strong color={p.forexArbitrage > 0 ? '#16A34A' : 'var(--text-secondary)'} sub="venta + compra" />
                </div>
              )}

              {/* Bs + Retención reconciliation diagnostic */}
              {p.taxObligationUsd > 0 && (p.forexBsReceived > 0 || p.retencionUsd > 0) && (
                <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px dashed var(--border)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#0EA5E9', textTransform: 'uppercase' as const, letterSpacing: '.08em', marginBottom: 4 }}>
                    🇻🇪 Verificación cobertura impuestos (IVA + IGTF factura)
                  </div>
                  <Row label="Tax obligation total" value={`$${fmtUSD2(p.taxObligationUsd)}`} sub="a remitir a SENIAT en Bs" />
                  {p.retencionUsd > 0 && (
                    <Row label="− Retención (forma papel)" value={`-$${fmtUSD2(p.retencionUsd)}`}
                      sub="contribuyente especial — ya pagado a SENIAT vía forma" color="#16A34A" />
                  )}
                  <Row label="= Restante a cubrir" value={`$${fmtUSD2(p.taxAfterRetencionUsd)}`} strong />
                  {p.forexBsReceived > 0 && (
                    <Row label="− Bs cash recibido" value={`-$${fmtUSD2(p.forexBsReceived)}`}
                      sub="transferencia en bolívares (cash en banco)" color="#16A34A" />
                  )}
                  <Row label="Diferencia (uncovered)" value={`$${fmtUSD2(p.uncoveredTaxUsd)}`}
                    color={p.uncoveredTaxUsd < 50 ? '#16A34A' : '#D97706'}
                    sub={p.uncoveredTaxUsd < 50 ? 'cuadra (impuestos cubiertos)' : 'comprar Bs en Binance para diferencia'} />
                </div>
              )}

              {/* Layer 0 — Sobrante */}
              {(p.sobrante > 0 || p.sobranteGross !== 0) && (
                <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px dashed var(--border)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#D97706', textTransform: 'uppercase' as const, letterSpacing: '.08em', marginBottom: 4 }}>
                    💵 Layer 0 — Sobrante
                  </div>
                  <Row label="Total recibido" value={`$${fmtUSD2(d.total_recibido)}`} sub="suma de todos los pagos" />
                  <Row label="− Total cliente (audit)" value={`-$${fmtUSD2(d.total_cliente)}`} sub="factura + admin + servicios + IGTF markup ya incluido" />
                  <Row label="Sobrante neto" value={`$${fmtUSD2(p.sobrante)}`} strong color={p.sobrante > 0 ? '#16A34A' : 'var(--text-secondary)'} sub="genuine excess paid by client" />
                </div>
              )}

              {/* Total */}
              <div style={{ background: '#BB162B', color: '#fff', padding: '10px 14px', borderRadius: 8, marginTop: 8 }}>
                <Row label="TOTAL P&L DEL NEGOCIO" value={`$${fmtUSD2(p.totalDealPnl)}`} strong color="#fff" />
                <div style={{ fontSize: 10, opacity: 0.85, marginTop: 4, fontStyle: 'italic' }}>
                  Layer 0 (sobrante) + 1A + 1B + 2 + 3. IVA/IGTF factura pass-through excluidos.
                </div>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: '#D97706', padding: 8 }}>
              ⚠ Faltan facturas para calcular utilidad bruta. Sube las facturas faltantes en Backfill.
            </div>
          )}
        </div>
      </div>
    )
  }

  // ════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════
  if (loading || permsLoading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg-page)' }}>
        <NavBar />
        <div style={{ padding: 80, textAlign: 'center', color: 'var(--text-secondary)' }}>
          Cargando reportes...
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-page)' }}>
      <NavBar />
      <main style={{ padding: '28px 32px', maxWidth: 1380, margin: '0 auto' }}>
        {/* ── Header ────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 4 }}>
              Análisis · AutoCore NPA · Motocentro II
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
              Reportes Operacionales
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => router.push('/reportes/backfill')}
              style={{
                fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--bg-card)',
                color: 'var(--text-secondary)', cursor: 'pointer',
              }}
            >
              📤 Backfill Documentos
            </button>
            <button
              onClick={() => printReport(activeLabel)}
              style={{
                fontSize: 12, fontWeight: 600, padding: '8px 16px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--bg-card)',
                color: 'var(--text-secondary)', cursor: 'pointer',
              }}
            >
              🖨 Imprimir
            </button>
          </div>
        </div>

        {/* ── Filter bar ────────────────────────────────────────────── */}
        <div style={{
          ...card(), padding: '12px 14px', marginBottom: 16,
          display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
            Filtros:
          </span>
          <select value={filterMes} onChange={e => setFilterMes(e.target.value)} style={selectStyle}>
            <option value="todo">Todo el período</option>
            {Array.from({ length: 12 }, (_, i) => {
              const d = new Date()
              d.setDate(1)
              d.setMonth(d.getMonth() - i)
              const m = d.toISOString().slice(0, 7)
              return <option key={m} value={m}>{fmtMesLong(m)}</option>
            })}
          </select>
          <select value={filterVendedor} onChange={e => setFilterVendedor(e.target.value)} style={selectStyle}>
            <option value="todos">Todos los vendedores</option>
            {vendedores.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={filterModelo} onChange={e => setFilterModelo(e.target.value)} style={selectStyle}>
            <option value="todos">Todos los modelos</option>
            {modelos.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={filterBanco} onChange={e => setFilterBanco(e.target.value)} style={selectStyle}>
            <option value="todos">Todos los bancos</option>
            {bancos.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{filteredDeals.length}</strong> negocios ·
            <strong style={{ color: 'var(--text-primary)', marginLeft: 6 }}>{filteredUnits.length}</strong> unidades
          </span>
        </div>

        {/* ── Tabs ──────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', gap: 3, marginBottom: 24, padding: 3, width: 'fit-content',
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
          flexWrap: 'wrap',
        }}>
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontSize: 12, fontWeight: 600, transition: 'all .15s',
                background: tab === t.id ? '#BB162B' : 'transparent',
                color: tab === t.id ? '#fff' : 'var(--text-secondary)',
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        <div id="rpt">
        {/* ════════════════════ DASHBOARD ════════════════════ */}
        {tab === 'dashboard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
              <KPICard label="Negocios totales" value={String(filteredDeals.length)}
                sub={`${dealsAprobados.length} aprobados · ${dealsBorrador.length} en borrador`}
                color="var(--text-primary)" icon="📑"
                onClick={() => setDrillDash(drillDash === 'all' ? null : 'all')}
              />
              <KPICard label="Volumen USD" value={`$${fmtUSD(volumenUSD)}`}
                sub={`promedio $${fmtUSD(filteredDeals.length > 0 ? volumenUSD / filteredDeals.length : 0)}/negocio`}
                color="#2563EB" icon="💵" />
              <KPICard label="Utilidad bruta" value={`$${fmtUSD(pnlTotals.gross)}`}
                sub={`${pnlTotals.countWithGross}/${filteredDeals.length} con factura completa · margen ${pnlTotals.margenAvg.toFixed(1)}%`}
                color="#16A34A" icon="💰"
                onClick={() => setTab('utilidad')} />
              <KPICard label="Entregados" value={String(dealsEntregados.length)}
                sub={`${filteredDeals.length > 0 ? Math.round(dealsEntregados.length / filteredDeals.length * 100) : 0}% del total`}
                color="#7C3AED" icon="🚗" />
            </div>

            {drillDash === 'all' && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '10px 16px', background: 'var(--bg-deep)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '.07em' }}>
                    Todos los negocios filtrados ({filteredDeals.length})
                  </span>
                  <button onClick={() => setDrillDash(null)} style={closeBtnStyle}>✕</button>
                </div>
                <SortableDrillTable cols={DEAL_COLS} rows={buildDealRows(filteredDeals)} />
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
              <div style={card()}>
                {sec('Distribución por Estado')}
                <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                  <DonutChart
                    pct={filteredDeals.length > 0 ? Math.round((dealsAprobados.length / filteredDeals.length) * 100) : 0}
                    color="#16A34A" size={96}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11 }}>
                    {Object.entries(dealsByStatus).map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <StatusBadge status={k} />
                        <strong>{v}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div style={card()}>
                {sec('Unidades / Mes — clic barra')}
                <BarChart
                  height={110}
                  data={monthlyVelocity.map(m => ({ label: m.label, value: m.unidades, color: '#2563EB' }))}
                  onBarClick={i => {
                    setTab('velocidad')
                    setDrillVeloc(monthlyVelocity[i].mes)
                  }}
                />
              </div>
              <div style={card()}>
                {sec('Volumen $ / Mes')}
                <BarChart
                  height={110}
                  data={monthlyVelocity.map(m => ({ label: m.label, value: m.volumen, color: '#7C3AED' }))}
                />
              </div>
            </div>

            {/* Mini leaderboards */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={card()}>
                {sec('Top Vendedores')}
                <DrillTable
                  cols={[
                    { key: 'vendedor', label: 'Vendedor' },
                    { key: 'deals', label: 'Negocios', align: 'right' },
                    { key: 'volumen', label: 'Volumen', align: 'right' },
                  ]}
                  rows={vendedorStats.slice(0, 5).map(v => ({
                    vendedor: <strong>{v.vendedor}</strong>,
                    deals: <strong>{v.total}</strong>,
                    volumen: <strong style={{ color: '#2563EB' }}>${fmtUSD(v.volumen)}</strong>,
                  }))}
                />
              </div>
              <div style={card()}>
                {sec('Top Modelos')}
                <DrillTable
                  cols={[
                    { key: 'modelo', label: 'Modelo' },
                    { key: 'vendidos', label: 'Vendidos', align: 'right' },
                    { key: 'stock', label: 'En Stock', align: 'right' },
                  ]}
                  rows={modeloStats.slice(0, 5).map(m => ({
                    modelo: <strong>{m.modelo}</strong>,
                    vendidos: <strong>{m.vendidos}</strong>,
                    stock: <span style={{ color: 'var(--text-secondary)' }}>{m.enStock}</span>,
                  }))}
                />
              </div>
            </div>
          </div>
        )}

        {/* ════════════════════ VELOCIDAD ════════════════════ */}
        {tab === 'velocidad' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
              <KPICard label="Total 6m" value={String(monthlyVelocity.reduce((s, m) => s + m.unidades, 0))}
                sub="unidades entregadas" color="#2563EB" icon="📈" />
              <KPICard label="Mejor mes" value={String(Math.max(...monthlyVelocity.map(m => m.unidades)))}
                sub="unidades / mes pico" color="#16A34A" icon="🏆" />
              <KPICard label="Promedio mensual"
                value={(monthlyVelocity.reduce((s, m) => s + m.unidades, 0) / 6).toFixed(1)}
                sub="unidades / mes" color="#7C3AED" icon="📊" />
            </div>

            <div style={card()}>
              {sec('Unidades Entregadas — Últimos 6 Meses · clic en una fila')}
              <BarChart
                height={150}
                data={monthlyVelocity.map(m => ({ label: m.label, value: m.unidades, color: '#2563EB' }))}
                onBarClick={i => setDrillVeloc(drillVeloc === monthlyVelocity[i].mes ? null : monthlyVelocity[i].mes)}
              />
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Mes</th>
                    <th style={thStyle}>Unidades</th>
                    <th style={thStyleRight}>Volumen</th>
                    <th style={thStyleRight}>Utilidad</th>
                    <th style={thStyleRight}>Margen</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyVelocity.map(m => {
                    const open = drillVeloc === m.mes
                    const margen = m.volumen > 0 ? (m.utilidad / m.volumen) * 100 : 0
                    return (
                      <Fragment key={m.mes}>
                        <tr
                          style={{ ...clickableRow, background: open ? 'var(--bg-deep)' : undefined }}
                          onClick={() => setDrillVeloc(open ? null : m.mes)}
                          onMouseEnter={e => rowHover(e, true)}
                          onMouseLeave={e => rowHover(e, false)}
                        >
                          <td style={tdStyle}><strong>{fmtMesLong(m.mes)}</strong></td>
                          <td style={tdStyle}>{m.unidades}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#2563EB', fontWeight: 700 }}>${fmtUSD(m.volumen)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#16A34A', fontWeight: 700 }}>${fmtUSD(m.utilidad)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{margen.toFixed(1)}%</td>
                          <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontSize: 11 }}>{open ? '▲ ocultar' : '▼ ver detalle'}</td>
                        </tr>
                        {open && (
                          <DrillDown title={`Negocios entregados en ${fmtMesLong(m.mes)}`} onClose={() => setDrillVeloc(null)}>
                            <SortableDrillTable cols={DEAL_COLS} rows={buildDealRows(m.deals)} />
                          </DrillDown>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {/* By banco */}
              <div style={card()}>
                {sec('Por Banco / Tipo de Financiamiento')}
                {(() => {
                  const map: Record<string, { count: number; vol: number }> = {}
                  filteredDeals.forEach(d => {
                    const b = d.banco || 'Sin banco'
                    if (!map[b]) map[b] = { count: 0, vol: 0 }
                    map[b].count++
                    map[b].vol += Number(d.factura_venta_total || d.total_cliente || 0)
                  })
                  return (
                    <DrillTable
                      cols={[
                        { key: 'banco', label: 'Banco' },
                        { key: 'count', label: 'Negocios', align: 'right' },
                        { key: 'vol', label: 'Volumen', align: 'right' },
                      ]}
                      rows={Object.entries(map).sort((a, b) => b[1].count - a[1].count).map(([k, v]) => ({
                        banco: <strong>{k}</strong>,
                        count: <strong>{v.count}</strong>,
                        vol: <strong style={{ color: '#2563EB' }}>${fmtUSD(v.vol)}</strong>,
                      }))}
                    />
                  )
                })()}
              </div>
              {/* By cliente_rif_tipo */}
              <div style={card()}>
                {sec('Persona Natural vs Jurídica')}
                {(() => {
                  const map: Record<string, { count: number; vol: number }> = {}
                  filteredDeals.forEach(d => {
                    const t = d.cliente_rif_tipo === 'V' ? 'Natural (V)'
                            : d.cliente_rif_tipo === 'J' ? 'Jurídica (J)'
                            : d.cliente_rif_tipo === 'E' ? 'Extranjero (E)'
                            : 'Sin clasificar'
                    if (!map[t]) map[t] = { count: 0, vol: 0 }
                    map[t].count++
                    map[t].vol += Number(d.factura_venta_total || d.total_cliente || 0)
                  })
                  return (
                    <DrillTable
                      cols={[
                        { key: 'tipo', label: 'Tipo' },
                        { key: 'count', label: 'Negocios', align: 'right' },
                        { key: 'vol', label: 'Volumen', align: 'right' },
                      ]}
                      rows={Object.entries(map).sort((a, b) => b[1].count - a[1].count).map(([k, v]) => ({
                        tipo: <strong>{k}</strong>,
                        count: <strong>{v.count}</strong>,
                        vol: <strong style={{ color: '#2563EB' }}>${fmtUSD(v.vol)}</strong>,
                      }))}
                    />
                  )
                })()}
              </div>
            </div>
          </div>
        )}

        {/* ════════════════════ INVENTARIO ════════════════════ */}
        {tab === 'inventario' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
              <KPICard label="En stock" value={String(inventoryAging.stockUnits.length)}
                sub="unidades disponibles" color="#2563EB" icon="📦" />
              <KPICard label="Capital amarrado" value={`$${fmtUSD(inventoryAging.capitalAmarrado)}`}
                sub="costo total en stock" color="#7C3AED" icon="💼" />
              <KPICard label="Asignados / Vendidos" value={String(filteredUnits.filter(u => ['ASIGNADO', 'PENDING_FUNDING', 'VENDIDO'].includes(u.estado)).length)}
                sub="esperando entrega" color="#D97706" icon="⏳" />
              <KPICard label="Entregados" value={String(filteredUnits.filter(u => u.estado === 'ENTREGADO').length)}
                sub="ciclo cerrado" color="#16A34A" icon="🚗" />
            </div>

            <div style={card()}>
              {sec('Aging — Stock por edad')}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 12 }}>
                {(['0-30', '31-60', '61-90', '90+'] as const).map(b => (
                  <div key={b} style={{
                    padding: '14px 16px', borderRadius: 8,
                    background: b === '0-30' ? 'rgba(22,163,74,.08)'
                              : b === '31-60' ? 'rgba(217,119,6,.08)'
                              : b === '61-90' ? 'rgba(234,88,12,.08)'
                              : 'rgba(187,22,43,.08)',
                    border: '1px solid var(--border)', textAlign: 'center',
                  }}>
                    <div style={{
                      fontSize: 22, fontWeight: 800, fontFamily: 'monospace',
                      color: b === '0-30' ? '#16A34A' : b === '31-60' ? '#D97706' : b === '61-90' ? '#EA580C' : '#BB162B',
                    }}>
                      {inventoryAging.buckets[b]}
                    </div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                      {b} días
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 8 }}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>VIN</th>
                      <th style={thStyle}>Modelo</th>
                      <th style={thStyle}>Color</th>
                      <th style={thStyle}>Factura</th>
                      <th style={thStyle}>Edad</th>
                      <th style={thStyleRight}>Costo</th>
                      <th style={thStyle}>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...filteredUnits]
                      .sort((a, b) => {
                        const ad = a.factura_compra_fecha ? daysBetween(today, a.factura_compra_fecha) : 0
                        const bd = b.factura_compra_fecha ? daysBetween(today, b.factura_compra_fecha) : 0
                        return bd - ad
                      })
                      .map(u => {
                        const days = u.factura_compra_fecha ? daysBetween(today, u.factura_compra_fecha) : 0
                        return (
                          <tr key={u.vin} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 11 }}>…{u.vin.slice(-8)}</td>
                            <td style={{ ...tdStyle, fontWeight: 600 }}>{u.modelo || '—'}</td>
                            <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{u.color || '—'}</td>
                            <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontSize: 11 }}>
                              {u.factura_compra_numero || '—'}<br />
                              <span style={{ fontSize: 10 }}>{fmtFecha(u.factura_compra_fecha)}</span>
                            </td>
                            <td style={tdStyle}><AgingBadge days={days} /></td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace' }}>${fmtUSD(u.costo_unidad_usd)}</td>
                            <td style={tdStyle}><EstadoUnidadBadge estado={u.estado} /></td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ════════════════════ PIPELINE ════════════════════ */}
        {tab === 'pipeline' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
              <KPICard label="Borrador" value={String(dealsBorrador.length)} sub="esperando aprobación" color="#D97706" icon="📝" />
              <KPICard label="Aprobados" value={String(dealsAprobados.length)} sub="cerrados" color="#16A34A" icon="✅" />
              <KPICard label="Entregados" value={String(dealsEntregados.length)} sub="ciclo completo" color="#7C3AED" icon="🚗" />
              <KPICard label="PIVCA pendientes" value={String(filteredUnits.filter(u => u.estado === 'PENDING_FUNDING').length)} sub="esperando bank funding" color="#7C3AED" icon="🏦" />
            </div>

            <div style={card()}>
              {sec('Funnel — días promedio en cada etapa')}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12 }}>
                <div style={{ padding: '14px 18px', background: 'var(--bg-deep)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>BORRADOR → APROBADO</div>
                  <div style={{ fontSize: 26, fontWeight: 800, fontFamily: 'monospace', color: '#D97706', marginTop: 4 }}>
                    {pipeline.avgDiasCierre}d
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>tiempo promedio de cierre</div>
                </div>
                <div style={{ padding: '14px 18px', background: 'var(--bg-deep)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>APROBADO → ENTREGA</div>
                  <div style={{ fontSize: 26, fontWeight: 800, fontFamily: 'monospace', color: '#7C3AED', marginTop: 4 }}>
                    {pipeline.avgDiasEntrega}d
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>tiempo promedio de entrega</div>
                </div>
              </div>
            </div>

            {/* PENDING_FUNDING aging */}
            {filteredUnits.filter(u => u.estado === 'PENDING_FUNDING').length > 0 && (
              <div style={card()}>
                {sec('PENDING_FUNDING — Esperando liquidación PIVCA')}
                <DrillTable
                  cols={[
                    { key: 'vin', label: 'VIN' },
                    { key: 'modelo', label: 'Modelo' },
                    { key: 'asignado', label: 'Asignado' },
                    { key: 'edad', label: 'Días esperando' },
                    { key: 'costo', label: 'Costo', align: 'right' },
                  ]}
                  rows={filteredUnits.filter(u => u.estado === 'PENDING_FUNDING').map(u => ({
                    vin: <span style={{ fontFamily: 'monospace', fontSize: 11 }}>…{u.vin.slice(-8)}</span>,
                    modelo: <strong>{u.modelo || '—'}</strong>,
                    asignado: fmtFecha(u.fecha_asignacion),
                    edad: u.fecha_asignacion ? <AgingBadge days={daysBetween(today, u.fecha_asignacion)} /> : '—',
                    costo: <strong>${fmtUSD(u.costo_unidad_usd)}</strong>,
                  }))}
                />
              </div>
            )}

            {/* Deals BORRADOR */}
            <div style={card()}>
              {sec('Negocios en BORRADOR — pendientes de auditoría/aprobación')}
              <SortableDrillTable cols={DEAL_COLS} rows={buildDealRows(dealsBorrador)} />
            </div>
          </div>
        )}

        {/* ════════════════════ VENDEDORES ════════════════════ */}
        {tab === 'vendedores' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
              <KPICard label="Vendedores activos" value={String(vendedorStats.length)} sub="con al menos 1 negocio" color="var(--text-primary)" icon="👥" />
              <KPICard label="Top vendedor" value={vendedorStats[0]?.vendedor || '—'} sub={`${vendedorStats[0]?.total || 0} negocios`} color="#16A34A" icon="🏆" />
              <KPICard label="Total volumen" value={`$${fmtUSD(vendedorStats.reduce((s, v) => s + v.volumen, 0))}`} sub="combinado" color="#2563EB" icon="💵" />
              <KPICard label="Días cierre prom." value={`${pipeline.avgDiasCierre}d`} sub="negocios cerrados" color="#7C3AED" icon="⏱" />
            </div>

            <div style={card()}>
              {sec('Leaderboard de Vendedores · clic para ver sus negocios')}
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Vendedor</th>
                    <th style={thStyleRight}>Negocios</th>
                    <th style={thStyleRight}>Aprobados</th>
                    <th style={thStyleRight}>Entregados</th>
                    <th style={thStyleRight}>Volumen</th>
                    <th style={thStyleRight}>Utilidad</th>
                    <th style={thStyleRight}>Días cierre</th>
                    <th style={thStyle}>Mix bancos</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {vendedorStats.map(v => {
                    const open = drillVend === v.vendedor
                    const vendedorDeals = filteredDeals.filter(d => (d.vendedor || 'Sin asignar') === v.vendedor)
                    const mix = Object.entries(v.bancoMix).map(([k, n]) => `${k}: ${n}`).join(' · ')
                    return (
                      <Fragment key={v.vendedor}>
                        <tr
                          style={{ ...clickableRow, background: open ? 'var(--bg-deep)' : undefined }}
                          onClick={() => setDrillVend(open ? null : v.vendedor)}
                          onMouseEnter={e => rowHover(e, true)}
                          onMouseLeave={e => rowHover(e, false)}
                        >
                          <td style={{ ...tdStyle, fontWeight: 700 }}>{v.vendedor}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{v.total}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#16A34A' }}>{v.aprobados}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#7C3AED' }}>{v.entregados}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#2563EB', fontWeight: 700 }}>${fmtUSD(v.volumen)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#16A34A', fontWeight: 700 }}>
                            {v.utilidadCount > 0 ? `$${fmtUSD(v.utilidad)}` : <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>—</span>}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>
                            {v.diasCierreN > 0 ? `${Math.round(v.diasCierreSum / v.diasCierreN)}d` : '—'}
                          </td>
                          <td style={{ ...tdStyle, fontSize: 10, color: 'var(--text-secondary)' }}>{mix}</td>
                          <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontSize: 11 }}>{open ? '▲' : '▼'}</td>
                        </tr>
                        {open && (
                          <DrillDown title={`Negocios de ${v.vendedor}`} onClose={() => setDrillVend(null)}>
                            <SortableDrillTable cols={DEAL_COLS} rows={buildDealRows(vendedorDeals)} />
                          </DrillDown>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ════════════════════ UTILIDAD POR NEGOCIO ════════════════════ */}
        {tab === 'utilidad' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Alimentar reportes con IA — reads attached facturas for deals missing venta data */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: '#2ecc8a' }}>📊 ALIMENTAR REPORTES CON IA</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
                  Lee la factura ya adjunta de los negocios del filtro actual que aún no tienen datos de venta y completa sus columnas de P&amp;L. No re-lee negocios ya alimentados.
                </div>
              </div>
              <button
                disabled={feedRun?.running}
                onClick={() => runBulkFeed()}
                style={{ padding: '10px 16px', fontSize: 12, fontWeight: 700, borderRadius: 8, border: '1px solid rgba(46,204,138,0.45)', background: feedRun?.running ? 'rgba(46,204,138,0.05)' : 'rgba(46,204,138,0.12)', color: '#2ecc8a', cursor: feedRun?.running ? 'wait' : 'pointer', whiteSpace: 'nowrap' as const }}>
                {feedRun?.running ? `Leyendo ${feedRun.done}/${feedRun.total}…` : 'Alimentar pendientes'}
              </button>
            </div>
            {feedRun && !feedRun.running && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: -8, lineHeight: 1.6 }}>
                Listo: <strong style={{ color: '#2ecc8a' }}>{feedRun.ok} alimentado(s)</strong>
                {feedRun.noFactura > 0 && <> · {feedRun.noFactura} sin factura adjunta</>}
                {feedRun.notRec > 0 && <> · {feedRun.notRec} no reconocido(s)</>}
                {feedRun.err > 0 && <> · <span style={{ color: '#BB162B' }}>{feedRun.err} con error</span></>}
              </div>
            )}

            {/* AI Agent panel */}
            <div style={{
              background: 'linear-gradient(135deg, #0D2257 0%, #1B4AAA 100%)',
              color: '#fff', borderRadius: 12, padding: 16,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', opacity: 0.85 }}>
                    🤖 ANÁLISIS IA DEL PERÍODO
                  </div>
                  <div style={{ fontSize: 14, marginTop: 4 }}>
                    Generado por Claude Sonnet 4.5 — revisa anomalías, detecta patrones y sugiere acciones
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <select value={agentMonth} onChange={e => setAgentMonth(Number(e.target.value))}
                    style={{
                      padding: '6px 10px', borderRadius: 6, border: '1px solid #E5E7EB', fontSize: 13,
                      background: '#ffffff', color: '#0F172A', fontWeight: 500, cursor: 'pointer',
                      minWidth: 80,
                    }}>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                      <option key={m} value={m}>
                        {['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][m-1]}
                      </option>
                    ))}
                  </select>
                  <select value={agentYear} onChange={e => setAgentYear(Number(e.target.value))}
                    style={{
                      padding: '6px 10px', borderRadius: 6, border: '1px solid #E5E7EB', fontSize: 13,
                      background: '#ffffff', color: '#0F172A', fontWeight: 500, cursor: 'pointer',
                      minWidth: 80,
                    }}>
                    {[2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                  <button onClick={() => runAgent(false)} disabled={agentLoading}
                    style={{
                      background: '#C49A2A', color: '#000', border: 'none', borderRadius: 6,
                      padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: agentLoading ? 'wait' : 'pointer',
                      opacity: agentLoading ? 0.6 : 1,
                      boxShadow: '0 2px 8px rgba(196, 154, 42, 0.3)',
                    }}>
                    {agentLoading ? 'Analizando…' : 'Analizar período'}
                  </button>
                </div>
              </div>

              {agentRun && (
                <div style={{ marginTop: 16, background: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      Análisis del {['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][agentRun.periodo_month-1]} {agentRun.periodo_year}
                      {' · generado '}{new Date(agentRun.generated_at).toLocaleString('es-VE')}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setAgentExpanded(!agentExpanded)}
                        style={{ background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.3)',
                          borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
                        {agentExpanded ? 'Colapsar' : 'Expandir'}
                      </button>
                      <button onClick={() => runAgent(true)} disabled={agentLoading}
                        style={{ background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.3)',
                          borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
                        🔄 Regenerar
                      </button>
                      <button onClick={emailAgentReport} disabled={agentEmailing || agentEmailSent}
                        style={{ background: agentEmailSent ? '#16A34A' : 'transparent', color: '#fff',
                          border: '1px solid rgba(255,255,255,0.3)',
                          borderRadius: 6, padding: '4px 10px', fontSize: 12,
                          cursor: agentEmailing ? 'wait' : 'pointer' }}>
                        {agentEmailSent ? '✓ Enviado' : (agentEmailing ? 'Enviando…' : '✉ Email')}
                      </button>
                    </div>
                  </div>

                  {agentExpanded && (
                    <div style={{ background: '#fff', color: '#000', borderRadius: 6, padding: 16, fontSize: 13, lineHeight: 1.6 }}>
                      <h4 style={{ margin: '0 0 8px 0', color: '#0D2257' }}>Resumen ejecutivo</h4>
                      <div style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>{agentRun.executive_summary}</div>

                      {agentRun.findings && agentRun.findings.length > 0 && (
                        <>
                          <h4 style={{ margin: '12px 0 8px 0', color: '#0D2257' }}>Hallazgos</h4>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                              <tr style={{ background: '#F5ECC8' }}>
                                <th style={{ padding: '6px 8px', textAlign: 'left', border: '1px solid #ddd' }}>Negocio</th>
                                <th style={{ padding: '6px 8px', textAlign: 'left', border: '1px solid #ddd' }}>Cliente</th>
                                <th style={{ padding: '6px 8px', textAlign: 'left', border: '1px solid #ddd' }}>Hallazgo</th>
                                <th style={{ padding: '6px 8px', textAlign: 'left', border: '1px solid #ddd' }}>Sugerencia</th>
                                <th style={{ padding: '6px 8px', textAlign: 'left', border: '1px solid #ddd' }}>Severidad</th>
                              </tr>
                            </thead>
                            <tbody>
                              {agentRun.findings.map((f: any, i: number) => (
                                <tr key={i}>
                                  <td style={{ padding: '6px 8px', border: '1px solid #ddd', fontWeight: 600 }}>#{f.negocio_num}</td>
                                  <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{f.cliente}</td>
                                  <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{f.hallazgo}</td>
                                  <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{f.sugerencia}</td>
                                  <td style={{ padding: '6px 8px', border: '1px solid #ddd',
                                    color: f.severidad === 'alta' ? '#BB162B' : f.severidad === 'media' ? '#D97706' : '#16A34A',
                                    fontWeight: 600, textTransform: 'capitalize' as const }}>{f.severidad}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </>
                      )}

                      {agentRun.patterns && (
                        <>
                          <h4 style={{ margin: '12px 0 8px 0', color: '#0D2257' }}>Patrones del período</h4>
                          <div style={{ whiteSpace: 'pre-wrap' }}>{agentRun.patterns}</div>
                        </>
                      )}

                      {agentRun.recommendations && (
                        <>
                          <h4 style={{ margin: '12px 0 8px 0', color: '#0D2257' }}>Recomendaciones</h4>
                          <div style={{ whiteSpace: 'pre-wrap' }}>{agentRun.recommendations}</div>
                        </>
                      )}

                      <div style={{ marginTop: 12, fontSize: 10, color: '#888' }}>
                        Tokens: {agentRun.input_token_count}↗ {agentRun.output_token_count}↙
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
              <KPICard label="Negocios c/ facturas" value={String(pnlTotals.countWithGross)}
                sub={`${pnlTotals.countWithFacturaVenta} venta · ${pnlTotals.countWithFacturaCompra} compra`}
                color="var(--text-primary)" icon="📋" />
              <KPICard label="Utilidad bruta" value={`$${fmtUSD(pnlTotals.gross)}`}
                sub={`profit on car $${fmtUSD(pnlTotals.profitOnCar)} + gastos admin $${fmtUSD(pnlTotals.gastosAdmin)}`}
                color="#16A34A" icon="💰" />
              <KPICard label="Margen promedio" value={`${pnlTotals.margenAvg.toFixed(1)}%`}
                sub="utilidad / volumen body" color="#2563EB" icon="📊" />
              <div onClick={() => setShowSobranteModal(true)} style={{ cursor: 'pointer' }}>
                <KPICard label="Sobrantes / Faltantes" value={`$${fmtUSD(pnlTotals.sobranteNet)}`}
                  sub={`${pnlTotals.sobranteCount} sobrantes · ${pnlTotals.faltanteCount} faltantes · clic para detalle`}
                  color={pnlTotals.sobranteNet >= 0 ? '#16A34A' : '#BB162B'} icon="💵" />
              </div>
            </div>

            <div style={card()}>
              {sec('Pendiente del modelo fiscal')}
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                La utilidad mostrada es <strong style={{ color: 'var(--text-primary)' }}>bruta operacional</strong> (body venta − body compra + gastos admin).
                <br />
                Pass-throughs (seguro, accesorios, placa) excluidos. IVA/IGTF van a SENIAT — el settlement de impuestos
                (calendario 10-15 / 25-30, retención 75% IVA, conversión Binance) se finalizará cuando confirmemos
                timing y subamos el calendario SENIAT 2026.
              </div>
            </div>

            <div style={card()}>
              {sec('Detalle por Negocio · clic para ver P&L completo')}
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Negocio</th>
                    <th style={thStyle}>Cliente</th>
                    <th style={thStyle}>Vendedor</th>
                    <th style={thStyle}>Modelo</th>
                    <th style={thStyle}>Banco</th>
                    <th style={{ ...thStyle, textAlign: 'center' }}>Datos</th>
                    <th style={thStyleRight}>Venta Body</th>
                    <th style={thStyleRight}>Compra Body</th>
                    <th style={thStyleRight}>+ Gastos Adm</th>
                    <th style={thStyleRight}>Utilidad</th>
                    <th style={thStyleRight}>Forex</th>
                    <th style={thStyleRight}>Total</th>
                    <th style={thStyleRight}>Margen</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {[...filteredDeals]
                    .map(d => ({ d, p: computePnL(d) }))
                    // Sort: complete profit (high to low) → complete loss → partials → nothing
                    .sort((a, b) => {
                      const score = (x: { p: PnL }) => {
                        if (x.p.hasGross) return x.p.grossOperacion           // any number
                        if (x.p.hasFacturaCompra) return -1e8                 // costo only
                        if (x.p.hasFacturaVenta) return -1.5e8                // venta only
                        return -2e8
                      }
                      return score(b) - score(a)
                    })
                    .map(({ d, p }) => {
                      const open = drillUtil === d.id
                      const linkedUnit = units.find(u => u.vin === d.inventory_vin)
                      const u = utilidadCell(d, p)
                      return (
                        <Fragment key={d.id}>
                          <tr
                            style={{ ...clickableRow, background: open ? 'var(--bg-deep)' : undefined }}
                            onClick={() => setDrillUtil(open ? null : d.id)}
                            onMouseEnter={e => rowHover(e, true)}
                            onMouseLeave={e => rowHover(e, false)}
                          >
                            <td style={{ ...tdStyle, fontWeight: 700 }}>#{d.negocio_num || d.id.slice(0, 6)}</td>
                            <td style={tdStyle}><strong>{d.cliente_nombre}</strong> {d.cliente_apellidos || ''}</td>
                            <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{d.vendedor || '—'}</td>
                            <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{linkedUnit?.modelo || d.vehiculo_modelo || '—'}</td>
                            <td style={{ ...tdStyle, fontSize: 11 }}>{d.banco || '—'}</td>
                            <td style={{ ...tdStyle, textAlign: 'center' }}><DocsBadge d={d} /></td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace' }}>
                              {p.hasFacturaVenta ? `$${fmtUSD(p.ventaBody)}` : <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>—</span>}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace' }}>
                              {p.hasFacturaCompra ? `$${fmtUSD(p.compraBody)}` : <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>—</span>}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: '#16A34A' }}>${fmtUSD(p.gastosAdmin)}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{u.node}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: p.forexArbitrage > 0 ? '#16A34A' : 'var(--text-secondary)' }}>
                              {p.hasGross ? (p.forexArbitrage > 0 ? `$${fmtUSD(p.forexArbitrage)}` : '$0') : <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>—</span>}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: (p.grossOperacion + p.forexArbitrage) >= 0 ? '#16A34A' : '#BB162B' }}>
                              {p.hasGross ? `$${fmtUSD(p.grossOperacion + p.forexArbitrage)}` : <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>—</span>}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>
                              {p.margenPct != null ? `${p.margenPct.toFixed(1)}%` : '—'}
                            </td>
                            <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontSize: 11 }}>{open ? '▲' : '▼'}</td>
                          </tr>
                          {open && (
                            <DrillDown title={`P&L Completo — ${dealLabel(d)}`} onClose={() => setDrillUtil(null)}>
                              <PnLCard d={d} />
                            </DrillDown>
                          )}
                        </Fragment>
                      )
                    })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid #0D2257', fontWeight: 700, background: '#F9FAFB' }}>
                    <td colSpan={6} style={{ padding: '10px 8px' }}>TOTAL ({pnlTotals.countWithGross} con facturas completas)</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>${fmtUSD(pnlTotals.ventaBody)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>${fmtUSD(pnlTotals.compraBody)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: '#16A34A' }}>${fmtUSD(pnlTotals.gastosAdmin)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: '#16A34A', fontWeight: 800 }}>${fmtUSD(pnlTotals.gross)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: '#16A34A', fontWeight: 700 }}>${fmtUSD(pnlTotals.forexArbitrage)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: '#16A34A', fontWeight: 800 }}>${fmtUSD(pnlTotals.gross + pnlTotals.forexArbitrage)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{pnlTotals.margenAvg.toFixed(1)}%</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* ════════════════════ TRÁMITES ════════════════════ */}
        {tab === 'tramites' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
              <KPICard label="Sin nota de entrega" value={String(tramites.sinNotaEntrega.length)}
                sub="aprobados >7 días" color={tramites.sinNotaEntrega.length > 0 ? '#D97706' : '#16A34A'} icon="📄" />
              <KPICard label="Sin placa" value={String(tramites.sinPlaca.length)}
                sub="entregados sin placa" color={tramites.sinPlaca.length > 0 ? '#BB162B' : '#16A34A'} icon="🪪" />
              <KPICard label="Sin póliza 2do año" value={String(tramites.sinPolizaSegundoAno.length)}
                sub="financiamiento interno" color={tramites.sinPolizaSegundoAno.length > 0 ? '#D97706' : '#16A34A'} icon="🛡" />
            </div>

            {tramites.sinNotaEntrega.length > 0 && (
              <div style={card()}>
                {sec('Sin nota de entrega · clic para detalle')}
                <SortableDrillTable cols={DEAL_COLS} rows={buildDealRows(tramites.sinNotaEntrega)} />
              </div>
            )}
            {tramites.sinPlaca.length > 0 && (
              <div style={card()}>
                {sec('Sin placa después de entrega · clic para detalle')}
                <SortableDrillTable cols={DEAL_COLS} rows={buildDealRows(tramites.sinPlaca)} />
              </div>
            )}
            {tramites.sinPolizaSegundoAno.length > 0 && (
              <div style={card()}>
                {sec('Financiamiento interno sin póliza segundo año')}
                <SortableDrillTable cols={DEAL_COLS} rows={buildDealRows(tramites.sinPolizaSegundoAno)} />
              </div>
            )}

            {tramites.sinNotaEntrega.length === 0 && tramites.sinPlaca.length === 0 && tramites.sinPolizaSegundoAno.length === 0 && (
              <div style={{ ...card(), textAlign: 'center', padding: 40, color: '#16A34A', fontWeight: 700 }}>
                ✓ Sin trámites pendientes
              </div>
            )}
          </div>
        )}

        {/* ════════════════════ MODELOS ════════════════════ */}
        {tab === 'modelos' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
              <KPICard label="Modelos distintos" value={String(modeloStats.length)} sub="catálogo activo" color="var(--text-primary)" icon="🚗" />
              <KPICard label="Top modelo" value={modeloStats[0]?.modelo || '—'} sub={`${modeloStats[0]?.vendidos || 0} vendidos`} color="#16A34A" icon="🏆" />
              <KPICard label="En stock" value={String(modeloStats.reduce((s, m) => s + m.enStock, 0))} sub="todas las unidades" color="#2563EB" icon="📦" />
            </div>

            <div style={card()}>
              {sec('Performance por Modelo · clic para ver negocios')}
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Modelo</th>
                    <th style={thStyleRight}>Vendidos</th>
                    <th style={thStyleRight}>En Stock</th>
                    <th style={thStyleRight}>Volumen</th>
                    <th style={thStyleRight}>Utilidad</th>
                    <th style={thStyleRight}>Margen</th>
                    <th style={thStyleRight}>Días stock prom.</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {modeloStats.map(m => {
                    const open = drillModel === m.modelo
                    const margen = m.volumen > 0 && m.utilidadCount > 0 ? (m.utilidad / m.volumen) * 100 : null
                    const diasProm = m.diasStockN > 0 ? Math.round(m.diasStockSum / m.diasStockN) : null
                    const modeloDeals = filteredDeals.filter(d => {
                      const linkedUnit = units.find(u => u.vin === d.inventory_vin)
                      const mod = linkedUnit?.modelo || d.vehiculo_modelo
                      return mod === m.modelo
                    })
                    return (
                      <Fragment key={m.modelo}>
                        <tr
                          style={{ ...clickableRow, background: open ? 'var(--bg-deep)' : undefined }}
                          onClick={() => setDrillModel(open ? null : m.modelo)}
                          onMouseEnter={e => rowHover(e, true)}
                          onMouseLeave={e => rowHover(e, false)}
                        >
                          <td style={{ ...tdStyle, fontWeight: 700 }}>{m.modelo}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{m.vendidos}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-secondary)' }}>{m.enStock}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#2563EB', fontWeight: 700 }}>${fmtUSD(m.volumen)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#16A34A', fontWeight: 700 }}>
                            {m.utilidadCount > 0 ? `$${fmtUSD(m.utilidad)}` : '—'}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{margen != null ? `${margen.toFixed(1)}%` : '—'}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{diasProm != null ? `${diasProm}d` : '—'}</td>
                          <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontSize: 11 }}>{open ? '▲' : '▼'}</td>
                        </tr>
                        {open && (
                          <DrillDown title={`Negocios — ${m.modelo}`} onClose={() => setDrillModel(null)}>
                            <SortableDrillTable cols={DEAL_COLS} rows={buildDealRows(modeloDeals)} />
                          </DrillDown>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        </div>
      </main>

      {showSobranteModal && (
        <div onClick={() => setShowSobranteModal(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#ffffff',
            color: '#0F172A',
            borderRadius: 12,
            padding: 24,
            maxWidth: 900, width: '100%', maxHeight: '90vh', overflowY: 'auto',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
            border: '1px solid #E5E7EB',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: '#0D2257', fontSize: 18 }}>Sobrantes / Faltantes — Detalle por negocio</h3>
              <button onClick={() => setShowSobranteModal(false)} style={{
                background: 'none', border: 'none', fontSize: 28, cursor: 'pointer', color: '#6B7280',
                lineHeight: 1, padding: 0,
              }}>×</button>
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 12 }}>
              Sobrante = total recibido − total cliente. El pv_igtf markup ya está incluido en total_cliente.
            </div>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #E5E7EB', textAlign: 'left', background: '#F9FAFB' }}>
                  <th style={{ padding: '10px 8px', color: '#0D2257', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>Negocio</th>
                  <th style={{ padding: '10px 8px', color: '#0D2257', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>Cliente</th>
                  <th style={{ padding: '10px 8px', textAlign: 'right', color: '#0D2257', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>Total Cliente</th>
                  <th style={{ padding: '10px 8px', textAlign: 'right', color: '#0D2257', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>Total Recibido</th>
                  <th style={{ padding: '10px 8px', textAlign: 'right', color: '#0D2257', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>IGTF markup (incl.)</th>
                  <th style={{ padding: '10px 8px', textAlign: 'right', color: '#0D2257', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>Sobrante / Faltante</th>
                </tr>
              </thead>
              <tbody>
                {filteredDeals
                  .map(d => {
                    const recibido = Number(d.total_recibido || 0)
                    const cliente = Number(d.total_cliente || 0)
                    const pvIgtf = Number(d.pv_igtf || 0)
                    const net = recibido - cliente
                    return { d, recibido, cliente, pvIgtf, net }
                  })
                  .filter(x => Math.abs(x.net) > 0.5)
                  .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
                  .map(({ d, recibido, cliente, pvIgtf, net }) => (
                    <tr key={d.id} style={{ borderBottom: '1px solid #F1F5F9' }}>
                      <td style={{ padding: '6px 4px', fontWeight: 600 }}>#{d.negocio_num}</td>
                      <td style={{ padding: '6px 4px' }}>{d.cliente_nombre} {d.cliente_apellidos}</td>
                      <td style={{ padding: '6px 4px', textAlign: 'right' }}>${fmtUSD2(cliente)}</td>
                      <td style={{ padding: '6px 4px', textAlign: 'right' }}>${fmtUSD2(recibido)}</td>
                      <td style={{ padding: '6px 4px', textAlign: 'right' }}>${fmtUSD2(pvIgtf)}</td>
                      <td style={{
                        padding: '6px 4px', textAlign: 'right', fontWeight: 700,
                        color: net > 0 ? '#16A34A' : '#BB162B'
                      }}>
                        {net > 0 ? '+' : ''}${fmtUSD2(net)}
                        <span style={{ fontSize: 10, marginLeft: 6, opacity: 0.7 }}>
                          {net > 0 ? 'sobrante' : 'faltante'}
                        </span>
                      </td>
                    </tr>
                  ))
                }
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #0D2257', fontWeight: 700, background: '#F9FAFB' }}>
                  <td colSpan={5} style={{ padding: '8px 4px', textAlign: 'right' }}>Neto del período:</td>
                  <td style={{ padding: '8px 4px', textAlign: 'right',
                    color: pnlTotals.sobranteNet >= 0 ? '#16A34A' : '#BB162B' }}>
                    {pnlTotals.sobranteNet >= 0 ? '+' : ''}${fmtUSD2(pnlTotals.sobranteNet)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// SHARED STYLES
// ═════════════════════════════════════════════════════════════════════════════
const selectStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text-primary)',
  fontSize: 12,
  outline: 'none',
  cursor: 'pointer',
}

const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: 15, color: 'var(--text-secondary)',
}

const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 12,
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 8px',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  borderBottom: '1px solid var(--border)',
}

const thStyleRight: React.CSSProperties = {
  ...thStyle, textAlign: 'right',
}

const tdStyle: React.CSSProperties = {
  padding: '8px 8px',
  color: 'var(--text-primary)',
}