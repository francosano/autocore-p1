// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/comprobantes/page.tsx
// AutoCore NPA — Comprobante detail (mobile/list chrome variant)
//
// URL: /tesoreria/comprobante?id={uuid}[&created=1][&scan=1]
//
// INGRESO actions (unchanged): Pickup confirm, Anular, Print.
//
// Phase 4 (2026-05-16) — EGRESO chain tracker:
//   BANCARIZACION · via_mirla:
//     SOLICITADO → EN_PODER_MIRLA → ENTREGADO_BANCARIZADOR → DEPOSITADO
//   BANCARIZACION · directa:
//     SOLICITADO → ENTREGADO_BANCARIZADOR → DEPOSITADO
//   CAJA_CHICA_REPO / VENDOR_PAGO:
//     SOLICITADO → EJECUTADO
//   PAGO_FIJO: born EJECUTADO (no actions here).
//
// Movimiento policy: the −1/CAJA_PPAL movimiento is written at the moment the
// money actually leaves — DEPOSITADO for bancarización, EJECUTADO for the
// others. CAJA_CHICA_REPO also writes the +1/CAJA_CHICA leg (internal transfer).
//
// &scan=1 (flow 2b): the user arrived via the QR scanner — auto-open the
// confirmation prompt for whatever the next valid transition is.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '../../supabase'
import AdminShell from '../../components/AdminShell'
import { useAuthGate } from '../../components/useAuthGate'
import SessionErrorScreen from '../../components/SessionErrorScreen'
import { useIsMobile } from '../../components/useIsMobile'
import TesoreriaQR from '../../components/TesoreriaQR'

const COMPROBANTE_WORKER = 'https://autocore-comprobante.sano-franco.workers.dev'
const WHATSAPP_WORKER    = 'https://autocore-whatsapp.sano-franco.workers.dev'

// Fire-and-forget Tesorería WhatsApp notification.
// Non-blocking, non-fatal — if the worker is unreachable the user's action
// (already committed in Supabase) still stands; the WhatsApp ping is just lost.
function notifyTesoreria(payload: Record<string, any>) {
  try {
    fetch(WHATSAPP_WORKER + '/notify-tesoreria', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => { /* silent */ })
  } catch { /* silent */ }
}

