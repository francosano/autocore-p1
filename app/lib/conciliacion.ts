// TARGET: autocore-npa/app/lib/conciliacion.ts
// AutoCore NPA — Reconciliation engine (Conciliación de cuentas)
//
// Pure logic, no React. Classifies every bank_transactions row over a window
// into one of four buckets and, for the unexplained ones, proposes the
// tesorería counterpart (deterministic high-confidence first; the genuinely
// ambiguous remainder is handed to the AI pass by the page, not here).
//
// READ-ONLY by contract: this module computes and returns; it never writes.
// Confirmation happens in the page via the existing merge paths.

import { supabase } from '../supabase'

export const COMPROBANTE_WORKER = 'https://autocore-comprobante.sano-franco.workers.dev'

export type Bucket = 'conciliado' | 'entrada_sin_explicar' | 'salida_sin_explicar' | 'interna'

export interface BankTx {
  id: string
  fecha: string
  monto_usd: number
  monto_bs: number | null
  cuenta: string | null
  tipo: string | null
  direccion: string | null
  sender_name: string | null
  referencia: string | null
  matched: boolean | null
  is_internal: boolean | null
  deal_id: string | null
  es_bancarizacion: boolean | null
  reversed_at: string | null
  seen_in_email: boolean | null
  seen_in_statement: boolean | null
  seen_in_screenshot: boolean | null
}

export interface Counterpart {
  kind: 'ingreso' | 'egreso' | 'bancarizacion_deposito' | 'cuota_pago' | 'diferida_pago' | 'deal'
  id: string
  label: string          // e.g. "ING-0027 · inicial · Christian Carrión"
  monto: number
  fecha: string | null
  ref: string | null
  direccion: 'credit' | 'debit'
}

export interface Proposal {
  strength: 'exact' | 'strong' | 'ai'  // exact/strong = deterministic, ai = fuzzy
  confianza: number                    // 0-100
  counterpart: Counterpart | null      // null = no candidate, flag for investigation
  razon: string
}

export interface ReconRow {
  tx: BankTx
  bucket: Bucket
  // For conciliado rows: what it's linked to (best-effort label). For
  // sin_explicar: the proposal (deterministic) or null (needs AI / flag).
  linkedLabel?: string
  proposal?: Proposal
}

export interface ReconResult {
  rows: ReconRow[]
  counts: { total: number; conciliado: number; entrada: number; salida: number; interna: number }
  // Unexplained txs with NO deterministic proposal — the page sends these to
  // the AI pass in one batched call (token-efficient).
  needsAI: BankTx[]
  // Candidate counterparts still open (for the AI prompt + confirm actions).
  openCounterparts: Counterpart[]
}

