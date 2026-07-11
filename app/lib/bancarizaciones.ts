// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/lib/bancarizaciones.ts
// v1 (2026-05-26) — Bancarización reporting + bancarizador balances.
//
// Loads the bancarización comprobantes + their linked bank_transactions +
// the per-bancarizador movement ledger, then computes KPIs:
//
//   - Total despachado (cash sent out)
//   - Total recibido (wired into our banks)
//   - En tránsito (cash handed over, deposit not yet uploaded)
//   - Discrepancia neta (surplus owed to bancarizadores)
//   - Por banco (motocentro / roframi / panama)
//   - Por bancarizador (saldo each, ranked)
//   - Tiempo promedio en tránsito (hours between handoff and deposit)
// ═══════════════════════════════════════════════════════════════════════════
import { supabase } from '../supabase'

// ── Types ───────────────────────────────────────────────────────────────────

export interface BancarizacionRow {
  id: string                          // comprobante id
  numero: string                      // EGR-NNNN-YYYY
  estado: string                      // SOLICITADO / EN_PODER_MIRLA / ENTREGADO_BANCARIZADOR / DEPOSITADO / ANULADO / REVERTIDO
  bancarizacion_ruta: 'via_mirla' | 'directa' | null
  monto_usd: number                   // expected (what cash was given)
  monto_depositado: number            // cumulative deposits (partials; 0 if none)
  bancarizador_nombre: string | null
  concepto: string | null
  creado_at: string | null            // comprobante created
  entregado_at: string | null         // when cash handed to bancarizador
  depositado_at: string | null        // when deposit uploaded
  egreso_documento_url: string | null
  egreso_ai_review: any | null
  bank_transaction_id: string | null
  // Joined from bank_transactions (if linked):
  bank_monto: number | null           // actual deposited amount
  bank_fecha: string | null
  bank_referencia: string | null
  bank_cuenta: string | null          // motocentro/roframi/panama/UNKNOWN
  bank_cuenta_id: string | null
}

export interface Bancarizador {
  id: string
  nombre: string
  contacto: string | null
  notas: string | null
  activo: boolean
  saldo_usd: number                   // positive = they owe us, negative = we owe them
}

export interface BancarizadorMovimiento {
  id: string
  bancarizador_id: string
  tipo: 'CASH_DELIVERED' | 'WIRE_RECEIVED' | 'SURPLUS' | 'SHORTFALL' | 'FEE' | 'ADJUSTMENT'
  monto: number
  comprobante_id: string | null
  bank_transaction_id: string | null
  notas: string | null
  created_at: string
}

// ── KPIs ────────────────────────────────────────────────────────────────────

export interface BancKPIs {
  totalDespachado: number             // sum of monto_usd for non-ANULADO comprobantes
  totalRecibido:   number             // sum of bank_monto for DEPOSITADO with bank_transaction_id
  enTransito:      number             // sum of monto_usd for ENTREGADO_BANCARIZADOR (not yet deposited)
  enTransitoCount: number
  discrepanciaNeta: number            // totalRecibido − totalDespachado (positive = bancarizadores deposited more than expected)
  countTotal:      number
  countDepositado: number
  countAnulado:    number
  countSinClasificar: number          // bank_cuenta = 'UNKNOWN'
  avgTransitHours: number | null      // average between entregado_at and depositado_at
}

// Per-bank breakdown
export interface BankSummary {
  cuenta: string                      // motocentro / roframi / panama / UNKNOWN
  count: number
  total_recibido: number              // sum of bank_monto
}

// Per-bancarizador breakdown
export interface BancarizadorSummary {
  bancarizador_id: string
  nombre: string
  count_comprobantes: number          // count of comprobantes where they appeared
  total_cash_delivered: number        // sum of CASH_DELIVERED
  total_wire_received: number         // sum of WIRE_RECEIVED
  saldo_usd: number                   // current running balance from master table
}

// ── Loaders ─────────────────────────────────────────────────────────────────

export interface DateRange { from: string; to: string }

/**
 * Load all bancarización comprobantes in a date range, joined with their
 * bank_transactions row. Date filtering is on the comprobante's creation
 * (`creado_at` if present, else cerrado_at as a fallback).
 */