// ─── Format helpers ───────────────────────────────────────────────────────
const fmt = (n: number | null | undefined) =>
  `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const d = new Date(iso)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const mn = String(d.getMinutes()).padStart(2, '0')
  return `${dd}/${mm}/${yy} ${hh}:${mn}`
}

// ─── Styles ───────────────────────────────────────────────────────────────
const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  content: { padding: '32px', maxWidth: '1000px', margin: '0 auto' },
  back: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', marginBottom: 16 },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, marginBottom: 16 },
  printArea: { background: '#fff', color: '#000', borderRadius: 12, padding: 32, marginBottom: 16, border: '1px solid var(--border)' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 },
  numero: { fontFamily: 'monospace', fontSize: 22, fontWeight: 800, color: '#000' },
  tipoLabel: { fontSize: 11, color: '#666', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 2 },
  badge: { display: 'inline-block', padding: '4px 12px', borderRadius: 999, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1 },
  gridMain: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 },
  grid3: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 },
  field: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  fieldLabel: { fontSize: 10, color: '#888', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1 },
  fieldValue: { fontSize: 14, color: '#000', fontWeight: 500 },
  fieldMono: { fontSize: 16, color: '#000', fontFamily: 'monospace', fontWeight: 700 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 10 },
  qrBox: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 8 },
  qrCaption: { fontSize: 9, color: '#666', fontFamily: 'monospace' },
  signLine: { borderTop: '1px solid #000', paddingTop: 6, marginTop: 32, fontSize: 11, textAlign: 'center' as const, color: '#666' },
  evt: { display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' },
  evtDot: { width: 8, height: 8, borderRadius: '50%', background: '#BB162B', flexShrink: 0, marginTop: 6 },
  evtTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  evtMeta: { fontSize: 11, color: 'var(--text-secondary)' },
  btnRed: { padding: '12px 24px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnGreen: { padding: '12px 24px', background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnSec: { padding: '12px 20px', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  btnRow: { display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' as const },
  err: { padding: '10px 14px', borderRadius: 8, background: 'rgba(187,22,43,0.1)', border: '1px solid #BB162B44', color: '#BB162B', fontSize: 13, marginBottom: 14 },
  success: { padding: '10px 14px', borderRadius: 8, background: 'rgba(26,122,74,0.1)', border: '1px solid #1a7a4a55', color: '#1a7a4a', fontSize: 13, marginBottom: 14 },
  urgentBanner: { padding: '10px 14px', borderRadius: 8, background: 'rgba(187,22,43,0.12)', border: '1px solid #BB162B', color: '#BB162B', fontSize: 13, fontWeight: 700, marginBottom: 14 },
  // Visual money-cycle tracker
  cycleWrap: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', margin: '8px 0 4px', gap: 4 },
  cycleStep: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', flex: 1, position: 'relative' as const },
  cycleNode: (state: 'done' | 'current' | 'todo') => ({
    width: 58, height: 58, borderRadius: '50%', display: 'flex', flexDirection: 'column' as const,
    alignItems: 'center', justifyContent: 'center', zIndex: 2, position: 'relative' as const,
    background: state === 'done' ? 'rgba(26,122,74,0.12)'
      : state === 'current' ? 'rgba(187,22,43,0.12)' : 'var(--bg-deep)',
    border: state === 'done' ? '2px solid #1a7a4a'
      : state === 'current' ? '2px solid #BB162B' : '2px solid var(--border)',
    boxShadow: state === 'current' ? '0 0 0 6px rgba(187,22,43,0.10)' : 'none',
    opacity: state === 'todo' ? 0.5 : 1,
  }),
  cycleHere: {
    position: 'absolute' as const, bottom: -9, fontSize: 8, fontWeight: 800,
    background: '#BB162B', color: '#fff', padding: '2px 6px', borderRadius: 999,
    whiteSpace: 'nowrap' as const,
  },
  cycleArrow: (done: boolean) => ({
    position: 'absolute' as const, top: 22, right: '-50%', width: '100%',
    textAlign: 'center' as const, fontSize: 18, zIndex: 1,
    color: done ? '#1a7a4a' : 'var(--border)', fontWeight: 800,
  }),
  cycleLabel: (state: 'done' | 'current' | 'todo') => ({
    fontSize: 11, marginTop: 12, textAlign: 'center' as const, lineHeight: 1.3,
    fontWeight: state === 'current' ? 800 : 600,
    color: state === 'current' ? '#BB162B' : state === 'done' ? 'var(--text-primary)' : 'var(--text-secondary)',
  }),
  cyclePlace: { fontSize: 9, color: 'var(--text-secondary)', textAlign: 'center' as const, marginTop: 1 },
  cycleDuration: (current: boolean) => ({
    fontSize: 9, marginTop: 4, textAlign: 'center' as const,
    fontWeight: 700, color: current ? '#BB162B' : 'var(--text-secondary)',
  }),
  cycleTotal: {
    marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)',
    fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' as const, fontWeight: 600,
  },
  // ── Mobile vertical stepper — replaces the horizontal cycle on phones ──
  // Each step is a row: node circle (left) + a connector line + text (right).
  vStep: { display: 'flex', gap: 12, position: 'relative' as const },
  vNodeCol: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', flexShrink: 0 },
  vNode: (state: 'done' | 'current' | 'todo') => ({
    width: 38, height: 38, borderRadius: '50%', display: 'flex',
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    fontSize: 16, fontWeight: 800,
    background: state === 'done' ? 'rgba(26,122,74,0.12)'
      : state === 'current' ? 'rgba(187,22,43,0.12)' : 'var(--bg-deep)',
    border: state === 'done' ? '2px solid #1a7a4a'
      : state === 'current' ? '2px solid #BB162B' : '2px solid var(--border)',
    color: state === 'done' ? '#1a7a4a'
      : state === 'current' ? '#BB162B' : 'var(--text-secondary)',
  }),
  vConnector: (done: boolean) => ({
    width: 2, flex: 1, minHeight: 16,
    background: done ? '#1a7a4a' : 'var(--border)',
    margin: '2px 0',
  }),
  vBody: { flex: 1, minWidth: 0, paddingBottom: 18 },
  vLabel: (state: 'done' | 'current' | 'todo') => ({
    fontSize: 14, fontWeight: state === 'current' ? 800 : 600,
    color: state === 'current' ? '#BB162B' : state === 'done' ? 'var(--text-primary)' : 'var(--text-secondary)',
  }),
  vPlace: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 },
  vDuration: (current: boolean) => ({
    fontSize: 10, marginTop: 3, fontWeight: 700,
    color: current ? '#BB162B' : 'var(--text-secondary)',
  }),
  vHere: {
    display: 'inline-block', marginLeft: 8, fontSize: 9, fontWeight: 800,
    background: '#BB162B', color: '#fff', padding: '2px 7px', borderRadius: 999,
    verticalAlign: 'middle' as const,
  },
  // Modal
  modalBg: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 },
  modal: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, maxWidth: 440, width: '100%' },
  modalTitle: { fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 },
  modalText: { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 },
  input: { padding: '10px 14px', background: 'var(--bg-input, var(--bg-deep))', border: '1px solid var(--border)', borderRadius: 8, fontSize: 14, color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' as const },
  label: { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 6, display: 'block' },
  aiBox: (ok: boolean) => ({
    padding: '12px 14px', borderRadius: 8, marginTop: 12, fontSize: 12, lineHeight: 1.6,
    background: ok ? 'rgba(26,122,74,0.08)' : 'rgba(230,126,34,0.1)',
    border: `1px solid ${ok ? '#1a7a4a55' : '#e67e2255'}`,
    color: ok ? '#1a7a4a' : '#b8720a',
  }),
}

interface Comprobante {
  id: string
  numero: string
  tipo: string
  estado: string
  monto_usd: number
  monto_bs: number | null
  tasa_aplicada: number | null
  ubicacion_origen_id: string | null
  ubicacion_destino_id: string | null
  contraparte_nombre: string | null
  contraparte_documento: string | null
  concepto: string
  categoria: string | null
  source_type: string | null
  source_label: string | null
  qr_payload: string
  solicitado_by: string | null
  solicitado_at: string
  aprobado_by: string | null
  aprobado_at: string | null
  confirmado_by: string | null
  confirmado_at: string | null
  cerrado_at: string | null
  notas: string | null
  printed_count: number
  // Egreso fields (Phase 4)
  egreso_tipo: string | null
  bancarizacion_ruta: string | null
  egreso_dirigido_a: string | null
  bancarizador_nombre: string | null
  pago_fijo_concepto: string | null
  es_urgente: boolean | null
  bank_transaction_id: string | null
  egreso_documento_url: string | null
  egreso_ai_review: any | null
  // Reversal fields (REVERTIDO state for executed comprobantes)
  reversed_at: string | null
  reversed_by: string | null
  reversal_motivo: string | null
}

interface Evento {
  id: string
  evento: string
  actor_label: string | null
  actor_user_id: string | null
  notas: string | null
  created_at: string
}

interface Ubicacion {
  id: string
  codigo: string
  nombre: string
  tipo: string
}

const ESTADO_COLORS: Record<string, string> = {
  PENDIENTE_PICKUP:      '#e67e22',
  PICKUP_CONFIRMADO:     '#1a7a4a',
  GENERADO:              '#3b82f6',
  CONFIRMADO:            '#1a7a4a',
  SOLICITADO:            '#b8720a',
  APROBADO:              '#3b82f6',
  ENTREGADO:             '#10b981',
  RECIBIDO:              '#1a7a4a',
  PENDIENTE_BS:          '#e67e22',
  BS_CONFIRMADO:         '#1a7a4a',
  COMPLETADO:            '#1a7a4a',
  ANULADO:               '#BB162B',
  REVERTIDO:             '#BB162B',
  // Egreso states
  EN_PODER_MIRLA:        '#3b82f6',
  ENTREGADO_BANCARIZADOR:'#8b5cf6',
  DEPOSITADO_PARCIAL:    '#b8720a',
  DEPOSITADO:            '#1a7a4a',
  EJECUTADO:             '#1a7a4a',
}

// Chain definitions per egreso flow.
// Each step: key (estado), label, icon (where the money physically is), and
// evento (the tesoreria_comprobante_eventos.evento name that marks ENTRY into
// this step — used to compute how long the money sat at the previous step).
interface ChainStep { key: string; label: string; icon: string; evento: string; place: string }

// Derive the EFFECTIVE bancarización route, regardless of what's stored.
// USDT-sourced bancarizaciones are ALWAYS treated as 'directa' — no physical
// cash exists so there's no Mirla intermediary. This also defensively
// corrects any historical row that was created with the wrong ruta before
// the egreso form forced it.
function effectiveRuta(comp: Comprobante, origenCodigo: string | undefined | null): 'via_mirla' | 'directa' {
  if (origenCodigo === 'USDT_WALLET') return 'directa'
  return comp.bancarizacion_ruta === 'directa' ? 'directa' : 'via_mirla'
}

function chainSteps(comp: Comprobante, origenCodigo?: string | null): ChainStep[] {
  if (comp.egreso_tipo === 'BANCARIZACION') {
    const ruta = effectiveRuta(comp, origenCodigo)
    // USDT-sourced bancarizaciones get a 3-step USDT-flavored chain — the
    // labels reflect digital transfer, not physical cash movement.
    if (origenCodigo === 'USDT_WALLET') {
      return [
        { key: 'SOLICITADO',             label: 'Solicitado',           icon: '📋', evento: 'SOLICITADO',             place: 'USDT Wallet' },
        { key: 'ENTREGADO_BANCARIZADOR', label: 'Transferido',          icon: '🪙', evento: 'ENTREGADO_BANCARIZADOR', place: 'Bancarizador' },
        { key: 'DEPOSITADO',             label: 'Depositado en banco',  icon: '🏦', evento: 'DEPOSITADO',             place: 'Banco' },
      ]
    }
    if (ruta === 'directa') {
      return [
        { key: 'SOLICITADO',             label: 'Solicitado',     icon: '📋', evento: 'SOLICITADO',             place: 'Caja Principal' },
        { key: 'ENTREGADO_BANCARIZADOR', label: 'Con bancarizador', icon: '🤝', evento: 'ENTREGADO_BANCARIZADOR', place: 'Bancarizador' },
        { key: 'DEPOSITADO',             label: 'Depositado',     icon: '🏦', evento: 'DEPOSITADO',             place: 'Banco' },
      ]
    }
    return [
      { key: 'SOLICITADO',             label: 'Solicitado',       icon: '📋', evento: 'SOLICITADO',             place: 'Caja' },
      { key: 'EN_PODER_MIRLA',         label: 'En poder de Mirla', icon: '💵', evento: 'EN_PODER_MIRLA',         place: 'Mirla' },
      { key: 'ENTREGADO_BANCARIZADOR', label: 'Con bancarizador',  icon: '🤝', evento: 'ENTREGADO_BANCARIZADOR', place: 'Bancarizador' },
      { key: 'DEPOSITADO',             label: 'Depositado',       icon: '🏦', evento: 'DEPOSITADO',             place: 'Banco' },
    ]
  }
  if (comp.egreso_tipo === 'CAJA_CHICA_REPO' || comp.egreso_tipo === 'VENDOR_PAGO') {
    return [
      { key: 'SOLICITADO', label: 'Solicitado', icon: '📋', evento: 'SOLICITADO', place: 'Caja' },
      { key: 'EJECUTADO',  label: 'Ejecutado',  icon: '✅', evento: 'EJECUTADO',  place: 'Completado' },
    ]
  }
  return []
}

// Human-friendly duration between two ISO timestamps.
function humanDuration(fromISO: string, toISO: string): string {
  const ms = new Date(toISO).getTime() - new Date(fromISO).getTime()
  if (ms < 0 || isNaN(ms)) return ''
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'menos de 1 min'
  if (mins < 60) return `${mins} min`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  if (hrs < 24) return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`
  const days = Math.floor(hrs / 24)
  const remH = hrs % 24
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`
}

function ComprobanteInner() {
  const router = useRouter()
  const isMobile = useIsMobile()
  const params = useSearchParams()
  const id = params.get('id')
  const justCreated = params.get('created') === '1'
  const cameFromScan = params.get('scan') === '1'
  // Layer 2: this page has no permission gate (anyone signed-in can view a
  // comprobante) — it only uses `permissions` to decide which action buttons
  // to show. So the gate predicate is "any authenticated session".
  const gate = useAuthGate(() => true)
  const { permissions, userId } = gate

  const [loading, setLoading] = useState(true)
  const [comp, setComp] = useState<Comprobante | null>(null)
  const [eventos, setEventos] = useState<Evento[]>([])
  const [ubicaciones, setUbicaciones] = useState<Record<string, Ubicacion>>({})
  const [err, setErr] = useState<string | null>(null)
  const [action, setAction] = useState(false)

  // Egreso modal state
  const [modal, setModal] = useState<null | 'recibi' | 'entregar' | 'depositar' | 'ejecutar' | 'revertir'>(null)
  const [bancarizadorInput, setBancarizadorInput] = useState('')
  const [revertirMotivo, setRevertirMotivo] = useState('')
  const [revertirConfirm, setRevertirConfirm] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const scanPromptShown = useRef(false)

  useEffect(() => {
    if (!id) { router.replace('/tesoreria'); return }
    // Wait for auth to settle before loading — never load on the transient
    // rehydration window. 'ok' and 'denied' both mean settled here ('denied'
    // is unreachable since the predicate is () => true, but kept explicit).
    if (gate.status === 'loading' || gate.status === 'error') return
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, gate.status])

  async function load() {
    setLoading(true)
    setErr(null)
    // Authoritative saldo recompute before reading. Every money-moving handler
    // here ends in await load(); the incremental balance trigger
    // (trg_tesoreria_balance) misses under the REST/pooler path, so a full
    // re-sum here guarantees ubicaciones saldos are current on every refresh.
    try { await supabase.rpc('tesoreria_recompute_saldos') }
    catch (e) { console.warn('[comprobantes] recompute warning', e) }
    const [compResp, evtResp, ubicResp] = await Promise.all([
      supabase.from('tesoreria_comprobantes').select('*').eq('id', id).single(),
      supabase.from('tesoreria_comprobante_eventos').select('*').eq('comprobante_id', id).order('created_at', { ascending: true }),
      supabase.from('tesoreria_ubicaciones').select('id, codigo, nombre, tipo'),
    ])
    if (compResp.error || !compResp.data) {
      setErr('Comprobante no encontrado')
      setLoading(false)
      return
    }
    const c = compResp.data as Comprobante
    setComp(c)
    setEventos((evtResp.data || []) as Evento[])
    const ubicMap: Record<string, Ubicacion> = {}
    ;(ubicResp.data || []).forEach((u: any) => { ubicMap[u.id] = u })
    setUbicaciones(ubicMap)
    setLoading(false)

    // Flow 2b: arrived via QR scan → auto-open the confirmation prompt for the
    // next valid egreso transition. Only once per page load.
    if (cameFromScan && !scanPromptShown.current && c.tipo === 'EGRESO') {
      scanPromptShown.current = true
      // origenCodigo needed so USDT-sourced bancarizaciones jump to the
      // transfer modal directly, skipping the Mirla-recibí step.
      const ocod = c.ubicacion_origen_id ? ubicMap[c.ubicacion_origen_id]?.codigo : null
      const next = nextEgresoModal(c, permissions, ocod)
      if (next) setModal(next)
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // INGRESO actions (unchanged from Phase 3.1)
  // ════════════════════════════════════════════════════════════════════════
  async function handleConfirmPickup() {
    if (!comp || !userId) return
    if (!confirm(`¿Confirmar recogida de ${fmt(comp.monto_usd)}? El dinero se moverá a Caja Principal.`)) return
    setAction(true); setErr(null)
    try {
      // 2026-05-19 — pickup now reads the comprobante's actual destination
      // instead of hardcoding PC_MIRLA. Today every ingreso lands at
      // PC_MIRLA so this behaves identically — but if an old row pointed at
      // a different ubicación (e.g. a Caja Chica ingreso created before the
      // form was tightened), the pickup will correctly debit THAT location
      // rather than wrongly draining PC_MIRLA.
      const origenUbic = comp.ubicacion_destino_id
        ? ubicaciones[comp.ubicacion_destino_id]
        : Object.values(ubicaciones).find(u => u.codigo === 'PC_MIRLA') // legacy fallback
      const cajaPpal = Object.values(ubicaciones).find(u => u.codigo === 'CAJA_PPAL')
      if (!origenUbic || !cajaPpal) throw new Error('Ubicaciones no encontradas')
      // Safety: if somehow the ingreso was already at Caja Principal, the
      // pickup is a no-op move (same source and destination). Block it so
      // we don't write a meaningless ±movimiento pair.
      if (origenUbic.id === cajaPpal.id) {
        throw new Error('Este ingreso ya está en Caja Principal — no requiere recogida.')
      }
      const { error: upErr } = await supabase
        .from('tesoreria_comprobantes')
        .update({ estado: 'PICKUP_CONFIRMADO', confirmado_by: userId, confirmado_at: new Date().toISOString(), cerrado_at: new Date().toISOString() })
        .eq('id', comp.id)
      if (upErr) throw upErr
      const { error: m1Err } = await supabase.from('tesoreria_movimientos').insert([
        { ubicacion_id: origenUbic.id, tipo: 'TRANSFER_PICKUP', monto_usd: comp.monto_usd, signo: -1, source_type: 'PICKUP', source_label: comp.source_label || comp.concepto, comprobante_id: comp.id, descripcion: `Pickup confirmado · ${comp.numero}`, registered_by: userId },
        { ubicacion_id: cajaPpal.id,   tipo: 'TRANSFER_PICKUP', monto_usd: comp.monto_usd, signo: 1,  source_type: 'PICKUP', source_label: comp.source_label || comp.concepto, comprobante_id: comp.id, descripcion: `Pickup confirmado · ${comp.numero}`, registered_by: userId },
      ])
      if (m1Err) throw m1Err
      await supabase.from('tesoreria_comprobante_eventos').insert({ comprobante_id: comp.id, evento: 'PICKUP_CONFIRMADO', actor_user_id: userId, actor_label: 'Tesorera', notas: `Pickup de ${fmt(comp.monto_usd)} de ${origenUbic.nombre} a Caja Principal` })

      // WhatsApp → ingreso_recogido. Non-blocking.
      notifyTesoreria({
        evento: 'PICKUP_CONFIRMADO',
        tipo: 'INGRESO',
        numero: comp.numero,
        monto_usd: comp.monto_usd,
        concepto: comp.concepto || '',
        enviado_por: userId,
      })

      await load()
    } catch (e: any) {
      setErr(e.message || 'Error al confirmar pickup')
    } finally { setAction(false) }
  }

  async function handleAnular() {
    if (!comp || !userId) return
    // Anulable states:
    //   INGRESOS: PENDIENTE_PICKUP (cash hasn't been picked up yet)
    //   EGRESOS:  SOLICITADO, EN_PODER_MIRLA, ENTREGADO_BANCARIZADOR
    //     (anything pre-DEPOSITADO is anulable — money returns to where it
    //      came from. DEPOSITADO/EJECUTADO need the REVERTIDO flow because
    //      a bank deposit / vendor pago already executed.)
    const anulableEstados = [
      'PENDIENTE_PICKUP',
      'SOLICITADO',
      'EN_PODER_MIRLA',
      'ENTREGADO_BANCARIZADOR',
    ]
    if (!anulableEstados.includes(comp.estado)) {
      alert('Este comprobante ya no se puede anular en su estado actual.')
      return
    }
    const motivo = prompt(
      'Anular comprobante ' + comp.numero + '\n\n' +
      'Marca el comprobante como ANULADO. Si ya había movimientos de dinero,\n' +
      'se escriben movimientos inversos para devolver el dinero al origen.\n\n' +
      'Indica el motivo (obligatorio):'
    )
    if (!motivo || !motivo.trim()) return
    setAction(true); setErr(null)
    try {
      // 1. Update comprobante to ANULADO.
      const { error: upErr } = await supabase
        .from('tesoreria_comprobantes')
        .update({ estado: 'ANULADO', cerrado_at: new Date().toISOString(), notas: (comp.notas ? comp.notas + ' · ' : '') + 'ANULADO: ' + motivo.trim() })
        .eq('id', comp.id)
        .eq('estado', comp.estado)
      if (upErr) throw upErr

      // 2. Query existing movimientos for this comprobante. Write a reverse
      // movimiento (opposite signo) for each. This handles every case:
      //   INGRESO PENDIENTE_PICKUP → 1 mov on destino → reverse it
      //   EGRESO SOLICITADO         → 0 movs → nothing to reverse
      //   EGRESO EN_PODER_MIRLA     → 0 movs → nothing to reverse
      //   EGRESO ENTREGADO_BANCARIZADOR → 1 mov on origen → reverse it
      //     (money returns to the source caja — Caja Principal / PC Mirla /
      //      USDT Wallet — exactly where it came from)
      const { data: existingMovs, error: qErr } = await supabase
        .from('tesoreria_movimientos')
        .select('id, ubicacion_id, monto_usd, signo, categoria')
        .eq('comprobante_id', comp.id)
        .eq('is_reversal', false)
      if (qErr) throw qErr

      if (existingMovs && existingMovs.length > 0) {
        const reversals = existingMovs.map((m: any) => ({
          ubicacion_id: m.ubicacion_id,
          tipo: 'ANULACION',
          monto_usd: m.monto_usd,
          signo: m.signo === 1 ? -1 : 1,   // opposite sign returns the money home
          source_type: 'REVERSAL',
          source_label: 'Anulación · ' + comp.numero,
          comprobante_id: comp.id,
          descripcion: 'Reverso por anulación · ' + motivo.trim().slice(0, 100),
          categoria: m.categoria,
          registered_by: userId,
          is_reversal: true,
          reversed_by_id: m.id,
        }))
        const { error: revErr } = await supabase.from('tesoreria_movimientos').insert(reversals)
        if (revErr) throw revErr
      }

      await supabase.from('tesoreria_comprobante_eventos').insert({ comprobante_id: comp.id, evento: 'ANULADO', actor_user_id: userId, actor_label: 'Tesorería', notas: motivo.trim() })

      // WhatsApp → banc_anulada (for bancarizaciones) or egreso_anulado (for
      // caja chica / vendor). Only for EGRESOS — an ingreso anulado is a
      // pre-money cancellation that's much less critical to broadcast.
      if (comp.tipo === 'EGRESO') {
        notifyTesoreria({
          evento: 'ANULADO',
          tipo: 'EGRESO',
          egreso_tipo: comp.egreso_tipo,
          numero: comp.numero,
          monto_usd: comp.monto_usd,
          motivo: motivo.trim(),
          enviado_por: userId,
        })
      }

      await load()
    } catch (e: any) {
      setErr(e.message || 'Error al anular comprobante')
    } finally { setAction(false) }
  }

  // Reverse a comprobante that already moved real money out of the system.
  // States covered: DEPOSITADO (bancarización), EJECUTADO (caja chica repo /
  // vendor pago). Unlike handleAnular which only touches comprobantes that
  // never deposited / never executed, this writes proper reversing entries:
  //   • +1 movimiento back to the source caja (cash returns to where it left)
  //   • flags the linked bank_transactions row as reversed (does NOT delete;
  //     /banco needs the audit trail)
  //   • marks the comprobante REVERTIDO with motivo (min 10 chars) + author
  async function handleRevertir() {
    if (!comp || !userId) return
    if (comp.estado !== 'DEPOSITADO' && comp.estado !== 'EJECUTADO') {
      alert('Sólo se pueden revertir comprobantes ya ejecutados (DEPOSITADO / EJECUTADO). Para revertir un depósito parcial, abre el comprobante en su página de detalle.')
      return
    }
    const motivo = revertirMotivo.trim()
    if (motivo.length < 10) {
      setErr('El motivo es obligatorio (mínimo 10 caracteres).')
      return
    }
    if (revertirConfirm.trim().toUpperCase() !== 'REVERTIR') {
      setErr('Debes escribir REVERTIR para confirmar.')
      return
    }
    setAction(true); setErr(null)
    try {
      const prevEstado = comp.estado

      // 1. Mark the comprobante REVERTIDO (status guards against double-revert)
      const { error: upErr } = await supabase
        .from('tesoreria_comprobantes')
        .update({
          estado: 'REVERTIDO',
          reversed_at: new Date().toISOString(),
          reversed_by: userId,
          reversal_motivo: motivo,
          cerrado_at: new Date().toISOString(),
          notas: (comp.notas ? comp.notas + ' · ' : '') + 'REVERTIDO: ' + motivo,
        })
        .eq('id', comp.id)
        .eq('estado', prevEstado)
      if (upErr) throw upErr

      // 2. Reverse every real movimiento on this comprobante. Same shape as
      //    handleAnular — opposite signo returns money to where it lived.
      const { data: existingMovs, error: qErr } = await supabase
        .from('tesoreria_movimientos')
        .select('id, ubicacion_id, monto_usd, signo, categoria')
        .eq('comprobante_id', comp.id)
        .eq('is_reversal', false)
      if (qErr) throw qErr

      if (existingMovs && existingMovs.length > 0) {
        const reversals = existingMovs.map((m: any) => ({
          ubicacion_id: m.ubicacion_id,
          tipo: 'REVERSION',
          monto_usd: m.monto_usd,
          signo: m.signo === 1 ? -1 : 1,
          source_type: 'REVERSAL',
          source_label: 'Reversión · ' + comp.numero,
          comprobante_id: comp.id,
          descripcion: 'Reverso por reversión · ' + motivo.slice(0, 100),
          categoria: m.categoria,
          registered_by: userId,
          is_reversal: true,
          reversed_by_id: m.id,
        }))
        const { error: revErr } = await supabase.from('tesoreria_movimientos').insert(reversals)
        if (revErr) throw revErr
      }

      // 3. If a bank_transactions row was linked (DEPOSITADO path), flag it
      //    reversed. We keep the row so /banco preserves the audit trail.
      if (comp.bank_transaction_id) {
        await supabase
          .from('bank_transactions')
          .update({
            reversed_at: new Date().toISOString(),
            reversed_by_comprobante_id: comp.id,
          })
          .eq('id', comp.bank_transaction_id)
      }

      // 4. Event row
      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: comp.id,
        evento: 'REVERTIDO',
        actor_user_id: userId,
        actor_label: 'Tesorería',
        notas: motivo,
      })

      // 5. Notify (Worker maps evento=REVERTIDO → egreso_revertido template).
      //    Pending Meta approval — worker should fall back to a generic
      //    text-mode message until the template is live.
      if (comp.tipo === 'EGRESO') {
        notifyTesoreria({
          evento: 'REVERTIDO',
          tipo: 'EGRESO',
          egreso_tipo: comp.egreso_tipo,
          numero: comp.numero,
          monto_usd: comp.monto_usd,
          motivo: motivo,
          ubicacion_origen_codigo: comp.ubicacion_origen_id
            ? ubicaciones[comp.ubicacion_origen_id]?.codigo
            : null,
          enviado_por: userId,
        })
      }

      setModal(null)
      setRevertirMotivo('')
      setRevertirConfirm('')
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error al revertir comprobante')
    } finally { setAction(false) }
  }

  async function handlePrint() {
    if (!comp) return
    await supabase.from('tesoreria_comprobantes').update({ printed_count: comp.printed_count + 1 }).eq('id', comp.id)
    await supabase.from('tesoreria_comprobante_eventos').insert({ comprobante_id: comp.id, evento: 'IMPRESO', actor_user_id: userId, actor_label: 'Print' })
    // Set document title so "Save as PDF" uses the comprobante number as the filename
    const originalTitle = document.title
    document.title = comp.numero
    window.print()
    // Restore after the print dialog closes
    setTimeout(() => { document.title = originalTitle }, 1000)
  }

  // ════════════════════════════════════════════════════════════════════════
  // EGRESO actions (Phase 4)
  // ════════════════════════════════════════════════════════════════════════

  // SOLICITADO → EN_PODER_MIRLA (bancarización via_mirla). Mirla confirms she
  // received the cash. No movimiento — money is just changing hands, still
  // inside CAJA_PPAL custody until deposited.
  async function egresoReciboMirla() {
    if (!comp || !userId) return
    setAction(true); setErr(null)
    try {
      const { error } = await supabase
        .from('tesoreria_comprobantes')
        .update({ estado: 'EN_PODER_MIRLA' })
        .eq('id', comp.id).eq('estado', 'SOLICITADO')
      if (error) throw error
      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: comp.id, evento: 'EN_PODER_MIRLA', actor_user_id: userId,
        actor_label: 'Mirla', notas: 'Efectivo recibido en oficina de Mirla',
      })

      // WhatsApp → banc_en_mirla. Only fires for via_mirla bancarizaciones
      // (directa skips this state entirely; USDT route also skips it).
      notifyTesoreria({
        evento: 'EN_PODER_MIRLA',
        tipo: 'EGRESO',
        egreso_tipo: 'BANCARIZACION',
        bancarizacion_ruta: comp.bancarizacion_ruta || 'via_mirla',
        ubicacion_origen_codigo: comp.ubicacion_origen_id
          ? ubicaciones[comp.ubicacion_origen_id]?.codigo
          : null,
        es_urgente: comp.es_urgente,
        numero: comp.numero,
        monto_usd: comp.monto_usd,
        bancarizador: comp.egreso_dirigido_a || '',
        enviado_por: userId,
      })

      setModal(null)
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error al confirmar recepción')
    } finally { setAction(false) }
  }

  // → ENTREGADO_BANCARIZADOR. Records who picked up the cash.
  async function egresoEntregarBancarizador() {
    if (!comp || !userId) return
    if (!bancarizadorInput.trim()) { setErr('Indica el nombre de quien recibe el efectivo'); return }
    // USDT bancarizaciones and 'directa' route both jump straight from
    // SOLICITADO; via_mirla goes through EN_PODER_MIRLA first.
    const origenCod = comp.ubicacion_origen_id ? ubicaciones[comp.ubicacion_origen_id]?.codigo : null
    const ruta = effectiveRuta(comp, origenCod)
    const fromEstado = ruta === 'directa' ? 'SOLICITADO' : 'EN_PODER_MIRLA'
    setAction(true); setErr(null)
    try {
      const { error } = await supabase
        .from('tesoreria_comprobantes')
        .update({ estado: 'ENTREGADO_BANCARIZADOR', bancarizador_nombre: bancarizadorInput.trim() })
        .eq('id', comp.id).eq('estado', fromEstado)
      if (error) throw error

      // ★ The cash physically left the company here. Write the −1 movimiento
      // against the source caja so the saldo reflects reality. This is the
      // earmark point for ALL bancarizaciones (via_mirla, directa, USDT).
      // Previously this happened at DEPOSITADO; now it happens here.
      if (comp.ubicacion_origen_id) {
        const { error: movErr } = await supabase.from('tesoreria_movimientos').insert({
          ubicacion_id: comp.ubicacion_origen_id,
          tipo: 'EGRESO_BANCARIZACION',
          monto_usd: comp.monto_usd,
          signo: -1,
          source_type: 'EGRESO',
          source_label: comp.source_label || comp.concepto,
          comprobante_id: comp.id,
          descripcion: `Bancarización entregada a ${bancarizadorInput.trim()} · ${comp.numero}`,
          categoria: 'BANCARIZACION',
          registered_by: userId,
        })
        if (movErr) throw new Error('Error registrando movimiento de egreso: ' + movErr.message)
      }

      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: comp.id, evento: 'ENTREGADO_BANCARIZADOR', actor_user_id: userId,
        // Actor: USDT = "Tesorería" (digital transfer), directa = "Viviana",
        // via_mirla = "Mirla" (she handed the cash off).
        actor_label: origenCod === 'USDT_WALLET' ? 'Tesorería' : (ruta === 'directa' ? 'Viviana' : 'Mirla'),
        notas: `Efectivo entregado a: ${bancarizadorInput.trim()}`,
      })

      // WhatsApp → routes by source caja + ruta:
      //   USDT_WALLET source → usdt_entregada
      //   directa ruta       → banc_directa_entregada
      //   via_mirla ruta     → banc_entregada
      notifyTesoreria({
        evento: 'ENTREGADO_BANCARIZADOR',
        tipo: 'EGRESO',
        egreso_tipo: 'BANCARIZACION',
        bancarizacion_ruta: comp.bancarizacion_ruta || 'via_mirla',
        ubicacion_origen_codigo: comp.ubicacion_origen_id
          ? ubicaciones[comp.ubicacion_origen_id]?.codigo
          : null,
        es_urgente: comp.es_urgente,
        numero: comp.numero,
        monto_usd: comp.monto_usd,
        bancarizador: bancarizadorInput.trim(),
        enviado_por: userId,
      })

      setModal(null); setBancarizadorInput('')
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error al registrar la entrega')
    } finally { setAction(false) }
  }

  // → DEPOSITADO. Mirla uploads the bank deposit proof. AI reads it. The
  // −1/CAJA_PPAL movimiento is written here (money has truly left). A
  // bank_transactions row is created so /banco shows the deposit.
  async function egresoDepositar(file: File) {
    if (!comp || !userId) return
    setAiBusy(true); setErr(null)
    try {
      // 1. Upload the deposit proof to storage
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
      const path = `tesoreria/${comp.id}/deposito.${ext}`
      const { error: upErr } = await supabase.storage.from('comprobantes').upload(path, file, { upsert: true })
      if (upErr) throw new Error('Error subiendo el comprobante: ' + upErr.message)
      const { data: pub } = supabase.storage.from('comprobantes').getPublicUrl(path)
      const documentoUrl = pub?.publicUrl || null

      // 2. AI reads the deposit record
      const aiReview = await aiReadDocument(file, 'deposito', comp.monto_usd)

      // 3. Create the bank_transactions row (internal cash deposit, /banco skips it)
      let bankTxId: string | null = null
      const { data: btRow } = await supabase.from('bank_transactions').insert({
        tipo: 'deposit',
        fecha: aiReview.fecha || new Date().toISOString().slice(0, 10),
        monto_usd: comp.monto_usd,
        referencia: aiReview.referencia || comp.numero,
        cuenta: null,
        raw_text: `Bancarización ${comp.numero} · ${comp.concepto}`,
        is_internal: true,
        flujo: 'ingreso',
      }).select('id').single()
      if (btRow) bankTxId = btRow.id

      // NOTE: The −1 movimiento on the source caja was already written at
      // ENTREGADO_BANCARIZADOR (the earmark point). DEPOSITADO is purely a
      // confirmation that the funds arrived in the bank — no balance change
      // happens to the source caja here.

      // Update the comprobante
      await supabase.from('tesoreria_comprobantes').update({
        estado: 'DEPOSITADO',
        cerrado_at: new Date().toISOString(),
        egreso_documento_url: documentoUrl,
        egreso_ai_review: aiReview,
        bank_transaction_id: bankTxId,
      }).eq('id', comp.id).eq('estado', 'ENTREGADO_BANCARIZADOR')

      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: comp.id, evento: 'DEPOSITADO', actor_user_id: userId,
        actor_label: 'Mirla',
        notas: aiReview.match
          ? `Depósito confirmado. IA leyó ${fmt(aiReview.monto_leido)}.`
          : `Depósito registrado. ⚠ IA: ${aiReview.motivo || 'monto no coincide'}.`,
      })

      // WhatsApp → banc_depositada / banc_directa_depositada / usdt_depositada.
      notifyTesoreria({
        evento: 'DEPOSITADO',
        tipo: 'EGRESO',
        egreso_tipo: 'BANCARIZACION',
        bancarizacion_ruta: comp.bancarizacion_ruta || 'via_mirla',
        ubicacion_origen_codigo: comp.ubicacion_origen_id
          ? ubicaciones[comp.ubicacion_origen_id]?.codigo
          : null,
        es_urgente: comp.es_urgente,
        numero: comp.numero,
        monto_usd: comp.monto_usd,
        bancarizador: comp.bancarizador_nombre || comp.egreso_dirigido_a || '',
        enviado_por: userId,
      })

      setModal(null)
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error al registrar el depósito')
    } finally { setAiBusy(false) }
  }

  // CAJA_CHICA_REPO / VENDOR_PAGO: SOLICITADO → EJECUTADO.
  // Caja chica writes 2 movimientos (internal transfer). Vendor writes 1, and
  // optionally an AI factura review if a file is attached.
  async function egresoEjecutar(file: File | null) {
    if (!comp || !userId) return
    setAiBusy(true); setErr(null)
    try {
      // Source caja = whatever the egreso was created against (CAJA_PPAL or
      // PC_MIRLA). Beto may have sourced this from the collection point.
      const cajaOrigen = comp.ubicacion_origen_id ? ubicaciones[comp.ubicacion_origen_id] : null
      if (!cajaOrigen) throw new Error('Caja de origen no encontrada')

      let documentoUrl: string | null = null
      let aiReview: any = null

      // Vendor pago: upload + AI review the factura. On mismatch/missing → email Mirla.
      if (comp.egreso_tipo === 'VENDOR_PAGO') {
        if (file) {
          const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
          const path = `tesoreria/${comp.id}/factura.${ext}`
          const { error: upErr } = await supabase.storage.from('comprobantes').upload(path, file, { upsert: true })
          if (upErr) throw new Error('Error subiendo la factura: ' + upErr.message)
          const { data: pub } = supabase.storage.from('comprobantes').getPublicUrl(path)
          documentoUrl = pub?.publicUrl || null
          aiReview = await aiReadDocument(file, 'factura', comp.monto_usd)
        } else {
          aiReview = { ok: false, match: false, motivo: 'No se adjuntó factura' }
        }
        if (!aiReview.ok || !aiReview.match) {
          await emailMirlaMismatch(comp, aiReview)
        }
      }

      // Movimientos
      if (comp.egreso_tipo === 'CAJA_CHICA_REPO') {
        const cajaChica = comp.ubicacion_destino_id ? ubicaciones[comp.ubicacion_destino_id] : null
        if (!cajaChica) throw new Error('Caja Chica (destino) no encontrada')
        await supabase.from('tesoreria_movimientos').insert([
          { ubicacion_id: cajaOrigen.id, tipo: 'EGRESO_CAJA_CHICA', monto_usd: comp.monto_usd, signo: -1, source_type: 'EGRESO', source_label: comp.concepto, comprobante_id: comp.id, descripcion: `Reposición caja chica · ${comp.numero}`, categoria: 'CAJA_CHICA_REPO', registered_by: userId },
          { ubicacion_id: cajaChica.id, tipo: 'EGRESO_CAJA_CHICA', monto_usd: comp.monto_usd, signo: 1, source_type: 'EGRESO', source_label: comp.concepto, comprobante_id: comp.id, descripcion: `Reposición caja chica · ${comp.numero}`, categoria: 'CAJA_CHICA_REPO', registered_by: userId },
        ])
      } else {
        // VENDOR_PAGO — single −1 leg
        await supabase.from('tesoreria_movimientos').insert({
          ubicacion_id: cajaOrigen.id, tipo: 'EGRESO_VENDOR', monto_usd: comp.monto_usd,
          signo: -1, source_type: 'EGRESO', source_label: comp.source_label || comp.concepto,
          comprobante_id: comp.id, descripcion: `Pago a proveedor · ${comp.numero}`,
          categoria: 'VENDOR_PAGO', registered_by: userId,
        })
      }

      await supabase.from('tesoreria_comprobantes').update({
        estado: 'EJECUTADO',
        cerrado_at: new Date().toISOString(),
        egreso_documento_url: documentoUrl,
        egreso_ai_review: aiReview,
      }).eq('id', comp.id).eq('estado', 'SOLICITADO')

      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: comp.id, evento: 'EJECUTADO', actor_user_id: userId,
        actor_label: 'Tesorería',
        notas: comp.egreso_tipo === 'VENDOR_PAGO'
          ? (aiReview?.match ? `Pago ejecutado. Factura verificada por IA.` : `Pago ejecutado. ⚠ ${aiReview?.motivo || 'factura no verificada'} — se notificó a Mirla.`)
          : 'Reposición de caja chica ejecutada.',
      })

      // WhatsApp → caja_chica_ejecutada, vendor_ejecutado, or
      // vendor_factura_alerta (Worker routes via factura_match flag).
      notifyTesoreria({
        evento: 'EJECUTADO',
        tipo: 'EGRESO',
        egreso_tipo: comp.egreso_tipo,
        es_urgente: comp.es_urgente,
        numero: comp.numero,
        monto_usd: comp.monto_usd,
        concepto: comp.concepto || '',
        egreso_dirigido_a: comp.egreso_dirigido_a || '',
        factura_match: comp.egreso_tipo === 'VENDOR_PAGO' ? !!aiReview?.match : undefined,
        factura_motivo: comp.egreso_tipo === 'VENDOR_PAGO' && !aiReview?.match
          ? (aiReview?.motivo || 'Factura no verificada')
          : undefined,
        enviado_por: userId,
      })

      setModal(null)
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error al ejecutar el egreso')
    } finally { setAiBusy(false) }
  }

  // ─── AI document reader — calls autocore-comprobante /messages passthrough ──
  async function aiReadDocument(file: File, kind: 'deposito' | 'factura', expectedMonto: number): Promise<any> {
    try {
      const base64 = await fileToBase64(file)
      const isPdf = file.type === 'application/pdf'
      const prompt = kind === 'deposito'
        ? `Esta es una constancia de depósito o transferencia bancaria. Devuelve SOLO un objeto JSON, sin markdown:
{"monto": <número USD>, "fecha": "<YYYY-MM-DD o null>", "banco": "<nombre del banco o null>", "referencia": "<número de referencia o null>"}
El monto esperado del depósito es ${expectedMonto}. Extrae el monto real del documento.`
        : `Esta es una factura de un proveedor. Devuelve SOLO un objeto JSON, sin markdown:
{"monto": <número total USD>, "proveedor": "<nombre del proveedor o null>", "fecha": "<YYYY-MM-DD o null>", "referencia": "<número de factura o null>"}
El monto esperado del pago es ${expectedMonto}. Extrae el monto total real de la factura.`

      const contentBlock = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
        : { type: 'image', source: { type: 'base64', media_type: file.type || 'image/jpeg', data: base64 } }

      const resp = await fetch(COMPROBANTE_WORKER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
        }),
      })
      const data = await resp.json()
      const textBlock = (data.content || []).find((b: any) => b.type === 'text')
      const raw = (textBlock?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      const parsed = JSON.parse(raw)
      const montoLeido = Number(parsed.monto) || 0
      const match = montoLeido > 0 && Math.abs(montoLeido - expectedMonto) <= 1
      return {
        ok: true,
        monto_leido: montoLeido,
        fecha: parsed.fecha || null,
        referencia: parsed.referencia || null,
        banco: parsed.banco || null,
        proveedor: parsed.proveedor || null,
        match,
        motivo: match ? null : `Monto leído ${fmt(montoLeido)} ≠ esperado ${fmt(expectedMonto)}`,
      }
    } catch (e: any) {
      return { ok: false, match: false, motivo: 'No se pudo leer el documento: ' + (e.message || 'error') }
    }
  }

  // Email Mirla when a vendor factura doesn't match (or is missing).
  async function emailMirlaMismatch(c: Comprobante, aiReview: any) {
    try {
      // Look up Mirla's email from the notify contacts (cajera role).
      const { data: contacts } = await supabase
        .from('tesoreria_notify_contacts')
        .select('email').eq('rol', 'cajera').eq('activo', true).limit(1)
      const mirlaEmail = contacts?.[0]?.email
      if (!mirlaEmail) return
      const html = `<div style="font-family:sans-serif;font-size:14px;color:#18181B">
        <p>El pago a proveedor <b>${c.numero}</b> se ejecutó pero la factura <b>no pudo verificarse</b>.</p>
        <p>Concepto: ${c.concepto}<br>Monto del egreso: ${fmt(c.monto_usd)}<br>
        Resultado IA: ${aiReview?.motivo || 'sin factura adjunta'}</p>
        <p>Por favor revisa el comprobante en Tesorería.</p></div>`
      await fetch(COMPROBANTE_WORKER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: true, to: mirlaEmail,
          subject: `⚠ Pago a proveedor sin factura verificada — ${c.numero}`,
          html,
        }),
      })
    } catch { /* non-fatal — the egreso still executes */ }
  }

  if (gate.status === 'error') {
    return <SessionErrorScreen homeHref="/tesoreria" />
  }
  if (gate.status === 'loading' || loading) {
    return (
      <AdminShell active="tesoreria">
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-secondary)' }}>Cargando…</div>
      </AdminShell>
    )
  }
  if (err && !comp) {
    return (
      <AdminShell active="tesoreria">
        <div style={s.content}>
          <div style={s.err}>{err}</div>
          <button style={s.btnSec} onClick={() => router.push('/tesoreria')}>← Volver al Dashboard</button>
        </div>
      </AdminShell>
    )
  }
  if (!comp) return null

  const isEgreso = comp.tipo === 'EGRESO'
  const tipoLabel: Record<string, string> = {
    INGRESO:       'COMPROBANTE DE INGRESO',
    EGRESO:        'COMPROBANTE DE EGRESO',
    PICKUP:        'COMPROBANTE DE RECOGIDA',
    SALIDA:        'ORDEN DE SALIDA',
    FX:            'OPERACIÓN DE CAMBIO',
    REPLENISHMENT: 'RECARGA DE CAJA CHICA',
  }
  const egresoTipoLabel: Record<string, string> = {
    BANCARIZACION:   'Bancarización',
    CAJA_CHICA_REPO: 'Reposición de Caja Chica',
    VENDOR_PAGO:     'Pago a proveedor',
    PAGO_FIJO:       'Pago fijo mensual',
  }
  const estadoColor = ESTADO_COLORS[comp.estado] || '#6b7280'
  const origenName  = comp.ubicacion_origen_id  ? ubicaciones[comp.ubicacion_origen_id]?.nombre  : null
  const destinoName = comp.ubicacion_destino_id ? ubicaciones[comp.ubicacion_destino_id]?.nombre : null

  const canConfirmPickup = comp.tipo === 'INGRESO' && comp.estado === 'PENDIENTE_PICKUP' && permissions.tesoreria_can_pickup
  const isAdmin = permissions.npa_can_admin || permissions.tesoreria_admin
  const isCreator = comp.solicitado_by === userId
  // Anular button visible in any pre-DEPOSITADO state. The handler enforces
  // the same list and writes reverse movimientos for any movement that
  // already happened.
  const canAnular = ['PENDIENTE_PICKUP', 'SOLICITADO', 'EN_PODER_MIRLA', 'ENTREGADO_BANCARIZADOR'].includes(comp.estado) && (isAdmin || isCreator)

  // Revertir button: comprobantes that already executed (money is OUT of the
  // system). Heavy friction — admin/tesorería only, motivo + type-to-confirm.
  // Egresos only (no point reverting an ingreso, anular is enough pre-pickup;
  // post-pickup, /banco / cobranza tools own the reversal).
  const canRevertir = isEgreso && ['DEPOSITADO', 'EJECUTADO'].includes(comp.estado) && isAdmin

  // Derive origen codigo once — used by chainSteps, egresoNextAction, and all
  // the ruta-dependent transition logic to treat USDT_WALLET sources as directa.
  const origenCodigo = comp.ubicacion_origen_id
    ? ubicaciones[comp.ubicacion_origen_id]?.codigo
    : null

  // Which egreso action button to show for the current state.
  // origenCodigo lets it correctly handle USDT (skip Mirla, jump to transfer).
  const egresoActionBtn = isEgreso ? egresoNextAction(comp, permissions, origenCodigo) : null
  const steps = isEgreso ? chainSteps(comp, origenCodigo) : []
  const timelineEstado = comp.estado === 'DEPOSITADO_PARCIAL' ? 'ENTREGADO_BANCARIZADOR' : comp.estado
  const currentStepIdx = steps.findIndex(st => st.key === timelineEstado)

  return (
    <AdminShell active="tesoreria">
      <div style={{ ...s.content, padding: isMobile ? '16px 14px 32px' : '32px', maxWidth: isMobile ? '100%' : 1000 }}>

        <button style={s.back} onClick={() => router.push('/tesoreria')} className="no-print">← Volver</button>

        {justCreated && (
          <div style={s.success} className="no-print">
            ✓ Comprobante creado.{isEgreso ? '' : ' Imprímelo o muéstralo para que la tesorera lo escanee.'}
          </div>
        )}
        {comp.es_urgente && comp.estado !== 'DEPOSITADO' && comp.estado !== 'EJECUTADO' && comp.estado !== 'ANULADO' && comp.estado !== 'REVERTIDO' && (
          <div style={s.urgentBanner} className="no-print">🔴 EGRESO URGENTE — atender con prioridad</div>
        )}
        {err && <div style={s.err} className="no-print">{err}</div>}

        {/* ── EGRESO visual money-cycle tracker ── (not printed) */}
        {isEgreso && steps.length > 0 && (
          <div style={s.card} className="no-print">
            <h2 style={s.sectionTitle}>¿Dónde está el dinero?</h2>

            {/* Timestamp of each step's entry event, for duration math */}
            {(() => {
              const eventTime: Record<string, string> = {}
              for (const e of eventos) {
                if (!eventTime[e.evento]) eventTime[e.evento] = e.created_at
              }
              const nowISO = new Date().toISOString()
              const anulado = comp.estado === 'ANULADO' || comp.estado === 'REVERTIDO'

              return (
                <>
                  {isMobile ? (
                    /* ── Mobile: vertical stepper ── */
                    <div>
                      {steps.map((st, i) => {
                        const state: 'done' | 'current' | 'todo' =
                          anulado ? (i === 0 ? 'done' : 'todo')
                          : i < currentStepIdx ? 'done'
                          : i === currentStepIdx ? 'current'
                          : 'todo'

                        let duration = ''
                        const thisT = eventTime[st.evento]
                        if (thisT) {
                          if (state === 'done' && i + 1 < steps.length) {
                            const nextT = eventTime[steps[i + 1].evento]
                            if (nextT) duration = humanDuration(thisT, nextT)
                          } else if (state === 'current' && !anulado) {
                            duration = humanDuration(thisT, nowISO)
                          }
                        }
                        const isLast = i === steps.length - 1

                        return (
                          <div key={st.key} style={s.vStep}>
                            <div style={s.vNodeCol}>
                              <div style={s.vNode(state)}>
                                {state === 'done' ? '✓' : i + 1}
                              </div>
                              {!isLast && (
                                <div style={s.vConnector(i < currentStepIdx && !anulado)} />
                              )}
                            </div>
                            <div style={s.vBody}>
                              <div style={s.vLabel(state)}>
                                {st.label}
                                {state === 'current' && !anulado && (
                                  <span style={s.vHere}>aquí</span>
                                )}
                              </div>
                              {st.place && <div style={s.vPlace}>{st.place}</div>}
                              {duration && (
                                <div style={s.vDuration(state === 'current')}>
                                  {state === 'current' ? `⏱ ${duration} aquí` : `⏱ ${duration}`}
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    /* ── Desktop: horizontal cycle ── */
                    <div style={s.cycleWrap}>
                      {steps.map((st, i) => {
                        const state: 'done' | 'current' | 'todo' =
                          anulado ? (i === 0 ? 'done' : 'todo')
                          : i < currentStepIdx ? 'done'
                          : i === currentStepIdx ? 'current'
                          : 'todo'

                        // Duration: time between this step's entry and the next
                        // step's entry (done steps), or entry → now (current step).
                        let duration = ''
                        const thisT = eventTime[st.evento]
                        if (thisT) {
                          if (state === 'done' && i + 1 < steps.length) {
                            const nextT = eventTime[steps[i + 1].evento]
                            if (nextT) duration = humanDuration(thisT, nextT)
                          } else if (state === 'current' && !anulado) {
                            duration = humanDuration(thisT, nowISO)
                          }
                        }

                        return (
                          <div key={st.key} style={s.cycleStep}>
                            {i < steps.length - 1 && (
                              <div style={s.cycleArrow(i < currentStepIdx && !anulado)}>→</div>
                            )}
                            <div style={s.cycleNode(state)}>
                              <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1,
                                color: state === 'done' ? '#1a7a4a' : state === 'current' ? '#BB162B' : 'var(--text-secondary)' }}>
                                {state === 'done' ? '✓' : i + 1}
                              </div>
                              {state === 'current' && !anulado && (
                                <div style={s.cycleHere}>aquí</div>
                              )}
                            </div>
                            <div style={s.cycleLabel(state)}>{st.label}</div>
                            {st.place && (
                              <div style={s.cyclePlace}>{st.place}</div>
                            )}
                            {duration && (
                              <div style={s.cycleDuration(state === 'current')}>
                                {state === 'current' ? `⏱ ${duration} aquí` : `⏱ ${duration}`}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Total elapsed since creation */}
                  {eventTime['SOLICITADO'] && (
                    <div style={s.cycleTotal}>
                      {comp.estado === 'DEPOSITADO' || comp.estado === 'EJECUTADO'
                        ? `Tiempo total del ciclo: ${humanDuration(eventTime['SOLICITADO'], comp.cerrado_at || nowISO)}`
                        : `Tiempo transcurrido: ${humanDuration(eventTime['SOLICITADO'], nowISO)}`}
                    </div>
                  )}

                  {anulado && (
                    <div style={{ ...s.err, marginTop: 12, marginBottom: 0 }}>
                      {comp.estado === 'REVERTIDO'
                        ? `Este egreso fue REVERTIDO. ${comp.reversal_motivo || ''}`
                        : 'Este egreso fue anulado.'}
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        )}

        {/* PRINT AREA */}
        <div style={s.printArea} id="print-area">
          <div style={s.headerRow}>
            <div>
              <div style={s.tipoLabel}>{tipoLabel[comp.tipo] || comp.tipo}</div>
              <div style={s.numero}>{comp.numero}</div>
              <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>MOTOCENTRO II · TESORERÍA</div>
            </div>
            <div style={{ textAlign: 'right' as const }}>
              <span style={{ ...s.badge, background: estadoColor + '22', color: estadoColor, border: `1px solid ${estadoColor}66` }}>
                {comp.estado.replace(/_/g, ' ')}
              </span>
              {comp.es_urgente && (
                <div style={{ marginTop: 6 }}>
                  <span style={{ ...s.badge, background: '#BB162B', color: '#fff' }}>🔴 URGENTE</span>
                </div>
              )}
            </div>
          </div>

          <div style={{ ...s.gridMain, gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
            <div>
              <div style={{ ...s.field, marginBottom: 16 }}>
                <span style={s.fieldLabel}>Monto</span>
                <span style={{ ...s.fieldMono, fontSize: 28 }}>{fmt(comp.monto_usd)}</span>
              </div>
              <div style={{ ...s.field, marginBottom: 12 }}>
                <span style={s.fieldLabel}>Concepto</span>
                <span style={s.fieldValue}>{comp.concepto}</span>
              </div>

              {/* Egreso-specific fields */}
              {isEgreso && comp.egreso_tipo && (
                <div style={{ ...s.field, marginBottom: 12 }}>
                  <span style={s.fieldLabel}>Tipo de egreso</span>
                  <span style={s.fieldValue}>
                    {egresoTipoLabel[comp.egreso_tipo] || comp.egreso_tipo}
                    {comp.egreso_tipo === 'BANCARIZACION' && (() => {
                      // USDT-sourced bancarizaciones surface as a distinct label
                      // (digital transfer); cash ones show via/directa as before.
                      if (origenCodigo === 'USDT_WALLET') return ' · en USDT'
                      const ruta = effectiveRuta(comp, origenCodigo)
                      return ruta === 'directa' ? ' · entrega directa' : ' · vía Mirla'
                    })()}
                    {comp.egreso_tipo === 'PAGO_FIJO' && comp.pago_fijo_concepto && ` · ${comp.pago_fijo_concepto}`}
                  </span>
                </div>
              )}
              {isEgreso && comp.egreso_dirigido_a && (
                <div style={{ ...s.field, marginBottom: 12 }}>
                  <span style={s.fieldLabel}>Dirigido a</span>
                  <span style={s.fieldValue}>{comp.egreso_dirigido_a}</span>
                </div>
              )}
              {isEgreso && comp.bancarizador_nombre && (
                <div style={{ ...s.field, marginBottom: 12 }}>
                  <span style={s.fieldLabel}>Recibido por (bancarizador)</span>
                  <span style={s.fieldValue}>{comp.bancarizador_nombre}</span>
                </div>
              )}

              {comp.source_label && (
                <div style={{ ...s.field, marginBottom: 12 }}>
                  <span style={s.fieldLabel}>Referencia</span>
                  <span style={s.fieldValue}>{comp.source_label}</span>
                </div>
              )}
              {comp.contraparte_nombre && (
                <div style={{ ...s.field, marginBottom: 12 }}>
                  <span style={s.fieldLabel}>Cliente / Contraparte</span>
                  <span style={s.fieldValue}>{comp.contraparte_nombre}</span>
                </div>
              )}

              <div style={{ ...s.grid3, gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)' }}>
                {origenName && (
                  <div style={s.field}>
                    <span style={s.fieldLabel}>Desde</span>
                    <span style={{ ...s.fieldValue, fontSize: 12 }}>{origenName}</span>
                  </div>
                )}
                {destinoName && (
                  <div style={s.field}>
                    <span style={s.fieldLabel}>Hacia</span>
                    <span style={{ ...s.fieldValue, fontSize: 12 }}>{destinoName}</span>
                  </div>
                )}
                <div style={s.field}>
                  <span style={s.fieldLabel}>Fecha</span>
                  <span style={{ ...s.fieldValue, fontSize: 12 }}>{fmtDateTime(comp.solicitado_at)}</span>
                </div>
              </div>
            </div>

            <div style={s.qrBox}>
              <TesoreriaQR payload={comp.qr_payload} size={180} />
              <div style={s.qrCaption}>Escanear con app de Tesorería</div>
            </div>
          </div>

          {/* AI review result (egreso) */}
          {isEgreso && comp.egreso_ai_review && (
            <div style={s.aiBox(!!comp.egreso_ai_review.match)} className="print-hide">
              <b>{comp.egreso_ai_review.match ? '✓ Documento verificado por IA' : '⚠ Revisión IA'}</b><br />
              {comp.egreso_ai_review.match
                ? `Monto leído: ${fmt(comp.egreso_ai_review.monto_leido)}`
                : (comp.egreso_ai_review.motivo || 'El documento no pudo verificarse.')}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginTop: 16 }} className="print-hide">
            <div style={s.signLine}>Entregado por</div>
            <div style={s.signLine}>Recibido por</div>
          </div>

          {comp.notas && (
            <div style={{ marginTop: 16, padding: 10, background: '#f7f7f7', borderRadius: 6, fontSize: 11, color: '#444' }}>
              <strong>Notas:</strong> {comp.notas}
            </div>
          )}
        </div>

        {/* Actions (not printed) */}
        <div style={s.btnRow} className="no-print">
          {canConfirmPickup && (
            <button style={s.btnRed} onClick={handleConfirmPickup} disabled={action}>
              {action ? 'Procesando…' : '✓ Confirmar Recogida'}
            </button>
          )}
          {egresoActionBtn && (
            <button style={s.btnGreen} onClick={() => {
              // 2026-06-12 — deposits are registered ONLY on the detail page:
              // it has the partial-deposit modal (cuenta selector, monto,
              // manual mode, ledger). The inline modal here was a stale copy.
              if (egresoActionBtn.modal === 'depositar') {
                window.location.href = '/tesoreria/comprobante?id=' + comp.id
                return
              }
              setModal(egresoActionBtn.modal)
            }} disabled={action}>
              {egresoActionBtn.label}
            </button>
          )}
          {canAnular && (
            <button
              style={{ ...s.btnSec, color: '#BB162B', borderColor: '#BB162B' }}
              onClick={handleAnular} disabled={action}
              title="Anular comprobante"
            >
              {action ? 'Procesando…' : '✕ Anular'}
            </button>
          )}
          {canRevertir && (
            <button
              style={{ ...s.btnSec, color: '#BB162B', borderColor: '#BB162B', background: 'rgba(187,22,43,0.06)' }}
              onClick={() => { setRevertirMotivo(''); setRevertirConfirm(''); setErr(null); setModal('revertir') }}
              disabled={action}
              title="Revertir comprobante ejecutado — devuelve el dinero al origen"
            >
              ↩ Revertir
            </button>
          )}
          <button style={s.btnSec} onClick={handlePrint}>🖨 Imprimir</button>
          <button style={s.btnSec} onClick={() => load()}>↻ Refrescar</button>
        </div>

        {/* Timeline (not printed) */}
        <div style={{ ...s.card, marginTop: 24 }} className="no-print">
          <h2 style={s.sectionTitle}>Línea de tiempo</h2>
          {eventos.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Sin eventos registrados.</div>
          ) : (
            eventos.map(e => (
              <div key={e.id} style={s.evt}>
                <div style={s.evtDot} />
                <div style={{ flex: 1 }}>
                  <div style={s.evtTitle}>{e.evento.replace(/_/g, ' ')}</div>
                  <div style={s.evtMeta}>
                    {fmtDateTime(e.created_at)}{e.actor_label && ` · ${e.actor_label}`}
                  </div>
                  {e.notas && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, fontStyle: 'italic' }}>
                      {e.notas}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Egreso modals ── */}
      {modal === 'recibi' && comp && (
        <div style={s.modalBg} onClick={() => !action && setModal(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>Confirmar recepción del efectivo</div>
            <div style={s.modalText}>
              ¿Confirmas que recibiste <b>{fmt(comp.monto_usd)}</b> en efectivo
              para la bancarización dirigida a <b>{comp.egreso_dirigido_a || '—'}</b>?
            </div>
            <div style={s.btnRow}>
              <button style={s.btnGreen} onClick={egresoReciboMirla} disabled={action}>
                {action ? 'Procesando…' : 'Sí, recibí el efectivo'}
              </button>
              <button style={s.btnSec} onClick={() => setModal(null)} disabled={action}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {modal === 'entregar' && comp && (
        <div style={s.modalBg} onClick={() => !action && setModal(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>Entregar al bancarizador</div>
            <div style={s.modalText}>
              Registra a quién se le entrega el efectivo de <b>{fmt(comp.monto_usd)}</b> para depositar en el banco.
            </div>
            <label style={s.label}>Nombre de quien recibe</label>
            <input
              style={s.input} type="text" value={bancarizadorInput}
              onChange={e => setBancarizadorInput(e.target.value)}
              placeholder={comp.egreso_dirigido_a || 'Ej: Enzo Carbonara'}
            />
            <div style={s.btnRow}>
              <button style={s.btnGreen} onClick={egresoEntregarBancarizador} disabled={action}>
                {action ? 'Procesando…' : 'Confirmar entrega'}
              </button>
              <button style={s.btnSec} onClick={() => setModal(null)} disabled={action}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {modal === 'depositar' && comp && (
        <div style={s.modalBg} onClick={() => !aiBusy && setModal(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>Registrar el depósito bancario</div>
            <div style={s.modalText}>
              Sube la constancia del depósito de <b>{fmt(comp.monto_usd)}</b>.
              La IA leerá el documento y se registrará en el módulo de Banco.
            </div>
            <input
              ref={fileRef} type="file" accept="image/*,application/pdf"
              style={{ ...s.input, padding: 8 }}
              onChange={e => { const f = e.target.files?.[0]; if (f) egresoDepositar(f) }}
              disabled={aiBusy}
            />
            {aiBusy && <div style={{ ...s.modalText, marginTop: 12, marginBottom: 0 }}>Subiendo y leyendo el documento…</div>}
            <div style={s.btnRow}>
              <button style={s.btnSec} onClick={() => setModal(null)} disabled={aiBusy}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {modal === 'ejecutar' && comp && (
        <div style={s.modalBg} onClick={() => !aiBusy && setModal(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>
              {comp.egreso_tipo === 'VENDOR_PAGO' ? 'Ejecutar pago a proveedor' : 'Ejecutar reposición de caja chica'}
            </div>
            <div style={s.modalText}>
              {comp.egreso_tipo === 'VENDOR_PAGO'
                ? <>Sube la factura del proveedor por <b>{fmt(comp.monto_usd)}</b>. La IA la revisará contra el egreso. Si no coincide o falta, se notifica a Mirla.</>
                : <>¿Confirmas la transferencia interna de <b>{fmt(comp.monto_usd)}</b> de Caja Principal a Caja Chica?</>}
            </div>
            {comp.egreso_tipo === 'VENDOR_PAGO' && (
              <input
                ref={fileRef} type="file" accept="image/*,application/pdf"
                style={{ ...s.input, padding: 8, marginBottom: 12 }}
                disabled={aiBusy}
              />
            )}
            {aiBusy && <div style={{ ...s.modalText, marginBottom: 0 }}>Procesando…</div>}
            <div style={s.btnRow}>
              <button
                style={s.btnGreen}
                onClick={() => egresoEjecutar(comp.egreso_tipo === 'VENDOR_PAGO' ? (fileRef.current?.files?.[0] || null) : null)}
                disabled={aiBusy}
              >
                {aiBusy ? 'Procesando…' : 'Ejecutar'}
              </button>
              <button style={s.btnSec} onClick={() => setModal(null)} disabled={aiBusy}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {modal === 'revertir' && comp && (
        <div style={s.modalBg} onClick={() => !action && setModal(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={{ ...s.modalTitle, color: '#BB162B' }}>↩ Revertir comprobante</div>
            <div style={s.modalText}>
              Vas a revertir <b>{comp.numero}</b> por <b>{fmt(comp.monto_usd)}</b>.<br />
              El dinero regresa al origen y la transacción bancaria queda marcada como revertida.
              Esta acción queda en el historial — no se elimina nada.
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ ...s.fieldLabel, color: 'var(--text-primary)', display: 'block', marginBottom: 6 }}>
                Motivo (obligatorio, mín. 10 caracteres)
              </label>
              <textarea
                value={revertirMotivo}
                onChange={e => setRevertirMotivo(e.target.value)}
                rows={3}
                placeholder="Ej: Cliente devolvió el dinero porque el depósito se hizo en cuenta equivocada"
                style={{
                  width: '100%', padding: 10, borderRadius: 8,
                  border: '1px solid var(--border)', background: 'var(--bg-deep)',
                  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit',
                  resize: 'vertical', boxSizing: 'border-box',
                }}
                disabled={action}
              />
              <div style={{ fontSize: 11, color: revertirMotivo.trim().length < 10 ? '#BB162B' : 'var(--text-secondary)', marginTop: 4 }}>
                {revertirMotivo.trim().length} / 10 mínimo
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ ...s.fieldLabel, color: 'var(--text-primary)', display: 'block', marginBottom: 6 }}>
                Escribe <b>REVERTIR</b> para confirmar
              </label>
              <input
                value={revertirConfirm}
                onChange={e => setRevertirConfirm(e.target.value)}
                placeholder="REVERTIR"
                style={{
                  width: '100%', padding: 10, borderRadius: 8,
                  border: '1px solid var(--border)', background: 'var(--bg-deep)',
                  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'monospace',
                  letterSpacing: 2, boxSizing: 'border-box',
                }}
                disabled={action}
              />
            </div>
            {err && <div style={s.err}>{err}</div>}
            <div style={s.btnRow}>
              <button
                style={{
                  ...s.btnRed,
                  opacity: revertirMotivo.trim().length >= 10 && revertirConfirm.trim().toUpperCase() === 'REVERTIR' ? 1 : 0.4,
                  cursor: revertirMotivo.trim().length >= 10 && revertirConfirm.trim().toUpperCase() === 'REVERTIR' ? 'pointer' : 'not-allowed',
                }}
                onClick={handleRevertir}
                disabled={action || revertirMotivo.trim().length < 10 || revertirConfirm.trim().toUpperCase() !== 'REVERTIR'}
              >
                {action ? 'Revirtiendo…' : '↩ Revertir definitivamente'}
              </button>
              <button style={s.btnSec} onClick={() => setModal(null)} disabled={action}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        @media print {
          /* Nuclear approach: hide everything, then show only print-area + its descendants */
          html, body {
            background: #fff !important;
            margin: 0 !important;
            padding: 0 !important;
            color: #000 !important;
          }
          body * { visibility: hidden !important; }
          #print-area, #print-area * { visibility: visible !important; }

          /* Lift print-area out of all wrapper padding/margins */
          #print-area {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 10px 14px !important;
            background: #fff !important;
            border: none !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            font-size: 9pt !important;
            color: #000 !important;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
          }
          /* Kill backgrounds/borders/shadows on EVERY descendant */
          #print-area * {
            background: transparent !important;
            background-color: transparent !important;
            box-shadow: none !important;
            border-color: transparent !important;
          }
          /* Keep badge outline visible */
          #print-area .badge,
          #print-area [class*="badge"] {
            border: 1px solid #999 !important;
          }
          /* FORCE two-column layout on print (override mobile single-column) */
          #print-area > div[style*="grid-template-columns"],
          #print-area > div > div[style*="grid-template-columns"] {
            grid-template-columns: 1.4fr 1fr !important;
          }
          /* Tighten ALL margins/padding on descendants — kill inline marginBottom */
          #print-area div { margin-bottom: 4px !important; }
          #print-area span { line-height: 1.25 !important; }
          /* Shrink the big "Monto" font on print */
          #print-area [style*="font-size: 28"] { font-size: 18pt !important; }
          /* QR much smaller on print */
          #print-area svg { max-width: 110px !important; height: auto !important; }
          /* Hide signature lines + AI box on print */
          #print-area .print-hide { display: none !important; }
          /* Narrow page margins */
          @page { size: letter; margin: 0.25in; }
        }
      `}</style>
    </AdminShell>
  )
}

