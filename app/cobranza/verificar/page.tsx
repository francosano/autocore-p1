// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/cobranza/verificar/page.tsx
// AutoCore NPA — Cobranza · Pagos por Verificar
//
// URL: /cobranza/verificar    Gate: npa_can_register_pagos | npa_can_admin
//
// WHY THIS PAGE EXISTS
//   Payment verification was unified into NPA (Portal /verificar is now just a
//   redirect to here). The NPA tesorería ingreso flow (registrarPagoCobranza)
//   auto-approves EFECTIVO but parks every non-cash método (Zelle / Wire /
//   Bolívares / USDT) as status='pending_review' in cobranza_cuota_pagos.
//   The Portal /pagos flow does the same and pairs cuota + inicial-diferida
//   legs by allocation_group_id. Those pending rows had NO approval UI after
//   the Portal page was stubbed — they piled up uncleared. This is that UI.
//
// WHAT IT DOES
//   • Lists pending_review rows from BOTH cobranza_cuota_pagos AND
//     compromisos_inicial_diferida_pagos, grouped by allocation_group_id.
//   • Suggests bank_transactions matches (same scorer as /tesoreria/confirmar).
//   • Aprobar  → status='approved' (+ optional bank link). The DB recompute
//     trigger counts only approved/paid pagos, so it moves the cuota / diferida
//     saldo. We DO NOT touch cobranza_cuotas / compromisos here — that would
//     double-count against the trigger.
//   • Rechazar → status='rejected' + rechazo_motivo.
//   • Aprobados / Rechazados tabs allow revert → pending_review.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'
import NavBar from '../../components/NavBar'
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
  efectivo:  { label: 'Efectivo',       color: '#16A34A' },
  banco:     { label: 'Transferencia',  color: '#64748b' },
}
// Map the free-text metodo_pago into a METODO bucket.
function metodoBucket(raw: string | null): string {
  const v = (raw || '').toLowerCase()
  if (v.includes('usdt')) return 'usdt'
  if (v.includes('zelle')) return 'zelle'
  if (v.includes('wire')) return 'wire'
  if (v.includes('bol')) return 'bolivares'
  if (v.includes('efect') || v.includes('caja')) return 'efectivo'
  return 'banco'
}

const fmt = (n: number | null | undefined) => `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (iso: string | null | undefined) => { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return d && m && y ? `${d}/${m}/${y}` : String(iso) }
const fmtDateTime = (iso: string | null | undefined) => { if (!iso) return '—'; const d = new Date(iso); const p = (x: number) => String(x).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}` }

// ── AI matcher (mirrors /tesoreria/confirmar thresholds) ─────────────────────
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
type Strength = 'exact' | 'strong' | 'partial'
interface Cand { tx: any; score: number; strength: Strength; razon: string }
function scoreCandidates(it: Item, txs: any[]): Cand[] {
  const out: Cand[] = []
  for (const tx of txs) {
    if (!amtClose(tx.monto_usd, it.monto_usd, 2)) continue
    const dd = it.fecha ? dateDiff(tx.fecha, it.fecha) : 99
    const hasRef = refSim(tx.referencia, it.referencia); const nameOK = namesMatch(tx.sender_name, it.cliente)
    let score = 60, razon = 'Monto coincide'
    if (hasRef && dd <= 2)      { score = 98; razon = 'Monto, referencia y fecha coinciden' }
    else if (hasRef)            { score = 92; razon = 'Monto y referencia coinciden' }
    else if (dd <= 0.0001)      { score = 88; razon = 'Monto exacto y misma fecha' }
    else if (dd <= 2 && nameOK) { score = 84; razon = `Monto, nombre y fecha ±${Math.round(dd)}d` }
    else if (dd <= 2)           { score = 78; razon = `Monto exacto, fecha ±${Math.round(dd)}d` }
    else if (nameOK)            { score = 72; razon = 'Monto y nombre coinciden' }
    const strength: Strength = score >= 90 ? 'exact' : score >= 78 ? 'strong' : 'partial'
    out.push({ tx, score, strength, razon })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4)
}

