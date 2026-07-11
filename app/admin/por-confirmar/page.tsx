'use client'
// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/admin/por-confirmar/page.tsx
// AutoCore NPA — Pagos por Confirmar (client-account approval surface)
//
// One queue for every client payment. Stage A: Inicial Diferida.
//
//   Ángeles registers a payment → pagos_recibidos (status PENDING_REVIEW,
//   monto_disponible 0) → shows here → Aprobar (AI-matched to a
//   bank_transactions row, comprobante side-by-side) → status AVAILABLE,
//   monto_disponible = monto (saldo a favor in the client's account) →
//   Asignar: apply / split the saldo across the client's open inicial-diferida
//   compromisos. Surplus stays AVAILABLE as saldo a favor. Nothing is lost.
//
// Draw-down is app-side (no money trigger): allocating inserts
// compromisos_inicial_diferida_pagos rows (pago_recibido_id + shared
// allocation_group_id) and decrements pagos_recibidos.monto_disponible.
// ═══════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'
import AdminShell from '../../components/AdminShell'
import { useNPAPermissions } from '../../components/useNPAPermissions'

// ── format helpers ───────────────────────────────────────────────────────────
const fmt = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (iso: string | null) => { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return d && m && y ? `${d}/${m}/${y}` : String(iso) }
const todayISO = () => new Date().toISOString().slice(0, 10)

// ── comprobante signing (private bucket → docsign worker, client fallback) ────
async function signDocPath(pathOrUrl: string | null): Promise<string | null> {
  if (!pathOrUrl) return null
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl   // already a URL
  try {
    const r = await fetch(`https://autocore-docsign.sano-franco.workers.dev/?path=${encodeURIComponent(pathOrUrl)}`)
    if (r.ok) { const j = await r.json(); if (j?.signedUrl) return j.signedUrl as string }
  } catch { /* fall through */ }
  try {
    const { data } = await supabase.storage.from('comprobantes').createSignedUrl(pathOrUrl, 3600)
    return data?.signedUrl || null
  } catch { return null }
}

// ── AI / deterministic bank matcher (mirrors lib/conciliacion bestDeterministic)
const amtClose = (a: number, b: number, tol = 1) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tol
const dateDiff = (a: string, b: string) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000)
function refSim(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const ca = a.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const cb = b.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (ca.length < 4 || cb.length < 4) return false
  return ca.includes(cb) || cb.includes(ca)
}
function namesMatch(txName: string | null, payerName: string | null): boolean {
  if (!txName || !payerName) return false
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/gi, '').toLowerCase().trim().split(/\s+/).filter(w => w.length > 2)
  const a = norm(txName), b = norm(payerName)
  if (!a.length || !b.length) return false
  const hits = a.filter(w => b.includes(w)).length
  return hits >= 1 && (hits >= 2 || a.length === 1 || b.length === 1)
}

interface Candidate { tx: any; score: number; strength: 'exact' | 'strong' | 'ai'; razon: string }
function scoreCandidates(pago: any, txs: any[]): Candidate[] {
  const pRef = pago.confirmation_code || pago.usdt_tx_hash || null
  const out: Candidate[] = []
  for (const tx of txs) {
    if (!amtClose(tx.monto_usd, pago.monto, 1)) continue
    const dd = pago.fecha ? dateDiff(tx.fecha, pago.fecha) : 99
    const hasRef = refSim(tx.referencia, pRef)
    const nameOK = namesMatch(tx.sender_name, pago.payer_name || pago.sender_name)
    let score = 60, razon = 'Monto coincide'
    if (hasRef && dd <= 2)        { score = 98; razon = 'Monto, referencia y fecha coinciden' }
    else if (hasRef)              { score = 92; razon = 'Monto y referencia coinciden' }
    else if (dd <= 0.0001)        { score = 88; razon = 'Monto exacto y misma fecha' }
    else if (dd <= 2 && nameOK)   { score = 84; razon = `Monto, nombre y fecha ±${Math.round(dd)}d` }
    else if (dd <= 2)             { score = 78; razon = `Monto exacto, fecha ±${Math.round(dd)}d` }
    else if (nameOK)              { score = 72; razon = 'Monto y nombre coinciden' }
    const strength: Candidate['strength'] = score >= 90 ? 'exact' : score >= 78 ? 'strong' : 'ai'
    out.push({ tx, score, strength, razon })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4)
}