export async function loadBancarizaciones(range: DateRange): Promise<BancarizacionRow[]> {
  // Pull all bancarization comprobantes; we filter by event-derived dates below.
  // First, query the comprobantes themselves.
  const { data: comps, error } = await supabase
    .from('tesoreria_comprobantes')
    .select(`
      id, numero, estado, bancarizacion_ruta, monto_usd, monto_depositado, bancarizador_nombre,
      concepto, cerrado_at, egreso_documento_url, egreso_ai_review,
      bank_transaction_id
    `)
    .eq('egreso_tipo', 'BANCARIZACION')
    .order('cerrado_at', { ascending: false, nullsFirst: false })
    .limit(500)
  if (error) {
    console.error('loadBancarizaciones comps', error)
    return []
  }
  const compsList = (comps || []) as any[]
  if (compsList.length === 0) return []

  // Pull events to derive entregado_at / depositado_at per comprobante
  const compIds = compsList.map(c => c.id)
  const { data: events } = await supabase
    .from('tesoreria_comprobante_eventos')
    .select('comprobante_id, evento, created_at')
    .in('comprobante_id', compIds)
    .in('evento', ['CREADO', 'ENTREGADO_BANCARIZADOR', 'DEPOSITADO'])
    .order('created_at', { ascending: true })

  const eventMap: Record<string, { creado: string | null; entregado: string | null; depositado: string | null }> = {}
  for (const e of (events || []) as any[]) {
    if (!eventMap[e.comprobante_id]) {
      eventMap[e.comprobante_id] = { creado: null, entregado: null, depositado: null }
    }
    if (e.evento === 'CREADO' && !eventMap[e.comprobante_id].creado) eventMap[e.comprobante_id].creado = e.created_at
    if (e.evento === 'ENTREGADO_BANCARIZADOR' && !eventMap[e.comprobante_id].entregado) eventMap[e.comprobante_id].entregado = e.created_at
    if (e.evento === 'DEPOSITADO' && !eventMap[e.comprobante_id].depositado) eventMap[e.comprobante_id].depositado = e.created_at
  }

  // Pull linked bank_transactions
  const btIds = compsList.map(c => c.bank_transaction_id).filter(Boolean)
  let btMap: Record<string, any> = {}
  if (btIds.length > 0) {
    const { data: bts } = await supabase
      .from('bank_transactions')
      .select('id, monto_usd, fecha, referencia, cuenta, cuenta_id')
      .in('id', btIds)
    for (const bt of (bts || []) as any[]) btMap[bt.id] = bt
  }

  // Compose final rows + filter by date range
  const rows: BancarizacionRow[] = compsList.map(c => {
    const ev = eventMap[c.id] || { creado: null, entregado: null, depositado: null }
    const bt = c.bank_transaction_id ? btMap[c.bank_transaction_id] : null
    return {
      id: c.id,
      numero: c.numero,
      estado: c.estado,
      bancarizacion_ruta: c.bancarizacion_ruta,
      monto_usd: Number(c.monto_usd) || 0,
      monto_depositado: Number(c.monto_depositado) || 0,
      bancarizador_nombre: c.bancarizador_nombre,
      concepto: c.concepto,
      creado_at: ev.creado || c.cerrado_at,
      entregado_at: ev.entregado,
      depositado_at: ev.depositado,
      egreso_documento_url: c.egreso_documento_url,
      egreso_ai_review: c.egreso_ai_review,
      bank_transaction_id: c.bank_transaction_id,
      bank_monto: bt ? Number(bt.monto_usd) : null,
      bank_fecha: bt ? bt.fecha : null,
      bank_referencia: bt ? bt.referencia : null,
      bank_cuenta: bt ? bt.cuenta : null,
      bank_cuenta_id: bt ? bt.cuenta_id : null,
    }
  })

  // Filter by date range on creado_at (fallback cerrado_at). Inclusive.
  const fromMs = new Date(range.from + 'T00:00:00-04:00').getTime()
  const toMs   = new Date(range.to   + 'T23:59:59-04:00').getTime()
  return rows.filter(r => {
    const ref = r.creado_at || r.depositado_at
    if (!ref) return false
    const ms = new Date(ref).getTime()
    return ms >= fromMs && ms <= toMs
  })
}

export async function loadBancarizadores(): Promise<Bancarizador[]> {
  const { data, error } = await supabase
    .from('bancarizadores')
    .select('*')
    .order('nombre')
  if (error) {
    console.error('loadBancarizadores', error)
    return []
  }
  return ((data || []) as any[]).map(b => ({
    id: b.id,
    nombre: b.nombre,
    contacto: b.contacto || null,
    notas: b.notas || null,
    activo: !!b.activo,
    saldo_usd: Number(b.saldo_usd) || 0,
  }))
}

export async function loadBancarizadorMovimientos(bancarizadorId: string): Promise<BancarizadorMovimiento[]> {
  const { data, error } = await supabase
    .from('bancarizador_movimientos')
    .select('*')
    .eq('bancarizador_id', bancarizadorId)
    .order('created_at', { ascending: false })
  if (error) {
    console.error('loadBancarizadorMovimientos', error)
    return []
  }
  return (data || []) as BancarizadorMovimiento[]
}