// ── Helpers ───────────────────────────────────────────────────────────────
const round2 = (n: number) => Math.round(n * 100) / 100
const dateDiff = (a: string, b: string) =>
  Math.abs((new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / 86400000)
const amtClose = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol
function refSim(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const ca = a.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const cb = b.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (ca.length < 4 || cb.length < 4) return false
  return ca.includes(cb) || cb.includes(ca)
}

// ── Main entry ──────────────────────────────────────────────────────────────
export async function reconcileWindow(fromDate: string, toDate: string): Promise<ReconResult> {
  // 1. Bank transactions in the window (exclude reversed).
  const { data: txRaw } = await (supabase
    .from('bank_transactions')
    .select('id, fecha, monto_usd, monto_bs, cuenta, tipo, direccion, sender_name, referencia, matched, is_internal, deal_id, es_bancarizacion, reversed_at, seen_in_email, seen_in_statement, seen_in_screenshot')
    .gte('fecha', fromDate)
    .lte('fecha', toDate)
    .order('fecha', { ascending: false }) as any)
  const txs: BankTx[] = (Array.isArray(txRaw) ? txRaw : []).filter((t: BankTx) => !t.reversed_at)

  // 2. Which bank_tx ids are already linked from the tesorería side.
  //    (a) bancarización deposits  (b) cuota pagos  (c) diferida pagos
  const linkedFrom = new Map<string, string>()  // bank_tx_id -> label

  const { data: deps } = await (supabase
    .from('tesoreria_comprobante_depositos')
    .select('bank_transaction_id, comprobante_id, monto_usd') as any)
  for (const d of (Array.isArray(deps) ? deps : [])) {
    if (d.bank_transaction_id) linkedFrom.set(d.bank_transaction_id, 'Depósito de bancarización')
  }

  const { data: cuotaPagos } = await (supabase
    .from('cobranza_cuota_pagos')
    .select('bank_tx_id, contrato_id, monto_usd')
    .not('bank_tx_id', 'is', null) as any)
  for (const p of (Array.isArray(cuotaPagos) ? cuotaPagos : [])) {
    if (p.bank_tx_id) linkedFrom.set(p.bank_tx_id, 'Pago de cuota')
  }

  const { data: difPagos } = await (supabase
    .from('compromisos_inicial_diferida_pagos')
    .select('bank_tx_id, compromiso_id, monto_usd')
    .not('bank_tx_id', 'is', null) as any)
  for (const p of (Array.isArray(difPagos) ? difPagos : [])) {
    if (p.bank_tx_id) linkedFrom.set(p.bank_tx_id, 'Pago de inicial diferida')
  }

  // (d) ingreso/egreso comprobantes linked directly via bank_transaction_id.
  const { data: compLinks } = await (supabase
    .from('tesoreria_comprobantes')
    .select('numero, tipo, egreso_tipo, bank_transaction_id')
    .not('bank_transaction_id', 'is', null) as any)
  for (const c of (Array.isArray(compLinks) ? compLinks : [])) {
    if (!c.bank_transaction_id) continue
    const lbl = c.egreso_tipo === 'BANCARIZACION' ? `${c.numero} · bancarización`
      : c.tipo === 'EGRESO' ? `${c.numero} · egreso` : `${c.numero} · ingreso`
    // Don't clobber a more specific deposit label already set.
    if (!linkedFrom.has(c.bank_transaction_id)) linkedFrom.set(c.bank_transaction_id, lbl)
  }

  // 3. Open counterparts (for proposals + AI). Pull recent-enough records.
  const openCounterparts = await loadOpenCounterparts(fromDate, toDate)

  // 4. Classify each tx.
  const rows: ReconRow[] = []
  const needsAI: BankTx[] = []
  const usedCounterpart = new Set<string>()

  for (const tx of txs) {
    // Internal / fee → interna.
    if (tx.is_internal) {
      rows.push({ tx, bucket: 'interna' })
      continue
    }
    // Already linked (any side) → conciliado.
    const fromLabel = linkedFrom.get(tx.id)
    if (tx.matched || tx.deal_id || fromLabel) {
      rows.push({ tx, bucket: 'conciliado', linkedLabel: fromLabel || (tx.deal_id ? 'Venta (negocio)' : 'Conciliado') })
      continue
    }

    // Unexplained → bucket by direction, then try a deterministic match.
    const dir = (tx.direccion || 'credit') as 'credit' | 'debit'
    const bucket: Bucket = dir === 'credit' ? 'entrada_sin_explicar' : 'salida_sin_explicar'

    const det = bestDeterministic(tx, dir, openCounterparts, usedCounterpart)
    if (det) {
      usedCounterpart.add(det.counterpart!.kind + ':' + det.counterpart!.id)
      rows.push({ tx, bucket, proposal: det })
    } else {
      // No deterministic hit → queue for AI (it may still find a fuzzy match,
      // or it stays a flag).
      needsAI.push(tx)
      rows.push({ tx, bucket })
    }
  }

  const counts = {
    total: rows.length,
    conciliado: rows.filter(r => r.bucket === 'conciliado').length,
    entrada: rows.filter(r => r.bucket === 'entrada_sin_explicar').length,
    salida: rows.filter(r => r.bucket === 'salida_sin_explicar').length,
    interna: rows.filter(r => r.bucket === 'interna').length,
  }

  return { rows, counts, needsAI, openCounterparts: openCounterparts.filter(c => !usedCounterpart.has(c.kind + ':' + c.id)) }
}

// ── Deterministic matcher: exact amount + date window + direction + signal ──
function bestDeterministic(
  tx: BankTx, dir: 'credit' | 'debit',
  pool: Counterpart[], used: Set<string>,
): Proposal | null {
  const cands = pool.filter(c =>
    c.direccion === dir &&
    !used.has(c.kind + ':' + c.id) &&
    amtClose(tx.monto_usd, c.monto, 1))
  if (cands.length === 0) return null

  // Rank: ref match > same-day > within window. Require a date proximity to
  // avoid pairing an exact amount months apart.
  let best: { c: Counterpart; score: number; razon: string } | null = null
  for (const c of cands) {
    if (!c.fecha) continue
    const dd = dateDiff(tx.fecha, c.fecha)
    if (dd > 5) continue
    const hasRef = refSim(tx.referencia, c.ref)
    let score = 0; let razon = ''
    if (hasRef && dd <= 2)      { score = 98; razon = 'Monto, referencia y fecha coinciden' }
    else if (dd <= 0.0001)      { score = 90; razon = 'Monto exacto y misma fecha' }
    else if (dd <= 2)           { score = 82; razon = `Monto exacto, fecha ±${Math.round(dd)}d` }
    else                        { score = 70; razon = `Monto exacto, fecha ±${Math.round(dd)}d` }
    if (!best || score > best.score) best = { c, score, razon }
  }
  if (!best) return null
  // Only auto-propose deterministically when confidence is high; weaker ones
  // fall through to the AI pass for judgement.
  if (best.score < 82) return null
  return {
    strength: best.score >= 90 ? 'exact' : 'strong',
    confianza: best.score,
    counterpart: best.c,
    razon: best.razon,
  }
}

// ── Load open (unsettled) tesorería counterparts the window could match ─────
async function loadOpenCounterparts(fromDate: string, toDate: string): Promise<Counterpart[]> {
  const out: Counterpart[] = []
  // Widen the lookback a bit — deposits arrive days after the record.
  const lookback = new Date(new Date(fromDate + 'T00:00:00Z').getTime() - 30 * 86400000).toISOString().slice(0, 10)

  // Comprobantes: ingresos (credit) + egresos (debit) not yet fully settled.
  const { data: comps } = await (supabase
    .from('tesoreria_comprobantes')
    .select('id, numero, tipo, egreso_tipo, categoria, monto_usd, monto_depositado, estado, concepto, bancarizador_nombre, egreso_dirigido_a, bancarizacion_ruta, solicitado_at')
    .gte('solicitado_at', lookback + 'T00:00:00Z') as any)
  for (const c of (Array.isArray(comps) ? comps : [])) {
    const isEgreso = c.tipo === 'EGRESO'
    const isBanc = c.egreso_tipo === 'BANCARIZACION'
    const restante = Number(c.monto_usd) - Number(c.monto_depositado || 0)
    if (isBanc) {
      // Open bancarización: still waiting deposits.
      if (['ENTREGADO_BANCARIZADOR', 'DEPOSITADO_PARCIAL'].includes(c.estado) && restante > 0.005) {
        out.push({
          kind: 'bancarizacion_deposito', id: c.id,
          label: `${c.numero} · bancarización · ${c.bancarizador_nombre || c.egreso_dirigido_a || ''}${c.bancarizacion_ruta === 'directa' ? ' · USDT' : ''} · restante ${restante.toFixed(2)}`,
          monto: restante, fecha: (c.solicitado_at || '').slice(0, 10), ref: c.numero, direccion: 'credit',
        })
      }
    } else if (isEgreso) {
      // Non-bancarización egreso awaiting a bank debit match.
      out.push({
        kind: 'egreso', id: c.id,
        label: `${c.numero} · egreso · ${c.concepto || ''}`.slice(0, 80),
        monto: Number(c.monto_usd), fecha: (c.solicitado_at || '').slice(0, 10), ref: c.numero, direccion: 'debit',
      })
    } else {
      // Ingreso awaiting a bank credit match.
      out.push({
        kind: 'ingreso', id: c.id,
        label: `${c.numero} · ${(c.categoria || '').replace('INGRESO_', '').toLowerCase()} · ${c.concepto || ''}`.slice(0, 80),
        monto: Number(c.monto_usd), fecha: (c.solicitado_at || '').slice(0, 10), ref: c.numero, direccion: 'credit',
      })
    }
  }

  // Cobranza cuota pagos without a bank link yet (credit).
  const { data: cuotas } = await (supabase
    .from('cobranza_cuota_pagos')
    .select('id, contrato_id, monto_usd, fecha_pago, metodo_pago, referencia_pago, status, is_reversal, bank_tx_id')
    .is('bank_tx_id', null)
    .eq('is_reversal', false)
    .gte('fecha_pago', lookback) as any)
  for (const p of (Array.isArray(cuotas) ? cuotas : [])) {
    const m = (p.metodo_pago || '').toLowerCase()
    if (m.includes('efectivo') || m.includes('usdt')) continue  // not a bank credit
    out.push({
      kind: 'cuota_pago', id: p.id,
      label: `Cuota · ${p.metodo_pago || ''} · ref ${p.referencia_pago || '—'}`,
      monto: Number(p.monto_usd), fecha: p.fecha_pago, ref: p.referencia_pago, direccion: 'credit',
    })
  }

  // Diferida pagos without a bank link (credit).
  const { data: difs } = await (supabase
    .from('compromisos_inicial_diferida_pagos')
    .select('id, compromiso_id, monto_usd, fecha, metodo, referencia, is_reversal, bank_tx_id')
    .is('bank_tx_id', null)
    .eq('is_reversal', false)
    .gte('fecha', lookback) as any)
  for (const p of (Array.isArray(difs) ? difs : [])) {
    const m = (p.metodo || '').toLowerCase()
    if (m.includes('efectivo') || m.includes('usdt')) continue
    out.push({
      kind: 'diferida_pago', id: p.id,
      label: `Inicial diferida · ${p.metodo || ''} · ref ${p.referencia || '—'}`,
      monto: Number(p.monto_usd), fecha: p.fecha, ref: p.referencia, direccion: 'credit',
    })
  }

  return out
}