// Which egreso transition is available for the current state + user perms.
// `origenCodigo` is the codigo of the source ubicación — needed because USDT
// bancarizaciones (origenCodigo === 'USDT_WALLET') must always be treated as
// directa, even if the stored bancarizacion_ruta says otherwise.
function egresoNextAction(
  comp: Comprobante,
  permissions: any,
  origenCodigo?: string | null,
): { label: string; modal: 'recibi' | 'entregar' | 'depositar' | 'ejecutar' } | null {
  const canAct = permissions.tesoreria_can_pickup || permissions.tesoreria_admin || permissions.npa_can_admin
  if (!canAct) return null

  if (comp.egreso_tipo === 'BANCARIZACION') {
    const ruta = effectiveRuta(comp, origenCodigo)
    const isUSDT = origenCodigo === 'USDT_WALLET'
    if (comp.estado === 'SOLICITADO') {
      // directa & USDT both jump straight to "transferir/entregar al bancarizador".
      // via_mirla shows the cash-recibí step for Mirla first.
      return ruta === 'directa'
        ? { label: isUSDT ? '→ Transferir USDT al bancarizador' : '→ Entregar al bancarizador', modal: 'entregar' }
        : { label: '✓ Recibí el efectivo', modal: 'recibi' }
    }
    if (comp.estado === 'EN_PODER_MIRLA')         return { label: '→ Entregar al bancarizador', modal: 'entregar' }
    if (comp.estado === 'ENTREGADO_BANCARIZADOR' || comp.estado === 'DEPOSITADO_PARCIAL') return { label: '→ Registrar depósito', modal: 'depositar' }
    return null
  }
  if (comp.egreso_tipo === 'CAJA_CHICA_REPO' || comp.egreso_tipo === 'VENDOR_PAGO') {
    if (comp.estado === 'SOLICITADO') return { label: '✓ Ejecutar egreso', modal: 'ejecutar' }
    return null
  }
  return null
}

// For flow 2b — which modal to auto-open when the user arrives via QR scan.
function nextEgresoModal(
  comp: Comprobante,
  permissions: any,
  origenCodigo?: string | null,
): 'recibi' | 'entregar' | 'depositar' | 'ejecutar' | null {
  const a = egresoNextAction(comp, permissions, origenCodigo)
  return a ? a.modal : null
}

// ─── File → base64 (strips the data: prefix) ──────────────────────────────
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const res = String(r.result || '')
      const comma = res.indexOf(',')
      resolve(comma >= 0 ? res.slice(comma + 1) : res)
    }
    r.onerror = () => reject(new Error('No se pudo leer el archivo'))
    r.readAsDataURL(file)
  })
}

export default function ComprobantePage() {
  return (
    <Suspense fallback={
      <AdminShell active="tesoreria">
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-secondary)' }}>Cargando…</div>
      </AdminShell>
    }>
      <ComprobanteInner />
    </Suspense>
  )
}