interface Item {
  kind: 'cuota' | 'diferida'
  id: string
  monto_usd: number
  fecha: string | null            // fecha_pago
  metodoRaw: string | null
  metodo: string                  // bucket
  referencia: string | null
  proofUrl: string | null
  notas: string | null
  sourceApp: string | null
  allocationGroup: string | null
  bankTxId: string | null
  bankStrength: string | null
  createdAt: string | null
  // display
  cliente: string
  vehiculo: string
  cuotaLabel: string | null       // cuota only
  cuotaVcto: string | null        // cuota only
  cuotaMonto: number | null       // cuota only (monto_cuota)
  // reviewed
  aprobadoPor?: string | null
  aprobadoAt?: string | null
  rechazoMotivo?: string | null
}

function Field({ label, value }: { label: string; value: string }) {
  return <div style={s.field}><span style={s.fieldLabel}>{label}</span><span style={s.fieldValue}>{value}</span></div>
}

function KindBadge({ kind }: { kind: Item['kind'] }) {
  const isDif = kind === 'diferida'
  return (
    <span style={{ ...s.kindBadge, color: isDif ? '#8B5CF6' : '#14B8A6', borderColor: isDif ? '#8B5CF6' : '#14B8A6' }}>
      {isDif ? 'Inicial Diferida' : 'Cuota'}
    </span>
  )
}

