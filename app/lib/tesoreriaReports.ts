// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/lib/tesoreriaReports.ts
// AutoCore NPA — Tesorería reports — shared utilities
//
// v1 (2026-05-25) — Phase 1: shared queries, formatters, xlsx export.
//
// IMPORTANT: every report load calls recomputeSaldosDefensive() at the top
// to defeat the trigger-drift bug (saldos sometimes stale on the ubicacion
// row even though movimientos are correct). Belt-and-suspenders alongside
// the eventual SECURITY DEFINER trigger fix.
// ═══════════════════════════════════════════════════════════════════════════
import { supabase } from '../supabase'
import * as XLSX from 'xlsx'

// ── Date range presets ─────────────────────────────────────────────────────
export type RangePresetKey =
  | 'hoy' | 'semana' | 'mes' | 'quincena' | 'mes_pasado' | 'custom'

export interface DateRange {
  from: string  // ISO date YYYY-MM-DD
  to:   string  // ISO date YYYY-MM-DD (inclusive)
  preset: RangePresetKey
}

export function getDefaultRange(): DateRange {
  // Default: current calendar month.
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const from = new Date(y, m, 1)
  const to   = now
  return {
    from: toISODate(from),
    to:   toISODate(to),
    preset: 'mes',
  }
}

export function rangeForPreset(preset: RangePresetKey): DateRange {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (preset) {
    case 'hoy':
      return { from: toISODate(today), to: toISODate(today), preset }
    case 'semana': {
      const start = new Date(today)
      start.setDate(today.getDate() - 6)
      return { from: toISODate(start), to: toISODate(today), preset }
    }
    case 'mes': {
      const start = new Date(today.getFullYear(), today.getMonth(), 1)
      return { from: toISODate(start), to: toISODate(today), preset }
    }
    case 'quincena': {
      // Current half: days 1-15 OR 16-end
      const day = today.getDate()
      if (day <= 15) {
        const start = new Date(today.getFullYear(), today.getMonth(), 1)
        const end   = new Date(today.getFullYear(), today.getMonth(), 15)
        return { from: toISODate(start), to: toISODate(end), preset }
      } else {
        const start = new Date(today.getFullYear(), today.getMonth(), 16)
        const end   = new Date(today.getFullYear(), today.getMonth() + 1, 0)
        return { from: toISODate(start), to: toISODate(end), preset }
      }
    }
    case 'mes_pasado': {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      const end   = new Date(today.getFullYear(), today.getMonth(), 0)
      return { from: toISODate(start), to: toISODate(end), preset }
    }
    default:
      return getDefaultRange()
  }
}

