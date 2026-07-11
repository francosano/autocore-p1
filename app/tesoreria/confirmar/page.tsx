// ═══════════════════════════════════════════════════════════════════════════

// TARGET: autocore-npa/app/tesoreria/confirmar/page.tsx

// AutoCore NPA — Ingresos por confirmar (overhauled + redesigned)

//

// URL: /tesoreria/confirmar   Gate: tesoreria_can_confirm_fx (o tesoreria_admin)

//

// Esta es la ventana de APROBACIÓN. Muestra todo el detalle del ingreso:

//   • Método real (Zelle / Wire / Bolívares / USDT) y destino, incl. USDT_WALLET

//   • Descripción de quien registró (Ángeles), prominente

//   • Remitente, referencia, fecha, tercero, origen

//   • Cruce bancario: correo BofA (métodos banco) o nota USDT (sin cruce de correo)

//   • Coincidencias bancarias (AI) con re-enlace

//   • Asignar a Inicial Diferida (split); excedente = saldo a favor (pagos_recibidos)

// Acciones a la derecha de cada tarjeta. Confirmar / Asignar / Rechazar.

// ═══════════════════════════════════════════════════════════════════════════

'use client'

import { useEffect, useState, useCallback } from 'react'

import { useRouter } from 'next/navigation'

import { supabase } from '../../supabase'

import AdminShell from '../../components/AdminShell'

import { useAuthGate } from '../../components/useAuthGate'

import SessionErrorScreen from '../../components/SessionErrorScreen'



const CUENTA_LABEL: Record<string, string> = {

  motocentro: 'BofA · Motocentro', roframi: 'BofA · Roframi', roframi_regions: 'Regions · Roframi',

  panama: 'Mercantil · Panamá', bolivares: 'Bolívares', UNKNOWN: 'Sin asignar',

}

const METODO: Record<string, { label: string; color: string }> = {

  zelle:     { label: 'Zelle',          color: '#1B4AAA' },

  wire:      { label: 'Wire',           color: '#0e7490' },

  bolivares: { label: 'Bolívares',      color: '#7c3aed' },

  usdt:      { label: 'USDT · Binance', color: '#0a8a5f' },

  banco:     { label: 'Banco',          color: '#64748b' },

}



// ── Cobranza centralization (2026-06-22) ─────────────────────────────────────
// This single queue now also confirms COBRANZA payments (loan cuotas + inicial
// diferida). There are two shapes:
//   1. Comprobante-linked — Ángeles registered via tesorería (categoria
//      INGRESO_CUOTA). The comprobante carries the receipt; on confirm we also
//      flip the linked cobranza_cuota_pagos row to 'approved' so the Portal
//      "Pagos por verificar" clears. No more bouncing to the Portal.
//   2. Standalone — a cobranza_cuota_pagos / diferida pago still pending_review
//      whose comprobante is already approved (or never existed, e.g. Portal
//      origin). We surface it here too so nothing stays orphaned.
// EVERY card MUST show the uploaded receipt (the comprobante Ángeles attaches,
// read by AI). REQUIRE_RECEIPT blocks confirmation when no receipt is on file.
const REQUIRE_RECEIPT = true
const COBRANZA_CATEGORIAS = new Set(['INGRESO_CUOTA'])

// Client receipt is sent from HERE (the approval window) — never automatically.

// The worker mints the REC-… number, builds the PDF and only delivers it if the

// linked client has a phone on file.

const WHATSAPP_WORKER = 'https://autocore-whatsapp.sano-franco.workers.dev'

const RECIBO_METODO: Record<string, string> = {

  zelle: 'Zelle', wire: 'Transferencia / Wire', usdt: 'USDT (Binance)',

  bolivares: 'Bolívares', banco: 'Transferencia',

}



