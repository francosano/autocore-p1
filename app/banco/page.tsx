// TARGET: autocore-npa/app/banco/page.tsx
// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/banco/page.tsx
// Bank reconciliation page — concilacion, bancarizaciones, compras, reports
// v4.2: hardened handleManualMatch (try/catch, null-safe names, RLS row-count check, double-click guard)
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import React, { useState, useEffect, Suspense } from 'react'
import { supabase } from '../supabase'
import { useRouter, useSearchParams } from 'next/navigation'
import AdminShell from '../components/AdminShell'
import { useNPAPermissions } from '../components/useNPAPermissions'

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (d: string | null) => { if (!d) return '—'; const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}` }

// Bank account FK map (mirror of comprobante page) — used when a manually
// loaded bancarización deposit creates its bank_transactions row.
const BANK_ACCOUNTS: { code: string; fkId: string; label: string }[] = [
  { code: 'motocentro',      fkId: 'BOFA_MOTOII',     label: 'BofA Motocentro II (0481)' },
  { code: 'roframi',         fkId: 'BOFA_ROFRAMI',    label: 'BofA Roframi (7252)' },
  { code: 'roframi_regions', fkId: 'REGIONS_ROFRAMI', label: 'Regions Roframi' },
  { code: 'panama',          fkId: 'MERCANTIL_PA',    label: 'Mercantil Panamá' },
]
const cuentaFkId = (code: string): string =>
  BANK_ACCOUNTS.find(a => a.code === code)?.fkId || 'UNKNOWN'

// ── Source-provenance pills ───────────────────────────────────────────────
// Minimal text pills showing which ingest channels have evidenced a bank_tx.
// A solid pill means the channel saw it; muted means it didn't. Tooltip lists
// the timestamped entries from sources_log.
function SourcePills({ tx }: { tx: any }) {
  const chans: { key: 'seen_in_email' | 'seen_in_statement' | 'seen_in_screenshot'; label: string }[] = [
    { key: 'seen_in_email',      label: 'EMAIL' },
    { key: 'seen_in_statement',  label: 'STMT' },
    { key: 'seen_in_screenshot', label: 'SHOT' },
  ]
  const log: any[] = Array.isArray(tx.sources_log) ? tx.sources_log : []
  const tip = (k: string) => {
    const sk = k.replace('seen_in_', '')
    const hits = log.filter(e => e?.source === sk)
    if (hits.length === 0) return `${sk}: no detectado`
    return hits.map(h => `${sk}: ${h.at ? new Date(h.at).toLocaleDateString('es-VE') : '—'}${h.ref ? ' · ' + h.ref : ''}`).join('\n')
  }
  return (
    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
      {chans.map(c => {
        const on = tx[c.key] === true
        return (
          <span
            key={c.key}
            title={tip(c.key)}
            style={{
              fontSize: 8.5, fontWeight: 700, letterSpacing: 0.5,
              padding: '1px 5px', borderRadius: 4, lineHeight: 1.4,
              border: '1px solid',
              borderColor: on ? 'var(--text-primary)' : 'var(--border)',
              color: on ? 'var(--text-primary)' : 'var(--border)',
              background: on ? 'transparent' : 'transparent',
              opacity: on ? 1 : 0.45,
              cursor: 'default',
            }}
          >
            {c.label}
          </span>
        )
      })}
    </div>
  )
}

const CUENTA_LABELS: Record<string, { label: string; color: string }> = {
  roframi:         { label: 'Roframi BofA',     color: '#3B82F6' },
  roframi_regions: { label: 'Roframi Regions',  color: '#60A5FA' },
  motocentro:      { label: 'Motocentro',       color: '#BB162B' },
  panama:          { label: 'Panamá',           color: '#10B981' },
  bolivares:       { label: 'Bolívares',        color: '#F59E0B' },
}

// AI proxy (pass-through mode, body.messages → Anthropic). Used by the
// Tier-2 "Conciliar con IA" pass for cross-source duplicate suggestions.
const COMPROBANTE_WORKER = 'https://autocore-comprobante.sano-franco.workers.dev'

const s: any = {
  page:  { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  content: { padding: '28px 32px', maxWidth: '1300px', margin: '0 auto' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, marginBottom: 20 },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--border)' },
  badge: (color: string) => ({ padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: color + '22', color }),
}

function BancoPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { permissions, loading: permsLoading } = useNPAPermissions()
  const [transactions, setTransactions] = useState<any[]>([])
  const [deals, setDeals]               = useState<any[]>([])
  // Phase 5 (2026-05-15): cross-app reconciliation. /banco also matches against
  // Portal cobranza pagos AND NPA diferida pagos so a single bank transaction
  // can find its home regardless of which app registered the customer-side pago.
  const [cobranzaPagos, setCobranzaPagos] = useState<any[]>([])
  const [diferidaPagos, setDiferidaPagos] = useState<any[]>([])
  const [contratosMap, setContratosMap]   = useState<Map<string, any>>(new Map())   // contrato_id → contrato row
  const [compromisosMap, setCompromisosMap] = useState<Map<string, any>>(new Map()) // compromiso_id → compromiso row
  const [loading, setLoading]           = useState(true)
  const [filter, setFilter]             = useState<'all' | 'unmatched' | 'third_party' | 'bancarizacion' | 'compras'>('all')
  const [cuentaFilter, setCuentaFilter] = useState<string>('all')
  const [matching, setMatching]           = useState(false)
  const [selectedTx, setSelectedTx]       = useState<any | null>(null)
  const [matchDealId, setMatchDealId]     = useState('')
  const [confirmingTx, setConfirmingTx]   = useState<any | null>(null)
  const [addingIngreso, setAddingIngreso] = useState(false)
  const [linking, setLinking]             = useState(false)
  // ★ Bancarización / Compras inline editors
  const [bancEditor, setBancEditor]       = useState<{ txId: string; depositante: string; esTercero: boolean; comision: string } | null>(null)
  const [compraEditor, setCompraEditor]   = useState<{ txId: string; proveedor: string } | null>(null)
  // Highlight + scroll target when navigated from global search
  const [highlightedTxId, setHighlightedTxId] = useState<string | null>(null)

  // ── Tier-2 AI conciliation (cross-source duplicate suggestions) ──
  const [aiSugs, setAiSugs]       = useState<any[]>([])
  const [aiBusy, setAiBusy]       = useState(false)
  const [aiRan, setAiRan]         = useState(false)
  const [aiErr, setAiErr]         = useState<string | null>(null)
  const [aiConfirming, setAiConfirming] = useState<string | null>(null)
  const [aiBancSugs, setAiBancSugs]     = useState<any[]>([])

  // ── Bancarizaciones pendientes por cerrar (manual deposit loading) ──
  // Panamá has no real-time feed; deposits are loaded by hand here and later
  // deduped against the scanned statement (BANCO↔INTERNA detector).
  const [pendientes, setPendientes]     = useState<any[]>([])
  const [pendOpen, setPendOpen]         = useState<string | null>(null)  // comprobante id with open form
  const [pendMonto, setPendMonto]       = useState('')
  const [pendFecha, setPendFecha]       = useState(() => new Date().toISOString().slice(0, 10))
  const [pendCuenta, setPendCuenta]     = useState('')
  const [pendRef, setPendRef]           = useState('')
  const [pendSaving, setPendSaving]     = useState(false)
  const [pendErr, setPendErr]           = useState<string | null>(null)

  useEffect(() => {
    if (!permsLoading && !permissions.npa_can_admin) router.replace('/dashboard')
  }, [permsLoading, permissions])

  useEffect(() => {
    load()
    loadPendientes()
  }, [])

  // Handle ?tx=ID from global search: scroll to + highlight that row
  useEffect(() => {
    const txId = searchParams?.get('tx')
    if (txId && transactions.length > 0) {
      setHighlightedTxId(txId)
      // Scroll after the DOM has rendered. Element id will be `tx-row-${id}`.
      setTimeout(() => {
        const el = document.getElementById(`tx-row-${txId}`)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        window.history.replaceState({}, '', '/banco')
      }, 100)
      // Fade highlight after a few seconds
      setTimeout(() => setHighlightedTxId(null), 4000)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions])

  // Load open bancarizaciones (waiting deposits) for the manual-load panel.
  const loadPendientes = async () => {
    const { data } = await (supabase
      .from('tesoreria_comprobantes')
      .select('id, numero, monto_usd, monto_depositado, estado, bancarizador_nombre, egreso_dirigido_a, bancarizacion_ruta, solicitado_at')
      .eq('egreso_tipo', 'BANCARIZACION')
      .in('estado', ['ENTREGADO_BANCARIZADOR', 'DEPOSITADO_PARCIAL'])
      .order('solicitado_at', { ascending: true }) as any)
    const open = (Array.isArray(data) ? data : [])
      .map((c: any) => ({ ...c, restante: Number(c.monto_usd) - Number(c.monto_depositado || 0) }))
      .filter((c: any) => c.restante > 0.005)
    setPendientes(open)
  }

  // Apply a manually loaded deposit to an open bancarización. Creates (or
  // links, if a statement row already exists) the bank_transactions row, the
  // child ledger row, accumulates monto_depositado, and closes at net-zero —
  // identical to the comprobante detail flow. When the Panamá statement is
  // later scanned, the BANCO↔INTERNA detector dedups the real row into this.
  const aplicarDepositoPendiente = async (comp: any) => {
    setPendErr(null)
    const restante = Number(comp.restante)
    const monto = parseFloat(pendMonto) || restante
    if (monto <= 0) { setPendErr('Monto inválido.'); return }
    if (monto > restante + 0.005) { setPendErr(`Excede lo pendiente (${fmt(restante)}).`); return }
    if (!pendFecha) { setPendErr('Indica la fecha del depósito.'); return }
    if (!pendCuenta) { setPendErr('Selecciona la cuenta donde se depositó.'); return }
    const ref = pendRef.trim() || `${comp.numero}-${Date.now().toString().slice(-5)}`
    const bancNombre = comp.bancarizador_nombre || comp.egreso_dirigido_a || null
    setPendSaving(true)
    try {
      const { data: au } = await supabase.auth.getUser()
      const uid = au?.user?.id || null

      // 1. Bank tx — link if an ingested row with same cuenta+ref exists, else insert.
      let bankTxId: string | null = null
      const { data: existing } = await supabase
        .from('bank_transactions').select('id')
        .eq('cuenta', pendCuenta).ilike('referencia', ref).limit(1)
      if (existing && existing.length > 0) {
        bankTxId = (existing[0] as any).id
        await supabase.from('bank_transactions').update({
          es_bancarizacion: true, matched: true, banc_depositante: bancNombre,
        }).eq('id', bankTxId)
      } else {
        const { data: ins, error: insErr } = await supabase.from('bank_transactions').insert({
          tipo: 'deposit', fecha: pendFecha, monto_usd: monto,
          referencia: ref, cuenta: pendCuenta, cuenta_id: cuentaFkId(pendCuenta),
          direccion: 'credit', flujo: 'ingreso',
          raw_text: `Bancarización ${comp.numero} · MANUAL (carga directa /banco)`,
          is_internal: true, es_bancarizacion: true, matched: true,
          banc_depositante: bancNombre, sender_name: bancNombre,
        }).select('id').single()
        if (insErr) throw new Error('No se pudo crear la transacción bancaria: ' + insErr.message)
        bankTxId = (ins as any).id
      }

      // 2. Child ledger row.
      const { error: depErr } = await supabase.from('tesoreria_comprobante_depositos').insert({
        comprobante_id: comp.id, bank_transaction_id: bankTxId, monto_usd: monto,
        fecha: pendFecha, referencia: ref, cuenta: pendCuenta, documento_url: null,
        ai_review: { source: 'carga_manual_banco' }, registered_by: uid,
      })
      if (depErr) throw new Error('No se pudo registrar el depósito: ' + depErr.message)

      // 3. Accumulate + estado.
      const nuevoTotal = Number(comp.monto_depositado || 0) + monto
      const completo = nuevoTotal >= Number(comp.monto_usd) - 0.005
      const { error: upErr } = await supabase.from('tesoreria_comprobantes').update({
        estado: completo ? 'DEPOSITADO' : 'DEPOSITADO_PARCIAL',
        cerrado_at: completo ? new Date().toISOString() : null,
        monto_depositado: nuevoTotal, bank_transaction_id: bankTxId,
      }).eq('id', comp.id).in('estado', ['ENTREGADO_BANCARIZADOR', 'DEPOSITADO_PARCIAL'])
      if (upErr) throw new Error('Depósito creado pero el comprobante no se actualizó: ' + upErr.message)

      // 4. Audit event.
      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: comp.id, evento: completo ? 'DEPOSITADO' : 'DEPOSITO_PARCIAL',
        actor_user_id: uid, actor_label: 'Carga manual (banco)',
        notas: `Depósito cargado manualmente desde /banco: ${fmt(monto)} · ${completo ? 'cierra' : 'parcial, faltan ' + fmt(Number(comp.monto_usd) - nuevoTotal)}.`,
      })

      setPendOpen(null); setPendMonto(''); setPendRef(''); setPendCuenta('')
      await Promise.all([loadPendientes(), load()])
    } catch (e: any) {
      setPendErr(e?.message || 'Error al aplicar el depósito')
    } finally { setPendSaving(false) }
  }

  const load = async () => {
    setLoading(true)
    const [{ data: txs }, { data: ds }, { data: ccp }, { data: dfp }] = await Promise.all([
      supabase.from('bank_transactions').select('*').order('fecha', { ascending: false }),
      supabase.from('deals').select('id, negocio_num, cliente_nombre, cliente_apellidos, cliente_rif, fecha_entrega, pagos, tasa_bcv').order('created_at', { ascending: false }),
      // Cross-app: cobranza_cuota_pagos. Match regardless of approval status (per user spec).
      // Skip reversal rows since they're cancellation markers, not real payments.
      supabase.from('cobranza_cuota_pagos')
        .select('id, cuota_id, contrato_id, monto_usd, fecha_pago, metodo_pago, referencia_pago, status, is_reversal, bank_tx_id, bank_match_strength')
        .eq('is_reversal', false),
      // Cross-app: compromisos_inicial_diferida_pagos. Also skip reversals.
      supabase.from('compromisos_inicial_diferida_pagos')
        .select('id, compromiso_id, deal_id, monto_usd, fecha, metodo, referencia, is_reversal, bank_tx_id, bank_match_strength')
        .eq('is_reversal', false),
    ])
    setTransactions(txs || [])
    setDeals(ds || [])
    setCobranzaPagos(ccp || [])
    setDiferidaPagos(dfp || [])

    // Lookup tables for client names (needed for namesMatch on cobranza/diferida)
    const contratoIds = Array.from(new Set((ccp || []).map((p: any) => p.contrato_id).filter(Boolean)))
    const compromisoIds = Array.from(new Set((dfp || []).map((p: any) => p.compromiso_id).filter(Boolean)))
    if (contratoIds.length > 0) {
      const { data: contratos } = await supabase
        .from('cobranza_contratos')
        .select('id, cliente_nombre, cliente_cedula, modelo, placa, factura_numero')
        .in('id', contratoIds)
      const m = new Map<string, any>()
      for (const c of (contratos || [])) m.set(c.id, c)
      setContratosMap(m)
    }
    if (compromisoIds.length > 0) {
      const { data: compromisos } = await supabase
        .from('compromisos_inicial_diferida')
        .select('id, cliente_nombre, cliente_rif, deal_id')
        .in('id', compromisoIds)
      const m = new Map<string, any>()
      for (const c of (compromisos || [])) m.set(c.id, c)
      setCompromisosMap(m)
    }
    setLoading(false)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ★ Phase 2: concurrent-safe pagos write
  //
  // All three handlers below (autoMatch / handleManualMatch / confirmIngreso)
  // used to read deal.pagos from stale React state, mutate, and write the
  // whole array back. If Deisi added a pago in auditoria between the page load
  // and Franco clicking "match", her pago would disappear.
  //
  // This helper fetches the deal's CURRENT pagos from the DB right before the
  // write, applies the mutation function to that fresh snapshot, and writes
  // back. Race window drops from minutes to milliseconds.
  //
  // Returns the new pagos array (for updating local state) or null on error.
  // ═══════════════════════════════════════════════════════════════════════════
  const safeUpdateDealPagos = async (
    dealId: string,
    mutate: (currentPagos: any[]) => any[],
    extraFields: Record<string, any> = {}
  ): Promise<any[] | null> => {
    // 1. Fresh read
    const { data: fresh, error: readErr } = await supabase
      .from('deals')
      .select('pagos')
      .eq('id', dealId)
      .single()
    if (readErr || !fresh) return null

    const currentPagos: any[] = Array.isArray(fresh.pagos) ? fresh.pagos : []
    const newPagos = mutate(currentPagos)
    const total_recibido = newPagos.reduce((s: number, p: any) => s + (parseFloat(p.monto_usd) || 0), 0)

    // 2. Write back
    const { error: writeErr } = await supabase
      .from('deals')
      .update({ pagos: newPagos, total_recibido, ...extraFields })
      .eq('id', dealId)
    if (writeErr) return null
    return newPagos
  }

  // Auto-match: try to match unmatched transactions against deal pagos by referencia or amount+date
  // ── Name similarity: checks if any word from sender matches any word from buyer ──
  const namesMatch = (senderRaw: string, buyerNombre: string, buyerApellidos: string): boolean => {
    if (!senderRaw) return false
    const normalize = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
    const senderWords = normalize(senderRaw).split(/\s+/).filter(w => w.length > 2)
    const buyerWords = normalize(`${buyerNombre} ${buyerApellidos}`).split(/\s+/).filter(w => w.length > 2)
    // At least 2 words must match (first + last name typically)
    const matches = senderWords.filter(sw => buyerWords.some(bw => bw === sw || bw.startsWith(sw) || sw.startsWith(bw)))
    return matches.length >= 2
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ★ Phase 3: Fuzzy reference matching for truncated bank statement refs
  //
  // Problem: comprobantes show the full reference (8-12 chars), but bank
  // statements often truncate to 6-8 chars. Exact matching misses these.
  //
  // Strategy:
  //   • "strong truncation" = 6+ char overlap AND amount within $0.50 AND
  //     date within ±2 days. Signal is so specific that we auto-verify.
  //   • "partial" = 6+ char overlap but amount or date don't align — show
  //     as a suggestion in the UI for Franco to one-click approve.
  // ══════════════════════════════════════════════════════════════════════════

  // Normalize a reference for comparison: lowercase, strip non-alphanumeric,
  // strip leading zeros. Banks sometimes prefix zeros on one side only.
  const normalizeRef = (r: string | null | undefined): string => {
    if (!r) return ''
    return r.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+/, '')
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ★ Phase 4 (2026-05-15): Levenshtein-based reference similarity
  //
  // Replaces the old substring-only refOverlapLength. The substring approach
  // missed real-world cases like xs96mepv7 vs xs59mepv7 (same prefix `xs`,
  // same suffix `mepv7`, 2 middle chars transposed → 78% similar).
  //
  // Levenshtein distance counts the minimum single-character edits
  // (insert/delete/substitute) to transform one string into another.
  // refSimilarity normalizes to 0..1 where 1.0 = identical, 0 = nothing in common.
  //
  // Thresholds applied in classifyMatch (Balanced preset):
  //   • exact   ≥ 0.90 (also acts as 'identical' shortcut when normalized equal)
  //   • strong  ≥ 0.70 + amount + date ±2
  //   • partial ≥ 0.60 + amount + date ±5
  // ══════════════════════════════════════════════════════════════════════════
  const levenshtein = (a: string, b: string): number => {
    const m = a.length, n = b.length
    if (m === 0) return n
    if (n === 0) return m
    let prev = new Array(n + 1).fill(0).map((_, i) => i)
    let curr = new Array(n + 1).fill(0)
    for (let i = 1; i <= m; i++) {
      curr[0] = i
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        curr[j] = Math.min(
          curr[j - 1] + 1,        // insertion
          prev[j] + 1,            // deletion
          prev[j - 1] + cost      // substitution
        )
      }
      ;[prev, curr] = [curr, prev]
    }
    return prev[n]
  }

  // Returns 0..1 similarity. Considers substring containment as boost.
  const refSimilarity = (a: string | null | undefined, b: string | null | undefined): number => {
    const na = normalizeRef(a), nb = normalizeRef(b)
    if (!na || !nb) return 0
    if (na === nb) return 1.0
    // Substring boost: if shorter contained in longer with len ≥ 6, treat as ≥0.80
    const shorter = na.length <= nb.length ? na : nb
    const longer  = na.length <= nb.length ? nb : na
    if (shorter.length >= 6 && longer.includes(shorter)) {
      // Score by length ratio — perfect substring of long string still scores well
      return Math.max(0.80, shorter.length / longer.length)
    }
    const dist = levenshtein(na, nb)
    const maxLen = Math.max(na.length, nb.length)
    return Math.max(0, 1 - dist / maxLen)
  }

  // Backwards-compat: refOverlapLength returned a chars count. Some callers use
  // it (e.g. suggestions UI shows "X chars" badge). Now it returns an effective
  // overlap value derived from similarity * shorter length so the UI still makes sense.
  const refOverlapLength = (a: string | null | undefined, b: string | null | undefined, minLen = 6): number => {
    const na = normalizeRef(a), nb = normalizeRef(b)
    if (!na || !nb) return 0
    const sim = refSimilarity(a, b)
    if (sim < 0.50) return 0
    // Effective overlap chars (for UI display only)
    const minRefLen = Math.min(na.length, nb.length)
    return Math.round(sim * minRefLen)
  }

  // Amount match within tolerance (default $0.50 to absorb bank rounding).
  // Decides which currency to compare based on the tx type.
  const amountsMatch = (txMontoUsd: number | null, txMontoBs: number | null, txTipo: string, pagoMontoUsd: number, pagoMontoBs: number): boolean => {
    const isUsdTx = txTipo === 'zelle' || txTipo === 'wire'
    if (isUsdTx && txMontoUsd != null) {
      return Math.abs(txMontoUsd - pagoMontoUsd) <= 0.5
    }
    if (txMontoBs != null) {
      // Bs amounts can be large; use 1% or 1 Bs tolerance, whichever is bigger
      const tolerance = Math.max(1, pagoMontoBs * 0.01)
      return Math.abs(txMontoBs - pagoMontoBs) <= tolerance
    }
    // Fallback: try USD match if we only have pagoMontoUsd
    if (txMontoUsd != null) return Math.abs(txMontoUsd - pagoMontoUsd) <= 0.5
    return false
  }

  // Dates within ±N days. Handles YYYY-MM-DD strings safely.
  const datesMatch = (dateA: string | null | undefined, dateB: string | null | undefined, maxDaysDiff = 2): boolean => {
    if (!dateA || !dateB) return false
    const parse = (s: string): Date | null => {
      // Accept YYYY-MM-DD at noon UTC to avoid timezone drift
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
      if (!m) return null
      return new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`)
    }
    const da = parse(dateA)
    const db = parse(dateB)
    if (!da || !db) return false
    const diffDays = Math.abs((da.getTime() - db.getTime()) / 86400000)
    return diffDays <= maxDaysDiff
  }

  // ── Phase 6 (2026-05-15): Method/account compatibility ─────────────────
  // A bank tx of tipo=zelle can ONLY match a pago whose metodo includes "Zelle".
  // A bank tx of tipo=wire can ONLY match a pago whose metodo is a wire/transfer.
  // Pagos with metodo=Efectivo/USDT/Retención/Saldo a Financiar/Liquidación PIVCA
  // never have a bank counterpart and are filtered out.
  // Additionally, when the pago metodo names a specific account (e.g. "Wire
  // Transfer Panama" vs "Wire Transfer Motocentro"), the tx.cuenta must match.
  //
  // EMPTY METODO POLICY: When the pago metodo is blank/missing (common on
  // historical cobranza data migrated without method info), we allow the
  // candidate to match ANY zelle/wire bank tx. Admin picks from suggestions.
  // The /admin/cobranza-metodo-backfill page lets Mirla fill these in.
  const compatibleMethodAndAccount = (tx: any, pagoMetodoRaw: string | null | undefined): boolean => {
    const m = (pagoMetodoRaw || '').toLowerCase().trim()

    // Empty/unknown metodo → allow (admin will pick from candidates).
    // This unblocks historical cobranza pagos with no method info.
    if (!m || m === '—' || m === '-') return true

    // Reject pagos that never hit the bank
    if (m.includes('efectivo') || m.includes('cash')) return false
    if (m.includes('usdt') || m.includes('crypto')) return false
    if (m.includes('retención') || m.includes('retencion')) return false
    if (m.includes('saldo a financiar') || m.includes('saldo financiar')) return false
    if (m.includes('liquidación pivca') || m.includes('liquidacion pivca')) return false
    if (m.includes('bolívares') || m.includes('bolivares')) return false  // Bs not in our bank_transactions

    // Method-type compatibility
    const txTipo = (tx.tipo || '').toLowerCase()
    if (txTipo === 'zelle') {
      if (!m.includes('zelle')) return false
    } else if (txTipo === 'wire') {
      if (!m.includes('wire') && !m.includes('transfer')) return false
    } else {
      // tx.tipo is unknown/other → no compatibility we can assert
      return false
    }

    // Account compatibility (when pago metodo names a specific account)
    const txCuenta = (tx.cuenta || '').toLowerCase()
    if (m.includes('panama') || m.includes('panamá')) {
      if (txCuenta !== 'panama') return false
    } else if (m.includes('regions')) {
      if (txCuenta !== 'roframi_regions') return false
    } else if (m.includes('roframi')) {
      // "Roframi" without "regions" → match BofA Roframi by default, but also
      // allow roframi_regions in case the pago was tagged generically.
      if (txCuenta !== 'roframi' && txCuenta !== 'roframi_regions') return false
    } else if (m.includes('motocentro')) {
      if (txCuenta !== 'motocentro') return false
    }
    // If metodo doesn't name an account, we don't enforce (e.g. plain "Wire Transfer")

    return true
  }

  // Classify a tx-against-pago match (Balanced thresholds, name overlap NOT required).
  // Strategy:
  //   • exact     identical ref (normalized) OR ≥90% similarity + amount + same day
  //   • strong    ≥70% ref similarity + amount + date ±2 (±5 for wires — Fedwire can post next-day)
  //   • partial   ≥60% ref similarity + amount + date ±5  → goes to Sugerencias UI
  //   • partial   NO-REF path: Zelle (amount + date ±2) OR Wire (amount + date ±5)
  //               → suggestion only, never auto-verified (Phase 6, 2026-05-15)
  //   • none      anything else
  type MatchStrength = 'exact' | 'strong' | 'partial' | 'partial_no_ref' | 'none'
  const classifyMatch = (tx: any, pago: any): MatchStrength => {
    // Phase 6 (2026-05-15): Method/account compatibility gate. Reject upfront
    // if the pago metodo can't possibly correspond to this bank tx.
    if (!compatibleMethodAndAccount(tx, pago.metodo)) return 'none'

    // Best similarity from tx.referencia OR tx.referencia_alt (BofA TRN)
    const sim = Math.max(
      refSimilarity(tx.referencia, pago.referencia),
      refSimilarity(tx.referencia_alt, pago.referencia)
    )

    const amtOk  = amountsMatch(tx.monto_usd, tx.monto_bs, tx.tipo, parseFloat(pago.monto_usd) || 0, parseFloat(pago.monto_bs) || 0)
    const date0  = datesMatch(tx.fecha, pago.fecha, 0)
    const date2  = datesMatch(tx.fecha, pago.fecha, 2)
    const date5  = datesMatch(tx.fecha, pago.fecha, 5)

    // Phase 6 (2026-05-15): wires post next-business-day on Fedwire — widen
    // the "strong" date window to ±5 for wires only. Zelle stays ±2 (instant).
    const strongDateOk = tx.tipo === 'wire' ? date5 : date2

    if (sim > 0) {
      // exact: normalized identical OR ≥90% similarity with amount + same-day
      if (sim >= 0.99) return 'exact'
      if (sim >= 0.90 && amtOk && date0) return 'exact'

      // strong: ≥70% similarity + amount + date (window depends on tipo)
      if (sim >= 0.70 && amtOk && strongDateOk) return 'strong'

      // partial: ≥60% similarity + amount + within 5 days  → suggestion
      if (sim >= 0.60 && amtOk && date5) return 'partial'

      // partial: amount + same-day match even with weak ref similarity (≥40%) →
      // worth showing as a suggestion since amount+date alignment is rare by chance
      if (sim >= 0.40 && amtOk && date0) return 'partial'
    }

    // Phase 6 (2026-05-15): no-ref path. Sender and receiver banks assign
    // DIFFERENT internal refs to the same Zelle, and wires sometimes lack
    // useful refs in our pago records. For zelle/wire txs ONLY, surface
    // (amount + date) as a suggestion candidate. Admin picks from the list.
    //   • Zelle: amount + date ±2 (instant)
    //   • Wire:  amount + date ±5 (next-business-day posting)
    if (amtOk) {
      if (tx.tipo === 'zelle' && date2) return 'partial_no_ref'
      if (tx.tipo === 'wire'  && date5) return 'partial_no_ref'
    }

    return 'none'
  }

  // ── Tier-2: Conciliar con IA ──────────────────────────────────────────
  // Hands the unmatched email-only rows and screenshot-only rows (last 21
  // days) to Claude and asks for proposed duplicate pairs with confidence
  // and reasoning. The AI only SUGGESTS — every merge requires a human
  // Confirmar, and every AI proposal is re-validated deterministically
  // (ids exist, montos within $1, no id reused) before it's even shown.
  const conciliarConIA = async () => {
    setAiBusy(true); setAiErr(null); setAiSugs([]); setAiRan(false)
    try {
      const cutoff = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10)
      const pool = transactions.filter((t: any) =>
        t.fecha >= cutoff && !t.reversed_at && Number(t.monto_usd) > 0)
      // BANCO side (absorbable duplicates): rows whose ONLY evidence is a bank
      // feed — email or statement — with no screenshot. INTERNA side (merge
      // targets, linked to comprobantes): screenshot rows AND no-badge rows
      // (deposit-modal/manual rows predating source flags), INCLUDING rows
      // already merged once (EMAIL+SHOT) — a replayed/re-forwarded email can
      // duplicate an already-merged row (caso Maryolin 2026-06-12).
      const emailOnly = pool.filter((t: any) =>
        (t.seen_in_email || t.seen_in_statement) && !t.seen_in_screenshot).slice(0, 40)
      const shotOnly = pool.filter((t: any) =>
        t.seen_in_screenshot || (!t.seen_in_email && !t.seen_in_statement)).slice(0, 40)
      if (emailOnly.length === 0 || shotOnly.length === 0) {
        setAiRan(true)
        setAiErr(null)
        setAiBusy(false)
        return
      }
      const slim = (t: any) => ({
        id: t.id, cuenta: t.cuenta, fecha: t.fecha, monto_usd: Number(t.monto_usd),
        tipo: t.tipo || null, direccion: t.direccion || null,
        sender: t.sender_name || null, referencia: t.referencia || null,
        fuentes: [t.seen_in_email && 'email', t.seen_in_statement && 'stmt', t.seen_in_screenshot && 'shot'].filter(Boolean),
      })
      const prompt = `Eres un asistente de conciliación bancaria de un concesionario en Venezuela. Tienes dos listas de transacciones bancarias:
- BANCO: filas cuya única evidencia es un feed del banco (correo de alerta o estado de cuenta). El sender es el titular real de la cuenta emisora.
- INTERNA: filas creadas por el personal (capturas de comprobantes, módulo de depósitos). El sender puede ser el nombre del cliente, un familiar, o incluso el destinatario por errores de OCR. Algunas ya tienen fuente email (fueron fusionadas antes) — un correo reenviado/duplicado en BANCO puede corresponder a una de estas.

Cada par BANCO+INTERNA que represente la MISMA transacción real es un duplicado que debe fusionarse. Propón los pares.

REGLAS ESTRICTAS:
- monto_usd debe ser igual (tolerancia máxima $1).
- direccion debe coincidir (nunca parear un depósito con un egreso).
- fecha dentro de 5 días.
- misma cuenta es señal fuerte; cuentas distintas SOLO si hay otra razón fuerte (marca "cuenta_diferente": true).
- Los senders pueden diferir totalmente (Zelle: paga un familiar). Explica la relación probable en "razon".
- Cada id puede aparecer en UN solo par.
- Omite pares con confianza menor a 60.
- Si no hay pares, devuelve [].

BANCO = ${JSON.stringify(emailOnly.map(slim))}
INTERNA = ${JSON.stringify(shotOnly.map(slim))}

Responde SOLO con un array JSON, sin markdown ni texto adicional ("email_id" = id de BANCO, "screenshot_id" = id de INTERNA):
[{"email_id":"<uuid>","screenshot_id":"<uuid>","confianza":<0-100>,"cuenta_diferente":<true|false>,"razon":"<máx 25 palabras en español>"}]`

      const resp = await fetch(COMPROBANTE_WORKER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 1500,
        }),
      })
      const data = await resp.json()
      const textBlock = (data.content || []).find((b: any) => b.type === 'text')
      const raw = (textBlock?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      let parsed: any[] = []
      try { parsed = JSON.parse(raw) } catch { throw new Error('La IA no devolvió JSON válido.') }
      if (!Array.isArray(parsed)) parsed = []

      // Deterministic re-validation — never trust raw model output for money.
      const emailMap = new Map(emailOnly.map((t: any) => [t.id, t]))
      const shotMap  = new Map(shotOnly.map((t: any) => [t.id, t]))
      const usedE = new Set<string>(); const usedS = new Set<string>()
      const valid: any[] = []
      for (const p of parsed) {
        const e = emailMap.get(p?.email_id); const sh = shotMap.get(p?.screenshot_id)
        if (!e || !sh) continue
        if (usedE.has(e.id) || usedS.has(sh.id)) continue
        if (Math.abs(Number(e.monto_usd) - Number(sh.monto_usd)) > 1) continue
        if (e.direccion && sh.direccion && e.direccion !== sh.direccion) continue
        const conf = Math.max(0, Math.min(100, Number(p.confianza) || 0))
        if (conf < 60) continue
        usedE.add(e.id); usedS.add(sh.id)
        valid.push({
          key: e.id + '|' + sh.id,
          email: e, shot: sh,
          confianza: conf,
          cuenta_diferente: e.cuenta !== sh.cuenta,
          razon: String(p.razon || '').slice(0, 300),
        })
      }
      valid.sort((a, b) => b.confianza - a.confianza)
      setAiSugs(valid)

      // ── Pass 2: bancarizaciones en tránsito ↔ depósitos del banco ──────
      // A $20k handoff can arrive as $17,050 + $2,950 (caso Daniel Woginiak).
      // The AI proposes the grouping; arithmetic is enforced here (suma ≤
      // restante, net-zero closes), and Confirmar feeds the SAME partial-
      // deposit machinery as the comprobante detail page.
      await conciliarBancarizaciones(pool)
      setAiRan(true)
    } catch (e: any) {
      setAiErr(e?.message || 'Error en la conciliación con IA')
      setAiRan(true)
    } finally { setAiBusy(false) }
  }

  const conciliarBancarizaciones = async (pool: any[]) => {
    setAiBancSugs([])
    // Open bancarizaciones (any age — backlog is real).
    const { data: comps } = await (supabase
      .from('tesoreria_comprobantes')
      .select('id, numero, monto_usd, monto_depositado, bancarizador_nombre, egreso_dirigido_a, estado, solicitado_at, bancarizacion_ruta')
      .eq('egreso_tipo', 'BANCARIZACION')
      .in('estado', ['ENTREGADO_BANCARIZADOR', 'DEPOSITADO_PARCIAL']) as any)
    const pendientes = (Array.isArray(comps) ? comps : [])
      .map((c: any) => ({
        ...c,
        restante: Number(c.monto_usd) - Number(c.monto_depositado || 0),
      }))
      .filter((c: any) => c.restante > 0.005)
    if (pendientes.length === 0) return

    // Deposits already attributed to a comprobante (child ledger + legacy link).
    const { data: usados } = await (supabase
      .from('tesoreria_comprobante_depositos')
      .select('bank_transaction_id') as any)
    const usedTx = new Set<string>((Array.isArray(usados) ? usados : [])
      .map((u: any) => u.bank_transaction_id).filter(Boolean))

    // Candidate deposits: bank-feed credits, last 60 days, not yet attributed.
    const cutoff60 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10)
    const deposits = pool.filter((t: any) =>
      t.fecha >= cutoff60 &&
      (t.seen_in_email || t.seen_in_statement) &&
      (t.direccion ? t.direccion === 'credit' : true) &&
      !usedTx.has(t.id) &&
      !t.deal_id)
      .slice(0, 60)
    if (deposits.length === 0) return

    const slimC = (c: any) => ({
      id: c.id, numero: c.numero,
      bancarizador: c.bancarizador_nombre || c.egreso_dirigido_a || null,
      ruta: c.bancarizacion_ruta || 'via_mirla',   // 'directa' suele indicar origen USDT
      monto_total: Number(c.monto_usd), ya_depositado: Number(c.monto_depositado || 0),
      restante: c.restante, entregado: (c.solicitado_at || '').slice(0, 10),
    })
    const slimD = (t: any) => ({
      id: t.id, cuenta: t.cuenta, fecha: t.fecha, monto: Number(t.monto_usd),
      tipo: t.tipo || null, sender: t.sender_name || null, referencia: t.referencia || null,
    })
    const prompt = `Eres un analista de conciliación de bancarizaciones de un concesionario en Venezuela. Entregamos valor a bancarizadores — efectivo (ruta via_mirla) y/o USDT (ruta directa) — y ellos lo depositan en nuestras cuentas bancarias. Las combinaciones reales incluyen:
- Una entrega de $20,000 llega como VARIOS depósitos parciales ($17,050 + $2,950).
- VARIAS entregas al mismo bancarizador (ej. $10,000 en efectivo + $10,000 en USDT, dos comprobantes) llegan como UN solo depósito de $20,000.
- Cualquier combinación M depósitos ↔ N bancarizaciones del mismo bancarizador.

BANCARIZACIONES PENDIENTES (valor entregado, esperando depósitos) = ${JSON.stringify(pendientes.map(slimC))}
DEPOSITOS SIN ATRIBUIR (feeds del banco) = ${JSON.stringify(deposits.map(slimD))}

Propón grupos. Cada grupo tiene depósito(s) y una distribución ("asignaciones") de su suma entre bancarización(es).
REGLAS ESTRICTAS:
- La suma de las asignaciones debe ser EXACTAMENTE igual a la suma de los depósitos del grupo (cada dólar depositado se asigna a alguna bancarización).
- Cada asignación debe ser MENOR O IGUAL al restante de su bancarización. Cierre exacto del restante es preferido; menor = avance parcial. NUNCA mayor.
- Todas las bancarizaciones de un grupo deben ser del MISMO bancarizador (variantes de nombre cuentan: "MEDROD CORP" ↔ "Javier Medina Medrod Corp").
- El sender del depósito suele ser el bancarizador o su empresa. Senders sin relación bajan la confianza.
- Los depósitos llegan días DESPUÉS de la fecha de entrega, nunca antes.
- COMISIONES: es común que el depósito llegue LIGERAMENTE MENOR que lo entregado (ej.: entregas de $25,000 + $19,200 = $44,200 llegan como un depósito de $44,185 por $15 de comisión). Propón el grupo igual: asigna TODO el depósito; una bancarización queda parcial con el pequeño faltante pendiente. Un faltante pequeño (hasta ~1% o ~$100) NO baja la confianza.
- Cada depósito y cada bancarización pueden usarse en UN solo grupo.
- Omite grupos con confianza menor a 60. Si no hay grupos, devuelve [].

Responde SOLO con un array JSON, sin markdown:
[{"deposito_ids":["<uuid>"],"asignaciones":[{"comprobante_id":"<uuid>","monto":<número>}],"confianza":<0-100>,"razon":"<máx 35 palabras en español>"}]`

    const resp = await fetch(COMPROBANTE_WORKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1500,
      }),
    })
    const data = await resp.json()
    const textBlock = (data.content || []).find((b: any) => b.type === 'text')
    const raw = (textBlock?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let parsed: any[] = []
    try { parsed = JSON.parse(raw) } catch { return }
    if (!Array.isArray(parsed)) return

    // Deterministic re-validation: ids exist, nothing reused, every deposited
    // dollar allocated, no allocation exceeds its restante. The AI proposes;
    // the arithmetic decides.
    const compMap = new Map(pendientes.map((c: any) => [c.id, c]))
    const depMap = new Map(deposits.map((d: any) => [d.id, d]))
    const usedD = new Set<string>(); const usedC = new Set<string>()
    const validB: any[] = []
    for (const g of parsed) {
      const ids: string[] = Array.isArray(g?.deposito_ids) ? g.deposito_ids : []
      const txs = ids.map(id => depMap.get(id)).filter(Boolean)
      if (txs.length === 0 || txs.length !== ids.length) continue
      if (txs.some((t: any) => usedD.has(t.id))) continue
      const rawAsigs: any[] = Array.isArray(g?.asignaciones) ? g.asignaciones : []
      const asigs = rawAsigs.map(a => ({ comp: compMap.get(a?.comprobante_id), monto: Number(a?.monto) || 0 }))
      if (asigs.length === 0 || asigs.some(a => !a.comp || a.monto <= 0)) continue
      const compIds = asigs.map(a => a.comp.id)
      if (new Set(compIds).size !== compIds.length) continue        // dup comp within group
      if (compIds.some(id => usedC.has(id))) continue               // comp reused across groups
      if (asigs.some(a => a.monto > a.comp.restante + 0.005)) continue
      const sumaD = txs.reduce((s: number, t: any) => s + Number(t.monto_usd), 0)
      const sumaA = asigs.reduce((s: number, a: any) => s + a.monto, 0)
      if (Math.abs(sumaD - sumaA) > 0.005) continue                 // every dollar lands somewhere
      const conf = Math.max(0, Math.min(100, Number(g.confianza) || 0))
      if (conf < 60) continue
      txs.forEach((t: any) => usedD.add(t.id))
      compIds.forEach(id => usedC.add(id))
      validB.push({
        key: compIds.join(',') + '|' + ids.join(','),
        asigs, txs, suma: sumaD,
        confianza: conf,
        razon: String(g.razon || '').slice(0, 300),
      })
    }
    validB.sort((a, b) => b.confianza - a.confianza)
    setAiBancSugs(validB)
  }

  // Attach an AI-confirmed deposit group to its bancarización(es) — same
  // machinery as the comprobante detail page, but the bank rows already
  // exist. A waterfall allocator splits the deposit montos across the
  // asignaciones deterministically, so a $20k wire can cover a $10k cash
  // EGR + a $10k USDT EGR with two child rows pointing at the same tx.
  const confirmarBancSugerencia = async (sug: any) => {
    setAiConfirming(sug.key); setAiErr(null)
    try {
      const { data: au } = await supabase.auth.getUser()
      const uid = au?.user?.id || null

      // Waterfall: consume deposits in order, fill asignaciones in order.
      // Emits (comp, tx, monto) slices whose totals reproduce both sides.
      const slices: { comp: any; tx: any; monto: number }[] = []
      const txQueue = sug.txs.map((t: any) => ({ tx: t, rem: Number(t.monto_usd) }))
      let qi = 0
      for (const a of sug.asigs) {
        let need = a.monto
        while (need > 0.0049 && qi < txQueue.length) {
          const cur = txQueue[qi]
          const take = Math.min(need, cur.rem)
          slices.push({ comp: a.comp, tx: cur.tx, monto: Math.round(take * 100) / 100 })
          need -= take; cur.rem -= take
          if (cur.rem <= 0.0049) qi++
        }
        if (need > 0.0049) throw new Error('Asignación inconsistente — no se ejecutó nada.')
      }

      // 1. Child ledger rows.
      for (const sl of slices) {
        const bancNombre = sl.comp.bancarizador_nombre || sl.comp.egreso_dirigido_a || null
        const { error: depErr } = await supabase.from('tesoreria_comprobante_depositos').insert({
          comprobante_id: sl.comp.id,
          bank_transaction_id: sl.tx.id,
          monto_usd: sl.monto,
          fecha: sl.tx.fecha,
          referencia: sl.tx.referencia || null,
          cuenta: sl.tx.cuenta || 'UNKNOWN',
          documento_url: null,
          ai_review: { source: 'ai_conciliacion_banco', confianza: sug.confianza, razon: sug.razon },
          registered_by: uid,
        })
        if (depErr) throw new Error('No se pudo registrar el depósito en el ledger: ' + depErr.message)
        await supabase.from('bank_transactions').update({
          es_bancarizacion: true,
          banc_depositante: bancNombre,
          matched: true,
        }).eq('id', sl.tx.id)
      }

      // 2. Per-comprobante accumulation + estado + evento.
      for (const a of sug.asigs) {
        const c = a.comp
        const nuevoTotal = Number(c.monto_depositado || 0) + a.monto
        const completo = nuevoTotal >= Number(c.monto_usd) - 0.005
        const lastTx = slices.filter(sl => sl.comp.id === c.id).slice(-1)[0]?.tx
        const { error: upErr } = await supabase.from('tesoreria_comprobantes').update({
          estado: completo ? 'DEPOSITADO' : 'DEPOSITADO_PARCIAL',
          cerrado_at: completo ? new Date().toISOString() : null,
          monto_depositado: nuevoTotal,
          bank_transaction_id: lastTx ? lastTx.id : null,
        }).eq('id', c.id).in('estado', ['ENTREGADO_BANCARIZADOR', 'DEPOSITADO_PARCIAL'])
        if (upErr) throw new Error(`${c.numero}: depósitos registrados pero el comprobante no se actualizó: ` + upErr.message)
        await supabase.from('tesoreria_comprobante_eventos').insert({
          comprobante_id: c.id,
          evento: completo ? 'DEPOSITADO' : 'DEPOSITO_PARCIAL',
          actor_user_id: uid,
          actor_label: 'Conciliación IA (confirmada)',
          notas: `Conciliado con IA desde /banco: ${fmt(a.monto)} asignados de ${sug.txs.length} depósito(s) (grupo ${fmt(sug.suma)})` +
            (completo ? ` — completa ${fmt(nuevoTotal)} de ${fmt(c.monto_usd)}.` : ` — van ${fmt(nuevoTotal)} de ${fmt(c.monto_usd)}, faltan ${fmt(Number(c.monto_usd) - nuevoTotal)}.`) +
            ` Razón IA: ${sug.razon}`,
        })
      }
      setAiBancSugs(prev => prev.filter(x => x.key !== sug.key))
      await load()
    } catch (err: any) {
      setAiErr(err?.message || 'Error al conciliar la bancarización')
    } finally { setAiConfirming(null) }
  }

  // Merge one AI-confirmed pair: absorb the email row into the screenshot
  // row (the one linked to comprobantes), exactly like the manual merges of
  // 2026-06-12. Order matters: repoint the bofa_email_log FK BEFORE deleting.
  const confirmarSugerencia = async (sug: any) => {
    setAiConfirming(sug.key); setAiErr(null)
    try {
      const e = sug.email, sh = sug.shot
      // 1. Repoint email-log rows (FK bofa_email_log.bank_tx_id).
      const { error: logErr } = await supabase.from('bofa_email_log')
        .update({ bank_tx_id: sh.id }).eq('bank_tx_id', e.id)
      if (logErr) throw new Error('No se pudo reasignar bofa_email_log: ' + logErr.message)
      // 2. Absorb into the screenshot row. Bank truth wins for sender/cuenta.
      const logEntry = {
        source: 'ai_conciliacion', at: new Date().toISOString(),
        email_tx_id: e.id, confianza: sug.confianza, razon: sug.razon,
        ...(sh.sender_name && e.sender_name && sh.sender_name !== e.sender_name
          ? { sender_discrepancy: { screenshot: sh.sender_name, email: e.sender_name } } : {}),
      }
      const patch: any = {
        seen_in_email: !!(sh.seen_in_email || e.seen_in_email),
        seen_in_statement: !!(sh.seen_in_statement || e.seen_in_statement),
        sources_log: [ ...(Array.isArray(sh.sources_log) ? sh.sources_log : []), logEntry ],
      }
      if (e.sender_name) patch.sender_name = e.sender_name
      if (sug.cuenta_diferente && e.cuenta) patch.cuenta = e.cuenta
      if (!sh.referencia && e.referencia) patch.referencia = e.referencia
      const { error: upErr } = await supabase.from('bank_transactions')
        .update(patch).eq('id', sh.id)
      if (upErr) throw new Error('No se pudo actualizar la fila destino: ' + upErr.message)
      // 3. Delete the email-only duplicate.
      const { error: delErr } = await supabase.from('bank_transactions')
        .delete().eq('id', e.id)
      if (delErr) throw new Error('Fila fusionada, pero el duplicado no se pudo borrar (¿RLS de DELETE?): ' + delErr.message)
      setAiSugs(prev => prev.filter(x => x.key !== sug.key))
      await load()
    } catch (err: any) {
      setAiErr(err?.message || 'Error al fusionar')
    } finally { setAiConfirming(null) }
  }

  const autoMatch = async () => {
    setMatching(true)
    try {
    // Bank reconciliation Phase 1: exclude internal transfers and bank fees from autoMatch
    // (they should never match cobranza receipts). Also exclude egresos.
    const unmatched = transactions.filter(tx =>
      !tx.matched &&
      tx.referencia &&
      !tx.is_internal &&
      !tx.is_bank_fee &&
      tx.flujo !== 'egreso'
    )
    let autoVerified = 0
    let truncatedVerified = 0
    let thirdPartyFlagged = 0
    let cobranzaMatched = 0
    let diferidaMatched = 0
    let writeErrors = 0

    // ════════════════════════════════════════════════════════════════════════
    // Phase 5 (2026-05-15): unified candidate list across THREE pago sources.
    //
    // Each candidate normalizes its source-specific columns into a common
    // shape that classifyMatch can consume (referencia, monto_usd, monto_bs,
    // fecha, tipo). Then we ALSO carry source metadata + a write-back routine.
    //
    // Order of candidates by source is irrelevant — we evaluate every one
    // against every unmatched tx and pick the best per tx. But to keep the
    // outer loop fast we pre-build the list once.
    // ════════════════════════════════════════════════════════════════════════
    type Candidate = {
      source: 'deal' | 'cobranza' | 'diferida'
      pago: any                  // normalized to look like a deal.pagos[] entry
      // For name verification
      clienteNombre: string
      clienteApellidos: string
      // For dispatch
      dealId?: string
      cobranzaPagoId?: string
      diferidaPagoId?: string
      // For human-facing label in alerts
      label: string
    }
    const candidates: Candidate[] = []

    // -- deals.pagos[]
    for (const deal of deals) {
      const pagos: any[] = Array.isArray(deal.pagos) ? deal.pagos : []
      pagos.forEach((p: any) => {
        if (p._verified_by_bank) return  // already linked
        candidates.push({
          source: 'deal',
          pago: p,
          clienteNombre: deal.cliente_nombre || '',
          clienteApellidos: deal.cliente_apellidos || '',
          dealId: deal.id,
          label: `Negocio #${deal.negocio_num}`,
        })
      })
    }
    // -- cobranza_cuota_pagos. Normalize column names to common shape.
    for (const cp of cobranzaPagos) {
      if (cp.bank_tx_id) continue  // already linked
      const contrato = contratosMap.get(cp.contrato_id)
      const clienteFull = (contrato?.cliente_nombre || '').trim()
      // Heuristic split: assume the LAST word(s) is apellidos. namesMatch is
      // tolerant though — full string in cliente_nombre still works.
      const parts = clienteFull.split(/\s+/)
      const half = Math.ceil(parts.length / 2)
      const nom = parts.slice(0, half).join(' ')
      const ape = parts.slice(half).join(' ')
      // Determine tipo from metodo_pago for amountsMatch (which uses USD vs Bs based on tipo)
      const metodo = (cp.metodo_pago || '').toLowerCase()
      const tipo = metodo.includes('zelle') ? 'zelle' : metodo.includes('wire') ? 'wire' : metodo.includes('transfer') ? 'wire' : 'other'
      candidates.push({
        source: 'cobranza',
        pago: {
          fecha: cp.fecha_pago,
          monto_usd: cp.monto_usd,
          monto_bs: null,
          referencia: cp.referencia_pago,
          tipo,
          metodo: cp.metodo_pago || '',  // Phase 6: needed for compatibility gate
        },
        clienteNombre: nom,
        clienteApellidos: ape,
        cobranzaPagoId: cp.id,
        label: `Cobranza ${contrato?.factura_numero || ''} (${clienteFull || '—'})`,
      })
    }
    // -- compromisos_inicial_diferida_pagos. Same normalization.
    for (const dp of diferidaPagos) {
      if (dp.bank_tx_id) continue  // already linked
      const compromiso = compromisosMap.get(dp.compromiso_id)
      const clienteFull = (compromiso?.cliente_nombre || '').trim()
      const parts = clienteFull.split(/\s+/)
      const half = Math.ceil(parts.length / 2)
      const nom = parts.slice(0, half).join(' ')
      const ape = parts.slice(half).join(' ')
      const metodo = (dp.metodo || '').toLowerCase()
      const tipo = metodo.includes('zelle') ? 'zelle' : metodo.includes('wire') ? 'wire' : metodo.includes('transfer') ? 'wire' : 'other'
      candidates.push({
        source: 'diferida',
        pago: {
          fecha: dp.fecha,
          monto_usd: dp.monto_usd,
          monto_bs: null,
          referencia: dp.referencia,
          tipo,
          metodo: dp.metodo || '',  // Phase 6: needed for compatibility gate
        },
        clienteNombre: nom,
        clienteApellidos: ape,
        diferidaPagoId: dp.id,
        label: `Diferida (${clienteFull || '—'})`,
      })
    }

    // Main loop: for each unmatched tx, find the best candidate across all sources
    for (const tx of unmatched) {
      let bestCand: Candidate | null = null
      let bestStrength: 'exact' | 'strong' = 'strong'
      for (const c of candidates) {
        const strength = classifyMatch(tx, c.pago)
        if (strength === 'exact') { bestCand = c; bestStrength = 'exact'; break }
        if (strength === 'strong' && !bestCand) { bestCand = c; bestStrength = 'strong' }
      }
      if (!bestCand) continue

      const senderMatchesBuyer = namesMatch(tx.sender_name || '', bestCand.clienteNombre, bestCand.clienteApellidos)

      // ── Dispatch by source ────────────────────────────────────────────
      if (bestCand.source === 'deal' && bestCand.dealId) {
        if (senderMatchesBuyer) {
          const result = await safeUpdateDealPagos(bestCand.dealId, (currentPagos) =>
            currentPagos.map((p: any) => {
              const s = classifyMatch(tx, p)
              if (s === 'exact' || s === 'strong') {
                return {
                  ...p,
                  _verified_by_bank: true,
                  _verified_at: new Date().toISOString(),
                  _bank_tx_id: tx.id,
                  _match_strength: s,
                }
              }
              return p
            })
          )
          if (result === null) { writeErrors++; continue }
          await supabase.from('bank_transactions').update({
            deal_id: bestCand.dealId,
            matched: true,
            is_third_party: false,
            suggested_as_ingreso: false,
            ingreso_confirmed: true,
          }).eq('id', tx.id)
          if (bestStrength === 'exact') autoVerified++
          else truncatedVerified++
          // Update local state so the UI reflects the match immediately
          setDeals(prev => prev.map(d => d.id === bestCand!.dealId
            ? { ...d, pagos: (Array.isArray(d.pagos) ? d.pagos : []).map((p: any) => {
                const s = classifyMatch(tx, p)
                return (s === 'exact' || s === 'strong')
                  ? { ...p, _verified_by_bank: true, _verified_at: new Date().toISOString(), _bank_tx_id: tx.id, _match_strength: s }
                  : p
              })}
            : d))
        } else {
          // Reference + amount + date all match BUT sender name differs → third party
          await supabase.from('bank_transactions').update({
            deal_id: bestCand.dealId,
            matched: true,
            is_third_party: true,
            suggested_as_ingreso: false,
          }).eq('id', tx.id)
          thirdPartyFlagged++
        }
      } else if (bestCand.source === 'cobranza' && bestCand.cobranzaPagoId) {
        // Update cobranza_cuota_pagos.bank_tx_id directly.
        // We DON'T gate this on sender_match like deals — cobranza customers
        // often pay through a relative's account legitimately, and the
        // approval flow already exists in Portal /verificar. The link is
        // informational: Mirla approves in Portal seeing the match.
        const { error: ccpErr } = await supabase
          .from('cobranza_cuota_pagos')
          .update({
            bank_tx_id: tx.id,
            bank_match_strength: bestStrength,
          })
          .eq('id', bestCand.cobranzaPagoId)
          .is('bank_tx_id', null)  // concurrent-safety: don't overwrite another match
        if (ccpErr) { writeErrors++; continue }
        await supabase.from('bank_transactions').update({
          matched: true,
          is_third_party: !senderMatchesBuyer,
          ingreso_confirmed: senderMatchesBuyer,
          // Note: deal_id stays NULL — this isn't a deal payment.
        }).eq('id', tx.id)
        cobranzaMatched++
        // Update local state
        setCobranzaPagos(prev => prev.map(cp => cp.id === bestCand!.cobranzaPagoId
          ? { ...cp, bank_tx_id: tx.id, bank_match_strength: bestStrength }
          : cp))
      } else if (bestCand.source === 'diferida' && bestCand.diferidaPagoId) {
        const { error: dfpErr } = await supabase
          .from('compromisos_inicial_diferida_pagos')
          .update({
            bank_tx_id: tx.id,
            bank_match_strength: bestStrength,
          })
          .eq('id', bestCand.diferidaPagoId)
          .is('bank_tx_id', null)
        if (dfpErr) { writeErrors++; continue }
        await supabase.from('bank_transactions').update({
          matched: true,
          is_third_party: !senderMatchesBuyer,
          ingreso_confirmed: senderMatchesBuyer,
        }).eq('id', tx.id)
        diferidaMatched++
        setDiferidaPagos(prev => prev.map(dp => dp.id === bestCand!.diferidaPagoId
          ? { ...dp, bank_tx_id: tx.id, bank_match_strength: bestStrength }
          : dp))
      }
    }

    await load()
    const parts = []
    if (autoVerified > 0) parts.push(`✅ ${autoVerified} verificados (negocio · ref exacta)`)
    if (truncatedVerified > 0) parts.push(`✅ ${truncatedVerified} verificados (negocio · ref similar + monto + fecha)`)
    if (cobranzaMatched > 0) parts.push(`💰 ${cobranzaMatched} vinculados a Cobranza (Portal)`)
    if (diferidaMatched > 0) parts.push(`📋 ${diferidaMatched} vinculados a Inicial Diferida`)
    if (thirdPartyFlagged > 0) parts.push(`⚠ ${thirdPartyFlagged} de terceros — requieren Declaración`)
    if (writeErrors > 0) parts.push(`⚠ ${writeErrors} con error de escritura — vuelve a intentar`)
    if (parts.length === 0) alert('No se encontraron nuevas coincidencias.\n\nRevisa las sugerencias (tx en amarillo) para confirmar manualmente.')
    else alert(parts.join('\n'))
    } catch (e: any) {
      // Without this, any throw inside autoMatch left the button stuck on
      // "Conciliando..." with no feedback. Surface the real error so it can be
      // diagnosed, and guarantee the spinner resets via finally.
      console.error('autoMatch failed:', e)
      alert('Error al conciliar: ' + (e?.message || String(e)) + '\n\nAbre la consola (F12) y reporta el mensaje.')
    } finally {
      setMatching(false)
    }
  }

  const handleManualMatch = async () => {
    if (!selectedTx || !matchDealId || linking) return
    setLinking(true)
    try {
      const key = matchDealId.trim()
      const deal = deals.find(d => String(d.negocio_num) === key || String(d.id) === key)
      if (!deal) { alert('Negocio no encontrado'); return }

      const senderName     = selectedTx.sender_name || ''
      const txRef          = (selectedTx.referencia || '').toLowerCase().replace(/\s/g, '')
      const buyerNombre    = deal.cliente_nombre || ''
      const buyerApellidos = (deal as any).cliente_apellidos || ''
      const senderMatchesBuyer = namesMatch(senderName, buyerNombre, buyerApellidos)

      if (senderMatchesBuyer && txRef) {
        // Verified buyer payment with a reference: mark the matching pago.
        const result = await safeUpdateDealPagos(deal.id, (currentPagos) =>
          currentPagos.map((p: any) =>
            (p && p.referencia && String(p.referencia).toLowerCase().replace(/\s/g, '') === txRef)
              ? { ...p, _verified_by_bank: true, _verified_at: new Date().toISOString(), _bank_tx_id: selectedTx.id, _match_strength: 'manual' }
              : p
          )
        )
        if (result === null) { alert('Error al actualizar el pago. Vuelve a intentar.'); return }
        const { data, error } = await supabase
          .from('bank_transactions')
          .update({ deal_id: deal.id, matched: true, is_third_party: false, ingreso_confirmed: true })
          .eq('id', selectedTx.id)
          .select('id')
        if (error) { alert('No se pudo ligar la transacción: ' + error.message); return }
        if (!data || data.length === 0) { alert('La transacción no se actualizó (posible permiso/RLS sobre bank_transactions).'); return }
      } else {
        // Third-party (or no reference): link the tx to the deal, flag tercero.
        const { data, error } = await supabase
          .from('bank_transactions')
          .update({ deal_id: deal.id, matched: true, is_third_party: !senderMatchesBuyer })
          .eq('id', selectedTx.id)
          .select('id')
        if (error) { alert('No se pudo ligar la transacción: ' + error.message); return }
        if (!data || data.length === 0) { alert('La transacción no se actualizó (posible permiso/RLS sobre bank_transactions).'); return }
      }

      setSelectedTx(null)
      setMatchDealId('')
      await load()
    } catch (e: any) {
      console.error('handleManualMatch failed:', e)
      alert('Error al ligar: ' + (e?.message || String(e)) + '\n\nAbre la consola (F12) y reporta el mensaje.')
    } finally {
      setLinking(false)
    }
  }

  const unmatch = async (tx: any) => {
    await supabase.from('bank_transactions').update({ deal_id: null, matched: false, is_third_party: false }).eq('id', tx.id)
    await load()
  }

  const confirmIngreso = async (tx: any, deal: any) => {
    if (!deal || addingIngreso) return
    setAddingIngreso(true)
    const tasa = parseFloat(deal.tasa_bcv) || 1
    const newPago = {
      metodo: tx.tipo === 'zelle' ? 'Zelle Motocentro' : tx.tipo === 'wire' ? 'Wire Transfer' : 'Transferencia',
      fecha: tx.fecha || new Date().toISOString().slice(0, 10),
      monto_usd: tx.monto_usd || 0,
      monto_bs: (tx.monto_usd || 0) * tasa,
      referencia: tx.referencia || '',
      comentario: 'Auto-verificado desde estado de cuenta · ' + (tx.sender_name || ''),
      _bank_tx_id: tx.id,
      _verified_by_bank: true,
      _verified_at: new Date().toISOString(),
      _match_strength: 'manual',
    }

    // ★ Phase 2: concurrent-safe append. The dedup check reads the FRESH pagos
    // from the DB, not stale React state. So if Deisi already added this same
    // bank tx from auditoria, we detect it and refuse instead of double-booking.
    let duplicateDetected = false
    const result = await safeUpdateDealPagos(deal.id, (currentPagos) => {
      const alreadyAdded = currentPagos.some((p: any) =>
        p._bank_tx_id === tx.id || (p.referencia && p.referencia === tx.referencia && p.referencia !== '')
      )
      if (alreadyAdded) {
        duplicateDetected = true
        return currentPagos  // no-op
      }
      return [...currentPagos, newPago]
    })

    if (duplicateDetected) {
      alert('Este pago ya fue agregado a este negocio.')
      setAddingIngreso(false)
      setConfirmingTx(null)
      return
    }
    if (result === null) {
      alert('Error al guardar. Vuelve a intentar.')
      setAddingIngreso(false)
      return
    }

    await supabase.from('bank_transactions').update({ ingreso_confirmed: true, ingreso_confirmed_at: new Date().toISOString() }).eq('id', tx.id)
    setAddingIngreso(false)
    setConfirmingTx(null)
    await load()
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ★ Bancarización: tag a bank deposit as "I converted shop cash to bank"
  //   Not tied to any deal. Tracks who brought the cash + optional commission.
  // ══════════════════════════════════════════════════════════════════════════
  const openBancEditor = (tx: any) => {
    setBancEditor({
      txId: tx.id,
      depositante: tx.banc_depositante || '',
      esTercero:   !!tx.banc_es_tercero,
      comision:    tx.banc_comision_usd ? String(tx.banc_comision_usd) : '',
    })
  }
  const saveBancEditor = async () => {
    if (!bancEditor) return
    const payload = {
      es_bancarizacion: true,
      banc_depositante: bancEditor.depositante.trim() || null,
      banc_es_tercero:  bancEditor.esTercero,
      banc_comision_usd: bancEditor.comision ? parseFloat(bancEditor.comision) || 0 : 0,
      matched: true,            // a tagged bancarización is "resolved"
      is_third_party: false,
    }
    const { error } = await supabase.from('bank_transactions').update(payload).eq('id', bancEditor.txId)
    if (error) { alert('Error: ' + error.message); return }
    setBancEditor(null)
    await load()
  }
  const removeBanc = async (tx: any) => {
    if (!confirm('¿Quitar el tag de Bancarización de esta transacción?')) return
    const { error } = await supabase.from('bank_transactions').update({
      es_bancarizacion: false,
      banc_depositante: null,
      banc_es_tercero: false,
      banc_comision_usd: 0,
      // leave matched as-is — user might re-tag or match to a deal
    }).eq('id', tx.id)
    if (error) { alert('Error: ' + error.message); return }
    await load()
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ★ Compra de Unidades: tag debits to suppliers (Venekia etc.)
  //   Autotagged on scan when sender matches /VENEKIA/i, but user can
  //   manually tag or untag here.
  // ══════════════════════════════════════════════════════════════════════════
  const openCompraEditor = (tx: any) => {
    setCompraEditor({
      txId: tx.id,
      proveedor: tx.compra_proveedor || 'VENEKIA DISTRIBUCIONES CA',
    })
  }
  const saveCompraEditor = async () => {
    if (!compraEditor) return
    const { error } = await supabase.from('bank_transactions').update({
      es_compra_unidades: true,
      compra_proveedor: compraEditor.proveedor.trim() || 'VENEKIA DISTRIBUCIONES CA',
      matched: true,
      is_third_party: false,
    }).eq('id', compraEditor.txId)
    if (error) { alert('Error: ' + error.message); return }
    setCompraEditor(null)
    await load()
  }
  const removeCompra = async (tx: any) => {
    if (!confirm('¿Quitar el tag de Compra de Unidades?')) return
    const { error } = await supabase.from('bank_transactions').update({
      es_compra_unidades: false,
      compra_proveedor: null,
    }).eq('id', tx.id)
    if (error) { alert('Error: ' + error.message); return }
    await load()
  }

  // Filter
  let filtered = transactions
  if (filter === 'unmatched')     filtered = filtered.filter(tx => !tx.matched && !tx.es_bancarizacion && !tx.es_compra_unidades)
  if (filter === 'third_party')   filtered = filtered.filter(tx => tx.is_third_party)
  if (filter === 'bancarizacion') filtered = filtered.filter(tx => tx.es_bancarizacion)
  if (filter === 'compras')       filtered = filtered.filter(tx => tx.es_compra_unidades)
  if (cuentaFilter !== 'all')     filtered = filtered.filter(tx => tx.cuenta === cuentaFilter)

  // ══════════════════════════════════════════════════════════════════════════
  // ★ Phase 3: compute "partial match" suggestions for each unmatched tx.
  // A suggestion is a pago whose reference overlaps with the tx reference by
  // at least 6 chars but doesn't qualify as 'strong' (i.e. amount or date
  // don't align, OR they do align but sender name didn't match — third party
  // case gets its own flow). Franco can one-click accept to match.
  // ══════════════════════════════════════════════════════════════════════════
  // Phase 5: Suggestion now spans all 3 sources.
  type Suggestion = {
    source: 'deal' | 'cobranza' | 'diferida'
    deal?: any                // present when source=deal
    pago: any
    // For non-deal sources:
    cobranzaPagoId?: string
    diferidaPagoId?: string
    contrato?: any
    compromiso?: any
    // Display
    label: string             // human-readable header (e.g. "Negocio #55812 · HASAN ZIB" or "Cobranza FAC-12345 (HASAN ZIB)")
    clienteNombre: string
    monto_usd: number
    fecha: string | null
    referencia: string | null
    // Match scoring
    overlap: number
    similarity: number
    amountMatch: boolean
    dateMatch: boolean
    nameMatch: boolean
    strength: 'strong' | 'partial'
  }

  const getSuggestions = (tx: any): Suggestion[] => {
    if (tx.matched) return []
    // Phase 6 (2026-05-15): allow no-ref suggestions for zelle/wire even when
    // tx.referencia is missing or won't match any pago's ref. For all other
    // tipos, we still require a referencia to fish for ref-similarity candidates.
    const noRefEligibleTipo = tx.tipo === 'zelle' || tx.tipo === 'wire'
    if (!tx.referencia && !noRefEligibleTipo) return []
    const out: Suggestion[] = []

    // -- deals.pagos[]
    for (const deal of deals) {
      const pagos: any[] = Array.isArray(deal.pagos) ? deal.pagos : []
      for (const p of pagos) {
        if (p._verified_by_bank) continue
        const strength = classifyMatch(tx, p)
        if (strength === 'exact' || strength === 'none') continue
        const overlap = refOverlapLength(tx.referencia, p.referencia, 6)
        const similarity = Math.max(refSimilarity(tx.referencia, p.referencia), refSimilarity(tx.referencia_alt, p.referencia))
        const amtOk = amountsMatch(tx.monto_usd, tx.monto_bs, tx.tipo, parseFloat(p.monto_usd) || 0, parseFloat(p.monto_bs) || 0)
        const dateOk = datesMatch(tx.fecha, p.fecha, 2)
        const nameOk = namesMatch(tx.sender_name || '', deal.cliente_nombre || '', (deal as any).cliente_apellidos || '')
        out.push({
          source: 'deal', deal, pago: p,
          label: `#${deal.negocio_num} · ${deal.cliente_nombre || ''} ${(deal as any).cliente_apellidos || ''}`.trim(),
          clienteNombre: `${deal.cliente_nombre || ''} ${(deal as any).cliente_apellidos || ''}`.trim(),
          monto_usd: parseFloat(p.monto_usd) || 0,
          fecha: p.fecha,
          referencia: p.referencia,
          overlap, similarity, amountMatch: amtOk, dateMatch: dateOk, nameMatch: nameOk,
          // partial_no_ref collapses into 'partial' for the UI's strong/partial display
          strength: (strength === 'strong' ? 'strong' : 'partial') as 'strong' | 'partial',
        })
      }
    }

    // -- cobranza_cuota_pagos
    for (const cp of cobranzaPagos) {
      if (cp.bank_tx_id) continue
      const contrato = contratosMap.get(cp.contrato_id)
      const clienteFull = (contrato?.cliente_nombre || '').trim()
      const parts = clienteFull.split(/\s+/)
      const half = Math.ceil(parts.length / 2)
      const nom = parts.slice(0, half).join(' ')
      const ape = parts.slice(half).join(' ')
      const metodo = (cp.metodo_pago || '').toLowerCase()
      const tipo = metodo.includes('zelle') ? 'zelle' : metodo.includes('wire') ? 'wire' : 'other'
      const normalizedPago = { fecha: cp.fecha_pago, monto_usd: cp.monto_usd, monto_bs: null, referencia: cp.referencia_pago, tipo, metodo: cp.metodo_pago || '' }
      const strength = classifyMatch(tx, normalizedPago)
      if (strength === 'exact' || strength === 'none') continue
      const overlap = refOverlapLength(tx.referencia, cp.referencia_pago, 6)
      const similarity = Math.max(refSimilarity(tx.referencia, cp.referencia_pago), refSimilarity(tx.referencia_alt, cp.referencia_pago))
      const amtOk = amountsMatch(tx.monto_usd, null, tx.tipo, parseFloat(cp.monto_usd) || 0, 0)
      const dateOk = datesMatch(tx.fecha, cp.fecha_pago, 2)
      const nameOk = namesMatch(tx.sender_name || '', nom, ape)
      out.push({
        source: 'cobranza', pago: normalizedPago,
        cobranzaPagoId: cp.id, contrato,
        label: `💰 ${contrato?.factura_numero || 'Cobranza'} · ${clienteFull}`,
        clienteNombre: clienteFull,
        monto_usd: parseFloat(cp.monto_usd) || 0,
        fecha: cp.fecha_pago, referencia: cp.referencia_pago,
        overlap, similarity, amountMatch: amtOk, dateMatch: dateOk, nameMatch: nameOk,
        strength: (strength === 'strong' ? 'strong' : 'partial') as 'strong' | 'partial',
      })
    }

    // -- compromisos_inicial_diferida_pagos
    for (const dp of diferidaPagos) {
      if (dp.bank_tx_id) continue
      const compromiso = compromisosMap.get(dp.compromiso_id)
      const clienteFull = (compromiso?.cliente_nombre || '').trim()
      const parts = clienteFull.split(/\s+/)
      const half = Math.ceil(parts.length / 2)
      const nom = parts.slice(0, half).join(' ')
      const ape = parts.slice(half).join(' ')
      const metodo = (dp.metodo || '').toLowerCase()
      const tipo = metodo.includes('zelle') ? 'zelle' : metodo.includes('wire') ? 'wire' : 'other'
      const normalizedPago = { fecha: dp.fecha, monto_usd: dp.monto_usd, monto_bs: null, referencia: dp.referencia, tipo, metodo: dp.metodo || '' }
      const strength = classifyMatch(tx, normalizedPago)
      if (strength === 'exact' || strength === 'none') continue
      const overlap = refOverlapLength(tx.referencia, dp.referencia, 6)
      const similarity = Math.max(refSimilarity(tx.referencia, dp.referencia), refSimilarity(tx.referencia_alt, dp.referencia))
      const amtOk = amountsMatch(tx.monto_usd, null, tx.tipo, parseFloat(dp.monto_usd) || 0, 0)
      const dateOk = datesMatch(tx.fecha, dp.fecha, 2)
      const nameOk = namesMatch(tx.sender_name || '', nom, ape)
      out.push({
        source: 'diferida', pago: normalizedPago,
        diferidaPagoId: dp.id, compromiso,
        label: `📋 Diferida · ${clienteFull}`,
        clienteNombre: clienteFull,
        monto_usd: parseFloat(dp.monto_usd) || 0,
        fecha: dp.fecha, referencia: dp.referencia,
        overlap, similarity, amountMatch: amtOk, dateMatch: dateOk, nameMatch: nameOk,
        strength: (strength === 'strong' ? 'strong' : 'partial') as 'strong' | 'partial',
      })
    }

    // Sort: strong first, then by # of matching signals, then similarity DESC
    out.sort((a, b) => {
      if (a.strength !== b.strength) return a.strength === 'strong' ? -1 : 1
      const scoreA = (a.nameMatch ? 1 : 0) + (a.amountMatch ? 1 : 0) + (a.dateMatch ? 1 : 0)
      const scoreB = (b.nameMatch ? 1 : 0) + (b.amountMatch ? 1 : 0) + (b.dateMatch ? 1 : 0)
      if (scoreA !== scoreB) return scoreB - scoreA
      return b.similarity - a.similarity
    })
    // Phase 6: widened to 8 suggestions per tx since amount+date alone can
    // produce multiple plausible candidates (e.g. several cobranza pagos with
    // same amount, different clients). Admin picks from the list.
    return out.slice(0, 8)
  }

  // Accept a suggestion: verify the matching pago by source.
  const acceptSuggestion = async (tx: any, suggestion: Suggestion) => {
    if (suggestion.source === 'deal' && suggestion.deal) {
      const result = await safeUpdateDealPagos(suggestion.deal.id, (currentPagos) =>
        currentPagos.map((p: any) => {
          if (normalizeRef(p.referencia) === normalizeRef(suggestion.pago.referencia) && !p._verified_by_bank) {
            return { ...p, _verified_by_bank: true, _verified_at: new Date().toISOString(), _bank_tx_id: tx.id, _match_strength: suggestion.strength }
          }
          return p
        })
      )
      if (result === null) { alert('Error al actualizar el pago. Vuelve a intentar.'); return }
      await supabase.from('bank_transactions').update({
        deal_id: suggestion.deal.id,
        matched: true,
        is_third_party: false,
        ingreso_confirmed: true,
      }).eq('id', tx.id)
    } else if (suggestion.source === 'cobranza' && suggestion.cobranzaPagoId) {
      const { error } = await supabase
        .from('cobranza_cuota_pagos')
        .update({ bank_tx_id: tx.id, bank_match_strength: suggestion.strength })
        .eq('id', suggestion.cobranzaPagoId)
        .is('bank_tx_id', null)
      if (error) { alert('Error: ' + error.message); return }
      await supabase.from('bank_transactions').update({
        matched: true,
        is_third_party: !suggestion.nameMatch,
        ingreso_confirmed: suggestion.nameMatch,
      }).eq('id', tx.id)
    } else if (suggestion.source === 'diferida' && suggestion.diferidaPagoId) {
      const { error } = await supabase
        .from('compromisos_inicial_diferida_pagos')
        .update({ bank_tx_id: tx.id, bank_match_strength: suggestion.strength })
        .eq('id', suggestion.diferidaPagoId)
        .is('bank_tx_id', null)
      if (error) { alert('Error: ' + error.message); return }
      await supabase.from('bank_transactions').update({
        matched: true,
        is_third_party: !suggestion.nameMatch,
        ingreso_confirmed: suggestion.nameMatch,
      }).eq('id', tx.id)
    }
    await load()
  }

  // KPIs
  const totalUSD       = transactions.reduce((s, tx) => s + (tx.monto_usd || 0), 0)
  const matchedCount   = transactions.filter(tx => tx.matched).length
  const unmatchedCount = transactions.filter(tx =>
    !tx.matched && !tx.es_bancarizacion && !tx.es_compra_unidades &&
    !tx.is_internal && !tx.is_bank_fee && tx.flujo !== 'egreso'
  ).length
  const thirdPartyCount = transactions.filter(tx => tx.is_third_party).length

  // ★ Monthly totals for Bancarizaciones and Compras de Unidades
  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
  const thisMonthTxs = transactions.filter(tx => tx.fecha && tx.fecha >= startOfMonth)
  const bancThisMonth    = thisMonthTxs.filter(tx => tx.es_bancarizacion)
  const comprasThisMonth = thisMonthTxs.filter(tx => tx.es_compra_unidades)
  const bancTotal        = bancThisMonth.reduce((s, tx) => s + Math.abs(tx.monto_usd || 0), 0)
  const bancComisiones   = bancThisMonth.reduce((s, tx) => s + (tx.banc_comision_usd || 0), 0)
  const comprasTotal     = comprasThisMonth.reduce((s, tx) => s + Math.abs(tx.monto_usd || 0), 0)

  // Third-party by deal
  const thirdPartyByDeal = deals.map(deal => {
    const txs = transactions.filter(tx => String(tx.deal_id) === String(deal.id) && tx.is_third_party)
    return { deal, txs }
  }).filter(d => d.txs.length > 0)

  // ══════════════════════════════════════════════════════════════════════════
  // POSICIÓN BANCARIA — per-account running saldo
  //   Computed from ALL bank_transactions (not filtered): sum credits − debits.
  //   Reflects opening seeds + all loaded activity.
  //   Click an account card → filters the transactions table to that cuenta.
  // ══════════════════════════════════════════════════════════════════════════
  const positionByCuenta = (() => {
    const accounts: { cuenta: string; label: string; color: string }[] = [
      { cuenta: 'motocentro',      label: 'Motocentro BofA',   color: '#BB162B' },
      { cuenta: 'roframi',         label: 'Roframi BofA',      color: '#3B82F6' },
      { cuenta: 'roframi_regions', label: 'Roframi Regions',   color: '#60A5FA' },
      { cuenta: 'panama',          label: 'Panamá Mercantil',  color: '#10B981' },
    ]
    return accounts.map(a => {
      const rows = transactions.filter((t: any) => t.cuenta === a.cuenta)
      const credits = rows.reduce((s: number, t: any) =>
        s + (t.flujo === 'ingreso' ? (Number(t.monto_usd) || 0) : 0), 0)
      const debits  = rows.reduce((s: number, t: any) =>
        s + (t.flujo === 'egreso'  ? (Number(t.monto_usd) || 0) : 0), 0)
      const saldo = credits - debits
      const lastTx = rows
        .map((t: any) => t.fecha)
        .filter(Boolean)
        .sort()
        .pop() || null
      return { ...a, n: rows.length, credits, debits, saldo, lastTx }
    })
  })()
  const grandTotalUSD = positionByCuenta.reduce((s, a) => s + a.saldo, 0)

  return (
    <AdminShell active="banco">
      <div style={s.content}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, marginTop: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 2 }}>Módulo</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' }}>Conciliación Bancaria</div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => router.push('/scan')}
              style={{ padding: '10px 20px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              📷 Subir Estado de Cuenta
            </button>
            <button onClick={autoMatch} disabled={matching}
              style={{ padding: '10px 20px', background: '#10B981', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: matching ? 0.6 : 1 }}>
              {matching ? 'Conciliando...' : '🔄 Auto-Conciliar'}
            </button>
            <button onClick={conciliarConIA} disabled={aiBusy}
              style={{ padding: '10px 20px', background: '#7C3AED', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: aiBusy ? 0.6 : 1 }}>
              {aiBusy ? 'Analizando…' : '🤖 Conciliar con IA'}
            </button>
          </div>
        </div>

        {/* ── Conciliación con IA — sugerencias de duplicados cross-source ── */}
        {(aiRan || aiErr) && (
          <div style={{ ...s.card, border: '1px solid rgba(124,58,237,0.35)' }}>
            <div style={{ ...s.sectionTitle, color: '#7C3AED' }}>
              🤖 Conciliación con IA — posibles duplicados BANCO ↔ INTERNA
            </div>
            {aiErr && (
              <div style={{ padding: '10px 14px', background: 'rgba(187,22,43,0.08)', border: '1px solid rgba(187,22,43,0.3)', borderRadius: 8, color: '#BB162B', fontSize: 13, marginBottom: 12 }}>
                {aiErr}
              </div>
            )}
            {!aiErr && aiSugs.length === 0 && aiBancSugs.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                No se encontraron duplicados probables ni depósitos atribuibles a bancarizaciones pendientes (últimos 21–60 días).
              </div>
            )}
            {aiSugs.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  La IA solo sugiere — nada se fusiona sin tu confirmación. Al confirmar, la fila del correo se absorbe en la fila de la captura (la que está ligada al comprobante), el remitente del banco prevalece y la discrepancia queda registrada en el historial.
                </div>
                {aiSugs.map(sug => (
                  <div key={sug.key} style={{ padding: '12px 14px', background: 'rgba(124,58,237,0.05)', border: '1px solid rgba(124,58,237,0.25)', borderRadius: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 260 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                          {fmt(sug.email.monto_usd)} · {fmtDate(sug.email.fecha)} · {(sug.email.tipo || '').toUpperCase()}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                          BANCO: <b>{sug.email.sender_name || '—'}</b> ({CUENTA_LABELS[sug.email.cuenta]?.label || sug.email.cuenta})
                          {' '}↔ INTERNA: <b>{sug.shot.sender_name || '—'}</b> ({CUENTA_LABELS[sug.shot.cuenta]?.label || sug.shot.cuenta})
                          {sug.shot.referencia ? <> · ref <span style={{ fontFamily: 'monospace' }}>{sug.shot.referencia}</span></> : null}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 6 }}>
                          {sug.razon}
                        </div>
                        {sug.cuenta_diferente && (
                          <div style={{ fontSize: 11, color: '#b8720a', fontWeight: 700, marginTop: 4 }}>
                            ⚠ Cuentas distintas — al confirmar se usará la cuenta del correo del banco ({CUENTA_LABELS[sug.email.cuenta]?.label || sug.email.cuenta}).
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 99, background: sug.confianza >= 85 ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)', color: sug.confianza >= 85 ? '#10B981' : '#F59E0B' }}>
                          {sug.confianza}% confianza
                        </span>
                        <button onClick={() => confirmarSugerencia(sug)} disabled={aiConfirming === sug.key}
                          style={{ padding: '8px 16px', background: '#10B981', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: aiConfirming === sug.key ? 0.6 : 1 }}>
                          {aiConfirming === sug.key ? 'Fusionando…' : '✓ Confirmar'}
                        </button>
                        <button onClick={() => setAiSugs(prev => prev.filter(x => x.key !== sug.key))} disabled={aiConfirming === sug.key}
                          style={{ padding: '8px 16px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                          Descartar
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Bancarizaciones en tránsito ↔ depósitos (incluye splits) ── */}
            {aiBancSugs.length > 0 && (
              <div style={{ marginTop: aiSugs.length > 0 ? 20 : 0 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: '#7C3AED', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 8 }}>
                  🏦 Depósitos de bancarizadores detectados
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
                  Un mismo egreso puede llegar en varios depósitos parciales. Al confirmar, los depósitos se registran en la bancarización (mismo flujo que el módulo de depósitos) y el comprobante avanza a Depósito parcial o se cierra si la suma iguala el restante.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {aiBancSugs.map(sug => (
                    <div key={sug.key} style={{ padding: '12px 14px', background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                        <div style={{ minWidth: 280 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>Depósitos ({fmt(sug.suma)})</div>
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {sug.txs.map((t: any) => (
                              <span key={t.id}>
                                ↳ {fmtDate(t.fecha)} · {(t.tipo || '').toUpperCase()} · {t.sender_name || '—'} ({CUENTA_LABELS[t.cuenta]?.label || t.cuenta}) — <b style={{ fontFamily: 'monospace' }}>{fmt(t.monto_usd)}</b>
                              </span>
                            ))}
                          </div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 0.5, marginTop: 8 }}>Se asignan a</div>
                          <div style={{ fontSize: 12, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {sug.asigs.map((a: any) => {
                              const cierra = (Number(a.comp.monto_depositado || 0) + a.monto) >= Number(a.comp.monto_usd) - 0.005
                              return (
                                <span key={a.comp.id} style={{ color: 'var(--text-primary)' }}>
                                  → <b>{a.comp.numero}</b> · {a.comp.bancarizador_nombre || a.comp.egreso_dirigido_a || 'Bancarizador'}{a.comp.bancarizacion_ruta === 'directa' ? ' · USDT/directa' : ''} — <b style={{ fontFamily: 'monospace' }}>{fmt(a.monto)}</b>{' '}
                                  <span style={{ fontWeight: 700, color: cierra ? '#10B981' : '#b8720a' }}>
                                    {cierra ? '(cierra ✓)' : `(parcial, quedarían ${fmt(a.comp.restante - a.monto)})`}
                                  </span>
                                </span>
                              )
                            })}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 6 }}>{sug.razon}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 99, background: sug.confianza >= 85 ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)', color: sug.confianza >= 85 ? '#10B981' : '#F59E0B' }}>
                            {sug.confianza}% confianza
                          </span>
                          <button onClick={() => confirmarBancSugerencia(sug)} disabled={aiConfirming === sug.key}
                            style={{ padding: '8px 16px', background: '#10B981', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: aiConfirming === sug.key ? 0.6 : 1 }}>
                            {aiConfirming === sug.key ? 'Registrando…' : '✓ Confirmar'}
                          </button>
                          <button onClick={() => setAiBancSugs(prev => prev.filter(x => x.key !== sug.key))} disabled={aiConfirming === sug.key}
                            style={{ padding: '8px 16px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                            Descartar
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Bancarizaciones pendientes por cerrar (carga manual de depósitos) ── */}
        {pendientes.length > 0 && (
          <div style={{ ...s.card, border: '1px solid rgba(184,114,10,0.35)' }}>
            <div style={{ ...s.sectionTitle, color: '#b8720a' }}>
              🏦 Bancarizaciones pendientes por cerrar ({pendientes.length})
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
              Carga los depósitos a mano (útil para Panamá, que no notifica). Se aceptan parciales; la bancarización se cierra cuando la suma iguala el restante. Al subir el estado de cuenta, el depósito real se concilia con este automáticamente.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {pendientes.map(c => {
                const pct = Number(c.monto_usd) > 0 ? Math.min(100, (Number(c.monto_depositado || 0) / Number(c.monto_usd)) * 100) : 0
                const open = pendOpen === c.id
                return (
                  <div key={c.id} style={{ padding: '12px 14px', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 220 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                          {c.numero} · {c.bancarizador_nombre || c.egreso_dirigido_a || 'Bancarizador'}{c.bancarizacion_ruta === 'directa' ? ' · USDT' : ''}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                          Total {fmt(c.monto_usd)} · depositado {fmt(c.monto_depositado || 0)} · <b style={{ color: '#b8720a' }}>restante {fmt(c.restante)}</b>
                        </div>
                        <div style={{ height: 6, background: '#2a2a2a', borderRadius: 3, marginTop: 6, overflow: 'hidden', maxWidth: 320 }}>
                          <div style={{ height: '100%', width: pct + '%', background: '#b8720a', borderRadius: 3 }} />
                        </div>
                      </div>
                      <button onClick={() => { setPendOpen(open ? null : c.id); setPendErr(null); setPendMonto(''); setPendRef(''); setPendCuenta(c.bancarizacion_ruta === 'directa' ? '' : 'panama') }}
                        style={{ padding: '8px 16px', background: open ? 'transparent' : '#b8720a', color: open ? 'var(--text-secondary)' : '#fff', border: open ? '1px solid var(--border)' : 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                        {open ? 'Cerrar' : '+ Aplicar depósito'}
                      </button>
                    </div>

                    {open && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
                          <div>
                            <label style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: 4 }}>MONTO (USD)</label>
                            <input type="number" step="0.01" value={pendMonto} onChange={e => setPendMonto(e.target.value)}
                              placeholder={c.restante.toFixed(2)}
                              style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: 4 }}>FECHA</label>
                            <input type="date" value={pendFecha} onChange={e => setPendFecha(e.target.value)}
                              style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: 4 }}>CUENTA</label>
                            <select value={pendCuenta} onChange={e => setPendCuenta(e.target.value)}
                              style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 }}>
                              <option value="">Seleccionar…</option>
                              {BANK_ACCOUNTS.map(a => <option key={a.code} value={a.code}>{a.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <label style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: 4 }}>REFERENCIA</label>
                            <input type="text" value={pendRef} onChange={e => setPendRef(e.target.value)}
                              placeholder="opcional"
                              style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 }} />
                          </div>
                        </div>
                        {(() => {
                          const m = parseFloat(pendMonto) || c.restante
                          const cierra = m >= c.restante - 0.005
                          return (
                            <div style={{ fontSize: 12, marginTop: 8, color: cierra ? '#16A34A' : '#b8720a', fontWeight: 600 }}>
                              {m > c.restante + 0.005 ? `Excede el restante (${fmt(c.restante)})` : cierra ? 'Cierra la bancarización ✓' : `Parcial — quedarían ${fmt(c.restante - m)}`}
                            </div>
                          )
                        })()}
                        {pendErr && <div style={{ fontSize: 12, color: '#BB162B', marginTop: 8 }}>{pendErr}</div>}
                        <button onClick={() => aplicarDepositoPendiente(c)} disabled={pendSaving}
                          style={{ marginTop: 10, padding: '9px 18px', background: '#16A34A', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: pendSaving ? 0.6 : 1 }}>
                          {pendSaving ? 'Registrando…' : '✓ Registrar depósito'}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Posición Bancaria — saldos consolidados por cuenta ── */}
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '18px 22px',
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5 }}>
              💰 Posición Bancaria
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              Total USD en todas las cuentas
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, alignItems: 'stretch' }}>
            {positionByCuenta.map(a => {
              const selected = cuentaFilter === a.cuenta
              return (
                <div key={a.cuenta}
                  onClick={() => setCuentaFilter(selected ? 'all' : a.cuenta)}
                  style={{
                    background: selected ? a.color + '11' : 'var(--bg-deep)',
                    border: selected ? `2px solid ${a.color}` : '1px solid var(--border)',
                    borderLeft: `4px solid ${a.color}`,
                    borderRadius: 10,
                    padding: '12px 14px',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                  title={`Click para filtrar la tabla a ${a.label}`}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: a.color, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                    {a.label}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-primary)', fontFamily: 'monospace', marginBottom: 4 }}>
                    {fmt(a.saldo)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {a.n} tx · últ. {a.lastTx ? fmtDate(a.lastTx) : '—'}
                  </div>
                </div>
              )
            })}
            {/* Grand total card */}
            <div style={{
              background: 'linear-gradient(135deg, #0D2257 0%, #1B4AAA 100%)',
              border: '1px solid #0D2257',
              borderRadius: 10,
              padding: '12px 14px',
              color: '#fff',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#C49A2A', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                Total Consolidado
              </div>
              <div style={{ fontSize: 22, fontWeight: 900, fontFamily: 'monospace' }}>
                {fmt(grandTotalUSD)}
              </div>
              <div style={{ fontSize: 10, color: '#F5ECC8', marginTop: 4 }}>
                USD en bancos
              </div>
            </div>
          </div>
        </div>

        {/* KPI Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, marginBottom: 24 }}>
          {[
            { label: 'Total Detectado',        value: fmt(totalUSD),            color: '#3B82F6' },
            { label: 'Conciliados',            value: `${matchedCount}`,        color: '#10B981' },
            { label: 'Sin Conciliar',          value: `${unmatchedCount}`,      color: '#BB162B' },
            { label: 'Terceros',               value: `${thirdPartyCount}`,     color: '#F59E0B' },
            { label: '🏦 Bancarizado (mes)',   value: fmt(bancTotal),           sub: `${bancThisMonth.length} dep · ${bancComisiones > 0 ? fmt(bancComisiones) + ' comis.' : 'sin comis.'}`, color: '#8B5CF6' },
            { label: '📦 Compras Venekia',     value: fmt(comprasTotal),        sub: `${comprasThisMonth.length} pagos`, color: '#F59E0B' },
          ].map((k: any) => (
            <div key={k.label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderLeft: `4px solid ${k.color}`, borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 }}>{k.label}</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{k.value}</div>
              {k.sub && <div style={{ fontSize: 9, color: 'var(--text-secondary)', marginTop: 4 }}>{k.sub}</div>}
            </div>
          ))}
        </div>

        {/* Third party deals needing Declaración */}
        {thirdPartyByDeal.length > 0 && (
          <div style={s.card}>
            <div style={s.sectionTitle}>⚠ Negocios con Pagos de Terceros — Requieren Declaración</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {thirdPartyByDeal.map(({ deal, txs }) => (
                <div key={deal.id} style={{ padding: '14px 16px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Negocio #{deal.negocio_num} — {deal.cliente_nombre}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{txs.length} pago{txs.length !== 1 ? 's' : ''} de terceros</div>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 6, background: 'rgba(245,158,11,0.2)', color: '#F59E0B' }}>
                      REQUIERE DECLARACIÓN
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {txs.map((tx, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderTop: i > 0 ? '1px solid rgba(245,158,11,0.15)' : 'none' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>{tx.sender_name || 'Remitente'} · {tx.tipo?.toUpperCase()} · {fmtDate(tx.fecha)}</span>
                        <span style={{ fontWeight: 700, color: '#F59E0B', fontFamily: 'monospace' }}>{tx.monto_usd ? fmt(tx.monto_usd) : '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Suggested Ingresos Queue */}
        {(() => {
          const suggested = transactions.filter((tx: any) => tx.suggested_as_ingreso && !tx.ingreso_confirmed)
          if (suggested.length === 0) return null
          return (
            <div style={s.card}>
              <div style={s.sectionTitle}>✅ Ingresos Sugeridos — Confirmación Pendiente ({suggested.length})</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 16 }}>
                Estos pagos coinciden con comprobantes en Auditoría. Confirma para agregarlos como ingreso al negocio.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
                {suggested.map((tx: any) => {
                  const matchedDeal = deals.find((d: any) => String(d.id) === String(tx.deal_id))
                  if (!matchedDeal) return null
                  const ci = CUENTA_LABELS[tx.cuenta]
                  return (
                    <div key={tx.id} style={{ padding: '14px 16px', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{tx.sender_name || 'Remitente'}</span>
                          {ci && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 99, background: ci.color + '22', color: ci.color, fontWeight: 700 }}>{ci.label}</span>}
                          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{tx.tipo?.toUpperCase()} · {tx.fecha}</span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                          Negocio #{matchedDeal.negocio_num} — {matchedDeal.cliente_nombre}
                          {tx.referencia ? ' · Ref: ' + tx.referencia : ''}
                        </div>
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 900, color: '#10B981', fontFamily: 'monospace', flexShrink: 0 }}>{tx.monto_usd ? fmt(tx.monto_usd) : '—'}</div>
                      <button onClick={() => setConfirmingTx({ tx, deal: matchedDeal })}
                        style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#10B981', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>
                        + Agregar Ingreso
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}

        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          {(['all', 'unmatched', 'third_party', 'bancarizacion', 'compras'] as const).map(f => {
            const label =
              f === 'all'           ? 'Todos' :
              f === 'unmatched'     ? `Sin conciliar (${unmatchedCount})` :
              f === 'third_party'   ? `Terceros (${thirdPartyCount})` :
              f === 'bancarizacion' ? `🏦 Bancarizaciones (${transactions.filter(tx => tx.es_bancarizacion).length})` :
                                      `📦 Compras (${transactions.filter(tx => tx.es_compra_unidades).length})`
            const activeColor =
              f === 'bancarizacion' ? '#8B5CF6' :
              f === 'compras'       ? '#F59E0B' :
                                      '#BB162B'
            return (
              <button key={f} onClick={() => setFilter(f)}
                style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: filter === f ? activeColor : 'transparent', color: filter === f ? '#fff' : 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                {label}
              </button>
            )
          })}
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            {['all', 'roframi', 'roframi_regions', 'motocentro', 'panama', 'bolivares'].map(c => (
              <button key={c} onClick={() => setCuentaFilter(c)}
                style={{ padding: '6px 12px', borderRadius: 8, border: `1px solid ${cuentaFilter === c ? (CUENTA_LABELS[c]?.color || '#BB162B') : 'var(--border)'}`, background: cuentaFilter === c ? (CUENTA_LABELS[c]?.color || '#BB162B') + '22' : 'transparent', color: cuentaFilter === c ? (CUENTA_LABELS[c]?.color || '#BB162B') : 'var(--text-secondary)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                {c === 'all' ? 'Todas' : CUENTA_LABELS[c]?.label}
              </button>
            ))}
          </div>
        </div>

        {/* Transactions table */}
        <div style={s.card}>
          <div style={s.sectionTitle}>Transacciones ({filtered.length})</div>
          {loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>Cargando...</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>No hay transacciones{filter !== 'all' ? ' con este filtro' : ''}.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Cuenta', 'Fecha', 'Remitente', 'Tipo', 'Referencia', 'USD', 'Negocio', 'Estado', ''].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(tx => {
                  const matchedDeal = tx.deal_id ? deals.find(d => String(d.id) === String(tx.deal_id)) : null
                  const cuentaInfo = CUENTA_LABELS[tx.cuenta]
                  // ★ Phase 3: compute partial-match suggestions for this tx
                  const suggestions = !tx.matched && !tx.es_bancarizacion && !tx.es_compra_unidades ? getSuggestions(tx) : []
                  const isDebit = tx.flujo === 'egreso' || tx.direccion === 'debit' || (tx.monto_usd ?? 0) < 0
                  const amountColor = tx.es_compra_unidades ? '#F59E0B' : tx.es_bancarizacion ? '#8B5CF6' : isDebit ? '#BB162B' : '#10B981'
                  const amountPrefix = isDebit && (tx.monto_usd ?? 0) > 0 ? '-' : ''
                  const editorOpenForThisRow = bancEditor?.txId === tx.id || compraEditor?.txId === tx.id
                  return (
                    <React.Fragment key={tx.id}>
                    <tr id={`tx-row-${tx.id}`} style={{
                      borderBottom: (suggestions.length > 0 || editorOpenForThisRow) ? 'none' : '1px solid var(--border)',
                      background:
                        highlightedTxId === String(tx.id) ? 'rgba(16,185,129,0.18)' :
                        tx.es_compra_unidades ? 'rgba(245,158,11,0.05)' :
                        tx.es_bancarizacion   ? 'rgba(139,92,246,0.05)' :
                        suggestions.length > 0 ? 'rgba(245,158,11,0.04)' :
                        undefined,
                      transition: 'background 0.5s',
                    }}>
                      <td style={{ padding: '10px' }}>
                        <span style={s.badge(cuentaInfo?.color || '#666')}>{cuentaInfo?.label || tx.cuenta}</span>
                      </td>
                      <td style={{ padding: '10px', fontSize: 12, color: 'var(--text-secondary)' }}>{fmtDate(tx.fecha)}</td>
                      <td style={{ padding: '10px', fontSize: 13, color: 'var(--text-primary)', fontWeight: tx.is_third_party ? 700 : 400 }}>
                        {tx.sender_name || '—'}
                        {tx.is_third_party && <span style={{ marginLeft: 6, fontSize: 10, color: '#F59E0B', fontWeight: 700 }}>3RO</span>}{tx.es_bancarizacion && tx.banc_depositante && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: '#8B5CF6', fontWeight: 700 }}>
                            · {tx.banc_depositante}{tx.banc_es_tercero ? ' (3RO)' : ''}
                          </span>
                        )}
                        {tx.es_bancarizacion && (() => {
                          // Extract EGR-NNNN-YYYY from raw_text. The deposit code writes:
                          //   "Bancarización EGR-XXXX-YYYY · ..."
                          // so a simple regex pulls the number out.
                          const match = (tx.raw_text || '').match(/EGR-\d+-\d+/)
                          if (!match) return null
                          const egrNum = match[0]
                          return (
                            <a
                              onClick={async (e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                // Look up the comprobante by numero and route to its detail page
                                const { data } = await supabase
                                  .from('tesoreria_comprobantes')
                                  .select('id')
                                  .eq('numero', egrNum)
                                  .maybeSingle()
                                if (data?.id) router.push('/tesoreria/comprobante?id=' + data.id)
                              }}
                              style={{
                                display: 'inline-block', marginLeft: 8,
                                fontSize: 10, fontWeight: 700,
                                color: '#8B5CF6',
                                textDecoration: 'underline',
                                cursor: 'pointer',
                              }}
                              title="Ver comprobante de la bancarización"
                            >
                              → {egrNum}
                            </a>
                          )
                        })()}
                        {tx.es_compra_unidades && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: '#F59E0B', fontWeight: 700 }}>
                            · {tx.compra_proveedor || 'Compra'}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '10px', fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                        <div>{tx.tipo || '—'}</div>
                        <SourcePills tx={tx} />
                      </td>
                      <td style={{ padding: '10px', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{tx.referencia || '—'}</td>
                      <td style={{ padding: '10px', fontSize: 13, fontWeight: 700, color: amountColor, fontFamily: 'monospace' }}>
                        {tx.monto_usd != null ? `${amountPrefix}${fmt(Math.abs(tx.monto_usd))}` : '—'}
                      </td>
                      <td style={{ padding: '10px', fontSize: 12 }}>
                        {matchedDeal
                          ? <span style={{ color: '#3B82F6', fontWeight: 600 }}>#{matchedDeal.negocio_num}</span>
                          : <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                      </td>
                      <td style={{ padding: '10px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
                        {tx.es_bancarizacion     && <span style={s.badge('#8B5CF6')}>🏦 BANC</span>}
                        {tx.es_compra_unidades   && <span style={s.badge('#F59E0B')}>📦 COMPRA</span>}
                        {tx.matched && !tx.es_bancarizacion && !tx.es_compra_unidades
                          ? <span style={s.badge('#10B981')}>✓ Conciliado</span>
                          : (!tx.matched && !tx.es_bancarizacion && !tx.es_compra_unidades)
                            ? <span style={s.badge('#BB162B')}>Pendiente</span>
                            : null}
                        {tx.ingreso_confirmed && <span style={s.badge('#3B82F6')}>💰 En Ingresos</span>}
                        {tx.suggested_as_ingreso && !tx.ingreso_confirmed && <span style={s.badge('#F59E0B')}>⏳ Sugerido</span>}
                        {tx.is_third_party && <span style={s.badge('#F59E0B')}>3RO</span>}
                      </div>
                      </td>
                      <td style={{ padding: '10px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3, minWidth: 90 }}>
                          {/* Ligar / Desligar (existing) */}
                          {tx.matched && !tx.es_bancarizacion && !tx.es_compra_unidades
                            ? <button onClick={() => unmatch(tx)} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>Desligar</button>
                            : (!tx.es_bancarizacion && !tx.es_compra_unidades)
                              ? <button onClick={() => { setSelectedTx(tx); setMatchDealId('') }} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid rgba(59,130,246,0.5)', background: 'rgba(59,130,246,0.1)', color: '#3B82F6', cursor: 'pointer', fontWeight: 600 }}>Ligar</button>
                              : null}
                          {/* 🏦 BANC */}
                          {tx.es_bancarizacion
                            ? <button onClick={() => removeBanc(tx)} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(139,92,246,0.4)', background: 'transparent', color: '#8B5CF6', cursor: 'pointer' }}>Quitar BANC</button>
                            : <button onClick={() => openBancEditor(tx)} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(139,92,246,0.5)', background: 'rgba(139,92,246,0.1)', color: '#8B5CF6', cursor: 'pointer', fontWeight: 600 }}>🏦 BANC</button>}
                          {/* 📦 COMPRA */}
                          {tx.es_compra_unidades
                            ? <button onClick={() => removeCompra(tx)} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(245,158,11,0.4)', background: 'transparent', color: '#F59E0B', cursor: 'pointer' }}>Quitar COMPRA</button>
                            : <button onClick={() => openCompraEditor(tx)} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(245,158,11,0.5)', background: 'rgba(245,158,11,0.1)', color: '#F59E0B', cursor: 'pointer', fontWeight: 600 }}>📦 COMPRA</button>}
                        </div>
                      </td>
                    </tr>
                    {/* Inline BANC editor */}
                    {(() => {
                      const be = bancEditor
                      if (!be || be.txId !== tx.id) return null
                      return (
                      <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(139,92,246,0.06)' }}>
                        <td colSpan={9} style={{ padding: '10px 14px 14px' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#8B5CF6', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 8 }}>
                            🏦 Tag como Bancarización
                          </div>
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const }}>
                            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>¿Quién depositó?</span>
                            {['Franco', 'Mirla'].map(name => (
                              <button key={name}
                                onClick={() => setBancEditor(e => e ? { ...e, depositante: name, esTercero: false } : null)}
                                style={{ fontSize: 11, padding: '4px 12px', borderRadius: 6, border: `1px solid ${be.depositante === name ? '#8B5CF6' : 'var(--border)'}`, background: be.depositante === name ? 'rgba(139,92,246,0.2)' : 'transparent', color: be.depositante === name ? '#8B5CF6' : 'var(--text-secondary)', cursor: 'pointer', fontWeight: 600 }}>
                                {name}
                              </button>
                            ))}
                            <button
                              onClick={() => setBancEditor(e => e ? { ...e, esTercero: true, depositante: e.depositante === 'Franco' || e.depositante === 'Mirla' ? '' : e.depositante } : null)}
                              style={{ fontSize: 11, padding: '4px 12px', borderRadius: 6, border: `1px solid ${be.esTercero ? '#8B5CF6' : 'var(--border)'}`, background: be.esTercero ? 'rgba(139,92,246,0.2)' : 'transparent', color: be.esTercero ? '#8B5CF6' : 'var(--text-secondary)', cursor: 'pointer', fontWeight: 600 }}>
                              Otro (3RO)
                            </button>
                            {be.esTercero && (
                              <input
                                value={be.depositante}
                                onChange={e => setBancEditor(ed => ed ? { ...ed, depositante: e.target.value } : null)}
                                placeholder="Nombre del gestor"
                                style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none', minWidth: 180 }}
                              />
                            )}
                            {be.esTercero && (
                              <input
                                value={be.comision}
                                onChange={e => setBancEditor(ed => ed ? { ...ed, comision: e.target.value.replace(/[^0-9.]/g, '') } : null)}
                                placeholder="Comisión USD"
                                style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none', width: 120, fontFamily: 'monospace' }}
                              />
                            )}
                            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                              <button onClick={() => setBancEditor(null)} style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                                Cancelar
                              </button>
                              <button onClick={saveBancEditor} disabled={!be.depositante.trim()}
                                style={{ fontSize: 11, padding: '5px 14px', borderRadius: 6, border: 'none', background: '#8B5CF6', color: '#fff', cursor: be.depositante.trim() ? 'pointer' : 'not-allowed', fontWeight: 700, opacity: be.depositante.trim() ? 1 : 0.5 }}>
                                ✓ Guardar
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                      )
                    })()}
                    {/* Inline COMPRA editor */}
                    {(() => {
                      const ce = compraEditor
                      if (!ce || ce.txId !== tx.id) return null
                      return (
                      <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(245,158,11,0.06)' }}>
                        <td colSpan={9} style={{ padding: '10px 14px 14px' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#F59E0B', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 8 }}>
                            📦 Tag como Compra de Unidades
                          </div>
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const }}>
                            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Proveedor:</span>
                            <input
                              value={ce.proveedor}
                              onChange={e => setCompraEditor(ed => ed ? { ...ed, proveedor: e.target.value } : null)}
                              placeholder="Nombre del proveedor"
                              style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none', minWidth: 280 }}
                            />
                            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                              <button onClick={() => setCompraEditor(null)} style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                                Cancelar
                              </button>
                              <button onClick={saveCompraEditor} disabled={!ce.proveedor.trim()}
                                style={{ fontSize: 11, padding: '5px 14px', borderRadius: 6, border: 'none', background: '#F59E0B', color: '#fff', cursor: ce.proveedor.trim() ? 'pointer' : 'not-allowed', fontWeight: 700, opacity: ce.proveedor.trim() ? 1 : 0.5 }}>
                                ✓ Guardar
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                      )
                    })()}
                    {suggestions.length > 0 && (
                      <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(245,158,11,0.04)' }}>
                        <td colSpan={9} style={{ padding: '8px 14px 14px' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#F59E0B', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 6 }}>
                            💡 Posibles coincidencias ({suggestions.length})
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                            {suggestions.map((sug, i) => {
                              const sourceColor = sug.source === 'deal' ? '#3B82F6' : sug.source === 'cobranza' ? '#14B8A6' : '#8B5CF6'
                              const sourceLabel = sug.source === 'deal' ? 'NEGOCIO' : sug.source === 'cobranza' ? 'COBRANZA' : 'DIFERIDA'
                              return (
                              <div key={i} style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                padding: '8px 12px',
                                background: 'var(--bg-deep)',
                                border: `1px solid ${sug.strength === 'strong' ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.3)'}`,
                                borderRadius: 6,
                                flexWrap: 'wrap' as const,
                              }}>
                                <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 3, background: sourceColor + '22', color: sourceColor, textTransform: 'uppercase' as const, letterSpacing: 1 }}>{sourceLabel}</span>
                                <span style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>{sug.label}</span>
                                <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>Ref: {sug.referencia || '—'}</span>
                                <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>${(sug.monto_usd || 0).toFixed(2)}</span>
                                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{sug.fecha ? fmtDate(sug.fecha) : '—'}</span>
                                <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                                  <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: 'rgba(59,130,246,0.15)', color: '#3B82F6', fontWeight: 700 }}>{Math.round(sug.similarity * 100)}% ref</span>
                                  {sug.amountMatch && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.15)', color: '#10B981', fontWeight: 700 }}>$ ✓</span>}
                                  {sug.dateMatch && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.15)', color: '#10B981', fontWeight: 700 }}>📅 ✓</span>}
                                  {sug.nameMatch && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.15)', color: '#10B981', fontWeight: 700 }}>👤 ✓</span>}
                                </div>
                                <button
                                  onClick={() => acceptSuggestion(tx, sug)}
                                  style={{
                                    fontSize: 11,
                                    padding: '4px 12px',
                                    borderRadius: 5,
                                    border: 'none',
                                    background: '#10B981',
                                    color: '#fff',
                                    cursor: 'pointer',
                                    fontWeight: 700,
                                  }}
                                >
                                  ✓ Aceptar
                                </button>
                              </div>
                              )
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Confirm ingreso modal */}
      {confirmingTx && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid rgba(16,185,129,0.4)', borderRadius: 16, padding: 28, maxWidth: 460, width: '100%' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Confirmar Ingreso</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
              Este pago se agrega a los ingresos del negocio y queda marcado como verificado por estado de cuenta.
            </div>
            <div style={{ background: 'var(--bg-deep)', borderRadius: 10, padding: '14px 16px', marginBottom: 20 }}>
              {[
                ['Remitente', confirmingTx.tx.sender_name || '—'],
                ['Cuenta', CUENTA_LABELS[confirmingTx.tx.cuenta]?.label || confirmingTx.tx.cuenta],
                ['Tipo', confirmingTx.tx.tipo?.toUpperCase() || '—'],
                ['Referencia', confirmingTx.tx.referencia || '—'],
                ['Fecha', confirmingTx.tx.fecha || '—'],
                ['Monto', confirmingTx.tx.monto_usd ? fmt(confirmingTx.tx.monto_usd) : '—'],
                ['Negocio', '#' + confirmingTx.deal.negocio_num + ' — ' + confirmingTx.deal.cliente_nombre],
              ].map(([label, value]: any) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{value}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirmingTx(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer' }}>Cancelar</button>
              <button onClick={() => confirmIngreso(confirmingTx.tx, confirmingTx.deal)} disabled={addingIngreso}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: '#10B981', color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: addingIngreso ? 0.6 : 1 }}>
                {addingIngreso ? 'Agregando...' : '✓ Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual match modal */}
      {selectedTx && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 16, padding: 28, maxWidth: 440, width: '100%' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Ligar Transacción a Negocio</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 20 }}>
              {selectedTx.sender_name} · {selectedTx.monto_usd ? fmt(selectedTx.monto_usd) : '—'} · {fmtDate(selectedTx.fecha)}
            </div>
            <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, display: 'block', marginBottom: 6 }}>Negocio # (número)</label>
            <input
              value={matchDealId}
              onChange={e => setMatchDealId(e.target.value)}
              placeholder="Ej: 55882"
              style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box', marginBottom: 16 }}
              autoFocus
            />
            {matchDealId && (() => {
              const d = deals.find(d => String(d.negocio_num) === matchDealId.trim())
              if (!d) return <div style={{ fontSize: 12, color: '#BB162B', marginBottom: 12 }}>Negocio no encontrado</div>
              return <div style={{ fontSize: 12, color: '#10B981', marginBottom: 12 }}>✓ {d.cliente_nombre} · {d.banco}</div>
            })()}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => { setSelectedTx(null); setMatchDealId('') }} style={{ flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer' }}>Cancelar</button>
              <button onClick={handleManualMatch} disabled={linking || !matchDealId || !deals.find(d => String(d.negocio_num) === matchDealId.trim())}
                style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: '#3B82F6', color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: (linking || !matchDealId) ? 0.5 : 1 }}>
                {linking ? 'Ligando…' : 'Ligar →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  )
}


export default function BancoPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--bg-page)' }} />}>
      <BancoPageInner />
    </Suspense>
  )
}