// ── styles (NPA tokens) ───────────────────────────────────────────────────────
const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  content: { padding: '24px', maxWidth: '1100px', margin: '0 auto' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', marginBottom: '16px' },
  chip: (bg: string) => ({ display: 'inline-block', padding: '2px 10px', borderRadius: '99px', fontSize: '11px', fontWeight: 700, background: bg, color: '#fff' }),
  btn: (bg: string) => ({ padding: '9px 18px', background: bg, color: '#fff', border: 'none', borderRadius: '9px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }),
  btnGhost: { padding: '9px 18px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '9px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  label: { fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' },
  input: { width: '100%', padding: '10px 12px', background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' },
  textarea: { width: '100%', minHeight: '70px', padding: '10px 12px', background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', boxSizing: 'border-box', resize: 'vertical' },
  modalWrap: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' },
  modal: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '26px', maxWidth: '560px', width: '100%', maxHeight: '90vh', overflowY: 'auto' },
}

type Tab = 'pendientes' | 'rechazados' | 'aprobados'
type ModalKind = 'approve' | 'reject' | 'info' | 'allocate' | null

export default function PorConfirmarPage() {
  const router = useRouter()
  const { permissions, loading: permsLoading, sessionError } = useNPAPermissions()
  const canApprove = permissions.npa_can_admin || permissions.npa_can_approve_deals

  // robust gate (same pattern as reportes): never eject on a recoverable blip
  const wasAuthorizedRef = useRef(false)
  useEffect(() => { if (canApprove) wasAuthorizedRef.current = true }, [canApprove])
  useEffect(() => {
    if (permsLoading || sessionError || wasAuthorizedRef.current) return
    if (!canApprove) router.replace('/dashboard')
  }, [permsLoading, sessionError, canApprove, router])

  const [tab, setTab] = useState<Tab>('pendientes')
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<any[]>([])
  const [bankPool, setBankPool] = useState<any[]>([])
  const [signed, setSigned] = useState<Record<string, string>>({})   // pago.id → signed comprobante url
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [flash, setFlash] = useState('')

  // filters
  const [qOrigen, setQOrigen] = useState('')
  const [qText, setQText] = useState('')

  // modal
  const [modal, setModal] = useState<ModalKind>(null)
  const [active, setActive] = useState<any>(null)
  const [chosenTx, setChosenTx] = useState<any>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  // allocation
  const [compromisos, setCompromisos] = useState<any[]>([])
  const [alloc, setAlloc] = useState<Record<string, string>>({})   // compromiso.id → amount string

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => { setUserEmail(data.user?.email ?? null); setUserId(data.user?.id ?? null) })
  }, [])

  const statusForTab = (t: Tab) => t === 'pendientes' ? ['PENDING_REVIEW'] : t === 'rechazados' ? ['REJECTED', 'CANCELLED'] : ['AVAILABLE', 'ALLOCATED']

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const wanted = statusForTab(tab)
      let query = supabase.from('pagos_recibidos').select('*').in('status', wanted)
      query = tab === 'pendientes'
        ? query.order('registered_at', { ascending: true })
        : query.order('updated_at', { ascending: false }).limit(100)
      const { data } = await query
      const list = data || []
      setRows(list)

      // sign comprobantes (best-effort, parallel)
      const sigs: Record<string, string> = {}
      await Promise.all(list.filter(r => r.comprob_url).map(async (r) => {
        const u = await signDocPath(r.comprob_url); if (u) sigs[r.id] = u
      }))
      setSigned(sigs)

      // bank pool for matching (only needed for pendientes) — unmatched ingresos
      if (tab === 'pendientes' && list.length) {
        const { data: txs } = await supabase.from('bank_transactions')
          .select('id, fecha, monto_usd, sender_name, referencia, cuenta, tipo, direccion, matched, is_internal, is_bank_fee, descripcion')
          .eq('matched', false).eq('is_internal', false).eq('is_bank_fee', false)
          .order('fecha', { ascending: false }).limit(400)
        setBankPool((txs || []).filter(t => t.direccion !== 'debit'))
      } else {
        setBankPool([])
      }
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => { if (!permsLoading && canApprove) load() }, [permsLoading, canApprove, tab, load])

  const candidatesFor = useCallback((pago: any) => scoreCandidates(pago, bankPool), [bankPool])

  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (qOrigen && String(r.origen || '').toLowerCase() !== qOrigen.toLowerCase()) return false
      if (qText) {
        const hay = `${r.payer_name || ''} ${r.payer_cedula || ''} ${r.confirmation_code || ''} ${r.nota_registro || ''}`.toLowerCase()
        if (!hay.includes(qText.toLowerCase())) return false
      }
      return true
    })
  }, [rows, qOrigen, qText])

  const origenes = useMemo(() => Array.from(new Set(rows.map(r => r.origen).filter(Boolean))) as string[], [rows])

  function openModal(kind: ModalKind, pago: any, tx: any = null) {
    setActive(pago); setChosenTx(tx); setReason(''); setModal(kind)
    if (kind === 'allocate') loadCompromisos(pago)
  }
  function closeModal() { setModal(null); setActive(null); setChosenTx(null); setReason(''); setCompromisos([]); setAlloc({}); setBusy(false) }

  // ── APPROVE: payment confirmed → money becomes available saldo ──────────────
  async function handleApprove() {
    if (!active) return
    setBusy(true)
    try {
      const patch: any = {
        status: 'AVAILABLE',
        monto_disponible: Number(active.monto),
        aprobado_por: userEmail || 'NPA',
        aprobado_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      if (chosenTx) {
        const cand = candidatesFor(active).find(c => c.tx.id === chosenTx.id)
        patch.bank_tx_id = chosenTx.id
        patch.bank_match_strength = cand?.strength || 'manual'
      }
      const { error } = await supabase.from('pagos_recibidos').update(patch).eq('id', active.id)
      if (error) throw error
      // link the bank tx so it's no longer offered to other payments
      if (chosenTx) {
        await supabase.from('bank_transactions').update({ matched: true, ingreso_confirmed: true }).eq('id', chosenTx.id)
      }
      setFlash(`Pago aprobado · ${fmt(active.monto)} disponible en la cuenta de ${active.payer_name || 'cliente'}.`)
      closeModal(); load()
      setTimeout(() => setFlash(''), 5000)
    } catch (e: any) {
      alert('Error al aprobar: ' + (e?.message || e)); setBusy(false)
    }
  }

  // ── REJECT ──────────────────────────────────────────────────────────────────
  async function handleReject() {
    if (!active || !reason.trim()) return
    setBusy(true)
    try {
      const { error } = await supabase.from('pagos_recibidos').update({
        status: 'REJECTED',
        rechazo_motivo: reason.trim(),
        cancelled_by: userId,
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', active.id)
      if (error) throw error
      setFlash('Pago rechazado.'); closeModal(); load(); setTimeout(() => setFlash(''), 4000)
    } catch (e: any) { alert('Error al rechazar: ' + (e?.message || e)); setBusy(false) }
  }

  // ── REQUEST INFO (stays pending, flagged) ────────────────────────────────────
  async function handleRequestInfo() {
    if (!active || !reason.trim()) return
    setBusy(true)
    try {
      const flagged = `⚠ Info requerida (${todayISO()}): ${reason.trim()}` + (active.nota_registro ? `\n— ${active.nota_registro}` : '')
      const { error } = await supabase.from('pagos_recibidos').update({ nota_registro: flagged, updated_at: new Date().toISOString() }).eq('id', active.id)
      if (error) throw error
      setFlash('Información solicitada. El pago sigue pendiente.'); closeModal(); load(); setTimeout(() => setFlash(''), 4000)
    } catch (e: any) { alert('Error: ' + (e?.message || e)); setBusy(false) }
  }

  // ── ALLOCATE: apply available saldo to inicial-diferida compromisos ──────────
  async function loadCompromisos(pago: any) {
    setCompromisos([]); setAlloc({})
    if (!pago.payer_cedula) return
    const { data } = await (supabase.from('compromisos_inicial_diferida')
      .select('id, deal_id, negocio_num, cliente_nombre, cliente_apellidos, monto_usd, monto_pagado_acumulado, saldo_pendiente, estado, fecha_vencimiento')
      .eq('cliente_rif', pago.payer_cedula)
      .in('estado', ['PENDIENTE', 'PARCIAL'])
      .order('fecha_vencimiento', { ascending: true }) as any)
    const list = (data || []) as any[]
    setCompromisos(list)
    // prefill: greedily fill oldest first up to available saldo
    let left = Number(pago.monto_disponible)
    const seed: Record<string, string> = {}
    for (const c of list) {
      const saldo = Number(c.saldo_pendiente ?? (Number(c.monto_usd) - Number(c.monto_pagado_acumulado || 0)))
      const take = Math.min(left, Math.max(0, saldo))
      if (take > 0.0001) { seed[c.id] = take.toFixed(2); left -= take }
    }
    setAlloc(seed)
  }

  const allocTotal = useMemo(() => Object.values(alloc).reduce((sum, v) => sum + (parseFloat(v) || 0), 0), [alloc])
  const allocLeft = active ? Number(active.monto_disponible) - allocTotal : 0

  async function handleAllocate() {
    if (!active) return
    const entries = Object.entries(alloc).map(([id, v]) => ({ id, monto: parseFloat(v) || 0 })).filter(e => e.monto > 0.0001)
    if (!entries.length) { alert('Indica al menos un monto a asignar.'); return }
    if (allocTotal > Number(active.monto_disponible) + 0.005) { alert('La asignación excede el saldo disponible.'); return }
    setBusy(true)
    try {
      const groupId = (crypto as any)?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const refCode = active.confirmation_code || active.usdt_tx_hash || null
      const nowISO = new Date().toISOString()
      for (const e of entries) {
        const c = compromisos.find(x => x.id === e.id)
        if (!c) continue
        const { error } = await supabase.from('compromisos_inicial_diferida_pagos').insert({
          compromiso_id: c.id,
          deal_id: c.deal_id,
          monto_usd: e.monto,
          fecha: todayISO(),
          metodo: active.origen || 'transferencia',
          referencia: refCode,
          comentario: (active.nota_registro || `Asignado desde pago recibido ${String(active.id).slice(0, 8)}`),
          registered_by: userId,
          status: 'paid',
          source_app: 'NPA',
          comprobante_url: active.comprob_url || null,
          bank_tx_id: active.bank_tx_id || null,
          bank_match_strength: active.bank_match_strength || null,
          pago_recibido_id: active.id,
          allocation_group_id: groupId,
          aprobado_por: userEmail || 'NPA',
          aprobado_at: nowISO,
          is_reversal: false,
        })
        if (error) throw error
      }
      // draw down the client account
      const newDisp = Number(active.monto_disponible) - allocTotal
      const { error: upErr } = await supabase.from('pagos_recibidos').update({
        monto_disponible: newDisp,
        status: newDisp <= 0.0001 ? 'ALLOCATED' : 'AVAILABLE',
        updated_at: nowISO,
      }).eq('id', active.id)
      if (upErr) throw upErr

      const surplus = newDisp > 0.0001
      setFlash(`Asignado ${fmt(allocTotal)} a inicial diferida.` + (surplus ? ` Quedan ${fmt(newDisp)} como saldo a favor.` : ''))
      closeModal(); load(); setTimeout(() => setFlash(''), 6000)
    } catch (e: any) { alert('Error al asignar: ' + (e?.message || e)); setBusy(false) }
  }

  // ── render ────────────────────────────────────────────────────────────────
  if (permsLoading) return <AdminShell active="por-confirmar"><div style={s.content}>Cargando…</div></AdminShell>
  if (!canApprove) return <AdminShell active="por-confirmar"><div style={s.content}>Sin acceso.</div></AdminShell>

  const tabColor: Record<Tab, string> = { pendientes: '#7C3AED', rechazados: '#DC2626', aprobados: '#16A34A' }

  return (
    <AdminShell active="por-confirmar">
      <div style={s.content}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Pagos por Confirmar</h1>
          {tab === 'pendientes' && filtered.length > 0 && (
            <span style={s.chip('#7C3AED')}>{filtered.length} pendiente{filtered.length === 1 ? '' : 's'}</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
          Cada pago entra a la cuenta del cliente. <strong>Aprobar</strong> (verificar contra banco) → el monto queda como saldo disponible → <strong>Asignar</strong> a la inicial diferida (puedes dividir; el excedente queda como saldo a favor).
        </div>

        {flash && <div style={{ ...s.card, background: 'rgba(22,163,74,0.12)', border: '1px solid rgba(22,163,74,0.4)', color: 'var(--text-primary)', fontSize: 13 }}>{flash}</div>}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 18, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', width: 'fit-content', flexWrap: 'wrap' }}>
          {(['pendientes', 'rechazados', 'aprobados'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: '9px 22px', border: 'none', fontSize: 13, fontWeight: tab === t ? 700 : 500, background: tab === t ? tabColor[t] : 'var(--bg-card)', color: tab === t ? '#fff' : 'var(--text-secondary)', cursor: 'pointer' }}>
              {t === 'pendientes' ? 'Pendientes' : t === 'rechazados' ? 'Rechazados' : 'Aprobados'}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <input style={{ ...s.input, maxWidth: 280 }} placeholder="Buscar cliente, cédula, referencia, nota…" value={qText} onChange={e => setQText(e.target.value)} />
          <select style={{ ...s.input, maxWidth: 200 }} value={qOrigen} onChange={e => setQOrigen(e.target.value)}>
            <option value="">Todos los métodos</option>
            {origenes.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>

        {loading ? (
          <div style={s.card}>Cargando pagos…</div>
        ) : filtered.length === 0 ? (
          <div style={{ ...s.card, textAlign: 'center', color: 'var(--text-secondary)' }}>Sin pagos en esta vista.</div>
        ) : (
          filtered.map(pago => {
            const cands = tab === 'pendientes' ? candidatesFor(pago) : []
            const best = cands[0]
            const sig = signed[pago.id]
            const isImg = sig && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(sig)
            return (
              <div key={pago.id} style={s.card}>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {/* comprobante */}
                  <div style={{ width: 132, flexShrink: 0 }}>
                    {sig ? (
                      isImg
                        ? <a href={sig} target="_blank" rel="noreferrer"><img src={sig} alt="comprobante" style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)' }} /></a>
                        : <a href={sig} target="_blank" rel="noreferrer" style={{ ...s.btnGhost, display: 'block', textAlign: 'center', textDecoration: 'none' }}>Ver comprobante</a>
                    ) : <div style={{ width: '100%', height: 90, borderRadius: 8, border: '1px dashed var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--text-secondary)' }}>Sin comprobante</div>}
                  </div>

                  {/* details */}
                  <div style={{ flex: 1, minWidth: 260 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>{pago.payer_name || 'Cliente sin nombre'}</div>
                      <div style={{ fontSize: 18, fontWeight: 900, color: '#2ecc8a', fontFamily: 'monospace' }}>{fmt(pago.monto)}</div>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                      {pago.payer_cedula ? `CI/RIF ${pago.payer_cedula} · ` : ''}{pago.origen || 'método ?'} · {fmtDate(pago.fecha)}
                      {pago.confirmation_code ? ` · ref ${pago.confirmation_code}` : ''}{pago.last4_account ? ` · ****${pago.last4_account}` : ''}
                    </div>
                    {pago.nota_registro && (
                      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-primary)', background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', whiteSpace: 'pre-wrap' }}>
                        📝 {pago.nota_registro}
                      </div>
                    )}

                    {/* approved/allocated meta */}
                    {tab === 'aprobados' && (
                      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                        {pago.status === 'ALLOCATED' ? <span style={s.chip('#16A34A')}>Asignado</span> : <span style={s.chip('#0ea5e9')}>Disponible {fmt(pago.monto_disponible)}</span>}
                        {pago.aprobado_por ? ` · aprobó ${pago.aprobado_por}` : ''}
                      </div>
                    )}
                    {tab === 'rechazados' && pago.rechazo_motivo && (
                      <div style={{ marginTop: 8, fontSize: 12, color: '#DC2626' }}>Motivo: {pago.rechazo_motivo}</div>
                    )}

                    {/* AI bank match */}
                    {tab === 'pendientes' && (
                      <div style={{ marginTop: 10 }}>
                        <div style={s.label}>Coincidencia bancaria (AI)</div>
                        {best ? (
                          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-primary)' }}>
                            <span style={s.chip(best.strength === 'exact' ? '#16A34A' : best.strength === 'strong' ? '#0ea5e9' : '#b8720a')}>{best.score}% {best.strength}</span>
                            <span>{best.tx.cuenta} · {fmtDate(best.tx.fecha)} · {fmt(best.tx.monto_usd)} · {best.tx.sender_name || best.tx.referencia || '—'}</span>
                            <span style={{ color: 'var(--text-secondary)' }}>({best.razon})</span>
                          </div>
                        ) : <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>Sin coincidencia automática — verifica en /banco o aprueba con override.</div>}
                      </div>
                    )}

                    {/* actions */}
                    {tab === 'pendientes' && (
                      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button style={s.btn('#16A34A')} onClick={() => openModal('approve', pago, best?.tx || null)}>Aprobar</button>
                        <button style={s.btn('#DC2626')} onClick={() => openModal('reject', pago)}>Rechazar</button>
                        <button style={s.btnGhost} onClick={() => openModal('info', pago)}>Solicitar info</button>
                      </div>
                    )}
                    {tab === 'aprobados' && pago.status === 'AVAILABLE' && Number(pago.monto_disponible) > 0.0001 && (
                      <div style={{ marginTop: 12 }}>
                        <button style={s.btn('#7C3AED')} onClick={() => openModal('allocate', pago)}>Asignar saldo ({fmt(pago.monto_disponible)})</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* ── MODALS ─────────────────────────────────────────────────────────── */}
      {modal === 'approve' && active && (
        <div style={s.modalWrap} onClick={closeModal}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', marginTop: 0 }}>Aprobar pago</h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {fmt(active.monto)} de <strong>{active.payer_name || 'cliente'}</strong> ({active.origen}). Al aprobar, el monto queda disponible en su cuenta para asignar.
            </p>
            <div style={{ marginTop: 8 }}>
              <div style={s.label}>Vincular transacción bancaria</div>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {candidatesFor(active).map(c => (
                  <label key={c.tx.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-primary)', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', background: chosenTx?.id === c.tx.id ? 'rgba(124,58,237,0.12)' : 'transparent' }}>
                    <input type="radio" name="tx" checked={chosenTx?.id === c.tx.id} onChange={() => setChosenTx(c.tx)} />
                    <span style={s.chip(c.strength === 'exact' ? '#16A34A' : c.strength === 'strong' ? '#0ea5e9' : '#b8720a')}>{c.score}%</span>
                    <span>{c.tx.cuenta} · {fmtDate(c.tx.fecha)} · {fmt(c.tx.monto_usd)} · {c.tx.sender_name || c.tx.referencia || '—'}</span>
                  </label>
                ))}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', padding: '8px 10px', cursor: 'pointer' }}>
                  <input type="radio" name="tx" checked={!chosenTx} onChange={() => setChosenTx(null)} />
                  Aprobar sin vincular (override — concílialo luego en /banco)
                </label>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button style={s.btnGhost} onClick={closeModal} disabled={busy}>Cancelar</button>
              <button style={s.btn('#16A34A')} onClick={handleApprove} disabled={busy}>{busy ? 'Aprobando…' : 'Confirmar aprobación'}</button>
            </div>
          </div>
        </div>
      )}

      {(modal === 'reject' || modal === 'info') && active && (
        <div style={s.modalWrap} onClick={closeModal}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', marginTop: 0 }}>{modal === 'reject' ? 'Rechazar pago' : 'Solicitar información'}</h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{fmt(active.monto)} de {active.payer_name || 'cliente'}.</p>
            <div style={s.label}>{modal === 'reject' ? 'Motivo del rechazo' : '¿Qué información falta?'}</div>
            <textarea style={s.textarea} value={reason} onChange={e => setReason(e.target.value)} placeholder={modal === 'reject' ? 'Ej: comprobante no corresponde al monto…' : 'Ej: falta el número de confirmación…'} />
            <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
              <button style={s.btnGhost} onClick={closeModal} disabled={busy}>Cancelar</button>
              <button style={s.btn(modal === 'reject' ? '#DC2626' : '#b8720a')} onClick={modal === 'reject' ? handleReject : handleRequestInfo} disabled={busy || !reason.trim()}>
                {busy ? 'Guardando…' : modal === 'reject' ? 'Rechazar' : 'Solicitar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === 'allocate' && active && (
        <div style={s.modalWrap} onClick={closeModal}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', marginTop: 0 }}>Asignar saldo a Inicial Diferida</h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Saldo disponible de <strong>{active.payer_name || 'cliente'}</strong>: <strong style={{ color: '#2ecc8a' }}>{fmt(active.monto_disponible)}</strong>. Reparte entre sus compromisos; lo que no asignes queda como saldo a favor.
            </p>
            {compromisos.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '12px 0' }}>Este cliente no tiene compromisos de inicial diferida abiertos (PENDIENTE/PARCIAL). El saldo queda a favor.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                {compromisos.map(c => {
                  const saldo = Number(c.saldo_pendiente ?? (Number(c.monto_usd) - Number(c.monto_pagado_acumulado || 0)))
                  return (
                    <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>#{c.negocio_num} · {c.estado}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>vence {fmtDate(c.fecha_vencimiento)} · saldo {fmt(saldo)}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                        <span style={s.label}>Asignar</span>
                        <input style={{ ...s.input, maxWidth: 140 }} inputMode="decimal" value={alloc[c.id] || ''} onChange={e => setAlloc(a => ({ ...a, [c.id]: e.target.value }))} placeholder="0.00" />
                        <button style={{ ...s.btnGhost, padding: '6px 10px', fontSize: 12 }} onClick={() => setAlloc(a => ({ ...a, [c.id]: Math.min(saldo, Math.max(0, allocLeft + (parseFloat(a[c.id] || '0') || 0))).toFixed(2) }))}>Máx</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <div style={{ marginTop: 14, fontSize: 13, color: 'var(--text-primary)', display: 'flex', justifyContent: 'space-between' }}>
              <span>Asignado: <strong>{fmt(allocTotal)}</strong></span>
              <span style={{ color: allocLeft < -0.005 ? '#DC2626' : 'var(--text-secondary)' }}>Saldo a favor restante: <strong>{fmt(allocLeft)}</strong></span>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
              <button style={s.btnGhost} onClick={closeModal} disabled={busy}>Cerrar</button>
              <button style={s.btn('#7C3AED')} onClick={handleAllocate} disabled={busy || allocTotal <= 0.0001 || allocLeft < -0.005}>{busy ? 'Asignando…' : 'Asignar'}</button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  )
}