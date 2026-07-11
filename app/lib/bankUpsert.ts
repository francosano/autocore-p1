// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/lib/bankUpsert.ts
// v3 (2026-07-01) — Cross-source dedupe + merge for bank_transactions.
//   v3: a screenshot receipt may CORRECT a stale fecha on a row the bank has
//   NOT confirmed (no email/statement sighting). Prior versions only backfilled
//   a NULL fecha, so a re-registered / pre-existing row kept its placeholder date.
//
// A single real-world transaction can be evidenced by up to three ingest
// paths, each setting a flag on the SAME row instead of creating duplicates:
//
//   - seen_in_email       (BOFA email alert → autocore-bofa-ingest Worker)
//   - seen_in_statement   (PDF bank statement upload via /scan or /admin)
//   - seen_in_screenshot  (Zelle receipt screenshot via /scan or Portal)
//
// MATCHING (reference is authoritative — changed 2026-06-19):
//   • If the incoming row HAS a reference → match ONLY by (cuenta, referencia),
//     case-insensitive. A different or absent reference on an existing row means
//     a DIFFERENT transaction; we DO NOT fall through to the fingerprint. This
//     prevents distinct same-day / same-amount / same-sender payments (e.g. one
//     buyer sending several $500 Zelles) from being collapsed into one row.
//   • If the incoming row has NO reference → fall back to the fingerprint
//     (cuenta, fecha, monto_usd, sender_name), but only merge onto a candidate
//     that is ALSO reference-less. Merging a ref-less row onto a ref-bearing one
//     could hide two distinct payments; a visible duplicate is safer than a
//     silent over-merge and can be reconciled manually.
//
// `source` records the row's ORIGIN (first writer wins). The seen_in_* flags
// record every path that has corroborated it. sources_log is an append-only
// audit array.
// ═══════════════════════════════════════════════════════════════════════════
import { supabase } from '../supabase'

export type IngestSource = 'email' | 'statement' | 'screenshot'

export interface BankTxInput {
  cuenta: string
  fecha: string | null
  monto_usd: number | null
  monto_bs?: number | null
  sender_name?: string | null
  referencia?: string | null
  referencia_alt?: string | null
  tipo?: string | null
  descripcion?: string | null
  payment_memo?: string | null
  raw_text?: string | null
  flujo?: 'ingreso' | 'egreso' | null
  is_internal?: boolean
  is_bank_fee?: boolean
  is_third_party?: boolean
  categoria_gasto?: string | null
  proveedor?: string | null
  es_compra_unidades?: boolean
  compra_proveedor?: string | null
  uploaded_by?: string | null
  // Origin source string written to `source` column when a new row is inserted.
  source: string
}

export interface UpsertResult {
  action: 'inserted' | 'merged'
  id: string
  matchedBy?: 'referencia' | 'fingerprint'
}

export interface BatchSummary {
  inserted: number
  merged: number
  errors: number
  results: UpsertResult[]
  errorDetails: string[]
}

/** Normalize a confirmation # / reference for stable cross-source matching. */
export function normalizeRef(s: string | null | undefined): string | null {
  if (!s) return null
  const cleaned = String(s).trim().toLowerCase().replace(/\s+/g, '')
  if (cleaned.length < 5 || cleaned.length > 20) return null
  return cleaned
}

interface ExistingRow {
  id: string
  referencia: string | null
  sender_name: string | null
  fecha: string | null
  monto_usd: number | null
  tipo: string | null
  seen_in_email: boolean
  seen_in_statement: boolean
  seen_in_screenshot: boolean
  sources_log: any[]
}

const MATCH_SELECT =
  'id,referencia,sender_name,fecha,monto_usd,tipo,seen_in_email,seen_in_statement,seen_in_screenshot,sources_log'

/**
 * Find an existing row that represents the same real-world transaction.
 * Returns it with a `matchedBy` tag, or null.
 *
 * Reference is authoritative: a row that carries its own reference is matched
 * ONLY by that reference. The fingerprint fallback applies solely to ref-less
 * incoming rows, and only against ref-less candidates — see the file header.
 */
async function findExistingMatch(t: BankTxInput): Promise<{ row: ExistingRow; matchedBy: 'referencia' | 'fingerprint' } | null> {
  const refNorm = normalizeRef(t.referencia)

  // 1) Incoming carries a reference → reference is the unique key.
  //    Match ONLY by (cuenta, referencia). No match means this is a NEW,
  //    distinct transaction — never fall through to the fingerprint (doing so
  //    is what collapsed six distinct $500 payments into one row on 2026-06-19).
  if (refNorm) {
    const q1 = (await (supabase
      .from('bank_transactions')
      .select(MATCH_SELECT)
      .eq('cuenta', t.cuenta)
      .ilike('referencia', refNorm)
      .limit(1)) as any)
    if (!q1.error && Array.isArray(q1.data) && q1.data.length > 0) {
      return { row: q1.data[0] as ExistingRow, matchedBy: 'referencia' }
    }
    // Reference present but unseen → distinct transaction. Insert new.
    return null
  }

  // 2) Incoming has NO reference → fingerprint fallback
  //    (cuenta + fecha + monto + sender, case-insensitive sender), but only
  //    merge onto a candidate that is ALSO reference-less. This keeps the
  //    email/screenshot corroboration case working for ref-less rows while
  //    refusing to merge a ref-less row onto a known ref-bearing payment.
  const sender = (t.sender_name || '').trim()
  if (sender && t.fecha && t.monto_usd != null) {
    const q2 = (await (supabase
      .from('bank_transactions')
      .select(MATCH_SELECT)
      .eq('cuenta', t.cuenta)
      .eq('fecha', t.fecha)
      .eq('monto_usd', t.monto_usd)
      .ilike('sender_name', sender)
      .is('referencia', null)
      .limit(1)) as any)
    if (!q2.error && Array.isArray(q2.data) && q2.data.length > 0) {
      return { row: q2.data[0] as ExistingRow, matchedBy: 'fingerprint' }
    }
  }

  return null
}