// ── Computations ────────────────────────────────────────────────────────────

export function computeKPIs(rows: BancarizacionRow[]): BancKPIs {
  let totalDespachado = 0
  let totalRecibido   = 0
  let enTransito      = 0
  let enTransitoCount = 0
  let countDepositado = 0
  let countAnulado    = 0
  let countSinClasificar = 0
  let transitSum = 0
  let transitN   = 0

  for (const r of rows) {
    if (r.estado === 'ANULADO' || r.estado === 'REVERTIDO') {
      countAnulado++
      continue
    }
    totalDespachado += r.monto_usd
    if (r.estado === 'DEPOSITADO') {
      countDepositado++
      // monto_depositado is the partials-aware truth; bank_monto (single
      // linked tx) is the legacy fallback for rows closed before 2026-06-12.
      const recibido = r.monto_depositado > 0 ? r.monto_depositado : (r.bank_monto != null ? r.bank_monto : 0)
      totalRecibido += recibido
      if (r.bank_cuenta === 'UNKNOWN' || (r.bank_monto != null && r.bank_cuenta == null)) countSinClasificar++
      if (r.entregado_at && r.depositado_at) {
        const dt = (new Date(r.depositado_at).getTime() - new Date(r.entregado_at).getTime()) / 3600000
        if (dt >= 0 && dt < 24 * 30) { // sanity bound
          transitSum += dt
          transitN += 1
        }
      }
    } else if (r.estado === 'DEPOSITADO_PARCIAL') {
      // Split: what arrived counts as received; the remainder is still
      // in the bancarizador's hands (en transito).
      totalRecibido += r.monto_depositado
      enTransito += Math.max(0, r.monto_usd - r.monto_depositado)
      enTransitoCount++
    } else if (r.estado === 'ENTREGADO_BANCARIZADOR' || r.estado === 'EN_PODER_MIRLA' || r.estado === 'SOLICITADO') {
      enTransito += r.monto_usd
      enTransitoCount++
    }
  }

  return {
    totalDespachado,
    totalRecibido,
    enTransito,
    enTransitoCount,
    discrepanciaNeta: totalRecibido - totalDespachado,
    countTotal: rows.length,
    countDepositado,
    countAnulado,
    countSinClasificar,
    avgTransitHours: transitN > 0 ? transitSum / transitN : null,
  }
}

export function summarizeByBank(rows: BancarizacionRow[]): BankSummary[] {
  const map: Record<string, BankSummary> = {}
  for (const r of rows) {
    // Partials-aware: DEPOSITADO uses cumulative monto_depositado (legacy
    // fallback bank_monto); DEPOSITADO_PARCIAL contributes what has arrived.
    // Multi-account partials are attributed to the last linked tx's cuenta —
    // exact per-account split lives in tesoreria_comprobante_depositos.
    let recibido = 0
    if (r.estado === 'DEPOSITADO') recibido = r.monto_depositado > 0 ? r.monto_depositado : (r.bank_monto != null ? r.bank_monto : 0)
    else if (r.estado === 'DEPOSITADO_PARCIAL') recibido = r.monto_depositado
    if (recibido <= 0) continue
    const key = r.bank_cuenta || 'UNKNOWN'
    if (!map[key]) map[key] = { cuenta: key, count: 0, total_recibido: 0 }
    map[key].count += 1
    map[key].total_recibido += recibido
  }
  return Object.values(map).sort((a, b) => b.total_recibido - a.total_recibido)
}

// Map cuenta short code → human label
export const BANK_LABEL: Record<string, string> = {
  motocentro:      'BofA Motocentro II',
  roframi:         'BofA Roframi',
  roframi_regions: 'Regions Roframi',
  panama:          'Mercantil Panamá',
  bolivares:       'Bolívares (VES)',
  UNKNOWN:         '⚠ Sin clasificar',
}

// ── Formatters (re-exports for convenience) ────────────────────────────────

export const fmtUSD = (n: number | null | undefined): string => {
  if (n == null || isNaN(Number(n))) return '$0.00'
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export const fmtUSDsigned = (n: number | null | undefined): string => {
  if (n == null || isNaN(Number(n))) return '$0.00'
  const v = Number(n)
  return (v >= 0 ? '+' : '') + '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export const fmtDateDMY = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
}

export const fmtHours = (h: number | null): string => {
  if (h == null) return '—'
  if (h < 1) return Math.round(h * 60) + ' min'
  if (h < 24) return h.toFixed(1) + ' h'
  return (h / 24).toFixed(1) + ' días'
}