const fmt = (n: number | null | undefined) => `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtBs = (n: number | null | undefined) => `Bs ${(n || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (iso: string | null | undefined) => { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return d && m && y ? `${d}/${m}/${y}` : String(iso) }

const fmtDateTime = (iso: string | null | undefined) => { if (!iso) return '—'; const d = new Date(iso); const p = (x: number) => String(x).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}` }

const todayISO = () => new Date().toISOString().slice(0, 10)



// ── AI matcher (mirrors lib/conciliacion thresholds) ──────────────────────────

const amtClose = (a: number, b: number, tol = 1) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tol

const dateDiff = (a: string, b: string) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000)

function refSim(a: string | null, b: string | null): boolean {

  if (!a || !b) return false

  const ca = a.replace(/[^a-z0-9]/gi, '').toLowerCase(); const cb = b.replace(/[^a-z0-9]/gi, '').toLowerCase()

  if (ca.length < 4 || cb.length < 4) return false

  return ca.includes(cb) || cb.includes(ca)

}

function namesMatch(txName: string | null, payerName: string | null): boolean {

  if (!txName || !payerName) return false

  const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/gi, '').toLowerCase().trim().split(/\s+/).filter(w => w.length > 2)

  const a = norm(txName), b = norm(payerName); if (!a.length || !b.length) return false

  const hits = a.filter(w => b.includes(w)).length

  return hits >= 1 && (hits >= 2 || a.length === 1 || b.length === 1)

}

interface Cand { tx: any; score: number; strength: 'exact' | 'strong' | 'ai'; razon: string }

function scoreCandidates(it: any, txs: any[]): Cand[] {

  const out: Cand[] = []

  for (const tx of txs) {

    if (!amtClose(tx.monto_usd, it.monto_usd, 2)) continue

    const dd = it.fecha ? dateDiff(tx.fecha, it.fecha) : 99

    const hasRef = refSim(tx.referencia, it.referencia); const nameOK = namesMatch(tx.sender_name, it.sender)

    let score = 60, razon = 'Monto coincide'

    if (hasRef && dd <= 2)      { score = 98; razon = 'Monto, referencia y fecha coinciden' }

    else if (hasRef)            { score = 92; razon = 'Monto y referencia coinciden' }

    else if (dd <= 0.0001)      { score = 88; razon = 'Monto exacto y misma fecha' }

    else if (dd <= 2 && nameOK) { score = 84; razon = `Monto, nombre y fecha ±${Math.round(dd)}d` }

    else if (dd <= 2)           { score = 78; razon = `Monto exacto, fecha ±${Math.round(dd)}d` }

    else if (nameOK)            { score = 72; razon = 'Monto y nombre coinciden' }

    const strength: Cand['strength'] = score >= 90 ? 'exact' : score >= 78 ? 'strong' : 'ai'

    out.push({ tx, score, strength, razon })

  }

  return out.sort((a, b) => b.score - a.score).slice(0, 4)

}



// ── Devoluciones a clientes (2026-07-08) ─────────────────────────────────────
// Esta cola también aprueba EGRESOS tipo DEVOLUCION_CLIENTE (solicitados desde
// /auditoria en deals con SOBRANTE). Mirla verifica contra el deal (link) y
// aprueba/rechaza; el pago lo ejecuta Caja Chica en /tesoreria/caja-chica.
// Flujo aparte del pipeline de ingresos: sin cruce bancario ni comprobante.
interface DevItem {
  id: string; numero: string; monto_usd: number; concepto: string | null
  cliente: string | null; solicitado_at: string | null; registrante: string | null
  sourceLabel: string | null; negocioNum: string | null; dealId: string | null
}

interface Item {

  id: string; numero: string; monto_usd: number; bsAmount: number | null; tasaBcv: number | null; concepto: string | null; categoria: string | null

  solicitado_at: string | null; proofUrl: string | null; notaOperador: string | null; sourceLabel: string | null

  bankTxId: string | null; cuenta: string | null; fecha: string | null

  sender: string | null; referencia: string | null; metodo: string; destinoLabel: string

  isUSDT: boolean; seenEmail: boolean; seenStatement: boolean; registrante: string | null

  tercero: string | null

  revisadoPor?: string | null; revisadoAt?: string | null; rechazoMotivo?: string | null

  // ── Cobranza linkage ──

  esCobranza: boolean                 // show the big COBRANZA banner

  isComprobante: boolean              // true → it.id is a tesoreria_comprobante; false → standalone cobranza pago

  cobranzaPagoId: string | null       // the cobranza_cuota_pagos / diferida pago to cascade

  cobranzaTable: 'cobranza_cuota_pagos' | 'compromisos_inicial_diferida_pagos' | null

  cobranzaCuotaId: string | null      // parent cobranza_cuotas.id (for recibo minting)

  cobranzaDetalle: string | null      // e.g. "Cuota 3 · SELTOS AP180B"

}



function ReviewedCard({ it, kind, busy, onAction }: { it: Item; kind: 'aprobado' | 'rechazado'; busy: boolean; onAction: () => void }) {

  const m = METODO[it.metodo] || METODO.banco

  const isBs = it.metodo === 'bolivares' && it.bsAmount != null

  const tone = kind === 'aprobado' ? '#16A34A' : '#BB162B'

  return (

    <div style={{ ...s.card, opacity: 0.97 }}>

      <div style={s.head}>

        <div style={s.headLeft}>

          <span style={s.ingresoTag}>Ingreso</span>

          <span style={s.numero}>{it.numero}</span>

          <span style={{ ...s.methodBadge, color: m.color, borderColor: m.color }}>{m.label}</span>

          <span style={{ ...s.methodBadge, color: tone, borderColor: tone }}>{kind === 'aprobado' ? 'Aprobado' : 'Rechazado'}</span>

        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>

          <span style={s.amount}>{isBs ? fmtBs(it.bsAmount as number) : fmt(it.monto_usd)}</span>

          {isBs && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>≈ {fmt(it.monto_usd)}</span>}

        </div>

      </div>

      <div style={{ padding: '14px 20px', display: 'flex', flexWrap: 'wrap', gap: '6px 24px', alignItems: 'center' }}>

        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{it.sender || '—'}</div>
        {it.esCobranza && <span style={s.cobranzaChip}>COBRANZA</span>}

        {it.referencia && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>ref {it.referencia}</div>}

        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{it.fecha || '—'}</div>

        {it.categoria && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{it.categoria}</div>}

        <div style={{ flex: 1 }} />

        {it.proofUrl && <a href={it.proofUrl} target="_blank" rel="noreferrer" style={s.proof}>Ver comprobante ↗</a>}

      </div>

      <div style={{ padding: '0 20px 16px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>

        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>

          {kind === 'aprobado' ? 'Aprobado' : 'Rechazado'} por <strong>{it.revisadoPor || '—'}</strong>{it.revisadoAt ? ` · ${String(it.revisadoAt).slice(0, 16).replace('T', ' ')}` : ''}

          {kind === 'rechazado' && it.rechazoMotivo ? <span style={{ display: 'block', color: '#BB162B', marginTop: 3 }}>Motivo: {it.rechazoMotivo}</span> : null}

        </div>

        <button style={{ ...s.railBtn, width: 'auto', padding: '9px 16px', ...(kind === 'aprobado' ? s.btnRejectGhost : s.btnAlloc) }} disabled={busy} onClick={onAction}>

          {busy ? 'Procesando…' : (kind === 'aprobado' ? 'Revertir aprobación' : 'Reconsiderar')}

        </button>

      </div>

    </div>

  )

}



export default function ConfirmarIngresos() {

  const router = useRouter()

  const gate = useAuthGate(p => p.tesoreria_can_confirm_fx || p.tesoreria_admin)



  const [items, setItems] = useState<Item[]>([])

  const [devoluciones, setDevoluciones] = useState<DevItem[]>([])

  const [devRejectId, setDevRejectId] = useState<string | null>(null)

  const [approvedItems, setApprovedItems] = useState<Item[]>([])

  const [rejectedItems, setRejectedItems] = useState<Item[]>([])

  const [activeTab, setActiveTab] = useState<'pendientes' | 'aprobados' | 'rechazados'>('pendientes')

  const [loading, setLoading] = useState(true)

  const [busy, setBusy] = useState<string | null>(null)

  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  // Duplicate-payment guard (one bank deposit must fund only one payment).
  const [dupLoading, setDupLoading] = useState(false)
  const [dupHits, setDupHits] = useState<any[]>([])          // possible duplicates of the item being confirmed
  const [dupHardBlock, setDupHardBlock] = useState<string | null>(null) // deposit already claimed → cannot approve
  const [dupAck, setDupAck] = useState(false)                 // user acknowledged a soft duplicate

  const [msg, setMsg] = useState<string | null>(null)
  // Cobranza cuota/diferida pagos store the approver as a TEXT email (the
  // comprobante uses revisado_por uuid). Capture the email once for cascades.
  const [reviewerEmail, setReviewerEmail] = useState<string>('')

  // Post-approval receipt prompt

  const [receiptPrompt, setReceiptPrompt] = useState<Item | null>(null)

  const [receiptStatus, setReceiptStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  const [receiptErr, setReceiptErr] = useState<string | null>(null)
  // Recibo number minted at cobranza approval, keyed by item id (for the modal).
  const [reciboMinted, setReciboMinted] = useState<Record<string, string>>({})

  const [rejectId, setRejectId] = useState<string | null>(null)

  const [reason, setReason] = useState<Record<string, string>>({})

  const [cands, setCands] = useState<Record<string, Cand[]>>({})



  const [allocId, setAllocId] = useState<string | null>(null)

  const [compSearch, setCompSearch] = useState('')

  const [comps, setComps] = useState<any[]>([])

  const [compsLoading, setCompsLoading] = useState(false)

  const [alloc, setAlloc] = useState<Record<string, string>>({})



  const load = useCallback(async () => {

    setLoading(true)

    try {

      const cols = 'id, numero, monto_usd, concepto, contraparte_nombre, categoria, source_label, solicitado_by, solicitado_at, notas, bank_transaction_id, ubicacion_destino_id, banco_bs_nombre, tasa_bcv_usada, monto_bs, es_tercero, tercero_nombre, tercero_cedula, tercero_relacion, revisado_por, revisado_at, revision_motivo'

      const [pq, aq, rq, dq] = await Promise.all([

        (supabase.from('tesoreria_comprobantes').select(cols).eq('tipo', 'INGRESO').eq('revision_estado', 'pendiente').order('solicitado_at', { ascending: true }) as any),

        (supabase.from('tesoreria_comprobantes').select(cols).eq('tipo', 'INGRESO').eq('revision_estado', 'aprobado').order('revisado_at', { ascending: false }).limit(60) as any),

        (supabase.from('tesoreria_comprobantes').select(cols).eq('tipo', 'INGRESO').eq('revision_estado', 'rechazado').order('revisado_at', { ascending: false }).limit(60) as any),

        // EGRESOS por confirmar: devoluciones a clientes solicitadas desde Auditoría.
        (supabase.from('tesoreria_comprobantes')
          .select('id, numero, monto_usd, concepto, contraparte_nombre, source_id, source_label, solicitado_by, solicitado_at')
          .eq('tipo', 'EGRESO').eq('egreso_tipo', 'DEVOLUCION_CLIENTE')
          .eq('revision_estado', 'pendiente').eq('estado', 'SOLICITADO')
          .order('solicitado_at', { ascending: true }) as any),

      ])

      const pend: any[] = Array.isArray(pq.data) ? pq.data : []

      const appr: any[] = Array.isArray(aq.data) ? aq.data : []

      const rej: any[] = Array.isArray(rq.data) ? rq.data : []

      const devRows: any[] = Array.isArray(dq.data) ? dq.data : []

      const all = [...pend, ...appr, ...rej]



      const txIds = all.map(c => c.bank_transaction_id).filter(Boolean)

      const txMap: Record<string, any> = {}

      if (txIds.length) {

        const tq = await (supabase.from('bank_transactions')

          .select('id, cuenta, fecha, sender_name, referencia, tipo, monto_usd, monto_bs, direccion, seen_in_email, seen_in_statement').in('id', txIds) as any)

        if (Array.isArray(tq.data)) for (const t of tq.data) txMap[t.id] = t

      }



      const ubiMap: Record<string, any> = {}

      const uq = await (supabase.from('tesoreria_ubicaciones').select('id, codigo, nombre') as any)

      if (Array.isArray(uq.data)) for (const u of uq.data) ubiMap[u.id] = u



      const uids = Array.from(new Set([...all.flatMap(c => [c.solicitado_by, c.revisado_por]), ...devRows.map(d => d.solicitado_by)].filter(Boolean)))

      const userMap: Record<string, string> = {}

      if (uids.length) {

        const ur = await (supabase.from('user_roles').select('user_id, full_name, email').in('user_id', uids) as any)

        if (Array.isArray(ur.data)) for (const u of ur.data) userMap[u.user_id] = (u.full_name && u.full_name.trim()) || (u.email ? String(u.email).split('@')[0] : '')

      }



      // Devoluciones → resolver negocio/cliente desde el deal de origen para el
      // link de verificación (/auditoria?negocio=NUM). Fallback: parsear el
      // source_label ("Neg 56020 · Cliente").
      const dealMap: Record<string, any> = {}
      const dealIds = Array.from(new Set(devRows.map((d: any) => d.source_id).filter(Boolean)))
      if (dealIds.length) {
        const dr = await (supabase.from('deals').select('id, negocio_num, cliente_nombre, cliente_apellidos').in('id', dealIds) as any)
        if (Array.isArray(dr.data)) for (const d of dr.data) dealMap[String(d.id)] = d
      }
      setDevoluciones(devRows.map((c: any): DevItem => {
        const dl = c.source_id ? dealMap[String(c.source_id)] : null
        const negFromLabel = /Neg\s+(\S+)/.exec(String(c.source_label || ''))
        return {
          id: c.id, numero: c.numero, monto_usd: Number(c.monto_usd || 0), concepto: c.concepto || null,
          cliente: c.contraparte_nombre || (dl ? [dl.cliente_nombre, dl.cliente_apellidos].filter(Boolean).join(' ') : null),
          solicitado_at: c.solicitado_at || null,
          registrante: c.solicitado_by ? (userMap[c.solicitado_by] || null) : null,
          sourceLabel: c.source_label || null,
          negocioNum: dl?.negocio_num != null ? String(dl.negocio_num) : (negFromLabel ? negFromLabel[1] : null),
          dealId: c.source_id || null,
        }
      }))



      // INGRESO_CUOTA comprobantes usually carry a null contraparte_nombre (the
      // payer is identified by the cobranza contrato, not re-entered here), which
      // left REMITENTE blank. Resolve the client's name from the linked cobranza
      // pago (referencia_pago == comprobante.numero) → contrato → cliente.
      const cuotaClienteMap: Record<string, string> = {}
      const cuotaNumeros = all
        .filter(c => c.categoria === 'INGRESO_CUOTA' && c.numero && !c.contraparte_nombre)
        .map(c => c.numero)
      if (cuotaNumeros.length) {
        const pq2 = await (supabase.from('cobranza_cuota_pagos')
          .select('referencia_pago, contrato_id').in('referencia_pago', cuotaNumeros) as any)
        const pagos2 = Array.isArray(pq2.data) ? pq2.data : []
        const ctIds = Array.from(new Set(pagos2.map((p: any) => p.contrato_id).filter(Boolean)))
        const ctName: Record<string, string> = {}
        if (ctIds.length) {
          const cq2 = await (supabase.from('cobranza_contratos')
            .select('id, cliente_nombre, cliente_apellidos').in('id', ctIds) as any)
          for (const ct of (Array.isArray(cq2.data) ? cq2.data : [])) {
            ctName[ct.id] = [ct.cliente_nombre, ct.cliente_apellidos].filter(Boolean).join(' ').trim()
          }
        }
        for (const p of pagos2) {
          if (p.referencia_pago && p.contrato_id && ctName[p.contrato_id]) {
            cuotaClienteMap[p.referencia_pago] = ctName[p.contrato_id]
          }
        }
      }

      const mapComp = (c: any): Item => {

        const tx = c.bank_transaction_id ? txMap[c.bank_transaction_id] : null

        const destino = c.ubicacion_destino_id ? ubiMap[c.ubicacion_destino_id] : null

        const destinoCodigo = destino?.codigo || ''

        const isUSDT = destinoCodigo === 'USDT_WALLET'

        const metodo = isUSDT ? 'usdt' : c.banco_bs_nombre ? 'bolivares' : (tx?.tipo || 'banco')

        const bsAmount = metodo === 'bolivares'

          ? (c.monto_bs != null ? Number(c.monto_bs)

             : c.tasa_bcv_usada ? Number(c.monto_usd || 0) * Number(c.tasa_bcv_usada)

             : tx?.monto_bs != null ? Number(tx.monto_bs) : null)

          : null

        const destinoLabel = isUSDT ? 'Wallet USDT (Binance)' : (CUENTA_LABEL[tx?.cuenta || 'UNKNOWN'] || tx?.cuenta || (c.banco_bs_nombre ? `Bs · ${c.banco_bs_nombre}` : 'Sin asignar'))

        const notas = String(c.notas || ''); const proof = /Comprobante:\s*(\S+)/.exec(notas)

        const nota = notas.replace(/Comprobante:\s*\S+/g, '').replace(/^\s*·\s*|\s*·\s*$/g, '').trim() || null

        const tercero = c.es_tercero ? `${c.tercero_nombre || '—'}${c.tercero_relacion ? ` (${c.tercero_relacion})` : ''}${c.tercero_cedula ? ` · ${c.tercero_cedula}` : ''}` : null

        return {

          id: c.id, numero: c.numero, monto_usd: c.monto_usd || 0, bsAmount, tasaBcv: c.tasa_bcv_usada ? Number(c.tasa_bcv_usada) : null, concepto: c.concepto, categoria: c.categoria,

          solicitado_at: c.solicitado_at, proofUrl: proof ? proof[1] : null, notaOperador: nota, sourceLabel: c.source_label || null,

          bankTxId: c.bank_transaction_id || null, cuenta: tx?.cuenta || null,

          fecha: tx?.fecha || (c.solicitado_at ? String(c.solicitado_at).slice(0, 10) : null),

          // REMITENTE is always the buyer Ángeles registered (contraparte_nombre).
          // The bank deposit's sender_name (which may be a third party who paid on
          // the buyer's behalf) is for reconciliation only and stays in the bank
          // match list — it must never overwrite who the money belongs to.
          sender: c.contraparte_nombre || cuotaClienteMap[c.numero] || tx?.sender_name || null, referencia: tx?.referencia || null,

          metodo, destinoLabel, isUSDT, seenEmail: !!tx?.seen_in_email, seenStatement: !!tx?.seen_in_statement,

          registrante: c.solicitado_by ? (userMap[c.solicitado_by] || null) : null, tercero,

          revisadoPor: c.revisado_por ? (userMap[c.revisado_por] || null) : null, revisadoAt: c.revisado_at || null, rechazoMotivo: c.revision_motivo || null,

          esCobranza: COBRANZA_CATEGORIAS.has(String(c.categoria || '')), isComprobante: true,

          cobranzaPagoId: null, cobranzaTable: COBRANZA_CATEGORIAS.has(String(c.categoria || '')) ? 'cobranza_cuota_pagos' : null,

          cobranzaCuotaId: null, cobranzaDetalle: null,

        }

      }



      const list = pend.map(mapComp)



      // ── COBRANZA centralization ──────────────────────────────────────────

      // metodo_pago / metodo on the pago is free text — bucket it for the badge.

      const bucket = (raw: string | null): string => {

        const v = (raw || '').toLowerCase()

        if (v.includes('usdt')) return 'usdt'

        if (v.includes('zelle')) return 'zelle'

        if (v.includes('wire')) return 'wire'

        if (v.includes('bol')) return 'bolivares'

        return 'banco'

      }

      const proofFromNotas = (n: any): string | null => { const m = /Comprobante:\s*(\S+)/.exec(String(n || '')); return m ? m[1] : null }



      // Pending cobranza payments (both tables) still awaiting verification.

      const [pagoCuotaQ, pagoDifQ] = await Promise.all([

        (supabase.from('cobranza_cuota_pagos').select('id, cuota_id, contrato_id, monto_usd, fecha_pago, metodo_pago, referencia_pago, comprobante_url, notas_pago, source_app, bank_tx_id, created_at').eq('status', 'pending_review').eq('is_reversal', false).order('created_at', { ascending: true }) as any),

        (supabase.from('compromisos_inicial_diferida_pagos').select('id, compromiso_id, deal_id, monto_usd, fecha, metodo, referencia, comprobante_url, comentario, source_app, bank_tx_id, created_at').eq('status', 'pending_review').eq('is_reversal', false).order('created_at', { ascending: true }) as any),

      ])

      const pagoCuotas = Array.isArray(pagoCuotaQ?.data) ? pagoCuotaQ.data : []

      const pagoDifs   = Array.isArray(pagoDifQ?.data) ? pagoDifQ.data : []



      // 1) Link comprobante-pending cobranza cards to their pending cuota pago.

      const numToComp: Record<string, Item> = {}

      list.forEach(it => { if (it.numero) numToComp[it.numero] = it })

      const linkedPagoIds = new Set<string>()

      pagoCuotas.forEach((p: any) => {

        const comp = p.referencia_pago ? numToComp[p.referencia_pago] : null

        if (comp) { comp.esCobranza = true; comp.cobranzaPagoId = p.id; comp.cobranzaTable = 'cobranza_cuota_pagos'; comp.cobranzaCuotaId = p.cuota_id || null; linkedPagoIds.add(p.id) }

      })



      // 2) Enrich + build STANDALONE cards for cobranza pagos NOT linked to a

      //    pending comprobante (comprobante already approved, or Portal origin).

      const standaloneCuotas = pagoCuotas.filter((p: any) => !linkedPagoIds.has(p.id))

      const cuotaIds    = [...new Set(standaloneCuotas.map((p: any) => p.cuota_id).filter(Boolean))]

      const contratoIds = [...new Set(standaloneCuotas.map((p: any) => p.contrato_id).filter(Boolean))]

      const compIds     = [...new Set(pagoDifs.map((p: any) => p.compromiso_id).filter(Boolean))]

      // receipts may live on an already-approved comprobante referenced by numero

      const refNumeros  = [...new Set([...standaloneCuotas, ...pagoDifs].map((p: any) => p.referencia_pago || p.referencia).filter(Boolean))]

      const cuotaMap: Record<string, any> = {}, contratoMap: Record<string, any> = {}, compMap: Record<string, any> = {}, compReceiptMap: Record<string, string | null> = {}

      await Promise.all([

        cuotaIds.length    ? (supabase.from('cobranza_cuotas').select('id, cuota_label, cuota_num, monto_cuota, fecha_vencimiento').in('id', cuotaIds) as any).then((r: any) => { (Array.isArray(r?.data) ? r.data : []).forEach((c: any) => { cuotaMap[c.id] = c }) }) : Promise.resolve(),

        contratoIds.length ? (supabase.from('cobranza_contratos').select('id, cliente_nombre, cliente_apellidos, modelo, vehiculo_marca, placa').in('id', contratoIds) as any).then((r: any) => { (Array.isArray(r?.data) ? r.data : []).forEach((c: any) => { contratoMap[c.id] = c }) }) : Promise.resolve(),

        compIds.length     ? (supabase.from('compromisos_inicial_diferida').select('id, negocio_num, cliente_nombre, cliente_apellidos, vehiculo_modelo, vehiculo_placa').in('id', compIds) as any).then((r: any) => { (Array.isArray(r?.data) ? r.data : []).forEach((c: any) => { compMap[c.id] = c }) }) : Promise.resolve(),

        refNumeros.length  ? (supabase.from('tesoreria_comprobantes').select('numero, notas').in('numero', refNumeros) as any).then((r: any) => { (Array.isArray(r?.data) ? r.data : []).forEach((c: any) => { compReceiptMap[c.numero] = proofFromNotas(c.notas) }) }) : Promise.resolve(),

      ])



      const standaloneItems: Item[] = []

      standaloneCuotas.forEach((p: any) => {

        const cu = cuotaMap[p.cuota_id] || {}; const ct = contratoMap[p.contrato_id] || {}

        const cliente = [ct.cliente_nombre, ct.cliente_apellidos].filter(Boolean).join(' ') || '—'

        const veh = [ct.vehiculo_marca || ct.modelo, ct.placa].filter(Boolean).join(' ')

        const cuotaLbl = cu.cuota_label || (cu.cuota_num != null ? `Cuota ${cu.cuota_num}` : 'Cuota')

        standaloneItems.push({

          id: 'cob:' + p.id, numero: p.referencia_pago || 'COBRANZA', monto_usd: Number(p.monto_usd || 0), bsAmount: null, tasaBcv: null,

          concepto: cuotaLbl, categoria: 'INGRESO_CUOTA', solicitado_at: p.created_at,

          proofUrl: p.comprobante_url || (p.referencia_pago ? compReceiptMap[p.referencia_pago] || null : null),

          notaOperador: p.notas_pago || null, sourceLabel: p.source_app || null,

          bankTxId: p.bank_tx_id || null, cuenta: null, fecha: p.fecha_pago || (p.created_at ? String(p.created_at).slice(0, 10) : null),

          sender: cliente, referencia: p.referencia_pago || null, metodo: bucket(p.metodo_pago), destinoLabel: 'Cobranza',

          isUSDT: bucket(p.metodo_pago) === 'usdt', seenEmail: false, seenStatement: false, registrante: p.source_app || null, tercero: null,

          esCobranza: true, isComprobante: false, cobranzaPagoId: p.id, cobranzaTable: 'cobranza_cuota_pagos',

          cobranzaCuotaId: p.cuota_id || null,

          cobranzaDetalle: [cuotaLbl, veh].filter(Boolean).join(' · ') || null,

        })

      })

      pagoDifs.forEach((p: any) => {

        const co = compMap[p.compromiso_id] || {}

        const cliente = [co.cliente_nombre, co.cliente_apellidos].filter(Boolean).join(' ') || '—'

        const veh = [co.vehiculo_modelo, co.vehiculo_placa].filter(Boolean).join(' ')

        standaloneItems.push({

          id: 'cob:' + p.id, numero: p.referencia || (co.negocio_num ? `Neg ${co.negocio_num}` : 'DIFERIDA'), monto_usd: Number(p.monto_usd || 0), bsAmount: null, tasaBcv: null,

          concepto: 'Inicial diferida', categoria: 'INGRESO_INICIAL', solicitado_at: p.created_at,

          proofUrl: p.comprobante_url || (p.referencia ? compReceiptMap[p.referencia] || null : null),

          notaOperador: p.comentario || null, sourceLabel: p.source_app || null,

          bankTxId: p.bank_tx_id || null, cuenta: null, fecha: p.fecha || (p.created_at ? String(p.created_at).slice(0, 10) : null),

          sender: cliente, referencia: p.referencia || null, metodo: bucket(p.metodo), destinoLabel: 'Cobranza · Diferida',

          isUSDT: bucket(p.metodo) === 'usdt', seenEmail: false, seenStatement: false, registrante: p.source_app || null, tercero: null,

          esCobranza: true, isComprobante: false, cobranzaPagoId: p.id, cobranzaTable: 'compromisos_inicial_diferida_pagos',

          cobranzaCuotaId: null,

          cobranzaDetalle: ['Inicial diferida', co.negocio_num ? `negocio ${co.negocio_num}` : '', veh].filter(Boolean).join(' · ') || null,

        })

      })



      const merged = [...list, ...standaloneItems]

      setItems(merged)



      // Approved / rejected COBRANZA pagos so confirmed cobranza shows in the

      // tabs (and can be reverted). Dedupe against cobranza comprobantes that

      // already appear in the reviewed lists (their referencia == comp numero).

      const buildReviewedCobranza = async (statuses: string[]): Promise<Item[]> => {

        // Approve flows set EITHER 'approved' (this page) OR 'paid' (admin /

        // cash). Both mean confirmed. We show EVERY reviewed cobranza pago as a

        // clear, client-named card (no dedup-out) — the matching comprobante

        // card is dropped below instead, so each payment appears exactly once.

        const q2 = await (supabase.from('cobranza_cuota_pagos')

          .select('id, cuota_id, contrato_id, monto_usd, fecha_pago, metodo_pago, referencia_pago, comprobante_url, notas_pago, source_app, aprobado_por, aprobado_at, rechazo_motivo')

          .in('status', statuses).eq('is_reversal', false).order('aprobado_at', { ascending: false, nullsFirst: false }).limit(80) as any)

        const rows = Array.isArray(q2?.data) ? q2.data : []

        if (!rows.length) return []

        const cids = [...new Set(rows.map((p: any) => p.cuota_id).filter(Boolean))]

        const ctids = [...new Set(rows.map((p: any) => p.contrato_id).filter(Boolean))]

        const cMap: Record<string, any> = {}, ctMap: Record<string, any> = {}

        await Promise.all([

          cids.length  ? (supabase.from('cobranza_cuotas').select('id, cuota_label, cuota_num').in('id', cids) as any).then((r: any) => { (Array.isArray(r?.data) ? r.data : []).forEach((c: any) => { cMap[c.id] = c }) }) : Promise.resolve(),

          ctids.length ? (supabase.from('cobranza_contratos').select('id, cliente_nombre, cliente_apellidos, modelo, vehiculo_marca, placa').in('id', ctids) as any).then((r: any) => { (Array.isArray(r?.data) ? r.data : []).forEach((c: any) => { ctMap[c.id] = c }) }) : Promise.resolve(),

        ])

        return rows.map((p: any) => {

          const cu = cMap[p.cuota_id] || {}; const ct = ctMap[p.contrato_id] || {}

          const cliente = [ct.cliente_nombre, ct.cliente_apellidos].filter(Boolean).join(' ') || '—'

          const veh = [ct.vehiculo_marca || ct.modelo, ct.placa].filter(Boolean).join(' ')

          const cuotaLbl = cu.cuota_label || (cu.cuota_num != null ? `Cuota ${cu.cuota_num}` : 'Cuota')

          return {

            id: 'cob:' + p.id, numero: p.referencia_pago || 'COBRANZA', monto_usd: Number(p.monto_usd || 0), bsAmount: null, tasaBcv: null,

            concepto: cuotaLbl, categoria: 'INGRESO_CUOTA', solicitado_at: p.aprobado_at,

            proofUrl: p.comprobante_url || null, notaOperador: p.notas_pago || null, sourceLabel: p.source_app || null,

            bankTxId: null, cuenta: null, fecha: p.fecha_pago || null,

            sender: cliente, referencia: p.referencia_pago || null, metodo: bucket(p.metodo_pago), destinoLabel: 'Cobranza',

            isUSDT: bucket(p.metodo_pago) === 'usdt', seenEmail: false, seenStatement: false, registrante: p.source_app || null, tercero: null,

            revisadoPor: p.aprobado_por || null, revisadoAt: p.aprobado_at || null, rechazoMotivo: p.rechazo_motivo || null,

            esCobranza: true, isComprobante: false, cobranzaPagoId: p.id, cobranzaTable: 'cobranza_cuota_pagos',

            cobranzaCuotaId: p.cuota_id || null, cobranzaDetalle: [cuotaLbl, veh].filter(Boolean).join(' · ') || null,

          }

        })

      }

      const [apprCob, rejCob] = await Promise.all([buildReviewedCobranza(['approved', 'paid']), buildReviewedCobranza(['rejected'])])

      // Drop the comprobante card whenever a cobranza pago card already represents

      // it (referencia == comprobante numero), so cobranza shows once, with name.

      const apprCobRefs = new Set(apprCob.map(i => i.referencia).filter(Boolean))

      const rejCobRefs  = new Set(rejCob.map(i => i.referencia).filter(Boolean))

      const apprComps = appr.map(mapComp).filter((c: Item) => !(c.numero && apprCobRefs.has(c.numero)))

      const rejComps  = rej.map(mapComp).filter((c: Item) => !(c.numero && rejCobRefs.has(c.numero)))

      // Merge cobranza + comprobante reviewed cards, then sort by ING number.

      // Order by ING number, newest first (ING-0124 at top → ING-0001 at bottom).
      // Year-major so a new year's ING-0001 outranks last year's ING-9999. Cards
      // without an ING number (e.g. Portal cobranza referencias) sink to the bottom.
      const ingSeq = (n: string | null) => {
        const m = /ING-0*(\d+)-(\d+)/i.exec(n || '')
        return m ? parseInt(m[2], 10) * 1000000 + parseInt(m[1], 10) : -1
      }
      const byIngDesc = (a: Item, b: Item) => ingSeq(b.numero) - ingSeq(a.numero)

      setApprovedItems([...apprCob, ...apprComps].sort(byIngDesc))

      setRejectedItems([...rejCob, ...rejComps].sort(byIngDesc))



      const bq = await (supabase.from('bank_transactions')

        .select('id, cuenta, fecha, sender_name, referencia, tipo, monto_usd, direccion, seen_in_email, matched, is_internal, is_bank_fee')

        .eq('matched', false).eq('is_internal', false).eq('is_bank_fee', false)

        .order('fecha', { ascending: false }).limit(500) as any)

      const pool = (Array.isArray(bq.data) ? bq.data : []).filter((t: any) => t.direccion !== 'debit')

      for (const id of txIds) if (txMap[id] && !pool.find((p: any) => p.id === id)) pool.push(txMap[id])

      const cmap: Record<string, Cand[]> = {}

      for (const it of merged) cmap[it.id] = it.isUSDT ? [] : scoreCandidates(it, pool)

      setCands(cmap)

    } catch (e: any) { setMsg('Error cargando: ' + (e?.message || 'desconocido')) } finally { setLoading(false) }

  }, [])



  useEffect(() => { if (gate.status === 'denied') router.replace('/tesoreria/home') }, [gate.status, router])

  useEffect(() => {

    if (gate.status !== 'ok') return

    ;(async () => { try { const { data } = await supabase.auth.getUser(); setReviewerEmail(data?.user?.email || 'NPA') } catch { setReviewerEmail('NPA') } })()

    load()

  }, [gate.status, load])



  // ── Parent-balance recompute ────────────────────────────────────────────
  // The cobranza recompute trigger fires on INSERT, not on a status UPDATE, so
  // when we approve (or revert) a pago we must apply it to the cuota / diferida
  // ourselves. We set the balance to the SUM of approved+paid pagos — idempotent,
  // so it's correct even if a trigger also runs and never double-counts.
  async function recomputeCuota(cuotaId: string | null) {
    if (!cuotaId) return
    try {
      const { data: pagos } = await (supabase.from('cobranza_cuota_pagos').select('monto_usd, status, is_reversal').eq('cuota_id', cuotaId) as any)
      const sum = (Array.isArray(pagos) ? pagos : [])
        .filter((p: any) => !p.is_reversal && (p.status === 'approved' || p.status === 'paid'))
        .reduce((s: number, p: any) => s + Number(p.monto_usd || 0), 0)
      const { data: cu } = await (supabase.from('cobranza_cuotas').select('monto_cuota, status').eq('id', cuotaId).single() as any)
      if (!cu) return
      const closes = sum >= Number(cu.monto_cuota || 0) - 0.005
      await (supabase.from('cobranza_cuotas').update({ monto_pagado: sum, status: closes ? 'paid' : cu.status }).eq('id', cuotaId) as any)
    } catch { /* best-effort — the pago status change already succeeded */ }
  }
  async function recomputeDiferida(pagoId: string | null) {
    if (!pagoId) return
    try {
      const { data: pg } = await (supabase.from('compromisos_inicial_diferida_pagos').select('compromiso_id').eq('id', pagoId).single() as any)
      const compId = pg?.compromiso_id
      if (!compId) return
      const { data: pagos } = await (supabase.from('compromisos_inicial_diferida_pagos').select('monto_usd, status, is_reversal').eq('compromiso_id', compId) as any)
      const sum = (Array.isArray(pagos) ? pagos : [])
        .filter((p: any) => !p.is_reversal && (p.status === 'approved' || p.status === 'paid'))
        .reduce((s: number, p: any) => s + Number(p.monto_usd || 0), 0)
      const { data: comp } = await (supabase.from('compromisos_inicial_diferida').select('monto_usd, estado').eq('id', compId).single() as any)
      if (!comp) return
      const closes = sum >= Number(comp.monto_usd || 0) - 0.005
      await (supabase.from('compromisos_inicial_diferida').update({
        monto_pagado_acumulado: sum,
        estado: closes ? 'PAGADA' : (sum > 0.004 ? 'PARCIAL' : comp.estado),
      }).eq('id', compId) as any)
    } catch { /* best-effort */ }
  }

  // ── Duplicate-payment detection ─────────────────────────────────────────
  // Catches the case where the SAME bank deposit is registered/confirmed twice
  // (e.g. one Procarton wire entered as both ING-0103 and ING-0105). Soft hits
  // (same amount + same payer, pending/approved) require acknowledgement; a
  // deposit already claimed by an APPROVED record is a hard block.
  const normKey = (x: string | null) => (x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  async function checkDuplicates(it: Item) {
    setDupLoading(true); setDupHits([]); setDupHardBlock(null); setDupAck(false)
    try {
      const amt = Number(it.monto_usd || 0)
      if (amt <= 0) return
      const payerKey = normKey(it.sender)
      const selTx = it.bankTxId || null
      const q = await (supabase.from('tesoreria_comprobantes')
        .select('id, numero, monto_usd, contraparte_nombre, revision_estado, solicitado_at, bank_transaction_id')
        .eq('tipo', 'INGRESO')
        .gte('monto_usd', amt - 0.5).lte('monto_usd', amt + 0.5)
        .in('revision_estado', ['pendiente', 'aprobado'])
        .order('solicitado_at', { ascending: false }).limit(60) as any)
      const rows = Array.isArray(q?.data) ? q.data : []
      let hard: string | null = null
      const hits = rows.filter((r: any) => {
        if (it.isComprobante && r.id === it.id) return false
        if (it.numero && r.numero === it.numero) return false
        const rKey = normKey(r.contraparte_nombre)
        const samePayer = payerKey.length > 2 && rKey.length > 2 && (rKey.includes(payerKey) || payerKey.includes(rKey))
        const sameTx = selTx && r.bank_transaction_id && r.bank_transaction_id === selTx
        if (sameTx && r.revision_estado === 'aprobado') {
          hard = `El depósito ya fue confirmado en ${r.numero}. No se puede aprobar el mismo depósito dos veces.`
        }
        return samePayer || sameTx
      })
      setDupHits(hits); setDupHardBlock(hard)
    } catch { /* non-fatal — guard just won't show */ } finally { setDupLoading(false) }
  }
  useEffect(() => {
    if (!confirmingId) { setDupHits([]); setDupHardBlock(null); setDupAck(false); return }
    const it = items.find(x => x.id === confirmingId)
    if (it) checkDuplicates(it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmingId])

  async function relink(it: Item, tx: any) {

    setBusy(it.id); setMsg(null)

    const { error } = it.isComprobante

      ? await (supabase.from('tesoreria_comprobantes').update({ bank_transaction_id: tx.id }).eq('id', it.id) as any)

      : await (supabase.from(it.cobranzaTable as string).update({ bank_tx_id: tx.id, bank_match_strength: 'manual' }).eq('id', it.cobranzaPagoId) as any)

    setBusy(null)

    if (error) { setMsg('Error al re-enlazar: ' + error.message); return }

    setItems(prev => prev.map(x => x.id === it.id ? { ...x, bankTxId: tx.id, cuenta: tx.cuenta || x.cuenta, fecha: tx.fecha || x.fecha, referencia: tx.referencia || x.referencia, seenEmail: !!tx.seen_in_email, seenStatement: !!tx.seen_in_statement, destinoLabel: CUENTA_LABEL[tx.cuenta || 'UNKNOWN'] || tx.cuenta || x.destinoLabel } : x))

    setMsg('Coincidencia bancaria actualizada.')

  }



  async function confirmar(it: Item) {

    if (dupHardBlock) { setMsg(dupHardBlock); return }

    if (REQUIRE_RECEIPT && !it.proofUrl) {

      setMsg('No se puede confirmar sin el comprobante adjunto. Pídele a quien registró el pago que suba el comprobante de la transacción.')

      return

    }

    setBusy(it.id); setMsg(null)

    try {

      // 1) Tesorería comprobante (real comprobante cards only).

      if (it.isComprobante) {

        const { error } = await (supabase.from('tesoreria_comprobantes').update({ revision_estado: 'aprobado', revisado_por: gate.userId, revisado_at: new Date().toISOString() }).eq('id', it.id) as any)

        if (error) throw error

      }

      // 2) Cascade: approve the linked cobranza pago AND apply it to the parent

      //    balance. The recompute trigger only fires on INSERT (not on this

      //    status UPDATE), so without this the money never reaches the cuota —

      //    the pago shows "aprobado" but the cuota stays unpaid (the bug that

      //    left $1,000 floating as "crédito").

      if (it.cobranzaPagoId && it.cobranzaTable) {

        const patch: any = { status: 'approved', aprobado_por: reviewerEmail, aprobado_at: new Date().toISOString() }

        if (it.bankTxId) { patch.bank_tx_id = it.bankTxId; patch.bank_match_strength = 'manual' }

        const { error: cobErr } = await (supabase.from(it.cobranzaTable).update(patch).eq('id', it.cobranzaPagoId) as any)

        if (cobErr) throw cobErr



        if (it.cobranzaTable === 'cobranza_cuota_pagos') {

          await recomputeCuota(it.cobranzaCuotaId)

        } else if (it.cobranzaTable === 'compromisos_inicial_diferida_pagos') {

          await recomputeDiferida(it.cobranzaPagoId)

        }



        // 3) COBRANZA recibo: mint a coherent sequence (REC-YYYY-NNNNN) and

        //    denormalize the pago's payment fields onto the cuota so the recibo

        //    PDF shows a valid date / método / referencia / número instead of

        //    "Invalid Date / ? / -".

        if (it.cobranzaTable === 'cobranza_cuota_pagos' && it.cobranzaCuotaId) {

          try {

            const { data: pago } = await (supabase.from('cobranza_cuota_pagos').select('fecha_pago, metodo_pago, referencia_pago').eq('id', it.cobranzaPagoId).single() as any)

            const cuPatch: any = {}

            if (pago?.fecha_pago)      cuPatch.fecha_pago = pago.fecha_pago

            if (pago?.metodo_pago)     cuPatch.metodo_pago = pago.metodo_pago

            if (pago?.referencia_pago) cuPatch.referencia_pago = pago.referencia_pago

            // Only mint a number if the cuota doesn't already have one.

            const { data: cuRow } = await (supabase.from('cobranza_cuotas').select('recibo_numero').eq('id', it.cobranzaCuotaId).single() as any)

            let recNo: string | null = cuRow?.recibo_numero || null

            if (!recNo) {

              const { data: minted } = await (supabase.rpc('cobranza_next_recibo_numero', { p_anio: new Date().getFullYear() }) as any)

              recNo = (typeof minted === 'string' ? minted : null)

              if (recNo) { cuPatch.recibo_numero = recNo; cuPatch.recibo_emitido_at = new Date().toISOString() }

            }

            if (Object.keys(cuPatch).length) await (supabase.from('cobranza_cuotas').update(cuPatch).eq('id', it.cobranzaCuotaId) as any)

            if (recNo) setReciboMinted(m => ({ ...m, [it.id]: recNo as string }))

          } catch { /* recibo minting is best-effort — approval already succeeded */ }

        }

      }

      setConfirmingId(null)

      setItems(prev => prev.filter(x => x.id !== it.id))

      // Receipt-send prompt for tesorería comprobantes AND cobranza payments.

      setReceiptErr(null); setReceiptStatus('idle'); setReceiptPrompt(it)

    } catch (e: any) {

      setMsg('Error al confirmar: ' + (e?.message || 'error'))

    } finally { setBusy(null) }

  }



  function closeReceipt() { setReceiptPrompt(null); setReceiptStatus('idle'); setReceiptErr(null) }



  // Fire the client receipt. Tesorería comprobantes go by comprobante_id;

  // cobranza payments go by the cuota pago (the worker builds the loan recibo

  // with the coherent REC-… number we minted at approval).

  async function enviarRecibo(it: Item) {

    setReceiptStatus('sending'); setReceiptErr(null)

    try {

      const moneda = it.metodo === 'usdt' ? 'USDT' : it.metodo === 'bolivares' ? 'Bs' : 'USD'

      const montoPaid = (moneda === 'Bs' && it.bsAmount != null) ? it.bsAmount : it.monto_usd

      const payload: any = {

        enviado_por: gate.userId,

        force_resend: false,

        receipt: {

          metodo: RECIBO_METODO[it.metodo] || null,

          moneda,

          banco: it.destinoLabel || null,

          referencia: it.referencia || it.sourceLabel || null,

          fecha: (it.fecha && /^\d{4}-\d{2}-\d{2}/.test(it.fecha)) ? it.fecha.slice(0, 10) : todayISO(),

          // Authoritative amounts — print AS-IS, never reconstruct Bs from USD.

          // `monto` is the exact amount in the currency the client actually paid.

          monto: montoPaid,

          monto_bs: it.bsAmount,

          monto_usd: it.monto_usd,

          tasa: it.tasaBcv,

          // Label for the rate on the client receipt. Provincial liquidaciones

          // and Bs cuotas snapshot the BINANCE rate (see ingresos/nuevo), so

          // printing 'Tasa BCV' there is wrong. The whatsapp worker uses this.

          tasa_tipo: (it.categoria === 'INGRESO_LIQ_PROVINCIAL' || (it.metodo === 'bolivares' && it.categoria === 'INGRESO_CUOTA')) ? 'Binance' : 'BCV',

        },

      }

      if (it.isComprobante) {

        payload.comprobante_id = it.id

      } else {

        payload.cobranza_cuota_pago_id = it.cobranzaPagoId

        payload.cobranza_cuota_id = it.cobranzaCuotaId

        payload.recibo_numero = reciboMinted[it.id] || null

      }

      const res = await fetch(WHATSAPP_WORKER + '/send-receipt', {

        method: 'POST',

        headers: { 'Content-Type': 'application/json' },

        body: JSON.stringify(payload),

      })

      if (!res.ok) throw new Error('HTTP ' + res.status)

      setReceiptStatus('sent')

    } catch (e: any) {

      setReceiptStatus('error')

      setReceiptErr('No se pudo enviar el recibo: ' + (e?.message || 'error') + '. Verifica que el cliente tenga teléfono registrado.')

    }

  }



  async function rechazar(it: Item) {

    const motivo = (reason[it.id] || '').trim(); if (!motivo) { setMsg('Indica el motivo del rechazo.'); return }

    setBusy(it.id); setMsg(null)

    try {

      if (it.isComprobante) {

        const { error } = await (supabase.from('tesoreria_comprobantes').update({ revision_estado: 'rechazado', revisado_por: gate.userId, revisado_at: new Date().toISOString(), revision_motivo: motivo }).eq('id', it.id) as any)

        if (error) throw error

        if (it.bankTxId) await (supabase.from('bank_transactions').update({ excluida_revision: true }).eq('id', it.bankTxId) as any)

      }

      if (it.cobranzaPagoId && it.cobranzaTable) {

        const { error: cobErr } = await (supabase.from(it.cobranzaTable).update({ status: 'rejected', rechazo_motivo: motivo, aprobado_por: reviewerEmail, aprobado_at: new Date().toISOString() }).eq('id', it.cobranzaPagoId) as any)

        if (cobErr) throw cobErr

      }

      setRejectId(null); setItems(prev => prev.filter(x => x.id !== it.id))

    } catch (e: any) {

      setMsg('Error al rechazar: ' + (e?.message || 'error'))

    } finally { setBusy(null) }

  }



  // ── Devoluciones a clientes: aprobar / rechazar ─────────────────────────
  // Aprobar deja el comprobante SOLICITADO + revision_estado 'aprobado' — el
  // dinero NO se mueve aquí; Caja Chica lo paga cuando Coraly decida.
  async function aprobarDevolucion(d: DevItem) {
    const ok = confirm(`¿Aprobar la devolución de ${fmt(d.monto_usd)} a ${d.cliente || 'cliente'} (${d.numero})?\n\nQuedará pendiente de pago en efectivo desde Caja Chica.`)
    if (!ok) return
    setBusy(d.id); setMsg(null)
    try {
      const now = new Date().toISOString()
      const { data: upd, error } = await (supabase.from('tesoreria_comprobantes')
        .update({ revision_estado: 'aprobado', aprobado_by: gate.userId, aprobado_at: now, revisado_por: gate.userId, revisado_at: now })
        .eq('id', d.id).eq('revision_estado', 'pendiente').select('id') as any)
      if (error) throw error
      if (!Array.isArray(upd) || upd.length === 0) throw new Error('La devolución ya fue procesada por otra persona.')
      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: d.id, evento: 'APROBADO', actor_user_id: gate.userId, actor_label: 'Tesorería',
        notas: `Devolución aprobada · ${fmt(d.monto_usd)} · ${d.sourceLabel || ''}`.trim(),
      })
      setDevoluciones(prev => prev.filter(x => x.id !== d.id))
      setMsg(`Devolución ${d.numero} aprobada — queda por pagar desde Caja Chica.`)
    } catch (e: any) {
      setMsg('Error al aprobar la devolución: ' + (e?.message || 'error'))
    } finally { setBusy(null) }
  }

  async function rechazarDevolucion(d: DevItem) {
    const motivo = (reason[d.id] || '').trim()
    if (!motivo) { setMsg('Indica el motivo del rechazo.'); return }
    setBusy(d.id); setMsg(null)
    try {
      const now = new Date().toISOString()
      const { data: upd, error } = await (supabase.from('tesoreria_comprobantes')
        .update({ revision_estado: 'rechazado', revision_motivo: motivo, revisado_por: gate.userId, revisado_at: now, estado: 'ANULADO' })
        .eq('id', d.id).eq('revision_estado', 'pendiente').eq('estado', 'SOLICITADO').select('id') as any)
      if (error) throw error
      if (!Array.isArray(upd) || upd.length === 0) throw new Error('La devolución ya fue procesada por otra persona.')
      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: d.id, evento: 'ANULADO', actor_user_id: gate.userId, actor_label: 'Tesorería',
        notas: `Devolución rechazada: ${motivo}`,
      })
      setDevRejectId(null)
      setDevoluciones(prev => prev.filter(x => x.id !== d.id))
      setMsg(`Devolución ${d.numero} rechazada y anulada.`)
    } catch (e: any) {
      setMsg('Error al rechazar la devolución: ' + (e?.message || 'error'))
    } finally { setBusy(null) }
  }



  async function revertir(it: Item) {

    setBusy(it.id); setMsg(null)

    try {

      if (it.isComprobante) {

        const { error } = await (supabase.rpc('revertir_aprobacion_comprobante', { p_comprobante_id: it.id }) as any)

        if (error) { setMsg('No se pudo revertir: ' + error.message); return }

      } else if (it.cobranzaPagoId && it.cobranzaTable) {

        const { error } = await (supabase.from(it.cobranzaTable).update({ status: 'pending_review', aprobado_por: null, aprobado_at: null }).eq('id', it.cobranzaPagoId) as any)

        if (error) { setMsg('No se pudo revertir: ' + error.message); return }

        // Pull the money back out of the parent balance, and invalidate the recibo.

        if (it.cobranzaTable === 'cobranza_cuota_pagos' && it.cobranzaCuotaId) {

          await recomputeCuota(it.cobranzaCuotaId)

          await (supabase.from('cobranza_cuotas').update({ recibo_numero: null, recibo_emitido_at: null }).eq('id', it.cobranzaCuotaId) as any)

        } else if (it.cobranzaTable === 'compromisos_inicial_diferida_pagos') {

          await recomputeDiferida(it.cobranzaPagoId)

        }

      }

      setMsg(`${it.esCobranza ? 'Pago' : 'Ingreso ' + it.numero} devuelto a pendientes.`); load()

    } catch (e: any) {

      setMsg('No se pudo revertir: ' + (e?.message || 'error de red'))

    } finally { setBusy(null) }

  }



  async function reconsiderar(it: Item) {

    setBusy(it.id); setMsg(null)

    try {

      if (it.isComprobante) {

        // A rejected ingreso never posted money — just return it to the queue.

        // (revertir_aprobacion_comprobante is only for APPROVED/posted ones.)

        const { error } = await (supabase.from('tesoreria_comprobantes').update({ revision_estado: 'pendiente', revision_motivo: null, revisado_por: null, revisado_at: null }).eq('id', it.id) as any)

        if (error) { setMsg('No se pudo reconsiderar: ' + error.message); return }

      } else if (it.cobranzaPagoId && it.cobranzaTable) {

        const { error } = await (supabase.from(it.cobranzaTable).update({ status: 'pending_review', rechazo_motivo: null, aprobado_por: null, aprobado_at: null }).eq('id', it.cobranzaPagoId) as any)

        if (error) { setMsg('No se pudo reconsiderar: ' + error.message); return }

      }

      setMsg(`${it.esCobranza ? 'Pago' : 'Ingreso ' + it.numero} devuelto a pendientes.`); load()

    } catch (e: any) {

      setMsg('No se pudo reconsiderar: ' + (e?.message || 'error de red'))

    } finally { setBusy(null) }

  }



  const searchComps = useCallback(async (q: string) => {

    setCompsLoading(true)

    try {

      let query = supabase.from('compromisos_inicial_diferida')

        .select('id, deal_id, negocio_num, cliente_rif, cliente_nombre, cliente_apellidos, monto_usd, monto_pagado_acumulado, saldo_pendiente, estado, fecha_vencimiento')

        .in('estado', ['PENDIENTE', 'PARCIAL']).order('fecha_vencimiento', { ascending: true }).limit(40)

      if (q.trim()) { const t = `%${q.trim()}%`; query = query.or(`cliente_nombre.ilike.${t},cliente_apellidos.ilike.${t},negocio_num.ilike.${t},cliente_rif.ilike.${t}`) }

      const { data } = await (query as any); setComps(Array.isArray(data) ? data : [])

    } finally { setCompsLoading(false) }

  }, [])



  function openAlloc(it: Item) { setAllocId(it.id); setRejectId(null); setMsg(null); setComps([]); setAlloc({}); const g = `${it.sender || ''} ${it.concepto || ''}`.trim(); setCompSearch(g); searchComps(g) }

  function closeAlloc() { setAllocId(null); setComps([]); setAlloc({}); setCompSearch('') }



  const allocItem = items.find(i => i.id === allocId) || null

  const allocTotal = Object.values(alloc).reduce((su, v) => su + (parseFloat(v) || 0), 0)

  const allocLeft = allocItem ? allocItem.monto_usd - allocTotal : 0



  async function applyAlloc() {

    if (!allocItem) return

    const entries = Object.entries(alloc).map(([id, v]) => ({ id, monto: parseFloat(v) || 0 })).filter(e => e.monto > 0.0001)

    if (!entries.length) { setMsg('Indica al menos un monto a asignar.'); return }

    if (allocTotal > allocItem.monto_usd + 0.005) { setMsg('La asignación excede el monto del ingreso.'); return }

    setBusy(allocItem.id); setMsg(null)

    try {

      const groupId = (crypto as any)?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`

      const first = comps.find(c => c.id === entries[0].id); const cedula = first?.cliente_rif || null

      const payerName = first ? `${first.cliente_nombre || ''} ${first.cliente_apellidos || ''}`.trim() : (allocItem.sender || null)

      let pagoRecibidoId: string | null = null

      if (cedula) {

        const surplus = Math.max(0, allocItem.monto_usd - allocTotal)

        const pr = await (supabase.from('pagos_recibidos').insert({

          fecha: allocItem.fecha || todayISO(), moneda: 'USD', monto: allocItem.monto_usd,

          origen: METODO[allocItem.metodo]?.label || allocItem.metodo, payer_cedula: cedula, payer_name: payerName,

          confirmation_code: allocItem.referencia || null, comprob_url: allocItem.proofUrl || null, registered_by: gate.userId,

          status: 'AVAILABLE', monto_disponible: surplus,

          source_comprobante_id: allocItem.id,

          nota_registro: allocItem.notaOperador || allocItem.concepto || null, aprobado_por: gate.userId, aprobado_at: new Date().toISOString(),

          bank_tx_id: allocItem.bankTxId || null, bank_match_strength: allocItem.bankTxId ? 'manual' : null, cuenta_destino: allocItem.cuenta || null,

        }).select('id').single() as any)

        pagoRecibidoId = pr.data?.id || null

      }

      for (const e of entries) {

        const c = comps.find(x => x.id === e.id); if (!c) continue

        const { error } = await (supabase.from('compromisos_inicial_diferida_pagos').insert({

          compromiso_id: c.id, deal_id: c.deal_id, monto_usd: e.monto, fecha: todayISO(),

          metodo: METODO[allocItem.metodo]?.label || allocItem.metodo, referencia: allocItem.referencia || null,

          comentario: allocItem.concepto || allocItem.notaOperador || `Asignado desde ingreso ${allocItem.numero}`,

          registered_by: gate.userId, status: 'paid', source_app: 'NPA', comprobante_url: allocItem.proofUrl || null,

          bank_tx_id: allocItem.bankTxId || null, pago_recibido_id: pagoRecibidoId, allocation_group_id: groupId,

          aprobado_por: gate.userId, aprobado_at: new Date().toISOString(), is_reversal: false,

        }) as any)

        if (error) throw new Error(error.message)

      }

      await (supabase.from('tesoreria_comprobantes').update({ revision_estado: 'aprobado', revisado_por: gate.userId, revisado_at: new Date().toISOString() }).eq('id', allocItem.id) as any)

      const surplus = allocItem.monto_usd - allocTotal

      setMsg(`Asignado ${fmt(allocTotal)} a inicial diferida.` + (surplus > 0.0001 ? ` Saldo a favor de ${payerName || 'cliente'}: ${fmt(surplus)}.` : ''))

      setItems(prev => prev.filter(x => x.id !== allocItem.id)); closeAlloc()

    } catch (e: any) { setMsg('Error al asignar: ' + (e?.message || e)) } finally { setBusy(null) }

  }



  if (gate.status === 'loading') return <div style={s.center}>Cargando…</div>

  if (gate.status === 'error')   return <SessionErrorScreen />

  if (gate.status !== 'ok')      return null



  return (

    <AdminShell active="tesoreria-confirmar">

      <div style={s.content}>

        <button style={s.back} onClick={() => { window.location.href = '/tesoreria/home' }}>‹ Tesorería</button>

        <div style={s.headerRow}>

          <div>

            <div style={s.kicker}>Tesorería · Aprobación</div>

            <h1 style={s.h1}>Ingresos/Egresos por confirmar</h1>

            <p style={s.sub}>Verifica el ingreso contra el banco o la wallet, confírmalo y, si aplica, asígnalo a inicial diferida. Los egresos por devolución a clientes también se aprueban aquí.</p>

          </div>

          <div style={s.countPill}>{items.length + devoluciones.length}</div>

        </div>



        <div style={{ display: 'flex', gap: 8, margin: '4px 0 16px', flexWrap: 'wrap' }}>

          {([['pendientes', `Pendientes (${items.length + devoluciones.length})`], ['aprobados', `Aprobados (${approvedItems.length})`], ['rechazados', `Rechazados (${rejectedItems.length})`]] as [('pendientes' | 'aprobados' | 'rechazados'), string][]).map(([k, label]) => (

            <button key={k} onClick={() => { setActiveTab(k); setMsg(null) }}

              style={{ padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer',

                       border: activeTab === k ? '1.5px solid var(--accent, #1B4AAA)' : '1px solid var(--border)',

                       background: activeTab === k ? 'var(--accent, #1B4AAA)' : 'transparent',

                       color: activeTab === k ? '#fff' : 'var(--text-secondary)' }}>

              {label}

            </button>

          ))}

        </div>



        {msg && <div style={s.msg}>{msg}</div>}



        {loading ? <div style={s.empty}>Cargando ingresos…</div>

        : activeTab === 'aprobados' ? (

            approvedItems.length === 0 ? <div style={s.empty}>No hay ingresos aprobados recientes.</div>

            : approvedItems.map(it => <ReviewedCard key={it.id} it={it} kind="aprobado" busy={busy === it.id} onAction={() => revertir(it)} />)

          )

        : activeTab === 'rechazados' ? (

            rejectedItems.length === 0 ? <div style={s.empty}>No hay ingresos rechazados.</div>

            : rejectedItems.map(it => <ReviewedCard key={it.id} it={it} kind="rechazado" busy={busy === it.id} onAction={() => reconsiderar(it)} />)

          )

        : items.length === 0 && devoluciones.length === 0 ? <div style={s.empty}>No hay ingresos ni egresos por confirmar. Todo al día.</div>

        : <>

        {/* ── EGRESOS: devoluciones a clientes pendientes de aprobación ── */}

        {devoluciones.map(d => {

          const isRej = devRejectId === d.id

          return (

            <div key={d.id} style={s.card}>

              <div style={s.head}>

                <div style={s.headLeft}>

                  <span style={{ ...s.ingresoTag, color: '#BB162B', borderColor: 'rgba(187,22,43,0.55)' }}>Egreso</span>

                  <span style={s.numero}>{d.numero}</span>

                  <span style={{ ...s.methodBadge, color: '#BB162B', borderColor: '#BB162B' }}>Devolución a cliente</span>

                  <span style={s.destino}>Caja Chica · efectivo</span>

                </div>

                <div style={s.headRight}>

                  <span style={{ ...s.amount, color: '#BB162B' }}>−{fmt(d.monto_usd)}</span>

                </div>

              </div>

              <div style={s.body}>

                <div style={s.main}>

                  <div style={s.devolucionBanner}>

                    <span style={s.devolucionBannerTag}>● DEVOLUCIÓN</span>

                    <span style={s.devolucionBannerText}>Se le devolverá dinero al cliente en efectivo desde Caja Chica. Verifica el sobrante en el negocio antes de aprobar.</span>

                  </div>

                  {d.concepto && (

                    <div style={s.notaBox}>

                      <span style={s.notaLabel}>Motivo de {d.registrante || 'Auditoría'}</span>

                      <span style={s.notaText}>{d.concepto}</span>

                    </div>

                  )}

                  <div style={s.grid}>

                    <Field label="Cliente"   value={d.cliente || '—'} />

                    <Field label="Negocio de origen" value={d.sourceLabel || (d.negocioNum ? `Neg ${d.negocioNum}` : '—')} />

                    <Field label="Solicitó"  value={d.registrante || '—'} />

                    <Field label="Solicitado" value={fmtDateTime(d.solicitado_at)} />

                  </div>

                  {d.negocioNum && (

                    <a href={`/auditoria?negocio=${encodeURIComponent(d.negocioNum)}`} target="_blank" rel="noreferrer" style={s.proof}>

                      Ver negocio #{d.negocioNum} en Auditoría ↗

                    </a>

                  )}

                </div>

                {!isRej && (

                  <div style={s.rail}>

                    <button style={{ ...s.railBtn, ...s.btnConfirm }} disabled={busy === d.id} onClick={() => aprobarDevolucion(d)}>{busy === d.id ? 'Procesando…' : 'Aprobar devolución'}</button>

                    <button style={{ ...s.railBtn, ...s.btnRejectGhost }} disabled={busy === d.id} onClick={() => { setDevRejectId(d.id); setMsg(null) }}>Rechazar</button>

                  </div>

                )}

              </div>

              {isRej && (

                <div style={s.panel}>

                  <label style={s.fieldLabel}>Motivo del rechazo</label>

                  <input style={s.input} autoFocus value={reason[d.id] || ''} onChange={e => setReason(r => ({ ...r, [d.id]: e.target.value }))} placeholder="Ej: el sobrante no corresponde / monto incorrecto" />

                  <div style={s.panelActions}>

                    <button style={{ ...s.btn, ...s.btnGhost }} disabled={busy === d.id} onClick={() => { setDevRejectId(null); setMsg(null) }}>Cancelar</button>

                    <button style={{ ...s.btn, ...s.btnReject }} disabled={busy === d.id} onClick={() => rechazarDevolucion(d)}>{busy === d.id ? 'Rechazando…' : 'Confirmar rechazo'}</button>

                  </div>

                </div>

              )}

            </div>

          )

        })}

        {items.map(it => {

          const isRej = rejectId === it.id, isAlloc = allocId === it.id

          const cs = cands[it.id] || []; const linked = it.bankTxId

          const m = METODO[it.metodo] || METODO.banco

          return (

            <div key={it.id} style={s.card}>

              {/* header band */}

              <div style={s.head}>

                <div style={s.headLeft}>

                  <span style={s.ingresoTag}>Ingreso</span>

                  <span style={s.numero}>{it.numero}</span>

                  <span style={{ ...s.methodBadge, color: m.color, borderColor: m.color }}>{m.label}</span>

                  <span style={s.destino}>{it.destinoLabel}</span>

                </div>

                <div style={s.headRight}>

                  {it.metodo === 'bolivares' && it.bsAmount != null ? (

                    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>

                      <span style={s.amount}>{fmtBs(it.bsAmount)}</span>

                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>≈ {fmt(it.monto_usd)}</span>

                    </span>

                  ) : (

                    <span style={s.amount}>{fmt(it.monto_usd)}</span>

                  )}

                </div>

              </div>



              {/* body: detail (left) + action rail (right) */}

              <div style={s.body}>

                <div style={s.main}>

                  {it.esCobranza && (

                    <div style={s.cobranzaBanner}>

                      <span style={s.cobranzaBannerTag}>● COBRANZA</span>

                      <span style={s.cobranzaBannerText}>{it.cobranzaDetalle || (it.categoria === 'INGRESO_INICIAL' ? 'Inicial diferida' : 'Pago de cuota de préstamo')}</span>

                    </div>

                  )}

                  {REQUIRE_RECEIPT && !it.proofUrl && (

                    <div style={s.receiptMissing}>⚠ Falta el comprobante de la transacción — no se puede confirmar hasta que se adjunte.</div>

                  )}

                  {/* cross-check */}

                  {it.isUSDT ? (

                    <div style={s.crossUsdt}>◆ Pago en USDT — verifica el comprobante de la wallet. No tiene cruce con correo bancario.</div>

                  ) : (

                    <div style={it.seenEmail ? s.crossOk : s.crossWarn}>

                      {it.seenEmail ? '✓ BofA confirmó este pago por correo' : '⚠ El banco aún no reporta este pago por correo — verifica antes de confirmar'}

                      {it.seenStatement && <span style={s.crossExtra}> · también en estado de cuenta</span>}

                    </div>

                  )}



                  {(it.concepto || it.notaOperador) && (

                    <div style={s.notaBox}>

                      <span style={s.notaLabel}>Descripción de {it.registrante || 'administración'}</span>

                      <span style={s.notaText}>{it.concepto || ''}{it.notaOperador ? `${it.concepto ? ' — ' : ''}${it.notaOperador}` : ''}</span>

                    </div>

                  )}



                  <div style={s.grid}>

                    <Field label="Remitente"  value={it.sender || '—'} />

                    <Field label="Referencia" value={it.referencia || '—'} />

                    <Field label="Fecha"      value={fmtDate(it.fecha)} />

                    <Field label="Método"     value={m.label} />

                    <Field label="Destino"    value={it.destinoLabel} />

                    {it.categoria && <Field label="Categoría" value={it.categoria} />}

                    {it.tercero && <Field label="Pagó tercero" value={it.tercero} />}

                    {it.sourceLabel && <Field label="Origen" value={it.sourceLabel} />}

                    <Field label="Registró"   value={it.registrante || '—'} />

                    <Field label="Registrado" value={fmtDateTime(it.solicitado_at)} />

                  </div>



                  {/* AI matches (bank only) */}

                  {!it.isUSDT && (

                    <div style={s.matchWrap}>

                      <div style={s.matchHead}>Coincidencias bancarias (AI)</div>

                      {cs.length === 0 ? <div style={s.matchEmpty}>Sin coincidencias automáticas. {linked ? 'Mantiene el enlace de registro.' : 'Verifica manualmente en /banco.'}</div>

                      : cs.map(c => {

                        const isLinked = c.tx.id === linked

                        return (

                          <div key={c.tx.id} style={{ ...s.matchRow, ...(isLinked ? s.matchRowLinked : {}) }}>

                            <span style={{ ...s.scoreChip, background: c.strength === 'exact' ? '#16A34A' : c.strength === 'strong' ? '#0ea5e9' : '#b8720a' }}>{c.score}%</span>

                            <span style={s.matchInfo}>{CUENTA_LABEL[c.tx.cuenta || 'UNKNOWN'] || c.tx.cuenta} · {fmtDate(c.tx.fecha)} · {fmt(c.tx.monto_usd)} · {c.tx.sender_name || c.tx.referencia || '—'}{c.tx.seen_in_email && <span style={s.matchEmail}> · ✓ correo</span>}<span style={s.matchRazon}> ({c.razon})</span></span>

                            {isLinked ? <span style={s.linkedTag}>Enlazado</span> : <button style={s.relinkBtn} disabled={busy === it.id} onClick={() => relink(it, c.tx)}>Usar este</button>}

                          </div>

                        )

                      })}

                    </div>

                  )}



                  {it.proofUrl && <a href={it.proofUrl} target="_blank" rel="noreferrer" style={s.proof}>Ver comprobante adjunto ↗</a>}

                </div>



                {/* action rail */}

                {!isRej && !isAlloc && (

                  <div style={s.rail}>

                    <button style={{ ...s.railBtn, ...s.btnConfirm, ...(REQUIRE_RECEIPT && !it.proofUrl ? s.btnDisabled : {}) }} disabled={busy === it.id || (REQUIRE_RECEIPT && !it.proofUrl)} title={REQUIRE_RECEIPT && !it.proofUrl ? 'Falta el comprobante adjunto' : ''} onClick={() => { setConfirmingId(it.id); setMsg(null) }}>Confirmar</button>

                    {it.isComprobante && <button style={{ ...s.railBtn, ...s.btnAlloc }} disabled={busy === it.id} onClick={() => openAlloc(it)}>Asignar a Inicial Diferida</button>}

                    <button style={{ ...s.railBtn, ...s.btnRejectGhost }} disabled={busy === it.id} onClick={() => { setRejectId(it.id); setMsg(null) }}>Rechazar</button>

                  </div>

                )}

              </div>



              {/* expanded: reject */}

              {isRej && (

                <div style={s.panel}>

                  <label style={s.fieldLabel}>Motivo del rechazo</label>

                  <input style={s.input} autoFocus value={reason[it.id] || ''} onChange={e => setReason(r => ({ ...r, [it.id]: e.target.value }))} placeholder="Ej: monto no coincide con el banco" />

                  <div style={s.panelActions}>

                    <button style={{ ...s.btn, ...s.btnGhost }} disabled={busy === it.id} onClick={() => { setRejectId(null); setMsg(null) }}>Cancelar</button>

                    <button style={{ ...s.btn, ...s.btnReject }} disabled={busy === it.id} onClick={() => rechazar(it)}>{busy === it.id ? 'Rechazando…' : 'Confirmar rechazo'}</button>

                  </div>

                </div>

              )}



              {/* expanded: allocate */}

              {isAlloc && (

                <div style={s.panel}>

                  <div style={s.allocTitle}>Asignar {fmt(it.monto_usd)} a Inicial Diferida</div>

                  <input style={s.input} value={compSearch} placeholder="Buscar cliente, negocio o cédula…" onChange={e => setCompSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') searchComps(compSearch) }} />

                  {compsLoading ? <div style={s.matchEmpty}>Buscando…</div> : comps.length === 0 ? <div style={s.matchEmpty}>Sin compromisos abiertos para esa búsqueda.</div>

                  : comps.map(c => {

                    const saldo = Number(c.saldo_pendiente ?? (Number(c.monto_usd) - Number(c.monto_pagado_acumulado || 0)))

                    return (

                      <div key={c.id} style={s.compRow}>

                        <div style={{ flex: 1, minWidth: 0 }}>

                          <div style={s.compName}>#{c.negocio_num} · {(c.cliente_nombre || '')} {(c.cliente_apellidos || '')}</div>

                          <div style={s.compMeta}>{c.estado} · vence {fmtDate(c.fecha_vencimiento)} · saldo {fmt(saldo)}</div>

                        </div>

                        <input style={s.allocInput} inputMode="decimal" placeholder="0.00" value={alloc[c.id] || ''} onChange={e => setAlloc(a => ({ ...a, [c.id]: e.target.value }))} />

                        <button style={s.maxBtn} onClick={() => setAlloc(a => ({ ...a, [c.id]: Math.min(saldo, Math.max(0, allocLeft + (parseFloat(a[c.id] || '0') || 0))).toFixed(2) }))}>Máx</button>

                      </div>

                    )

                  })}

                  <div style={s.allocSummary}><span>Asignado: <b>{fmt(allocTotal)}</b></span><span style={{ color: allocLeft < -0.005 ? '#BB162B' : 'var(--text-secondary)' }}>Saldo a favor: <b>{fmt(allocLeft)}</b></span></div>

                  <div style={s.panelActions}>

                    <button style={{ ...s.btn, ...s.btnGhost }} disabled={busy === it.id} onClick={closeAlloc}>Cancelar</button>

                    <button style={{ ...s.btn, ...s.btnConfirm }} disabled={busy === it.id || allocTotal <= 0.0001 || allocLeft < -0.005} onClick={applyAlloc}>{busy === it.id ? 'Asignando…' : 'Asignar y confirmar'}</button>

                  </div>

                </div>

              )}

            </div>

          )

        })}

        </>}

      </div>



      {/* Post-approval client receipt — explicit, opt-in (never automatic) */}

      {confirmingId && (() => {
        const ci = items.find(x => x.id === confirmingId)
        if (!ci) return null
        const amt = ci.metodo === 'bolivares' && ci.bsAmount != null ? fmtBs(ci.bsAmount) : fmt(ci.monto_usd)
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(8,20,31,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
               onClick={busy === ci.id ? undefined : () => setConfirmingId(null)}>
            <div style={{ width: 'min(420px,100%)', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 16, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
                 onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ display: 'inline-flex', width: 22, height: 22, borderRadius: 999, background: '#16A34A', color: '#fff', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 900 }}>✓</span>
                <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>¿Aprobar este pago?</span>
              </div>
              {ci.esCobranza && <div style={{ ...s.cobranzaChip, display: 'inline-block', marginBottom: 8 }}>COBRANZA · {ci.cobranzaDetalle || ci.sender}</div>}
              <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', margin: '4px 0 14px', lineHeight: 1.5 }}>
                Vas a aprobar <strong style={{ color: 'var(--text-primary)' }}>{amt}</strong>{ci.sender ? <> de <strong style={{ color: 'var(--text-primary)' }}>{ci.sender}</strong></> : null}. Quedará registrado como pago confirmado.
              </div>

              {dupLoading && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>Verificando duplicados…</div>}

              {!dupLoading && dupHardBlock && (
                <div style={{ fontSize: 12.5, color: '#BB162B', background: 'rgba(187,22,43,0.10)', border: '1px solid rgba(187,22,43,0.35)', borderRadius: 8, padding: '10px 12px', marginBottom: 14, fontWeight: 600 }}>
                  ⛔ {dupHardBlock}
                </div>
              )}

              {!dupLoading && !dupHardBlock && dupHits.length > 0 && (
                <div style={{ background: 'rgba(184,114,10,0.10)', border: '1px solid rgba(184,114,10,0.35)', borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: '#8a6d24', marginBottom: 6 }}>⚠ Posible pago duplicado — mismo monto y pagador</div>
                  {dupHits.slice(0, 4).map((h: any) => (
                    <div key={h.id} style={{ fontSize: 12, color: 'var(--text-primary)', marginBottom: 3 }}>
                      {h.numero} · {fmt(Number(h.monto_usd || 0))} · {h.contraparte_nombre || '—'} · {h.solicitado_at ? String(h.solicitado_at).slice(0, 10) : '—'} · <strong>{h.revision_estado === 'aprobado' ? 'aprobado' : 'pendiente'}</strong>
                    </div>
                  ))}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12.5, color: 'var(--text-primary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={dupAck} onChange={e => setDupAck(e.target.checked)} />
                    He verificado que NO es el mismo depósito — aprobar de todos modos.
                  </label>
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button style={{ ...s.btn, ...s.btnGhost, flex: 1 }} disabled={busy === ci.id} onClick={() => setConfirmingId(null)}>Cancelar</button>
                <button
                  style={{ ...s.btn, ...s.btnConfirm, flex: 1, ...((dupHardBlock || (dupHits.length > 0 && !dupAck) || dupLoading) ? s.btnDisabled : {}) }}
                  disabled={busy === ci.id || dupLoading || !!dupHardBlock || (dupHits.length > 0 && !dupAck)}
                  onClick={() => confirmar(ci)}>
                  {busy === ci.id ? 'Aprobando…' : 'Sí, aprobar'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {receiptPrompt && (

        <div style={{ position: 'fixed', inset: 0, background: 'rgba(8,20,31,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}

             onClick={receiptStatus === 'sending' ? undefined : closeReceipt}>

          <div style={{ width: 'min(420px,100%)', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 16, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}

               onClick={e => e.stopPropagation()}>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>

              <span style={{ display: 'inline-flex', width: 22, height: 22, borderRadius: 999, background: '#16A34A', color: '#fff', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 900 }}>✓</span>

              <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' }}>Pago {receiptPrompt.numero} aprobado</span>

            </div>

            {reciboMinted[receiptPrompt.id] && (

              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>Recibo <strong style={{ color: '#0d9488' }}>{reciboMinted[receiptPrompt.id]}</strong></div>

            )}

            {receiptStatus === 'sent' ? (

              <>

                <div style={{ fontSize: 13.5, color: 'var(--text-primary)', margin: '12px 0 4px', fontWeight: 700 }}>Recibo enviado al cliente por WhatsApp.</div>

                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 18 }}>El recibo solo se entrega si el cliente tiene un teléfono registrado.</div>

                <button style={{ ...s.btn, ...s.btnConfirm, width: '100%' }} onClick={closeReceipt}>Listo</button>

              </>

            ) : (

              <>

                <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', margin: '10px 0 18px', lineHeight: 1.5 }}>

                  ¿Enviar el recibo de <strong style={{ color: 'var(--text-primary)' }}>{receiptPrompt.metodo === 'bolivares' && receiptPrompt.bsAmount != null ? fmtBs(receiptPrompt.bsAmount) : fmt(receiptPrompt.monto_usd)}</strong> al cliente por WhatsApp?

                </div>

                {receiptStatus === 'error' && receiptErr && (

                  <div style={{ fontSize: 12.5, color: '#BB162B', background: 'rgba(187,22,43,0.08)', border: '1px solid rgba(187,22,43,0.25)', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>{receiptErr}</div>

                )}

                <div style={{ display: 'flex', gap: 10 }}>

                  <button style={{ ...s.btn, ...s.btnGhost, flex: 1 }} disabled={receiptStatus === 'sending'} onClick={closeReceipt}>Omitir</button>

                  <button style={{ ...s.btn, ...s.btnConfirm, flex: 1 }} disabled={receiptStatus === 'sending'} onClick={() => enviarRecibo(receiptPrompt)}>{receiptStatus === 'sending' ? 'Enviando…' : 'Enviar recibo'}</button>

                </div>

              </>

            )}

          </div>

        </div>

      )}

    </AdminShell>

  )

}



function Field({ label, value }: { label: string; value: string }) {

  return <div style={s.field}><span style={s.fieldLabel}>{label}</span><span style={s.fieldValue}>{value}</span></div>

}



const s: any = {

  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },

  content: { padding: '32px', maxWidth: '900px', margin: '0 auto' },

  center: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', background: 'var(--bg-page)' },

  back: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', marginBottom: 16 },

  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22 },

  kicker: { fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-muted)' },

  h1: { fontSize: 25, fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0 4px', letterSpacing: '-0.01em' },

  sub: { fontSize: 13, color: 'var(--text-secondary)', margin: 0, maxWidth: 580 },

  countPill: { background: 'var(--accent, #1B4AAA)', color: '#fff', borderRadius: 999, minWidth: 30, height: 30, padding: '0 11px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 14 },

  msg: { background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 10, padding: '11px 15px', fontSize: 13, marginBottom: 14 },

  empty: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 48, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 },



  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, marginBottom: 16, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },

  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '15px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' },

  headLeft: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 },

  headRight: { display: 'flex', alignItems: 'center', gap: 10 },

  ingresoTag: { fontSize: 9.5, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px' },

  numero: { fontFamily: 'monospace', fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' },

  methodBadge: { fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.6, padding: '3px 9px', borderRadius: 999, border: '1.5px solid', background: 'transparent' },

  destino: { fontSize: 12, color: 'var(--text-secondary)' },

  amount: { fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' },



  body: { display: 'flex', gap: 0, flexWrap: 'wrap', alignItems: 'stretch' },

  main: { flex: '1 1 380px', padding: '18px 20px', minWidth: 0 },

  rail: { flex: '0 0 210px', borderLeft: '1px solid var(--border)', background: 'var(--bg-page)', padding: 16, display: 'flex', flexDirection: 'column', gap: 9, justifyContent: 'flex-start' },

  railBtn: { width: '100%', padding: '11px 14px', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: '1px solid transparent', textAlign: 'center' },

  btnConfirm: { background: '#16A34A', color: '#fff' },

  btnAlloc: { background: 'transparent', color: 'var(--accent, #1B4AAA)', border: '1.5px solid var(--accent, #1B4AAA)' },

  btnRejectGhost: { background: 'transparent', color: '#BB162B', border: '1px solid rgba(187,22,43,0.4)' },



  crossOk: { background: 'rgba(22,163,74,0.10)', border: '1px solid rgba(22,163,74,0.3)', color: '#1a7d44', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, marginBottom: 12 },

  crossWarn: { background: 'rgba(184,114,10,0.10)', border: '1px solid rgba(184,114,10,0.3)', color: '#8a6d24', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, marginBottom: 12 },

  crossUsdt: { background: 'rgba(10,138,95,0.10)', border: '1px solid rgba(10,138,95,0.3)', color: '#0a8a5f', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, marginBottom: 12 },
  cobranzaBanner: { display: 'flex', alignItems: 'center', gap: 12, background: 'linear-gradient(90deg, rgba(20,184,166,0.18), rgba(20,184,166,0.04))', border: '1px solid rgba(20,184,166,0.45)', borderLeft: '5px solid #14B8A6', borderRadius: 10, padding: '12px 16px', marginBottom: 14, flexWrap: 'wrap' },
  cobranzaBannerTag: { fontSize: 13, fontWeight: 900, letterSpacing: 1.5, color: '#0d9488', textTransform: 'uppercase' },
  cobranzaBannerText: { fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' },
  cobranzaChip: { fontSize: 10, fontWeight: 900, letterSpacing: 1, color: '#0d9488', border: '1.5px solid #14B8A6', borderRadius: 999, padding: '2px 8px', textTransform: 'uppercase' },
  devolucionBanner: { display: 'flex', alignItems: 'center', gap: 12, background: 'linear-gradient(90deg, rgba(187,22,43,0.15), rgba(187,22,43,0.03))', border: '1px solid rgba(187,22,43,0.45)', borderLeft: '5px solid #BB162B', borderRadius: 10, padding: '12px 16px', marginBottom: 14, flexWrap: 'wrap' },
  devolucionBannerTag: { fontSize: 13, fontWeight: 900, letterSpacing: 1.5, color: '#BB162B', textTransform: 'uppercase' },
  devolucionBannerText: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 200 },
  receiptMissing: { background: 'rgba(187,22,43,0.08)', border: '1px solid rgba(187,22,43,0.3)', color: '#BB162B', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, fontWeight: 700, marginBottom: 12 },
  btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },

  crossExtra: { fontWeight: 400, opacity: 0.85 },



  notaBox: { display: 'flex', flexDirection: 'column', gap: 3, background: 'var(--bg-page)', border: '1px solid var(--border)', borderLeft: '3px solid var(--accent, #1B4AAA)', borderRadius: 8, padding: '10px 13px', marginBottom: 14 },

  notaLabel: { fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 },

  notaText: { fontSize: 14, color: 'var(--text-primary)', fontWeight: 600 },



  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 18px', marginBottom: 14 },

  field: { display: 'flex', flexDirection: 'column', gap: 3 },

  fieldLabel: { fontSize: 9.5, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 },

  fieldValue: { fontSize: 13.5, color: 'var(--text-primary)' },



  matchWrap: { border: '1px solid var(--border)', borderRadius: 10, padding: '11px 13px', marginBottom: 12, background: 'var(--bg-page)' },

  matchHead: { fontSize: 9.5, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },

  matchEmpty: { fontSize: 12.5, color: 'var(--text-secondary)' },

  matchRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' },

  matchRowLinked: { background: 'rgba(27,74,170,0.06)', borderRadius: 6 },

  scoreChip: { color: '#fff', borderRadius: 999, fontSize: 11, fontWeight: 800, padding: '2px 8px', flexShrink: 0 },

  matchInfo: { flex: 1, fontSize: 12.5, color: 'var(--text-primary)', minWidth: 0 },

  matchEmail: { color: '#1a7d44', fontWeight: 700 },

  matchRazon: { color: 'var(--text-secondary)' },

  linkedTag: { fontSize: 11, fontWeight: 700, color: 'var(--accent, #1B4AAA)' },

  relinkBtn: { fontSize: 12, fontWeight: 700, color: 'var(--accent, #1B4AAA)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' },

  proof: { display: 'inline-block', fontSize: 12.5, color: 'var(--accent, #1B4AAA)' },



  panel: { borderTop: '1px solid var(--border)', padding: '16px 20px', background: 'var(--bg-page)' },

  panelActions: { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6, flexWrap: 'wrap' },

  btn: { padding: '9px 18px', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: '1px solid transparent' },

  btnReject: { background: '#BB162B', color: '#fff' },

  btnGhost: { background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)' },

  allocTitle: { fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 10 },

  compRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '1px solid var(--border)' },

  compName: { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },

  compMeta: { fontSize: 11.5, color: 'var(--text-secondary)' },

  allocInput: { width: 110, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13 },

  maxBtn: { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', cursor: 'pointer' },

  allocSummary: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-primary)', margin: '12px 0' },

  input: { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, margin: '4px 0 12px', boxSizing: 'border-box' },

}