/**
 * Upsert a single transaction with source attribution.
 * If a matching row exists → PATCH it (set seen_in_<source>, append log, fill gaps).
 * Otherwise → INSERT new row with seen_in_<source> = true.
 */
export async function upsertBankTx(t: BankTxInput, ingestSource: IngestSource): Promise<UpsertResult> {
  const refNorm = normalizeRef(t.referencia)
  const sender = (t.sender_name || '').trim() || null
  const logEntry = {
    source: ingestSource,
    at: new Date().toISOString(),
    ref: refNorm,
  }

  const match = await findExistingMatch(t)

  if (match) {
    const { row, matchedBy } = match
    const patch: any = {
      [`seen_in_${ingestSource}`]: true,
      sources_log: [...(Array.isArray(row.sources_log) ? row.sources_log : []), logEntry],
    }
    // Backfill any fields the existing row is missing and this source provides.
    if (!row.referencia && refNorm) patch.referencia = refNorm
    if (!row.sender_name && sender) patch.sender_name = sender
    // fecha: backfill when the existing row has none. Additionally, a screenshot
    // receipt carries the real transaction (send) date the user just confirmed,
    // so let it CORRECT a stale placeholder on a row the bank has NOT itself
    // confirmed. Never overwrite a bank-confirmed date — the BofA email /
    // statement date is the posting truth.
    if (t.fecha) {
      const bankConfirmed = row.seen_in_email || row.seen_in_statement
      if (!row.fecha) patch.fecha = t.fecha
      else if (!bankConfirmed && ingestSource === 'screenshot' && row.fecha !== t.fecha) patch.fecha = t.fecha
    }
    if (row.monto_usd == null && t.monto_usd != null) patch.monto_usd = t.monto_usd
    if (!row.tipo && t.tipo) patch.tipo = t.tipo

    const { error } = await supabase.from('bank_transactions').update(patch).eq('id', row.id)
    if (error) throw new Error(`merge failed (${row.id}): ${error.message}`)
    return { action: 'merged', id: row.id, matchedBy }
  }

  // Insert new row
  const insertRow: any = {
    cuenta: t.cuenta,
    fecha: t.fecha || null,
    monto_usd: t.monto_usd ?? null,
    monto_bs: t.monto_bs ?? null,
    sender_name: sender,
    referencia: refNorm,
    referencia_alt: t.referencia_alt ?? null,
    tipo: t.tipo || 'other',
    descripcion: t.descripcion ?? null,
    payment_memo: t.payment_memo ?? null,
    raw_text: t.raw_text ?? null,
    flujo: t.flujo ?? null,
    matched: false,
    is_third_party: t.is_third_party ?? false,
    is_internal: t.is_internal ?? false,
    is_bank_fee: t.is_bank_fee ?? false,
    categoria_gasto: t.categoria_gasto ?? null,
    proveedor: t.proveedor ?? null,
    es_compra_unidades: t.es_compra_unidades ?? false,
    compra_proveedor: t.compra_proveedor ?? null,
    source: t.source,
    uploaded_by: t.uploaded_by ?? null,
    seen_in_email: ingestSource === 'email',
    seen_in_statement: ingestSource === 'statement',
    seen_in_screenshot: ingestSource === 'screenshot',
    sources_log: [logEntry],
  }

  const { data, error } = await supabase
    .from('bank_transactions')
    .insert(insertRow)
    .select('id')
    .single()
  if (error) throw new Error(`insert failed: ${error.message}`)
  return { action: 'inserted', id: (data as any).id }
}

/**
 * Upsert a batch of transactions sequentially. Each row is matched/merged
 * independently so a re-uploaded statement merges into existing email/screenshot
 * rows rather than duplicating. Returns a summary for the UI.
 *
 * Sequential (not Promise.all) on purpose: two rows in the same batch could
 * match the same existing row; serial execution keeps sources_log consistent.
 */
export async function upsertBankTxBatch(rows: BankTxInput[], ingestSource: IngestSource): Promise<BatchSummary> {
  const summary: BatchSummary = { inserted: 0, merged: 0, errors: 0, results: [], errorDetails: [] }
  for (const r of rows) {
    try {
      const res = await upsertBankTx(r, ingestSource)
      summary.results.push(res)
      if (res.action === 'inserted') summary.inserted++
      else summary.merged++
    } catch (e: any) {
      summary.errors++
      summary.errorDetails.push(e?.message || String(e))
    }
  }
  return summary
}