export function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${da}`
}

export function isoToTimestamp(iso: string, endOfDay = false): string {
  // Convert YYYY-MM-DD into an ISO timestamp with VET-equivalent boundary.
  // We treat the date as local-day for the user; tagging with -04:00 (VET) is
  // close enough. Movimientos are timestamptz so Postgres compares fine.
  const time = endOfDay ? 'T23:59:59.999-04:00' : 'T00:00:00.000-04:00'
  return iso + time
}

// ── Formatters ─────────────────────────────────────────────────────────────
export function fmtUSD(n: number | null | undefined): string {
  if (n == null || isNaN(Number(n))) return '$0.00'
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtDateDMY(isoOrTs: string | null | undefined): string {
  if (!isoOrTs) return '—'
  const d = new Date(isoOrTs)
  if (isNaN(d.getTime())) return '—'
  const day = String(d.getDate()).padStart(2, '0')
  const mo  = String(d.getMonth() + 1).padStart(2, '0')
  const yr  = d.getFullYear()
  return `${day}/${mo}/${yr}`
}

export function fmtTime(ts: string | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '—'
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

// ── Defensive saldo recompute ──────────────────────────────────────────────
// The AFTER INSERT trigger on tesoreria_movimientos has been observed to
// silently skip the saldo update under the Supabase REST path (probably an
// RLS UPDATE on tesoreria_ubicaciones blocking the trigger function which
// isn't SECURITY DEFINER). Until that's root-caused, every reports page
// calls this at the top of its load() to force a fresh saldo.
export async function recomputeSaldosDefensive(): Promise<void> {
  try {
    await supabase.rpc('tesoreria_recompute_saldos')
  } catch (e) {
    // Non-fatal. Reports still render; saldos may be stale.
    console.warn('[reportes] recompute saldos failed', e)
  }
}

// ── Ubicaciones lookup ─────────────────────────────────────────────────────
export interface Ubicacion {
  id: string
  codigo: string
  nombre: string
  tipo: string
  saldo_actual_usd: number
}

export async function loadUbicaciones(): Promise<Ubicacion[]> {
  const { data, error } = await supabase
    .from('tesoreria_ubicaciones')
    .select('id, codigo, nombre, tipo, saldo_actual_usd')
    .eq('activa', true)
    .order('codigo')
  if (error) throw error
  return (data || []) as Ubicacion[]
}

// ── Movimientos (ledger primary query) ─────────────────────────────────────
export interface MovimientoRow {
  id: string
  created_at: string
  ubicacion_id: string
  ubicacion_codigo: string
  ubicacion_nombre: string
  tipo: string
  signo: number
  monto_usd: number
  categoria: string | null
  source_type: string | null
  source_label: string | null
  descripcion: string | null
  comprobante_id: string | null
  comprobante_numero: string | null
  registered_by: string | null
  is_reversal: boolean | null
}

export async function loadMovimientos(
  range: DateRange,
  ubicacionIds: string[] | null,   // null = all
): Promise<MovimientoRow[]> {
  let q = supabase
    .from('tesoreria_movimientos')
    .select(`
      id, created_at, ubicacion_id, tipo, signo, monto_usd,
      categoria, source_type, source_label, descripcion,
      comprobante_id, registered_by, is_reversal,
      tesoreria_ubicaciones!inner ( codigo, nombre ),
      tesoreria_comprobantes ( numero )
    `)
    .gte('created_at', isoToTimestamp(range.from))
    .lte('created_at', isoToTimestamp(range.to, true))
    .order('created_at', { ascending: true })
  if (ubicacionIds && ubicacionIds.length > 0) {
    q = q.in('ubicacion_id', ubicacionIds)
  }
  const { data, error } = await q
  if (error) throw error
  // Flatten the joined rows.
  return (data || []).map((r: any) => ({
    id: r.id,
    created_at: r.created_at,
    ubicacion_id: r.ubicacion_id,
    ubicacion_codigo: r.tesoreria_ubicaciones?.codigo || '',
    ubicacion_nombre: r.tesoreria_ubicaciones?.nombre || '',
    tipo: r.tipo,
    signo: Number(r.signo),
    monto_usd: Number(r.monto_usd),
    categoria: r.categoria,
    source_type: r.source_type,
    source_label: r.source_label,
    descripcion: r.descripcion,
    comprobante_id: r.comprobante_id,
    comprobante_numero: r.tesoreria_comprobantes?.numero || null,
    registered_by: r.registered_by,
    is_reversal: r.is_reversal,
  }))
}

// ── Cash position over time ────────────────────────────────────────────────
export interface SaldoPoint {
  date: string          // YYYY-MM-DD or YYYY-Www or YYYY-MM
  ubicacion_id: string
  ubicacion_codigo: string
  saldo: number         // running saldo at end of the bucket
}

export type Granularity = 'dia' | 'semana' | 'mes'

// Build a saldo curve per ubicacion by replaying movimientos chronologically
// and bucketing the running balance by the selected granularity.
export function buildSaldoSeries(
  movs: MovimientoRow[],
  ubicaciones: Ubicacion[],
  range: DateRange,
  gran: Granularity,
): SaldoPoint[] {
  // 1. Compute starting balance per ubicacion: current saldo MINUS all
  //    movimientos in the range (so we get the saldo BEFORE the range).
  const currentSaldos: Record<string, number> = {}
  ubicaciones.forEach(u => { currentSaldos[u.id] = Number(u.saldo_actual_usd || 0) })
  const totalsInRange: Record<string, number> = {}
  movs.forEach(m => {
    totalsInRange[m.ubicacion_id] = (totalsInRange[m.ubicacion_id] || 0) + (m.monto_usd * m.signo)
  })
  const startSaldos: Record<string, number> = {}
  ubicaciones.forEach(u => {
    startSaldos[u.id] = (currentSaldos[u.id] || 0) - (totalsInRange[u.id] || 0)
  })

  // 2. Bucket movimientos.
  const bucketKey = (ts: string): string => {
    const d = new Date(ts)
    if (gran === 'dia') return toISODate(d)
    if (gran === 'mes') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    // semana: ISO week start (Monday).
    const day = d.getDay() === 0 ? 6 : d.getDay() - 1
    const monday = new Date(d)
    monday.setDate(d.getDate() - day)
    return toISODate(monday)
  }

  // 3. Walk movimientos, accumulate running saldo per ubicacion, emit a point
  //    at every bucket boundary.
  const running: Record<string, number> = { ...startSaldos }
  const points: SaldoPoint[] = []
  let currentBucket: string | null = null
  for (const m of movs) {
    const b = bucketKey(m.created_at)
    if (currentBucket && b !== currentBucket) {
      // Bucket flipped — emit snapshot of all ubicaciones at the prior bucket.
      ubicaciones.forEach(u => {
        points.push({
          date: currentBucket!,
          ubicacion_id: u.id,
          ubicacion_codigo: u.codigo,
          saldo: running[u.id] || 0,
        })
      })
    }
    currentBucket = b
    running[m.ubicacion_id] = (running[m.ubicacion_id] || 0) + (m.monto_usd * m.signo)
  }
  // Final bucket.
  if (currentBucket) {
    ubicaciones.forEach(u => {
      points.push({
        date: currentBucket!,
        ubicacion_id: u.id,
        ubicacion_codigo: u.codigo,
        saldo: running[u.id] || 0,
      })
    })
  }
  return points
}

// Top movers helper.
export interface TopMover {
  comprobante_numero: string | null
  descripcion: string | null
  ubicacion_codigo: string
  monto_usd: number
  signo: number
  created_at: string
}

export function topMovers(movs: MovimientoRow[], side: 'ingreso' | 'egreso', n = 5): TopMover[] {
  const filtered = movs.filter(m =>
    side === 'ingreso' ? m.signo > 0 : m.signo < 0
  )
  return filtered
    .sort((a, b) => Math.abs(b.monto_usd) - Math.abs(a.monto_usd))
    .slice(0, n)
    .map(m => ({
      comprobante_numero: m.comprobante_numero,
      descripcion: m.descripcion || m.source_label || m.tipo,
      ubicacion_codigo: m.ubicacion_codigo,
      monto_usd: m.monto_usd,
      signo: m.signo,
      created_at: m.created_at,
    }))
}

// ── XLSX export ─────────────────────────────────────────────────────────────
// Single-sheet workbook. For multi-sheet (e.g. summary + detail) use
// exportMultiSheet below.
export interface SheetDef {
  name: string
  rows: any[]      // array of plain objects; keys become columns
  colWidths?: number[]
}

export function exportExcel(filename: string, sheets: SheetDef[]): void {
  const wb = XLSX.utils.book_new()
  sheets.forEach(s => {
    const ws = XLSX.utils.json_to_sheet(s.rows)
    if (s.colWidths && s.colWidths.length > 0) {
      ws['!cols'] = s.colWidths.map(w => ({ wch: w }))
    }
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31))  // 31-char Excel limit
  })
  XLSX.writeFile(wb, filename)
}

// Convenience: turn a list of MovimientoRow into ledger-ready rows for export.
export function movimientosToSheet(movs: MovimientoRow[]): any[] {
  return movs.map(m => ({
    'Fecha':         fmtDateDMY(m.created_at),
    'Hora':          fmtTime(m.created_at),
    'Ubicación':     m.ubicacion_codigo,
    'Tipo':          m.tipo,
    'Signo':         m.signo > 0 ? '+' : '−',
    'Monto USD':     Number(m.monto_usd.toFixed(2)),
    'Net':           Number((m.monto_usd * m.signo).toFixed(2)),
    'Categoría':     m.categoria || '',
    'Comprobante':   m.comprobante_numero || '',
    'Descripción':   m.descripcion || m.source_label || '',
    'Reverso':       m.is_reversal ? 'Sí' : '',
  }))
}

// ── PDF export ─────────────────────────────────────────────────────────────
// Generic titled-table PDF via jsPDF (dynamic-imported at call time — same
// pattern as clientes/page.tsx, so the static-export build never bundles a
// browser-only module and no jspdf-autotable dependency is needed). Draws a
// navy header band, a column-header row that repeats on every page, zebra body
// rows with automatic page breaks, an optional totals footer, and page numbers.
// Callers pass row values as already-formatted strings keyed by column key.
// NOTE: keep all glyphs within Latin-1 (jsPDF standard Helvetica is WinAnsi) —
// use ASCII '-'/'+' for signs, never the U+2212 minus.
export interface PdfColumn {
  header: string
  key: string
  width: number                 // relative weight; normalized to printable width
  align?: 'left' | 'right'
}

export interface PdfTotal {
  label: string
  value: string
  tone?: 'pos' | 'neg' | 'plain'
}

export interface PdfExportOptions {
  title: string
  subtitle?: string
  meta?: string                 // small muted line, right of the title
  columns: PdfColumn[]
  rows: Record<string, string>[]
  totals?: PdfTotal[]
}

export async function exportPDF(filename: string, opts: PdfExportOptions): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' })

  const NAVY  = [13, 34, 87] as const
  const GRN   = [22, 163, 74] as const
  const RED   = [187, 22, 43] as const
  const DARK  = [39, 39, 42] as const
  const MUTED = [113, 113, 122] as const
  const ZEBRA = [250, 248, 242] as const
  const LINE  = [229, 226, 216] as const

  const PW = doc.internal.pageSize.getWidth()
  const PH = doc.internal.pageSize.getHeight()
  const M = 12
  const contentW = PW - M * 2
  const bottomLimit = PH - 14

  const wsum = opts.columns.reduce((a, c) => a + c.width, 0) || 1
  const cols = opts.columns.map(c => ({ ...c, mm: (c.width / wsum) * contentW }))
  const colX = (i: number) => M + cols.slice(0, i).reduce((a, c) => a + c.mm, 0)

  // Truncate to fit a column width (mm) at the current font. ASCII ellipsis.
  const fit = (s: string, mm: number): string => {
    if (!s) return ''
    if (doc.getTextWidth(s) <= mm) return s
    let out = s
    while (out.length > 1 && doc.getTextWidth(out + '...') > mm) out = out.slice(0, -1)
    return out + '...'
  }

  let y = M

  const drawHeaderBand = () => {
    doc.setFillColor(NAVY[0], NAVY[1], NAVY[2]); doc.rect(0, 0, PW, 22, 'F')
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(14)
    doc.text(opts.title, M, 11)
    if (opts.subtitle) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(220, 224, 235)
      doc.text(opts.subtitle, M, 17)
    }
    if (opts.meta) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(220, 224, 235)
      doc.text(opts.meta, PW - M, 11, { align: 'right' })
    }
    y = 30
  }

  const drawColHeader = () => {
    doc.setFillColor(NAVY[0], NAVY[1], NAVY[2]); doc.rect(M, y, contentW, 8, 'F')
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(8)
    cols.forEach((c, i) => {
      const x = colX(i)
      if (c.align === 'right') doc.text(c.header, x + c.mm - 2, y + 5.4, { align: 'right' })
      else doc.text(c.header, x + 2, y + 5.4)
    })
    y += 8
  }

  drawHeaderBand()
  drawColHeader()

  const rowH = 7
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
  opts.rows.forEach((r, idx) => {
    if (y + rowH > bottomLimit) {
      doc.addPage(); y = M; drawColHeader()
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
    }
    if (idx % 2 === 1) { doc.setFillColor(ZEBRA[0], ZEBRA[1], ZEBRA[2]); doc.rect(M, y, contentW, rowH, 'F') }
    doc.setTextColor(DARK[0], DARK[1], DARK[2])
    cols.forEach((c, i) => {
      const raw = r[c.key] || ''
      const x = colX(i)
      if (c.align === 'right') {
        doc.setFont('helvetica', 'bold')
        doc.text(fit(raw, c.mm - 4), x + c.mm - 2, y + 4.8, { align: 'right' })
        doc.setFont('helvetica', 'normal')
      } else {
        doc.text(fit(raw, c.mm - 4), x + 2, y + 4.8)
      }
    })
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(0.1)
    doc.line(M, y + rowH, M + contentW, y + rowH)
    y += rowH
  })

  if (opts.totals && opts.totals.length > 0) {
    if (y + 14 > bottomLimit) { doc.addPage(); y = M }
    y += 4
    doc.setDrawColor(NAVY[0], NAVY[1], NAVY[2]); doc.setLineWidth(0.4); doc.line(M, y, M + contentW, y)
    y += 6
    doc.setFontSize(9)
    let x = M
    opts.totals.forEach(t => {
      doc.setFont('helvetica', 'normal'); doc.setTextColor(MUTED[0], MUTED[1], MUTED[2])
      doc.text(t.label + ':', x, y); x += doc.getTextWidth(t.label + ': ')
      const tone = t.tone === 'pos' ? GRN : t.tone === 'neg' ? RED : DARK
      doc.setFont('helvetica', 'bold'); doc.setTextColor(tone[0], tone[1], tone[2])
      doc.text(t.value, x, y); x += doc.getTextWidth(t.value) + 8
    })
  }

  const pageCount = (doc as any).internal.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(MUTED[0], MUTED[1], MUTED[2])
    doc.text('Pagina ' + p + ' de ' + pageCount, PW - M, PH - 6, { align: 'right' })
    doc.text('AutoCore - Motocentro II', M, PH - 6)
  }

  doc.save(filename)
}