export default function CobranzaVerificarPage() {
  const router = useRouter()
  const gate = useAuthGate(p => p.npa_can_register_pagos || p.npa_can_admin)

  const [reviewerEmail, setReviewerEmail] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [items, setItems]   = useState<Item[]>([])
  const [approvedItems, setApprovedItems] = useState<Item[]>([])
  const [rejectedItems, setRejectedItems] = useState<Item[]>([])
  const [cands, setCands]   = useState<Record<string, Cand[]>>({})
  const [linkSel, setLinkSel] = useState<Record<string, { id: string; strength: Strength } | null>>({})
  const [activeTab, setActiveTab] = useState<'pendientes' | 'aprobados' | 'rechazados'>('pendientes')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [rejectId, setRejectId] = useState<string | null>(null)
  const [reason, setReason] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg]   = useState<string | null>(null)

  // ── Load all three buckets in one pass ─────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const cuotaCols = 'id, cuota_id, contrato_id, monto_usd, fecha_pago, metodo_pago, referencia_pago, comprobante_url, notas_pago, status, allocation_group_id, source_app, bank_tx_id, bank_match_strength, aprobado_por, aprobado_at, rechazo_motivo, created_at, is_reversal'
      const difCols   = 'id, compromiso_id, deal_id, monto_usd, fecha, metodo, referencia, comprobante_url, comentario, status, allocation_group_id, source_app, bank_tx_id, bank_match_strength, aprobado_por, aprobado_at, rechazo_motivo, created_at, is_reversal'

      const [pendCuota, apprCuota, rejCuota, pendDif, apprDif, rejDif] = await Promise.all([
        (supabase.from('cobranza_cuota_pagos').select(cuotaCols).eq('status', 'pending_review').eq('is_reversal', false).order('created_at', { ascending: true }) as any),
        (supabase.from('cobranza_cuota_pagos').select(cuotaCols).eq('status', 'approved').eq('is_reversal', false).order('aprobado_at', { ascending: false }).limit(40) as any),
        (supabase.from('cobranza_cuota_pagos').select(cuotaCols).eq('status', 'rejected').eq('is_reversal', false).order('aprobado_at', { ascending: false }).limit(40) as any),
        (supabase.from('compromisos_inicial_diferida_pagos').select(difCols).eq('status', 'pending_review').eq('is_reversal', false).order('created_at', { ascending: true }) as any),
        (supabase.from('compromisos_inicial_diferida_pagos').select(difCols).eq('status', 'approved').eq('is_reversal', false).order('aprobado_at', { ascending: false }).limit(40) as any),
        (supabase.from('compromisos_inicial_diferida_pagos').select(difCols).eq('status', 'rejected').eq('is_reversal', false).order('aprobado_at', { ascending: false }).limit(40) as any),
      ])

      const cuotaRows = [pendCuota, apprCuota, rejCuota].flatMap((r: any) => Array.isArray(r?.data) ? r.data : [])
      const difRows   = [pendDif, apprDif, rejDif].flatMap((r: any) => Array.isArray(r?.data) ? r.data : [])

      // ── Enrich cuota pagos: cuota label + contrato (client/vehicle) ──
      const cuotaIds = [...new Set(cuotaRows.map((r: any) => r.cuota_id).filter(Boolean))]
      const contratoIds = [...new Set(cuotaRows.map((r: any) => r.contrato_id).filter(Boolean))]
      const cuotaMap: Record<string, any> = {}
      const contratoMap: Record<string, any> = {}
      if (cuotaIds.length) {
        const cq = await (supabase.from('cobranza_cuotas').select('id, cuota_label, cuota_num, monto_cuota, fecha_vencimiento').in('id', cuotaIds) as any)
        if (Array.isArray(cq?.data)) cq.data.forEach((c: any) => { cuotaMap[c.id] = c })
      }
      if (contratoIds.length) {
        const ctq = await (supabase.from('cobranza_contratos').select('id, cliente_nombre, cliente_apellidos, cliente_cedula, modelo, vehiculo_marca, placa').in('id', contratoIds) as any)
        if (Array.isArray(ctq?.data)) ctq.data.forEach((c: any) => { contratoMap[c.id] = c })
      }

      // ── Enrich diferida pagos: compromiso (client/vehicle) ──
      const compromisoIds = [...new Set(difRows.map((r: any) => r.compromiso_id).filter(Boolean))]
      const compromisoMap: Record<string, any> = {}
      if (compromisoIds.length) {
        const coq = await (supabase.from('compromisos_inicial_diferida').select('id, negocio_num, cliente_nombre, cliente_apellidos, vehiculo_modelo, vehiculo_placa').in('id', compromisoIds) as any)
        if (Array.isArray(coq?.data)) coq.data.forEach((c: any) => { compromisoMap[c.id] = c })
      }

      const toCuotaItem = (r: any): Item => {
        const cu = cuotaMap[r.cuota_id] || {}
        const ct = contratoMap[r.contrato_id] || {}
        return {
          kind: 'cuota', id: r.id, monto_usd: Number(r.monto_usd || 0), fecha: r.fecha_pago,
          metodoRaw: r.metodo_pago, metodo: metodoBucket(r.metodo_pago), referencia: r.referencia_pago,
          proofUrl: r.comprobante_url, notas: r.notas_pago, sourceApp: r.source_app,
          allocationGroup: r.allocation_group_id, bankTxId: r.bank_tx_id, bankStrength: r.bank_match_strength,
          createdAt: r.created_at,
          cliente: [ct.cliente_nombre, ct.cliente_apellidos].filter(Boolean).join(' ') || '—',
          vehiculo: [ct.vehiculo_marca || ct.modelo, ct.placa].filter(Boolean).join(' · ') || '—',
          cuotaLabel: cu.cuota_label || (cu.cuota_num != null ? `Cuota ${cu.cuota_num}` : null),
          cuotaVcto: cu.fecha_vencimiento || null, cuotaMonto: cu.monto_cuota != null ? Number(cu.monto_cuota) : null,
          aprobadoPor: r.aprobado_por, aprobadoAt: r.aprobado_at, rechazoMotivo: r.rechazo_motivo,
        }
      }
      const toDifItem = (r: any): Item => {
        const co = compromisoMap[r.compromiso_id] || {}
        return {
          kind: 'diferida', id: r.id, monto_usd: Number(r.monto_usd || 0), fecha: r.fecha,
          metodoRaw: r.metodo, metodo: metodoBucket(r.metodo), referencia: r.referencia,
          proofUrl: r.comprobante_url, notas: r.comentario, sourceApp: r.source_app,
          allocationGroup: r.allocation_group_id, bankTxId: r.bank_tx_id, bankStrength: r.bank_match_strength,
          createdAt: r.created_at,
          cliente: [co.cliente_nombre, co.cliente_apellidos].filter(Boolean).join(' ') || '—',
          vehiculo: [co.vehiculo_modelo, co.vehiculo_placa].filter(Boolean).join(' · ') || (co.negocio_num ? `Negocio ${co.negocio_num}` : '—'),
          cuotaLabel: 'Inicial diferida' + (co.negocio_num ? ` · ${co.negocio_num}` : ''),
          cuotaVcto: null, cuotaMonto: null,
          aprobadoPor: r.aprobado_por, aprobadoAt: r.aprobado_at, rechazoMotivo: r.rechazo_motivo,
        }
      }

      const cuotaItems = cuotaRows.map((r: any) => ({ status: r.status, item: toCuotaItem(r) }))
      const difItems   = difRows.map((r: any)   => ({ status: r.status, item: toDifItem(r) }))
      const all = [...cuotaItems, ...difItems]

      const pend = all.filter(x => x.status === 'pending_review').map(x => x.item)
      const appr = all.filter(x => x.status === 'approved').map(x => x.item)
      const rej  = all.filter(x => x.status === 'rejected').map(x => x.item)

      // group order: keep allocation-group legs adjacent
      const groupKey = (i: Item) => i.allocationGroup || i.id
      pend.sort((a, b) => groupKey(a).localeCompare(groupKey(b)) || (a.kind === b.kind ? 0 : a.kind === 'diferida' ? -1 : 1))

      setItems(pend); setApprovedItems(appr); setRejectedItems(rej)

      // ── Bank candidates for pending bank-route pagos only ──
      const bankPend = pend.filter(i => i.metodo !== 'usdt' && i.metodo !== 'efectivo')
      if (bankPend.length) {
        const bq = await (supabase.from('bank_transactions')
          .select('id, cuenta, fecha, sender_name, referencia, tipo, monto_usd, direccion, seen_in_email, is_internal, is_bank_fee')
          .eq('direccion', 'credit').eq('is_internal', false).eq('is_bank_fee', false)
          .order('fecha', { ascending: false }).limit(400) as any)
        const txs = Array.isArray(bq?.data) ? bq.data : []
        const cmap: Record<string, Cand[]> = {}
        bankPend.forEach(i => { const c = scoreCandidates(i, txs); if (c.length) cmap[i.id] = c })
        setCands(cmap)
      } else {
        setCands({})
      }
    } catch (e: any) {
      setMsg('Error al cargar: ' + (e?.message || 'desconocido'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (gate.status === 'denied') router.replace('/cobranza') }, [gate.status, router])
  useEffect(() => {
    if (gate.status !== 'ok') return
    ;(async () => { try { const { data } = await supabase.auth.getUser(); setReviewerEmail(data?.user?.email || 'NPA') } catch { setReviewerEmail('NPA') } })()
    load()
  }, [gate.status, load])

  // ── Table router for the two pago tables ───────────────────────────────────
  const tableFor = (it: Item) => it.kind === 'cuota' ? 'cobranza_cuota_pagos' : 'compromisos_inicial_diferida_pagos'

  async function aprobar(it: Item) {
    setBusy(it.id); setMsg(null)
    try {
      const link = linkSel[it.id]
      const patch: any = {
        status: 'approved',
        aprobado_por: reviewerEmail,
        aprobado_at: new Date().toISOString(),
      }
      if (link) { patch.bank_tx_id = link.id; patch.bank_match_strength = link.strength }
      const { error } = await (supabase.from(tableFor(it)).update(patch).eq('id', it.id) as any)
      if (error) throw error
      // The cuota / diferida saldo is recomputed by the DB trigger that counts
      // only approved/paid pagos — we intentionally do NOT touch the parent here.
      setConfirmingId(null)
      setMsg(`Pago aprobado — ${it.cliente} · ${fmt(it.monto_usd)}.`)
      await load()
    } catch (e: any) {
      setMsg('No se pudo aprobar: ' + (e?.message || 'error'))
    } finally { setBusy(null) }
  }

  async function rechazar(it: Item) {
    const motivo = (reason[it.id] || '').trim()
    if (motivo.length < 4) { setMsg('Escribe un motivo de rechazo (mínimo 4 caracteres).'); return }
    setBusy(it.id); setMsg(null)
    try {
      const { error } = await (supabase.from(tableFor(it)).update({
        status: 'rejected', rechazo_motivo: motivo,
        aprobado_por: reviewerEmail, aprobado_at: new Date().toISOString(),
      }).eq('id', it.id) as any)
      if (error) throw error
      setRejectId(null)
      setMsg(`Pago rechazado — ${it.cliente}.`)
      await load()
    } catch (e: any) {
      setMsg('No se pudo rechazar: ' + (e?.message || 'error'))
    } finally { setBusy(null) }
  }

  async function revertir(it: Item, to: 'aprobado' | 'rechazado') {
    setBusy(it.id); setMsg(null)
    try {
      const patch: any = { status: 'pending_review', aprobado_por: null, aprobado_at: null }
      if (to === 'rechazado') patch.rechazo_motivo = null
      const { error } = await (supabase.from(tableFor(it)).update(patch).eq('id', it.id) as any)
      if (error) throw error
      setMsg(`Pago devuelto a pendientes — ${it.cliente}.`)
      await load()
    } catch (e: any) {
      setMsg('No se pudo revertir: ' + (e?.message || 'error'))
    } finally { setBusy(null) }
  }

  if (gate.status === 'loading') return <div style={s.center}>Cargando…</div>
  if (gate.status === 'error')   return <SessionErrorScreen />
  if (gate.status !== 'ok')      return null

  return (
    <div style={s.page}>
      <NavBar />
      <div style={s.content}>
        <button style={s.back} onClick={() => { window.location.href = '/cobranza' }}>‹ Cobranza</button>
        <div style={s.headerRow}>
          <div>
            <div style={s.kicker}>Cobranza · Verificación</div>
            <h1 style={s.h1}>Pagos por verificar</h1>
            <p style={s.sub}>Verifica cada pago de cuota o inicial diferida contra el banco o la wallet y apruébalo. Solo los pagos aprobados cuentan contra el saldo.</p>
          </div>
          <div style={s.countPill}>{items.length}</div>
        </div>

        <div style={{ display: 'flex', gap: 8, margin: '4px 0 16px', flexWrap: 'wrap' }}>
          {([['pendientes', `Pendientes (${items.length})`], ['aprobados', `Aprobados (${approvedItems.length})`], ['rechazados', `Rechazados (${rejectedItems.length})`]] as [('pendientes' | 'aprobados' | 'rechazados'), string][]).map(([k, label]) => (
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

        {loading ? <div style={s.empty}>Cargando pagos…</div>
        : activeTab === 'aprobados' ? (
            approvedItems.length === 0 ? <div style={s.empty}>No hay pagos aprobados recientes.</div>
            : approvedItems.map(it => <ReviewedCard key={it.id} it={it} kind="aprobado" busy={busy === it.id} onAction={() => revertir(it, 'aprobado')} />)
          )
        : activeTab === 'rechazados' ? (
            rejectedItems.length === 0 ? <div style={s.empty}>No hay pagos rechazados.</div>
            : rejectedItems.map(it => <ReviewedCard key={it.id} it={it} kind="rechazado" busy={busy === it.id} onAction={() => revertir(it, 'rechazado')} />)
          )
        : items.length === 0 ? <div style={s.empty}>No hay pagos por verificar. Todo al día.</div>
        : items.map(it => {
          const isRej = rejectId === it.id
          const cs = cands[it.id] || []
          const linked = linkSel[it.id]?.id || it.bankTxId
          const m = METODO[it.metodo] || METODO.banco
          const isCashlikeNoCross = it.metodo === 'usdt' || it.metodo === 'efectivo'
          return (
            <div key={it.id} style={s.card}>
              <div style={s.head}>
                <div style={s.headLeft}>
                  <KindBadge kind={it.kind} />
                  <span style={s.numero}>{it.cliente}</span>
                  <span style={{ ...s.methodBadge, color: m.color, borderColor: m.color }}>{m.label}</span>
                  {it.allocationGroup && <span style={s.groupTag}>grupo</span>}
                </div>
                <div style={s.headRight}>
                  <span style={s.amount}>{fmt(it.monto_usd)}</span>
                </div>
              </div>

              <div style={s.body}>
                <div style={s.main}>
                  {isCashlikeNoCross ? (
                    <div style={s.crossUsdt}>◆ {it.metodo === 'usdt' ? 'Pago en USDT' : 'Pago en efectivo'} — verifica el comprobante adjunto. No tiene cruce con correo bancario.</div>
                  ) : (
                    <div style={s.crossWarn}>⚠ Verifica este pago contra el banco antes de aprobar. Las coincidencias automáticas se muestran abajo.</div>
                  )}

                  {it.notas && (
                    <div style={s.notaBox}>
                      <span style={s.notaLabel}>Nota del registro</span>
                      <span style={s.notaText}>{it.notas}</span>
                    </div>
                  )}

                  <div style={s.grid}>
                    <Field label={it.kind === 'cuota' ? 'Cuota' : 'Concepto'} value={it.cuotaLabel || '—'} />
                    <Field label="Vehículo"   value={it.vehiculo} />
                    {it.cuotaVcto && <Field label="Vence" value={fmtDate(it.cuotaVcto)} />}
                    {it.cuotaMonto != null && <Field label="Monto cuota" value={fmt(it.cuotaMonto)} />}
                    <Field label="Referencia" value={it.referencia || '—'} />
                    <Field label="Fecha pago" value={fmtDate(it.fecha)} />
                    <Field label="Método"     value={it.metodoRaw || m.label} />
                    <Field label="Origen"     value={it.sourceApp || '—'} />
                    <Field label="Registrado" value={fmtDateTime(it.createdAt)} />
                  </div>

                  {!isCashlikeNoCross && (
                    <div style={s.matchWrap}>
                      <div style={s.matchHead}>Coincidencias bancarias (AI)</div>
                      {cs.length === 0 ? <div style={s.matchEmpty}>Sin coincidencias automáticas. Verifica manualmente en /banco.</div>
                      : cs.map(c => {
                        const isLinked = c.tx.id === linked
                        return (
                          <div key={c.tx.id} style={{ ...s.matchRow, ...(isLinked ? s.matchRowLinked : {}) }}>
                            <span style={{ ...s.scoreChip, background: c.strength === 'exact' ? '#16A34A' : c.strength === 'strong' ? '#0ea5e9' : '#b8720a' }}>{c.score}%</span>
                            <span style={s.matchInfo}>{CUENTA_LABEL[c.tx.cuenta || 'UNKNOWN'] || c.tx.cuenta} · {fmtDate(c.tx.fecha)} · {fmt(c.tx.monto_usd)} · {c.tx.sender_name || c.tx.referencia || '—'}{c.tx.seen_in_email && <span style={s.matchEmail}> · ✓ correo</span>}<span style={s.matchRazon}> ({c.razon})</span></span>
                            {isLinked ? <span style={s.linkedTag}>Enlazado</span> : <button style={s.relinkBtn} disabled={busy === it.id} onClick={() => setLinkSel(p => ({ ...p, [it.id]: { id: c.tx.id, strength: c.strength } }))}>Usar este</button>}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {it.proofUrl && <a href={it.proofUrl} target="_blank" rel="noreferrer" style={s.proof}>Ver comprobante adjunto ↗</a>}
                </div>

                {!isRej && (
                  <div style={s.rail}>
                    {confirmingId === it.id ? (
                      <>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', textAlign: 'center' }}>¿Aprobar este pago de {fmt(it.monto_usd)}?</div>
                        <button style={{ ...s.railBtn, ...s.btnConfirm }} disabled={busy === it.id} onClick={() => aprobar(it)}>{busy === it.id ? 'Aprobando…' : 'Sí, aprobar'}</button>
                        <button style={{ ...s.railBtn, ...s.btnGhost }} disabled={busy === it.id} onClick={() => setConfirmingId(null)}>Cancelar</button>
                      </>
                    ) : (
                      <>
                        <button style={{ ...s.railBtn, ...s.btnConfirm }} disabled={busy === it.id} onClick={() => { setConfirmingId(it.id); setMsg(null) }}>Aprobar</button>
                        <button style={{ ...s.railBtn, ...s.btnRejectGhost }} disabled={busy === it.id} onClick={() => { setRejectId(it.id); setMsg(null) }}>Rechazar</button>
                        {linkSel[it.id] && <div style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center' }}>Se enlazará al banco al aprobar.</div>}
                      </>
                    )}
                  </div>
                )}
              </div>

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
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ReviewedCard({ it, kind, busy, onAction }: { it: Item; kind: 'aprobado' | 'rechazado'; busy: boolean; onAction: () => void }) {
  const m = METODO[it.metodo] || METODO.banco
  const tone = kind === 'aprobado' ? '#16A34A' : '#BB162B'
  return (
    <div style={{ ...s.card, opacity: 0.97 }}>
      <div style={s.head}>
        <div style={s.headLeft}>
          <KindBadge kind={it.kind} />
          <span style={s.numero}>{it.cliente}</span>
          <span style={{ ...s.methodBadge, color: m.color, borderColor: m.color }}>{m.label}</span>
          <span style={{ ...s.methodBadge, color: tone, borderColor: tone }}>{kind === 'aprobado' ? 'Aprobado' : 'Rechazado'}</span>
        </div>
        <span style={s.amount}>{fmt(it.monto_usd)}</span>
      </div>
      <div style={{ padding: '14px 20px', display: 'flex', flexWrap: 'wrap', gap: '6px 24px', alignItems: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{it.cuotaLabel || '—'}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{it.vehiculo}</div>
        {it.referencia && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>ref {it.referencia}</div>}
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmtDate(it.fecha)}</div>
        <div style={{ flex: 1 }} />
        {it.proofUrl && <a href={it.proofUrl} target="_blank" rel="noreferrer" style={s.proof}>Ver comprobante ↗</a>}
      </div>
      <div style={{ padding: '0 20px 16px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {kind === 'aprobado' ? 'Aprobado' : 'Rechazado'} por <strong>{it.aprobadoPor || '—'}</strong>{it.aprobadoAt ? ` · ${String(it.aprobadoAt).slice(0, 16).replace('T', ' ')}` : ''}
          {kind === 'rechazado' && it.rechazoMotivo ? <span style={{ display: 'block', color: '#BB162B', marginTop: 3 }}>Motivo: {it.rechazoMotivo}</span> : null}
        </div>
        <button style={{ ...s.railBtn, width: 'auto', padding: '9px 16px', ...(kind === 'aprobado' ? s.btnRejectGhost : s.btnAlloc) }} disabled={busy} onClick={onAction}>
          {busy ? 'Procesando…' : (kind === 'aprobado' ? 'Revertir aprobación' : 'Devolver a pendientes')}
        </button>
      </div>
    </div>
  )
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
  kindBadge: { fontSize: 9.5, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', border: '1.5px solid', borderRadius: 4, padding: '2px 7px', background: 'transparent' },
  groupTag: { fontSize: 9.5, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px' },
  numero: { fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' },
  methodBadge: { fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.6, padding: '3px 9px', borderRadius: 999, border: '1.5px solid', background: 'transparent' },
  amount: { fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' },

  body: { display: 'flex', gap: 0, flexWrap: 'wrap', alignItems: 'stretch' },
  main: { flex: '1 1 380px', padding: '18px 20px', minWidth: 0 },
  rail: { flex: '0 0 210px', borderLeft: '1px solid var(--border)', background: 'var(--bg-page)', padding: 16, display: 'flex', flexDirection: 'column', gap: 9, justifyContent: 'flex-start' },
  railBtn: { width: '100%', padding: '11px 14px', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: '1px solid transparent', textAlign: 'center' },
  btnConfirm: { background: '#16A34A', color: '#fff' },
  btnAlloc: { background: 'transparent', color: 'var(--accent, #1B4AAA)', border: '1.5px solid var(--accent, #1B4AAA)' },
  btnRejectGhost: { background: 'transparent', color: '#BB162B', border: '1px solid rgba(187,22,43,0.4)' },

  crossWarn: { background: 'rgba(184,114,10,0.10)', border: '1px solid rgba(184,114,10,0.3)', color: '#8a6d24', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, marginBottom: 12 },
  crossUsdt: { background: 'rgba(10,138,95,0.10)', border: '1px solid rgba(10,138,95,0.3)', color: '#0a8a5f', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, marginBottom: 12 },

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
  input: { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, margin: '4px 0 12px', boxSizing: 'border-box' },
}