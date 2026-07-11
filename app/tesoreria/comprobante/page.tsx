// TARGET: autocore-npa/app/tesoreria/comprobante/page.tsx
// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/comprobante/page.tsx
// AutoCore NPA — Comprobante detail
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
import { registrarPrestamoCorto, prestamistaResponsable } from '../../lib/prestamos'
import PrestamoNegativoModal, { PrestamoPrompt } from '../../components/PrestamoNegativoModal'

const COMPROBANTE_WORKER = 'https://autocore-comprobante.sano-franco.workers.dev'
const WHATSAPP_WORKER    = 'https://autocore-whatsapp.sano-franco.workers.dev'

// Real bank accounts for the deposit modal — mandatory selection so every
// bancarización deposit lands pre-classified and reconciles in /banco.
// Codes must match bank_transactions.cuenta values.
// code  → bank_transactions.cuenta (what /banco groups by)
// fkId  → bank_transactions.cuenta_id (FK → cuentas_bancarias.id)
const BANK_ACCOUNTS: { code: string; fkId: string; label: string }[] = [
  { code: 'motocentro',      fkId: 'BOFA_MOTOII',     label: 'BofA Motocentro II (0481)' },
  { code: 'roframi',         fkId: 'BOFA_ROFRAMI',    label: 'BofA Roframi (7252)' },
  { code: 'roframi_regions', fkId: 'REGIONS_ROFRAMI', label: 'Regions Roframi' },
  { code: 'panama',          fkId: 'MERCANTIL_PA',    label: 'Mercantil Panamá' },
]
const cuentaFkId = (code: string): string =>
  BANK_ACCOUNTS.find(a => a.code === code)?.fkId || 'UNKNOWN'

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
  source_id: string | null
  source_label: string | null
  // Revisión (cola de /tesoreria/confirmar) — usado por DEVOLUCION_CLIENTE:
  // el paso "Aprobado" vive en revision_estado, no en estado.
  revision_estado?: string | null
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
  monto_depositado: number | null   // cumulative bancarización deposits (partials)
  egreso_documento_url: string | null
  egreso_ai_review: any | null
  // Reversal fields (REVERTIDO state for executed comprobantes)
  reversed_at: string | null
  reversed_by: string | null
  reversal_motivo: string | null
  fx_monto_recibido_usd?: number | null
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
  if (comp.egreso_tipo === 'CAMBIO_USDT') {
    const usdtToCash = origenCodigo === 'USDT_WALLET'
    return [
      { key: 'SOLICITADO', label: usdtToCash ? 'Cambio USDT → Efectivo' : 'Cambio Efectivo → USDT', icon: '⇄', evento: 'SOLICITADO', place: usdtToCash ? 'USDT Wallet' : 'Caja' },
      { key: 'EJECUTADO',  label: 'Cambio ejecutado', icon: '✅', evento: 'EJECUTADO', place: usdtToCash ? 'Caja' : 'USDT Wallet' },
    ]
  }
  if (comp.egreso_tipo === 'CAMBIO_BS') {
    // Cash sold for bolívares: Viviana hands USD to the cambista, the Bs
    // arrive later at the Venezuelan bank. Reuses the bancarización estados
    // (already in the tesoreria_comprobantes CHECK) — no DDL needed.
    return [
      { key: 'SOLICITADO',             label: 'Solicitado',         icon: '📋', evento: 'SOLICITADO',             place: 'Caja' },
      { key: 'ENTREGADO_BANCARIZADOR', label: 'Efectivo entregado', icon: '🤝', evento: 'ENTREGADO_BANCARIZADOR', place: 'Cambista' },
      { key: 'DEPOSITADO',             label: 'Bs recibidos',       icon: '🏦', evento: 'DEPOSITADO',             place: (comp as any).banco_bs_nombre || 'Banco Bs' },
    ]
  }
  if (comp.egreso_tipo === 'DEVOLUCION_CLIENTE') {
    // Devolución al cliente (deal con SOBRANTE): Auditoría solicita, Mirla
    // aprueba en /tesoreria/confirmar (el estado sigue SOLICITADO — la
    // aprobación vive en revision_estado) y Caja Chica paga en efectivo.
    // El paso APROBADO es virtual: se marca cumplido vía timelineEstado
    // cuando revision_estado = 'aprobado'.
    return [
      { key: 'SOLICITADO', label: 'Solicitado',        icon: '📋', evento: 'CREADO',    place: 'Auditoría' },
      { key: 'APROBADO',   label: 'Aprobado',          icon: '🧾', evento: 'APROBADO',  place: 'Tesorería' },
      { key: 'EJECUTADO',  label: 'Pagado al cliente', icon: '💵', evento: 'EJECUTADO', place: 'Caja Chica' },
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

  // Manager-only true-delete: signed-in email + who registered the comprobante.
  // useAuthGate doesn't expose email, so we fetch it directly (same pattern as
  // /settings). creatorEmail resolves solicitado_by → user_roles for the
  // "Registrado por" header field.
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [creatorEmail, setCreatorEmail] = useState<string | null>(null)

  // Egreso modal state
  const [modal, setModal] = useState<null | 'recibi' | 'entregar' | 'depositar' | 'ejecutar' | 'revertir' | 'cambiar'>(null)
  // CAMBIO_USDT: monto realmente recibido ('' = igual al entregado)
  const [fxRecibidoStr, setFxRecibidoStr] = useState('')
  // CAMBIO_BS: bolívares realmente recibidos al cierre
  const [bsRecibidoStr, setBsRecibidoStr] = useState('')
  // "¿A quién le debemos?" — captura de préstamo cuando una bancarización deja la caja en negativo.
  const [prestModal, setPrestModal] = useState<{ prompt: PrestamoPrompt; resume: (p: string, m: number) => void } | null>(null)
  const [bancarizadorInput, setBancarizadorInput] = useState('')
  const [revertirMotivo, setRevertirMotivo] = useState('')
  const [revertirConfirm, setRevertirConfirm] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  // 2026-05-21 — depósito modal supports either uploading a file (AI reads it)
  // or entering the reference + date manually. depositoMode tracks which.
  const [depositoMode, setDepositoMode] = useState<'file' | 'manual'>('file')
  const [depositoRef, setDepositoRef] = useState('')
  const [depositoFecha, setDepositoFecha] = useState(() => new Date().toISOString().slice(0, 10))
  const [depositoCuenta, setDepositoCuenta] = useState('')
  const [depositoNotas, setDepositoNotas] = useState('')
  // 2026-06-12 — partial deposits: bancarizadores often split one handoff
  // ($20k) into several deposits ($14k + $6k). Each deposit is a child row in
  // tesoreria_comprobante_depositos; the comprobante accumulates
  // monto_depositado and only closes (DEPOSITADO) when it nets to zero.
  const [depositos, setDepositos] = useState<any[]>([])
  const [depositoMonto, setDepositoMonto] = useState('')
  const [cerrarAbsorbe, setCerrarAbsorbe] = useState(false)
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

  // Resolve the signed-in user's email once (for the manager-only delete gate).
  useEffect(() => {
    let active = true
    supabase.auth.getUser().then(({ data }) => {
      if (active) setUserEmail(data?.user?.email || null)
    })
    return () => { active = false }
  }, [])

  async function load() {
    setLoading(true)
    setErr(null)
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

    // Partial deposits ledger (bancarización only; harmless empty otherwise).
    // Wrapped as any per the Supabase JS Unicode-chain rule; array-guarded.
    if (c.tipo === 'EGRESO' && c.egreso_tipo === 'BANCARIZACION') {
      const { data: deps } = await (supabase
        .from('tesoreria_comprobante_depositos')
        .select('id, monto_usd, fecha, referencia, cuenta, documento_url, bank_transaction_id, created_at')
        .eq('comprobante_id', c.id)
        .order('created_at', { ascending: true }) as any)
      setDepositos(Array.isArray(deps) ? deps : [])
    } else {
      setDepositos([])
    }

    // Who registered it: solicitado_by → user_roles. Non-blocking; fills the
    // "Registrado por" header field when it resolves.
    if (c.solicitado_by) {
      supabase.from('user_roles').select('full_name, email').eq('user_id', c.solicitado_by).single()
        .then(({ data }) => setCreatorEmail((data as any)?.email || (data as any)?.full_name || null))
    } else {
      setCreatorEmail(null)
    }
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
      const next = nextEgresoModal(c, permissions, ocod, c.solicitado_by === userId)
      if (next) setModal(next)
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // INGRESO actions
  // ════════════════════════════════════════════════════════════════════════
  // 2026-05-25 v3 — Pickup MOVES cash from PC_MIRLA → CAJA_PPAL immediately.
  //
  // Workflow: Viviana arrives, scans Angeles/Deisi's QR. At that moment cash
  // physically transfers from Mirla's drawer to Tesorería's safe. Two
  // movimientos are written atomically:
  //   −PC_MIRLA  monto
  //   +CAJA_PPAL monto
  // Both stamped with comprobante_id for idempotency + audit.
  //
  // USDT ingresos are NOT moved here — they live in USDT_WALLET and the
  // pickup is purely state-only for them (handled by the early-return below).
  //
  // Idempotency: if a PICKUP_TRANSFER movimiento already exists for this
  // comprobante, we skip the insert and just sync state. Lets a double-scan
  // (or a batch handoff after an individual scan) be a no-op.
  // ════════════════════════════════════════════════════════════════════════
  async function handleConfirmPickup() {
    if (!comp || !userId) return
    if (!confirm(`¿Confirmar recogida de ${fmt(comp.monto_usd)}? El dinero pasa de Punto de Cobro a Caja Principal.`)) return
    setAction(true); setErr(null)
    try {
      // Determine source ubicacion. The ingreso form stores the location
      // where cash *landed* in ubicacion_destino_id (PC_MIRLA for cash,
      // USDT_WALLET for USDT). ubicacion_origen_id is left NULL on ingresos.
      // USDT skips the cash transfer entirely.
      const origenCod = comp.ubicacion_destino_id
        ? ubicaciones[comp.ubicacion_destino_id]?.codigo
        : null
      const isUSDT = origenCod === 'USDT_WALLET'

      // Atomic state flip first (only PENDIENTE_PICKUP can transition)
      const { error: upErr } = await supabase
        .from('tesoreria_comprobantes')
        .update({
          estado: 'PICKUP_CONFIRMADO',
          confirmado_by: userId,
          confirmado_at: new Date().toISOString(),
        })
        .eq('id', comp.id)
        .eq('estado', 'PENDIENTE_PICKUP')   // atomic guard
      if (upErr) throw upErr

      // For cash ingresos: move PC_MIRLA → CAJA_PPAL (idempotent).
      if (!isUSDT && comp.ubicacion_destino_id) {
        // Idempotency check — has a transfer pair already been written?
        const { data: existing, error: exErr } = await supabase
          .from('tesoreria_movimientos')
          .select('id')
          .eq('comprobante_id', comp.id)
          .eq('tipo', 'PICKUP_TRANSFER')
          .limit(1)
        if (exErr) throw exErr

        if (!existing || existing.length === 0) {
          // Resolve CAJA_PPAL id from the loaded ubicaciones map.
          const cajaPpal = Object.values(ubicaciones).find(u => u.codigo === 'CAJA_PPAL')
          if (!cajaPpal) {
            throw new Error('CAJA_PPAL no encontrada en ubicaciones. Verifica configuración de Tesorería.')
          }

          // PRE-recompute saldos so the negative-saldo guard sees current truth.
          // The AFTER INSERT trigger on tesoreria_movimientos sometimes misses
          // under the Supabase REST/pooler path, leaving saldo_actual_usd stale.
          // If we don't resync first, the guard may falsely reject this transfer
          // (e.g. saldo card shows $0 but real saldo is $3000).
          try { await supabase.rpc('tesoreria_recompute_saldos') }
          catch (e) { console.warn('[pickup] pre-insert recompute warning', e) }

          const { error: movErr } = await supabase
            .from('tesoreria_movimientos')
            .insert([
              {
                ubicacion_id: comp.ubicacion_destino_id,  // cash leaving PC_MIRLA
                tipo: 'PICKUP_TRANSFER',
                monto_usd: comp.monto_usd,
                signo: -1,
                source_type: 'INGRESO',
                source_label: 'Recogida · ' + comp.numero,
                descripcion: 'Recogida por Tesorería · ' + comp.numero,
                categoria: 'PICKUP',
                comprobante_id: comp.id,
                registered_by: userId,
              },
              {
                ubicacion_id: cajaPpal.id,
                tipo: 'PICKUP_TRANSFER',
                monto_usd: comp.monto_usd,
                signo: 1,
                source_type: 'INGRESO',
                source_label: 'Recepción · ' + comp.numero,
                descripcion: 'Recepción desde Punto de Cobro · ' + comp.numero,
                categoria: 'PICKUP',
                comprobante_id: comp.id,
                registered_by: userId,
              },
            ])
          if (movErr) throw new Error('Error escribiendo movimientos del pickup: ' + movErr.message)

          // Defensive recompute in case the AFTER INSERT trigger missed.
          try { await supabase.rpc('tesoreria_recompute_saldos') }
          catch (e) { console.warn('[pickup] post-insert recompute warning', e) }
        }
      }

      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: comp.id,
        evento: 'PICKUP_CONFIRMADO',
        actor_user_id: userId,
        actor_label: 'Tesorera',
        notas: isUSDT
          ? `Pickup USDT · ${fmt(comp.monto_usd)}`
          : `Recogida de ${fmt(comp.monto_usd)} · PC_MIRLA → CAJA_PPAL`,
      })

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
      //   EGRESO SOLICITADO        → 0 movs → nothing to reverse
      //   EGRESO EN_PODER_MIRLA    → 1 mov on origen → reverse it (2026-05-21:
      //     the cash debit now fires at EN_PODER_MIRLA for via_mirla; money
      //     returns to source caja on anulación)
      //   EGRESO ENTREGADO_BANCARIZADOR (directa/USDT) → 1 mov → reverse
      //   EGRESO ENTREGADO_BANCARIZADOR (via_mirla)    → 1 mov already from
      //     EN_PODER_MIRLA; reversal returns money to source caja
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

  // ════════════════════════════════════════════════════════════════════════
  // True-delete (manager only). The receipt should never have existed.
  //
  // Visible ONLY when isManagerEmail && comp.estado === 'ANULADO' — Anular is
  // forced first as the audit step. Delegates to the admin_delete_comprobante
  // RPC, which snapshots into admin_delete_log, cascades the delete, and
  // recomputes saldos in one transaction. Authorization is re-checked
  // server-side via auth.jwt() — the UI gate is just the first line.
  // ════════════════════════════════════════════════════════════════════════
  async function handleEliminar() {
    if (!comp || !userId) return
    if (comp.estado !== 'ANULADO') {
      alert('Solo se pueden eliminar comprobantes ANULADOS. Anula primero.')
      return
    }
    if (userEmail !== 'manager@motocentro2.com') {
      alert('Solo la cuenta de gerencia puede eliminar comprobantes.')
      return
    }
    const motivo = prompt(
      'ELIMINAR PERMANENTEMENTE ' + comp.numero + '\n\n' +
      'Esto borra el comprobante, su historial, los movimientos de caja, las\n' +
      'transacciones bancarias y los movimientos de bancarizador asociados.\n' +
      'Se guarda una copia en auditoría (admin_delete_log) antes de borrar.\n\n' +
      'Esta acción NO se puede deshacer. Indica el motivo (obligatorio):'
    )
    if (!motivo || !motivo.trim()) return
    const confirmText = prompt('Escribe ELIMINAR para confirmar el borrado permanente de ' + comp.numero)
    if (!confirmText || confirmText.trim().toUpperCase() !== 'ELIMINAR') {
      alert('Cancelado — no escribiste ELIMINAR.')
      return
    }
    setAction(true); setErr(null)
    try {
      const { error } = await supabase.rpc('admin_delete_comprobante', {
        p_id: comp.id,
        p_actor: userId,
        p_actor_email: userEmail,
        p_motivo: motivo.trim(),
      })
      if (error) throw error
      alert('Comprobante ' + comp.numero + ' eliminado permanentemente. Copia guardada en auditoría.')
      router.push('/tesoreria')
    } catch (e: any) {
      setErr(e.message || 'Error al eliminar el comprobante')
      setAction(false)
    }
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
    if (comp.estado !== 'DEPOSITADO' && comp.estado !== 'EJECUTADO' && comp.estado !== 'DEPOSITADO_PARCIAL') {
      alert('Sólo se pueden revertir comprobantes ya ejecutados (DEPOSITADO / DEPOSITADO_PARCIAL / EJECUTADO).')
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

      // 3. Flag EVERY linked bank_transactions row as reversed (partials may
      //    have several; the legacy single link is covered as fallback). Rows
      //    are kept so /banco preserves the audit trail.
      const revTxIds = new Set<string>()
      const { data: depRows } = await (supabase
        .from('tesoreria_comprobante_depositos')
        .select('bank_transaction_id')
        .eq('comprobante_id', comp.id) as any)
      for (const d of (Array.isArray(depRows) ? depRows : [])) {
        if (d.bank_transaction_id) revTxIds.add(d.bank_transaction_id)
      }
      if (comp.bank_transaction_id) revTxIds.add(comp.bank_transaction_id)
      for (const txId of revTxIds) {
        await supabase
          .from('bank_transactions')
          .update({
            reversed_at: new Date().toISOString(),
            reversed_by_comprobante_id: comp.id,
          })
          .eq('id', txId)
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
  // received the cash from the source caja.
  //
  // 2026-05-21: the cash debit happens HERE now, not at ENTREGADO_BANCARIZADOR.
  // The reason: once Viviana hands cash to Mirla, the money is physically
  // out of Caja Principal. The dashboard's "Caja Principal" saldo should
  // reflect that. Mirla's hold time before going to the bancarizador is
  // surfaced in the lifecycle widget via comp.estado='EN_PODER_MIRLA', not
  // via a saldo bucket.
  async function egresoReciboMirla(loan?: { prestamista: string; monto: number }) {
    if (!comp || !userId) return

    // Pre-check origen saldo. DB trigger would block; this gives clean UX.
    if (comp.ubicacion_origen_id) {
      const origen = ubicaciones[comp.ubicacion_origen_id]
      if (origen) {
        const { data: ubicRow } = await supabase
          .from('tesoreria_ubicaciones')
          .select('saldo_actual_usd')
          .eq('id', comp.ubicacion_origen_id)
          .single()
        const saldo = Number(ubicRow?.saldo_actual_usd || 0)
        if (Number(comp.monto_usd) > saldo && !loan) {
          setPrestModal({
            prompt: { cajaNombre: origen.nombre, who: prestamistaResponsable(origen.codigo), montoEgreso: Number(comp.monto_usd), saldoDisponible: saldo },
            resume: (p, m) => { setPrestModal(null); egresoReciboMirla({ prestamista: p, monto: m }) },
          })
          return
        }
      }
    }

    setAction(true); setErr(null)
    try {
      const { error } = await supabase
        .from('tesoreria_comprobantes')
        .update({ estado: 'EN_PODER_MIRLA' })
        .eq('id', comp.id).eq('estado', 'SOLICITADO')
      if (error) throw error

      // ★ Cash debit fires HERE for via_mirla bancarizaciones. The money
      // physically left the source caja the moment Mirla received it.
      if (comp.ubicacion_origen_id) {
        if (loan) {
          const { error: pErr } = await registrarPrestamoCorto({
            ubicacionId: comp.ubicacion_origen_id, prestamista: loan.prestamista, monto: loan.monto,
            comprobanteId: comp.id, userId,
          })
          if (pErr) throw new Error('Error registrando préstamo: ' + pErr)
        }
        const { error: movErr } = await supabase.from('tesoreria_movimientos').insert({
          ubicacion_id: comp.ubicacion_origen_id,
          tipo: 'EGRESO_BANCARIZACION',
          monto_usd: comp.monto_usd,
          signo: -1,
          permite_negativo: !!loan,
          source_type: 'EGRESO',
          source_label: comp.source_label || comp.concepto,
          comprobante_id: comp.id,
          descripcion: `Bancarización · entregada a Mirla · ${comp.numero}`,
          categoria: 'BANCARIZACION',
          registered_by: userId,
        })
        if (movErr) throw new Error('Error registrando movimiento de egreso: ' + movErr.message)
      }

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
  async function egresoEntregarBancarizador(loan?: { prestamista: string; monto: number }) {
    if (!comp || !userId) return
    if (!bancarizadorInput.trim()) { setErr('Indica el nombre de quien recibe el efectivo'); return }
    // USDT bancarizaciones and 'directa' route both jump straight from
    // SOLICITADO; via_mirla goes through EN_PODER_MIRLA first.
    const origenCod = comp.ubicacion_origen_id ? ubicaciones[comp.ubicacion_origen_id]?.codigo : null
    // CAMBIO_BS behaves like the 'directa' route: Viviana hands the cash
    // straight to the cambista from SOLICITADO, debiting the caja here.
    const ruta = comp.egreso_tipo === 'CAMBIO_BS' ? 'directa' : effectiveRuta(comp, origenCod)
    const fromEstado = ruta === 'directa' ? 'SOLICITADO' : 'EN_PODER_MIRLA'

    // Hard block: cash debit would push origen below zero. Only applies to
    // 'directa'/USDT routes (via_mirla already debited at EN_PODER_MIRLA).
    if (ruta === 'directa' && comp.ubicacion_origen_id) {
      const origen = ubicaciones[comp.ubicacion_origen_id]
      if (origen) {
        const { data: ubicRow } = await supabase
          .from('tesoreria_ubicaciones')
          .select('saldo_actual_usd')
          .eq('id', comp.ubicacion_origen_id)
          .single()
        const saldo = Number(ubicRow?.saldo_actual_usd || 0)
        if (Number(comp.monto_usd) > saldo && !loan) {
          setPrestModal({
            prompt: { cajaNombre: origen.nombre, who: prestamistaResponsable(origen.codigo), montoEgreso: Number(comp.monto_usd), saldoDisponible: saldo },
            resume: (p, m) => { setPrestModal(null); egresoEntregarBancarizador({ prestamista: p, monto: m }) },
          })
          return
        }
      }
    }

    setAction(true); setErr(null)
    try {
      const { error } = await supabase
        .from('tesoreria_comprobantes')
        .update({ estado: 'ENTREGADO_BANCARIZADOR', bancarizador_nombre: bancarizadorInput.trim() })
        .eq('id', comp.id).eq('estado', fromEstado)
      if (error) throw error

      // 2026-05-21: cash debit fires HERE only for 'directa' and USDT routes
      // (which skip the EN_PODER_MIRLA step). For 'via_mirla', the debit
      // already happened when Mirla received the cash, so we skip it here
      // to avoid double-debiting.
      if (comp.ubicacion_origen_id && ruta === 'directa') {
        if (loan) {
          const { error: pErr } = await registrarPrestamoCorto({
            ubicacionId: comp.ubicacion_origen_id, prestamista: loan.prestamista, monto: loan.monto,
            comprobanteId: comp.id, userId,
          })
          if (pErr) throw new Error('Error registrando préstamo: ' + pErr)
        }
        const { error: movErr } = await supabase.from('tesoreria_movimientos').insert({
          ubicacion_id: comp.ubicacion_origen_id,
          tipo: comp.egreso_tipo === 'CAMBIO_BS' ? 'EGRESO_CAMBIO_BS' : 'EGRESO_BANCARIZACION',
          monto_usd: comp.monto_usd,
          signo: -1,
          permite_negativo: !!loan,
          source_type: 'EGRESO',
          source_label: comp.source_label || comp.concepto,
          comprobante_id: comp.id,
          descripcion: comp.egreso_tipo === 'CAMBIO_BS'
            ? `Efectivo entregado para cambio a Bs a ${bancarizadorInput.trim()} · ${comp.numero}`
            : `Bancarización entregada a ${bancarizadorInput.trim()} · ${comp.numero}`,
          categoria: comp.egreso_tipo === 'CAMBIO_BS' ? 'CAMBIO_BS' : 'BANCARIZACION',
          registered_by: userId,
        })
        if (movErr) throw new Error('Error registrando movimiento de egreso: ' + movErr.message)
        // Recompute saldos authoritatively — same protection as the ingreso
        // flow: the incremental balance trigger can miss under the REST/pooler
        // path, leaving the caja showing money that already left.
        try { await supabase.rpc('tesoreria_recompute_saldos') }
        catch (e) { console.warn('[egreso] recompute warning', e) }
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
        egreso_tipo: comp.egreso_tipo || 'BANCARIZACION',
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
    if (!depositoCuenta) { setErr('Selecciona la cuenta bancaria donde se hizo el depósito.'); return }
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

     // 3. Create the bank_transactions row (internal cash deposit)
      //
      // FIX 2026-05-26: cuenta is NOT NULL in DB. Use 'UNKNOWN' placeholder
      // when AI didn't identify an account (Mirla classifies later in /banco).
      // Surface insert errors instead of silently swallowing them.
      // Use AI-read monto when available — the bank received what the receipt
      // says, not necessarily what we expected.
      const realMonto = (typeof aiReview.monto_leido === 'number' && aiReview.monto_leido > 0)
        ? aiReview.monto_leido
        : null
      if (realMonto == null) throw new Error('La IA no pudo leer el monto del depósito. Usa el modo Manual e ingresa el monto.')

      // ── Partial-deposit accounting (2026-06-12) ──────────────────────────
      // Net-zero rule: deposits must sum exactly to monto_usd. A deposit that
      // exceeds the remaining balance is rejected (verify the receipt or use
      // Manual mode to correct the amount).
      const yaDepositado = Number(comp.monto_depositado || 0)
      const restante = Number(comp.monto_usd) - yaDepositado
      if (realMonto > restante + 0.005) {
        throw new Error(`El depósito ($${realMonto.toFixed(2)}) excede lo pendiente ($${restante.toFixed(2)}) de ESTE lote. Si el depósito cubre varios lotes, registra en cada lote solo su parte (modo Manual).`)
      }
      const nuevoTotal = yaDepositado + realMonto
      const completo = cerrarAbsorbe || nuevoTotal >= Number(comp.monto_usd) - 0.005
      const absorbido = completo ? Math.max(0, Number(comp.monto_usd) - nuevoTotal) : 0

      const bankTxId: string = await upsertDepositTx({
        tipo: 'deposit',
        fecha: aiReview.fecha || new Date().toISOString().slice(0, 10),
        monto_usd: realMonto,
        referencia: aiReview.referencia || comp.numero,
        cuenta: depositoCuenta,
        cuenta_id: cuentaFkId(depositoCuenta),
        direccion: 'credit',
        raw_text: `Bancarización ${comp.numero} · ${comp.concepto}${completo ? '' : ' · PARCIAL ' + realMonto.toFixed(2) + ' de ' + Number(comp.monto_usd).toFixed(2)}`,
        is_internal: true,
        flujo: 'ingreso',
        banc_depositante: comp.bancarizador_nombre || comp.egreso_dirigido_a || null,
        es_bancarizacion: true,
        matched: true,
      })

      // Child ledger row — one per deposit, always.
      const { error: depErr } = await supabase.from('tesoreria_comprobante_depositos').insert({
        comprobante_id: comp.id,
        bank_transaction_id: bankTxId,
        monto_usd: realMonto,
        fecha: aiReview.fecha || new Date().toISOString().slice(0, 10),
        referencia: aiReview.referencia || comp.numero,
        cuenta: depositoCuenta,
        documento_url: documentoUrl,
        ai_review: aiReview,
        registered_by: userId,
      })
      if (depErr) throw new Error('Depósito bancario creado pero no se pudo registrar en el ledger: ' + depErr.message)

      // NOTE: The −1 movimiento on the source caja was already written at
      // ENTREGADO_BANCARIZADOR (the earmark point). DEPOSITADO is purely a
      // confirmation that the funds arrived in the bank — no balance change
      // happens to the source caja here.

      // Update the comprobante — closes only when deposits net to zero.
      await supabase.from('tesoreria_comprobantes').update({
        estado: completo ? 'DEPOSITADO' : 'DEPOSITADO_PARCIAL',
        cerrado_at: completo ? new Date().toISOString() : null,
        monto_depositado: nuevoTotal,
        egreso_documento_url: documentoUrl,
        egreso_ai_review: aiReview,
        bank_transaction_id: bankTxId,   // latest tx (compat); ledger has all
      }).eq('id', comp.id).in('estado', ['ENTREGADO_BANCARIZADOR', 'DEPOSITADO_PARCIAL'])

      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: comp.id,
        evento: completo ? 'DEPOSITADO' : 'DEPOSITO_PARCIAL',
        actor_user_id: userId,
        actor_label: 'Mirla',
        notas: completo
          ? (depositos.length > 0
              ? `Depósito final ${fmt(realMonto)} — completa ${fmt(nuevoTotal)} de ${fmt(comp.monto_usd)} en ${depositos.length + 1} depósitos.`
              : (aiReview.match
                  ? `Depósito confirmado. IA leyó ${fmt(aiReview.monto_leido)}.`
                  : `Depósito registrado. ⚠ IA: ${aiReview.motivo || 'monto no coincide'}.`))
          : `Depósito parcial ${fmt(realMonto)} — van ${fmt(nuevoTotal)} de ${fmt(comp.monto_usd)} · faltan ${fmt(Number(comp.monto_usd) - nuevoTotal)}.`,
      })

      // WhatsApp → banc_depositada / banc_directa_depositada / usdt_depositada.
      // Fires on EVERY deposit with THAT deposit's monto; the Worker routes
      // recipients (Mirla + Roberto; Viviana only when she's involved).
      notifyTesoreria({
        evento: completo ? 'DEPOSITADO' : 'DEPOSITO_PARCIAL',
        tipo: 'EGRESO',
        egreso_tipo: 'BANCARIZACION',
        bancarizacion_ruta: comp.bancarizacion_ruta || 'via_mirla',
        ubicacion_origen_codigo: comp.ubicacion_origen_id
          ? ubicaciones[comp.ubicacion_origen_id]?.codigo
          : null,
        es_urgente: comp.es_urgente,
        numero: comp.numero,
        monto_usd: realMonto,
        monto_restante: completo ? 0 : Number(comp.monto_usd) - nuevoTotal,
        bancarizador: comp.bancarizador_nombre || comp.egreso_dirigido_a || '',
        enviado_por: userId,
      } as any)

      setModal(null)
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error al registrar el depósito')
    } finally { setAiBusy(false) }
  }

  // → DEPOSITADO (manual). Same effect as egresoDepositar but with user-entered
  // fields instead of an AI-parsed file. No storage upload, no AI call.
  // Used when there's no digital comprobante to upload (cash deposit at teller,
  // text-only confirmation, etc.) or when AI parsing is unnecessary.
  async function egresoDepositarManual() {
    if (!comp || !userId) return
    if (!depositoRef.trim()) { setErr('Indica la referencia o número de depósito'); return }
    if (!depositoFecha)      { setErr('Indica la fecha del depósito'); return }
    if (!depositoCuenta)     { setErr('Selecciona la cuenta bancaria donde se hizo el depósito.'); return }

    // Partial-deposit accounting (2026-06-12): the monto is user-entered,
    // defaults to the remaining balance, and must net to zero exactly.
    const yaDepositado = Number(comp.monto_depositado || 0)
    const restante = Number(comp.monto_usd) - yaDepositado
    const montoDep = parseFloat(depositoMonto) || restante
    if (montoDep <= 0) { setErr('Monto de depósito inválido.'); return }
    if (montoDep > restante + 0.005) {
      setErr(`El depósito ($${montoDep.toFixed(2)}) excede lo pendiente ($${restante.toFixed(2)}) de ESTE lote. Si cubre varios lotes, registra en cada lote solo su parte; usa “cerrar lote y absorber” para la comisión.`)
      return
    }
    const nuevoTotal = yaDepositado + montoDep
    const completo = cerrarAbsorbe || nuevoTotal >= Number(comp.monto_usd) - 0.005
    const absorbido = completo ? Math.max(0, Number(comp.monto_usd) - nuevoTotal) : 0

    setAction(true); setErr(null)
    try {

     // 1. Create the bank_transactions row (internal, /banco shows the deposit)
      //
      // FIX 2026-05-26: cuenta is NOT NULL. Fall back to 'UNKNOWN' if user
      // didn't fill the field. Surface errors instead of silently failing.
      const bankTxId: string = await upsertDepositTx({
        tipo: 'deposit',
        fecha: depositoFecha,
        monto_usd: montoDep,
        referencia: depositoRef.trim(),
        cuenta: depositoCuenta,
        cuenta_id: cuentaFkId(depositoCuenta),
        direccion: 'credit',
        raw_text: `Bancarización ${comp.numero} · ${comp.concepto} · MANUAL${completo ? '' : ' · PARCIAL ' + montoDep.toFixed(2) + ' de ' + Number(comp.monto_usd).toFixed(2)}`,
        is_internal: true,
        flujo: 'ingreso',
        banc_depositante: comp.bancarizador_nombre || comp.egreso_dirigido_a || null,
        es_bancarizacion: true,
        matched: true,
      })

      // 1b. Child ledger row — one per deposit, always.
      const { error: depErr } = await supabase.from('tesoreria_comprobante_depositos').insert({
        comprobante_id: comp.id,
        bank_transaction_id: bankTxId,
        monto_usd: montoDep,
        fecha: depositoFecha,
        referencia: depositoRef.trim(),
        cuenta: depositoCuenta,
        documento_url: null,
        ai_review: null,
        registered_by: userId,
      })
      if (depErr) throw new Error('Depósito bancario creado pero no se pudo registrar en el ledger: ' + depErr.message)

      // NOTE: The −1 movimiento was already written at EN_PODER_MIRLA (via_mirla)
      // or ENTREGADO_BANCARIZADOR (directa/USDT). DEPOSITADO is purely the
      // arrival confirmation — no balance change at this step.

      // Build a synthetic ai_review record so the historial shows the manual
      // entry consistently with file-uploaded ones.
      const manualReview = {
        ok: true,
        match: completo,
        manual: true,
        monto_leido: montoDep,
        referencia: depositoRef.trim(),
        fecha: depositoFecha,
        cuenta: depositoCuenta || null,
        motivo: completo ? (absorbido > 0.005 ? `Cierre con diferencia absorbida ${fmt(absorbido)}` : 'Registro manual sin comprobante') : `Depósito parcial manual — van ${nuevoTotal.toFixed(2)} de ${Number(comp.monto_usd).toFixed(2)}`,
        notas: depositoNotas.trim() || null,
      }

      await supabase.from('tesoreria_comprobantes').update({
        estado: completo ? 'DEPOSITADO' : 'DEPOSITADO_PARCIAL',
        cerrado_at: completo ? new Date().toISOString() : null,
        monto_depositado: nuevoTotal,
        egreso_documento_url: null,         // no file uploaded
        egreso_ai_review: manualReview,
        bank_transaction_id: bankTxId,
      }).eq('id', comp.id).in('estado', ['ENTREGADO_BANCARIZADOR', 'DEPOSITADO_PARCIAL'])

      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: comp.id, evento: completo ? 'DEPOSITADO' : 'DEPOSITO_PARCIAL', actor_user_id: userId,
        actor_label: 'Mirla',
        notas: completo
          ? `Depósito registrado manualmente · ref ${depositoRef.trim()}${depositos.length > 0 ? ` · completa ${fmt(nuevoTotal)} en ${depositos.length + 1} depósitos` : ''}${absorbido > 0.005 ? ` · diferencia ${fmt(absorbido)} absorbida` : ''}${depositoNotas.trim() ? ' · ' + depositoNotas.trim() : ''}`
          : `Depósito parcial manual ${fmt(montoDep)} · ref ${depositoRef.trim()} — van ${fmt(nuevoTotal)} de ${fmt(comp.monto_usd)} · faltan ${fmt(Number(comp.monto_usd) - nuevoTotal)}.${depositoNotas.trim() ? ' · ' + depositoNotas.trim() : ''}`,
      })

      // WhatsApp → same as file flow: per-deposit, with THAT deposit's monto.
      notifyTesoreria({
        evento: completo ? 'DEPOSITADO' : 'DEPOSITO_PARCIAL',
        tipo: 'EGRESO',
        egreso_tipo: 'BANCARIZACION',
        bancarizacion_ruta: comp.bancarizacion_ruta || 'via_mirla',
        ubicacion_origen_codigo: comp.ubicacion_origen_id
          ? ubicaciones[comp.ubicacion_origen_id]?.codigo
          : null,
        es_urgente: comp.es_urgente,
        numero: comp.numero,
        monto_usd: montoDep,
        monto_restante: completo ? 0 : Number(comp.monto_usd) - nuevoTotal,
        bancarizador: comp.bancarizador_nombre || comp.egreso_dirigido_a || '',
        enviado_por: userId,
      } as any)

      // Reset modal fields
      setDepositoRef(''); setDepositoCuenta(''); setDepositoNotas(''); setDepositoMonto(''); setCerrarAbsorbe(false)
      setDepositoMode('file')
      setModal(null)
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error al registrar el depósito')
    } finally { setAction(false) }
  }

  // ── CAMBIO_BS: cierre — confirmar los Bs recibidos ────────────────────────
  // The USD cash already left the caja at ENTREGADO_BANCARIZADOR. This step
  // records what actually arrived at the Venezuelan bank: one
  // bank_transactions row on the 'bolivares' bucket (real Bs + the USD they
  // came from, direccion set explicitly — the CHECK silently rejects rows
  // without it), the REAL rate on the comprobante (tasa_aplicada), and the
  // pactada-vs-real difference preserved forever in the evento trail.
  async function egresoConfirmarBs() {
    if (!comp || !userId) return
    const bs = parseFloat(bsRecibidoStr)
    if (!bs || bs <= 0)      { setErr('Indica los bolívares recibidos.'); return }
    if (!depositoRef.trim()) { setErr('Indica la referencia de la transferencia en Bs.'); return }
    if (!depositoFecha)      { setErr('Indica la fecha.'); return }
    const usd = Number(comp.monto_usd)
    const tasaReal = bs / usd
    const tasaPactada = Number((comp as any).tasa_aplicada) || 0
    const bsEsperados = tasaPactada > 0 ? usd * tasaPactada : 0
    const difBs = bsEsperados > 0 ? bs - bsEsperados : 0

    setAction(true); setErr(null)
    try {
      // 1. Bank row — Bs bucket. Direct insert (not upsertDepositTx: its
      //    dedupe branch tags rows es_bancarizacion, wrong for a cambio).
      const { data: btx, error: btErr } = await supabase.from('bank_transactions').insert({
        cuenta: 'bolivares',
        fecha: depositoFecha,
        monto_usd: usd,
        monto_bs: bs,
        referencia: depositoRef.trim(),
        tipo: 'transfer_in',
        direccion: 'credit',
        flujo: 'ingreso',
        descripcion: `Cambio Bs · ${comp.numero} · ${comp.bancarizador_nombre || comp.egreso_dirigido_a || ''}`.trim(),
        payment_memo: `Egreso ${comp.numero} · ${(comp as any).banco_bs_nombre || ''}`.trim(),
        raw_text: `CAMBIO_BS ${comp.numero} · ${usd.toFixed(2)} USD → ${bs.toFixed(2)} Bs @ ${tasaReal.toFixed(4)} · MANUAL`,
        is_internal: false,
        matched: true,
        source: 'manual',
        uploaded_by: userId,
      }).select('id').single()
      if (btErr) throw new Error('No se pudo crear el registro bancario en Bs: ' + btErr.message)
      const bankTxId = (btx as any).id as string

      // 2. Close the comprobante with the REAL numbers. The tasa pactada is
      //    not lost — it lives in the evento below and in the creation event.
      const { error: upErr } = await supabase.from('tesoreria_comprobantes').update({
        estado: 'DEPOSITADO',
        monto_bs: bs,
        tasa_aplicada: tasaReal,
        bank_transaction_id: bankTxId,
        confirmado_by: userId,
        confirmado_at: new Date().toISOString(),
        cerrado_at: new Date().toISOString(),
      }).eq('id', comp.id).eq('estado', 'ENTREGADO_BANCARIZADOR')
      if (upErr) throw upErr

      // 3. Evento — pactada vs real, auditable siempre.
      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: comp.id, evento: 'DEPOSITADO', actor_user_id: userId,
        actor_label: 'Tesorería',
        notas: `Bs recibidos: ${bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ref ${depositoRef.trim()} · tasa real ${tasaReal.toFixed(4)}`
          + (tasaPactada > 0 ? ` (pactada ${tasaPactada.toFixed(4)} · diferencia ${difBs >= 0 ? '+' : ''}${difBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs)` : '')
          + (depositoNotas.trim() ? ' · ' + depositoNotas.trim() : ''),
      })

      setBsRecibidoStr(''); setDepositoRef(''); setDepositoNotas('')
      setModal(null)
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error al confirmar los Bs recibidos')
    } finally { setAction(false) }
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

      // Hard block: pre-check origen saldo. DB trigger would reject anyway.
      const { data: ubicRow } = await supabase
        .from('tesoreria_ubicaciones')
        .select('saldo_actual_usd')
        .eq('id', cajaOrigen.id)
        .single()
      const saldo = Number(ubicRow?.saldo_actual_usd || 0)
      if (Number(comp.monto_usd) > saldo) {
        throw new Error(
          `Saldo insuficiente en ${cajaOrigen.nombre}: $${saldo.toFixed(2)} disponible, ` +
          `$${Number(comp.monto_usd).toFixed(2)} requerido. ` +
          `No se puede ejecutar el egreso.`
        )
      }

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

      // Movimientos.
      // 2026-05-21: simple single-leg writes. Cash transfers between PC_MIRLA
      // and CAJA_PPAL happen via the handoff batch flow (Path B), which is
      // decoupled from comprobantes.
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

  // CAMBIO_USDT: SOLICITADO → EJECUTADO. Two-leg internal swap:
  //   −monto_entregado on origen, +monto_recibido on destino.
  // If recibido < entregado, the gap is the real exchange cost — it simply
  // leaves total holdings, which is the truth. Reuses the préstamo-negativo
  // prompt when the origen caja would go below zero.
  async function egresoEjecutarCambio(loan?: { prestamista: string; monto: number }) {
    if (!comp || !userId) return
    if (!comp.ubicacion_origen_id || !comp.ubicacion_destino_id) {
      setErr('Este cambio no tiene origen/destino definidos.'); return
    }
    const entregado = Number(comp.monto_usd)
    const recibido = fxRecibidoStr.trim() === '' ? entregado : parseFloat(fxRecibidoStr)
    if (isNaN(recibido) || recibido <= 0) { setErr('Monto recibido inválido.'); return }

    // Saldo pre-check on origen — préstamo prompt instead of a hard block.
    const origen = ubicaciones[comp.ubicacion_origen_id]
    if (origen && !loan) {
      const { data: ubicRow } = await supabase
        .from('tesoreria_ubicaciones')
        .select('saldo_actual_usd')
        .eq('id', comp.ubicacion_origen_id)
        .single()
      const saldo = Number(ubicRow?.saldo_actual_usd || 0)
      if (entregado > saldo) {
        setPrestModal({
          prompt: { cajaNombre: origen.nombre, who: prestamistaResponsable(origen.codigo), montoEgreso: entregado, saldoDisponible: saldo },
          resume: (pr, m) => { setPrestModal(null); egresoEjecutarCambio({ prestamista: pr, monto: m }) },
        })
        return
      }
    }

    setAction(true); setErr(null)
    try {
      if (loan) {
        const { error: pErr } = await registrarPrestamoCorto({
          ubicacionId: comp.ubicacion_origen_id, prestamista: loan.prestamista, monto: loan.monto,
          comprobanteId: comp.id, userId,
        })
        if (pErr) throw new Error('Error registrando préstamo: ' + pErr)
      }

      const { error: movErr } = await supabase.from('tesoreria_movimientos').insert([
        {
          ubicacion_id: comp.ubicacion_origen_id,
          tipo: 'CAMBIO_USDT', monto_usd: entregado, signo: -1,
          permite_negativo: !!loan,
          source_type: 'EGRESO', source_label: comp.source_label || comp.concepto,
          comprobante_id: comp.id,
          descripcion: `Cambio · entregado · ${comp.numero}`,
          categoria: 'CAMBIO_USDT', registered_by: userId,
        },
        {
          ubicacion_id: comp.ubicacion_destino_id,
          tipo: 'CAMBIO_USDT', monto_usd: recibido, signo: 1,
          permite_negativo: false,
          source_type: 'EGRESO', source_label: comp.source_label || comp.concepto,
          comprobante_id: comp.id,
          descripcion: `Cambio · recibido · ${comp.numero}`,
          categoria: 'CAMBIO_USDT', registered_by: userId,
        },
      ])
      if (movErr) throw new Error('Error registrando movimientos del cambio: ' + movErr.message)

      try { await supabase.rpc('tesoreria_recompute_saldos') }
      catch (e) { console.warn('[cambio] recompute warning', e) }

      const fee = entregado - recibido
      const { error: upErr } = await supabase.from('tesoreria_comprobantes').update({
        estado: 'EJECUTADO',
        cerrado_at: new Date().toISOString(),
        fx_monto_recibido_usd: recibido,
      }).eq('id', comp.id).eq('estado', 'SOLICITADO')
      if (upErr) throw upErr

      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: comp.id, evento: 'EJECUTADO', actor_user_id: userId,
        actor_label: 'Tesorería',
        notas: `Cambio ejecutado · entregado ${fmt(entregado)} · recibido ${fmt(recibido)}` +
          (Math.abs(fee) > 0.005 ? ` · ${fee > 0 ? 'costo' : 'ganancia'} del cambio ${fmt(Math.abs(fee))}` : ''),
      })

      notifyTesoreria({
        evento: 'EJECUTADO',
        tipo: 'EGRESO',
        egreso_tipo: 'CAMBIO_USDT',
        numero: comp.numero,
        monto_usd: entregado,
        concepto: comp.concepto || '',
        egreso_dirigido_a: comp.egreso_dirigido_a || '',
        enviado_por: userId,
      })

      setModal(null); setFxRecibidoStr('')
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error al ejecutar el cambio')
    } finally { setAction(false) }
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
    CAMBIO_USDT:     'Cambio Cash ⇄ USDT',
    DEVOLUCION_CLIENTE: 'Devolución al cliente',
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
  const canRevertir = isEgreso && ['DEPOSITADO', 'DEPOSITADO_PARCIAL', 'EJECUTADO'].includes(comp.estado) && isAdmin

  // True-delete: manager account only, and only after the comprobante is
  // ANULADO (Anular is the forced audit step). Server-side RPC re-checks email.
  const isManagerEmail = userEmail === 'manager@motocentro2.com'
  const canEliminar = isManagerEmail && comp.estado === 'ANULADO'

  // Derive origen codigo once — used by chainSteps, egresoNextAction, and all
  // the ruta-dependent transition logic to treat USDT_WALLET sources as directa.
  const origenCodigo = comp.ubicacion_origen_id
    ? ubicaciones[comp.ubicacion_origen_id]?.codigo
    : null

  // Which egreso action button to show for the current state.
  // origenCodigo lets it correctly handle USDT (skip Mirla, jump to transfer).
  const egresoActionBtn = isEgreso ? egresoNextAction(comp, permissions, origenCodigo, isCreator) : null
  const steps = isEgreso ? chainSteps(comp, origenCodigo) : []
  // DEPOSITADO_PARCIAL has no own chain step — visually it sits at the
  // "Con bancarizador" step until the deposits net to zero.
  // DEVOLUCION_CLIENTE: la aprobación de Mirla no cambia el estado (sigue
  // SOLICITADO hasta el pago) — el paso APROBADO se cumple por revision_estado.
  const timelineEstado =
    comp.estado === 'DEPOSITADO_PARCIAL' ? 'ENTREGADO_BANCARIZADOR'
    : (comp.egreso_tipo === 'DEVOLUCION_CLIENTE' && comp.estado === 'SOLICITADO' && comp.revision_estado === 'aprobado') ? 'APROBADO'
    : comp.estado
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
                {(comp as any).banco_bs_nombre && !isEgreso ? (
                  <>
                    <span style={{ ...s.fieldMono, fontSize: 28 }}>Bs {(comp.monto_bs ?? (comp.monto_usd * (Number((comp as any).tasa_bcv_usada) || 0))).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    <span style={s.fieldLabel}>≈ {fmt(comp.monto_usd)}</span>
                  </>
                ) : isEgreso && comp.egreso_tipo === 'CAMBIO_BS' ? (
                  <>
                    <span style={{ ...s.fieldMono, fontSize: 28 }}>{fmt(comp.monto_usd)}</span>
                    {Number((comp as any).tasa_aplicada) > 0 && (
                      <span style={s.fieldLabel}>
                        Bs esperados: {(comp.monto_usd * Number((comp as any).tasa_aplicada)).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} @ {Number((comp as any).tasa_aplicada).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                      </span>
                    )}
                  </>
                ) : (
                  <span style={{ ...s.fieldMono, fontSize: 28 }}>{fmt(comp.monto_usd)}</span>
                )}
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
                  <span style={s.fieldLabel}>{comp.source_type === 'DEAL' ? 'Negocio de origen' : 'Referencia'}</span>
                  {comp.source_type === 'DEAL' && comp.source_id ? (
                    <a href={`/auditoria?open_deal=${encodeURIComponent(comp.source_id)}`}
                       style={{ ...s.fieldValue, color: '#1B4AAA', textDecoration: 'underline' }}>
                      {comp.source_label} ↗
                    </a>
                  ) : (
                    <span style={s.fieldValue}>{comp.source_label}</span>
                  )}
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

              {creatorEmail && (
                <div style={{ ...s.field, marginTop: 12 }}>
                  <span style={s.fieldLabel}>Registrado por</span>
                  <span style={{ ...s.fieldValue, fontSize: 12 }}>{creatorEmail}</span>
                </div>
              )}
            </div>

            <div style={s.qrBox}>
              <TesoreriaQR payload={comp.qr_payload} size={180} />
              <div style={s.qrCaption}>Escanear con app de Tesorería</div>
            </div>
          </div>

         
          {/* AI review result + receipt + bank tx link (egreso) */}
          {isEgreso && comp.egreso_ai_review && (
            <div style={s.aiBox(!!comp.egreso_ai_review.match)} className="print-hide">
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <b>{comp.egreso_ai_review.match ? '✓ Documento verificado por IA' : '⚠ Revisión IA'}</b><br />
                  {comp.egreso_ai_review.match
                    ? `Monto leído: ${fmt(comp.egreso_ai_review.monto_leido)}`
                    : (comp.egreso_ai_review.motivo || 'El documento no pudo verificarse.')}
                  {comp.egreso_ai_review.match === false && typeof comp.egreso_ai_review.monto_leido === 'number' && (
                    <div style={{ marginTop: 8, padding: '8px 10px', background: '#FEF3C7', borderRadius: 4, fontSize: 11, color: '#92400E' }}>
                      <b>Esperado:</b> {fmt(comp.monto_usd)} ·{' '}
                      <b>Depositado:</b> {fmt(comp.egreso_ai_review.monto_leido)} ·{' '}
                      <b>Δ:</b> {fmt(comp.egreso_ai_review.monto_leido - comp.monto_usd)}
                      {comp.bancarizador_nombre && (
                        <> · Saldo {comp.egreso_ai_review.monto_leido > comp.monto_usd ? 'a favor de' : 'en contra de'} <b>{comp.bancarizador_nombre}</b></>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                  {comp.egreso_documento_url && (
                    <a href={comp.egreso_documento_url} target="_blank" rel="noopener noreferrer"
                      style={{ padding: '6px 12px', borderRadius: 4, background: '#0D2257', color: '#fff', fontSize: 11, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                      📎 Ver comprobante
                    </a>
                  )}
                  {comp.bank_transaction_id && (
                    <a onClick={(e) => { e.preventDefault(); router.push('/banco?tx=' + comp.bank_transaction_id) }}
                      style={{ padding: '6px 12px', borderRadius: 4, background: '#16A34A', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      🏦 Ver en banco
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}
 

          {/* ── Depósitos de bancarización (parciales) ─────────────────────── */}
          {isEgreso && comp.egreso_tipo === 'BANCARIZACION' && depositos.length > 0 && (
            <div style={{ marginTop: 16, padding: 14, background: 'var(--bg-card, #fff)', border: '1px solid var(--border, #e5e5e5)', borderRadius: 8 }} className="print-hide">
              {(() => {
                const dep = Number(comp.monto_depositado || 0)
                const total = Number(comp.monto_usd)
                const falta = Math.max(0, total - dep)
                const pct = total > 0 ? Math.min(100, (dep / total) * 100) : 0
                return (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 800 }}>🏦 Depósitos del bancarizador</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: falta > 0.005 ? '#b8720a' : '#1a7a4a' }}>
                        {fmt(dep)} de {fmt(total)}{falta > 0.005 ? ` · faltan ${fmt(falta)}` : ' · completo ✓'}
                      </div>
                    </div>
                    <div style={{ height: 8, background: '#eee', borderRadius: 4, marginTop: 8, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: pct + '%', background: falta > 0.005 ? '#b8720a' : '#1a7a4a', borderRadius: 4, transition: 'width .3s' }} />
                    </div>
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {depositos.map((d, i) => (
                        <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12, padding: '6px 8px', background: '#fafafa', borderRadius: 6, flexWrap: 'wrap' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>#{i + 1} · {d.fecha} · {BANK_ACCOUNTS.find(b => b.code === d.cuenta)?.label || d.cuenta} · ref {d.referencia || '—'}</span>
                          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                            <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(d.monto_usd)}</b>
                            {d.documento_url && (
                              <a href={d.documento_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#0D2257', fontWeight: 700 }}>📎</a>
                            )}
                            {d.bank_transaction_id && (
                              <a onClick={(e) => { e.preventDefault(); router.push('/banco?tx=' + d.bank_transaction_id) }} style={{ fontSize: 11, color: '#16A34A', fontWeight: 700, cursor: 'pointer' }}>🏦</a>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )
              })()}
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
            <button style={s.btnGreen} onClick={() => setModal(egresoActionBtn.modal)} disabled={action}>
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
          {canEliminar && (
            <button
              style={{ ...s.btnRed, background: '#7a0d1b' }}
              onClick={handleEliminar} disabled={action}
              title="Eliminar permanentemente — irreversible, solo gerencia"
            >
              {action ? 'Procesando…' : '🗑 Eliminar definitivamente'}
            </button>
          )}
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
              <button style={s.btnGreen} onClick={() => egresoReciboMirla()} disabled={action}>
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
            <div style={s.modalTitle}>{comp.egreso_tipo === 'CAMBIO_BS' ? 'Entregar efectivo al cambista' : 'Entregar al bancarizador'}</div>
            <div style={s.modalText}>
              {comp.egreso_tipo === 'CAMBIO_BS'
                ? <>Registra a quién se le entrega el efectivo de <b>{fmt(comp.monto_usd)}</b> para el cambio a bolívares{(comp as any).tasa_aplicada ? <> (tasa pactada <b>{Number((comp as any).tasa_aplicada).toLocaleString('es-VE', { maximumFractionDigits: 4 })}</b>)</> : null}. Este paso descuenta el efectivo de la caja.</>
                : <>Registra a quién se le entrega el efectivo de <b>{fmt(comp.monto_usd)}</b> para depositar en el banco.</>}
            </div>
            <label style={s.label}>Nombre de quien recibe</label>
            <input
              style={s.input} type="text" value={bancarizadorInput}
              onChange={e => setBancarizadorInput(e.target.value)}
              placeholder={comp.egreso_dirigido_a || 'Ej: Enzo Carbonara'}
            />
            <div style={s.btnRow}>
              <button style={s.btnGreen} onClick={() => egresoEntregarBancarizador()} disabled={action}>
                {action ? 'Procesando…' : 'Confirmar entrega'}
              </button>
              <button style={s.btnSec} onClick={() => setModal(null)} disabled={action}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {modal === 'depositar' && comp && comp.egreso_tipo === 'CAMBIO_BS' && (
        <div style={s.modalBg} onClick={() => !action && setModal(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>Confirmar Bs recibidos</div>
            <div style={s.modalText}>
              Entregado: <b>{fmt(comp.monto_usd)}</b>
              {Number((comp as any).tasa_aplicada) > 0 && (
                <> · Tasa pactada: <b>{Number((comp as any).tasa_aplicada).toLocaleString('es-VE', { maximumFractionDigits: 4 })}</b>
                <br />Bs esperados: <b>{(Number(comp.monto_usd) * Number((comp as any).tasa_aplicada)).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
                {(comp as any).banco_bs_nombre ? <> en <b>{(comp as any).banco_bs_nombre}</b></> : null}</>
              )}
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
                Bolívares recibidos *
              </div>
              <input
                type="number" step="0.01" min="0.01"
                value={bsRecibidoStr}
                onChange={e => setBsRecibidoStr(e.target.value)}
                placeholder={Number((comp as any).tasa_aplicada) > 0 ? (Number(comp.monto_usd) * Number((comp as any).tasa_aplicada)).toFixed(2) : 'Bs'}
                style={s.input}
                disabled={action}
              />
              {(() => {
                const bs = parseFloat(bsRecibidoStr)
                if (!bs || bs <= 0) return null
                const tasaReal = bs / Number(comp.monto_usd)
                const pactada = Number((comp as any).tasa_aplicada) || 0
                const dif = pactada > 0 ? bs - Number(comp.monto_usd) * pactada : 0
                return (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                    Tasa real: <b>{tasaReal.toLocaleString('es-VE', { maximumFractionDigits: 4 })}</b>
                    {pactada > 0 && <> · Diferencia vs pactada: <b style={{ color: dif >= 0 ? '#1a7a4a' : '#BB162B' }}>{dif >= 0 ? '+' : ''}{dif.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs</b></>}
                  </div>
                )
              })()}
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
                Referencia de la transferencia *
              </div>
              <input
                type="text"
                value={depositoRef}
                onChange={e => setDepositoRef(e.target.value)}
                placeholder="Ej: 04512398765"
                style={s.input}
                disabled={action}
              />
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
                Fecha *
              </div>
              <input
                type="date"
                value={depositoFecha}
                onChange={e => setDepositoFecha(e.target.value)}
                style={s.input}
                disabled={action}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
                Notas
              </div>
              <input
                type="text"
                value={depositoNotas}
                onChange={e => setDepositoNotas(e.target.value)}
                placeholder="Opcional"
                style={s.input}
                disabled={action}
              />
            </div>
            <div style={s.btnRow}>
              <button style={s.btnGreen} onClick={() => egresoConfirmarBs()} disabled={action}>
                {action ? 'Procesando…' : '✓ Confirmar y cerrar'}
              </button>
              <button style={s.btnSec} onClick={() => setModal(null)} disabled={action}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {modal === 'depositar' && comp && comp.egreso_tipo !== 'CAMBIO_BS' && (
        <div style={s.modalBg} onClick={() => !aiBusy && !action && setModal(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>Registrar el depósito bancario</div>
            <div style={s.modalText}>
              {Number(comp.monto_depositado || 0) > 0 ? (
                <>
                  Total bancarización: <b>{fmt(comp.monto_usd)}</b> · Depositado: <b style={{ color: '#1a7a4a' }}>{fmt(comp.monto_depositado)}</b>
                  <br />Pendiente por depositar: <b style={{ color: '#b8720a' }}>{fmt(Number(comp.monto_usd) - Number(comp.monto_depositado || 0))}</b>
                </>
              ) : (
                <>Monto: <b>{fmt(comp.monto_usd)}</b> — se aceptan depósitos parciales; el comprobante cierra cuando la suma iguala el total.</>
              )}
            </div>

            {/* Mandatory account — applies to BOTH modes */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
                Cuenta bancaria del depósito *
              </div>
              <select
                value={depositoCuenta}
                onChange={e => setDepositoCuenta(e.target.value)}
                style={{ ...s.input, fontFamily: 'inherit' }}
                disabled={aiBusy || action}
              >
                <option value="">— Selecciona la cuenta —</option>
                {BANK_ACCOUNTS.map(a => (
                  <option key={a.code} value={a.code}>{a.label}</option>
                ))}
              </select>
            </div>

            {/* Mode tabs — file (AI) or manual */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 14, marginTop: 12 }}>
              <button
                type="button"
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                  cursor: 'pointer',
                  border: '1px solid ' + (depositoMode === 'file' ? '#1a7a4a' : 'var(--border)'),
                  background: depositoMode === 'file' ? '#1a7a4a' : 'transparent',
                  color: depositoMode === 'file' ? '#fff' : 'var(--text-primary)',
                }}
                onClick={() => setDepositoMode('file')}
                disabled={aiBusy || action}
              >
                📎 Subir comprobante (IA)
              </button>
              <button
                type="button"
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                  cursor: 'pointer',
                  border: '1px solid ' + (depositoMode === 'manual' ? '#1a7a4a' : 'var(--border)'),
                  background: depositoMode === 'manual' ? '#1a7a4a' : 'transparent',
                  color: depositoMode === 'manual' ? '#fff' : 'var(--text-primary)',
                }}
                onClick={() => setDepositoMode('manual')}
                disabled={aiBusy || action}
              >
                ✏ Manual
              </button>
            </div>

            {depositoMode === 'file' ? (
              <>
                <div style={{ ...s.modalText, marginBottom: 8 }}>
                  Sube la constancia del depósito. La IA leerá el documento y se registrará en el módulo de Banco.
                </div>
                <input
                  ref={fileRef} type="file" accept="image/*,application/pdf"
                  style={{ ...s.input, padding: 8, opacity: depositoCuenta ? 1 : 0.5 }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) egresoDepositar(f); e.target.value = '' }}
                  disabled={aiBusy || !depositoCuenta}
                />
                {!depositoCuenta && (
                  <div style={{ fontSize: 11, color: '#b8720a', marginTop: 6 }}>
                    Selecciona primero la cuenta bancaria.
                  </div>
                )}
                {aiBusy && <div style={{ ...s.modalText, marginTop: 12, marginBottom: 0 }}>Subiendo y leyendo el documento…</div>}
              </>
            ) : (
              <>
                <div style={{ ...s.modalText, marginBottom: 8 }}>
                  Ingresa los datos del depósito manualmente. No requiere comprobante adjunto.
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
                    Referencia / N° de depósito *
                  </div>
                  <input
                    type="text"
                    value={depositoRef}
                    onChange={e => setDepositoRef(e.target.value)}
                    placeholder="Ej: 001234567 o transferencia ID"
                    style={s.input}
                    disabled={action}
                  />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
                    Monto depositado (USD) *
                  </div>
                  <input
                    type="number" step="0.01" min="0.01"
                    value={depositoMonto}
                    onChange={e => setDepositoMonto(e.target.value)}
                    placeholder={(Number(comp.monto_usd) - Number(comp.monto_depositado || 0)).toFixed(2)}
                    style={s.input}
                    disabled={action}
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                    Vacío = el restante completo ({fmt(Number(comp.monto_usd) - Number(comp.monto_depositado || 0))}). Un monto menor registra un depósito parcial.
                  </div>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input type="checkbox" checked={cerrarAbsorbe} onChange={e => setCerrarAbsorbe(e.target.checked)} disabled={action} style={{ marginTop: 3 }} />
                    <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
                      Cerrar lote y absorber la diferencia
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                        Cierra el lote por el monto registrado aunque sea menor a lo pendiente (p. ej. comisión bancaria). La diferencia se absorbe.
                      </span>
                    </span>
                  </label>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
                    Fecha *
                  </div>
                  <input
                    type="date"
                    value={depositoFecha}
                    onChange={e => setDepositoFecha(e.target.value)}
                    style={s.input}
                    disabled={action}
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
                    Notas (opcional)
                  </div>
                  <textarea
                    rows={2}
                    value={depositoNotas}
                    onChange={e => setDepositoNotas(e.target.value)}
                    style={{ ...s.input, fontFamily: 'inherit', resize: 'vertical' as const }}
                    disabled={action}
                  />
                </div>
                <button
                  style={{ ...s.btnGreen, width: '100%', opacity: action ? 0.5 : 1 }}
                  onClick={egresoDepositarManual}
                  disabled={action}
                >
                  {action ? 'Registrando…' : 'Registrar depósito'}
                </button>
              </>
            )}

            <div style={s.btnRow}>
              <button style={s.btnSec} onClick={() => setModal(null)} disabled={aiBusy || action}>Cancelar</button>
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

      {modal === 'cambiar' && comp && (() => {
        const entregado = Number(comp.monto_usd)
        const recibidoNum = fxRecibidoStr.trim() === '' ? entregado : parseFloat(fxRecibidoStr)
        const fee = !isNaN(recibidoNum) ? entregado - recibidoNum : 0
        const origenN = comp.ubicacion_origen_id ? ubicaciones[comp.ubicacion_origen_id]?.nombre : '—'
        const destinoN = comp.ubicacion_destino_id ? ubicaciones[comp.ubicacion_destino_id]?.nombre : '—'
        return (
          <div style={s.modalBg} onClick={() => !action && setModal(null)}>
            <div style={s.modal} onClick={e => e.stopPropagation()}>
              <div style={s.modalTitle}>⇄ Ejecutar cambio</div>
              <div style={s.modalText}>
                <b>{origenN}</b> → <b>{destinoN}</b><br />
                Entregas <b>{fmt(entregado)}</b> a <b>{comp.egreso_dirigido_a || '—'}</b>.
                Confirma cuánto se recibió realmente en {destinoN}.
              </div>
              <label style={s.label}>Monto recibido (USD)</label>
              <input
                style={s.input} type="number" step="0.01" min="0.01"
                value={fxRecibidoStr}
                onChange={e => setFxRecibidoStr(e.target.value)}
                placeholder={entregado.toFixed(2)}
                disabled={action}
              />
              {!isNaN(recibidoNum) && Math.abs(fee) > 0.005 && (
                <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, fontSize: 12,
                  background: fee > 0 ? 'rgba(230,126,34,0.10)' : 'rgba(26,122,74,0.08)',
                  border: fee > 0 ? '1px solid #e67e2255' : '1px solid #1a7a4a55',
                  color: fee > 0 ? '#b8720a' : '#1a7a4a' }}>
                  {fee > 0
                    ? `Costo del cambio: ${fmt(fee)} (se entrega más de lo que se recibe)`
                    : `Ganancia del cambio: ${fmt(Math.abs(fee))}`}
                </div>
              )}
              <div style={s.btnRow}>
                <button style={s.btnGreen} onClick={() => egresoEjecutarCambio()} disabled={action}>
                  {action ? 'Procesando…' : '⇄ Confirmar cambio'}
                </button>
                <button style={s.btnSec} onClick={() => setModal(null)} disabled={action}>Cancelar</button>
              </div>
            </div>
          </div>
        )
      })()}

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

      {prestModal && (
        <PrestamoNegativoModal
          prompt={prestModal.prompt}
          saving={action}
          onConfirm={prestModal.resume}
          onCancel={() => setPrestModal(null)}
        />
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
  isRequester?: boolean,
): { label: string; modal: 'recibi' | 'entregar' | 'depositar' | 'ejecutar' | 'cambiar' } | null {
  const isAdmin   = permissions.tesoreria_admin || permissions.npa_can_admin
  const canPickup = permissions.tesoreria_can_pickup

  // Separation of duties by who physically holds the cash at each step:
  //   • Mirla-side steps (she RECEIVES the cash, then hands it to the
  //     bancarizador) → only the requester (Mirla) or an admin may confirm.
  //     NEVER Tesorería: she is handing the cash OVER and cannot confirm its
  //     receipt on Mirla's behalf.
  //   • Tesorería-side steps (directa hand-off straight to bancarizador, and
  //     recording the bank deposit) → pickup or admin.
  const canMirla     = !!isRequester || isAdmin
  const canTesoreria = canPickup     || isAdmin

  if (comp.egreso_tipo === 'BANCARIZACION') {
    const ruta = effectiveRuta(comp, origenCodigo)
    const isUSDT = origenCodigo === 'USDT_WALLET'
    if (comp.estado === 'SOLICITADO') {
      if (ruta === 'directa') {
        // Tesorería hands cash/USDT straight to the bancarizador (no Mirla).
        return canTesoreria
          ? { label: isUSDT ? '→ Transferir USDT al bancarizador' : '→ Entregar al bancarizador', modal: 'entregar' }
          : null
      }
      // via_mirla: only Mirla can confirm she physically received the cash.
      return canMirla ? { label: '✓ Recibí el efectivo', modal: 'recibi' } : null
    }
    if (comp.estado === 'EN_PODER_MIRLA') {
      // via_mirla: Mirla holds the cash and hands it to the bancarizador.
      return canMirla ? { label: '→ Entregar al bancarizador', modal: 'entregar' } : null
    }
    if (comp.estado === 'ENTREGADO_BANCARIZADOR' || comp.estado === 'DEPOSITADO_PARCIAL') {
      // Recording the bank deposit(s) — Tesorería / admin reconciles. Stays
      // available through DEPOSITADO_PARCIAL until deposits net to zero.
      return canTesoreria ? { label: '→ Registrar depósito', modal: 'depositar' } : null
    }
    return null
  }
  if (comp.egreso_tipo === 'CAMBIO_BS') {
    // Tesorería-side both steps: Viviana hands the cash out and later
    // confirms the Bs arrived. Admin can always act.
    if (comp.estado === 'SOLICITADO')
      return canTesoreria ? { label: '→ Entregar efectivo al cambista', modal: 'entregar' } : null
    if (comp.estado === 'ENTREGADO_BANCARIZADOR')
      return canTesoreria ? { label: '✓ Confirmar Bs recibidos', modal: 'depositar' } : null
    return null
  }
  if (comp.egreso_tipo === 'CAJA_CHICA_REPO' || comp.egreso_tipo === 'VENDOR_PAGO') {
    if (comp.estado === 'SOLICITADO') {
      return canTesoreria ? { label: '✓ Ejecutar egreso', modal: 'ejecutar' } : null
    }
    return null
  }
  if (comp.egreso_tipo === 'CAMBIO_USDT') {
    if (comp.estado === 'SOLICITADO') {
      const canFX = canTesoreria || (permissions as any)?.can_manage_usdt === true
      return canFX ? { label: '⇄ Ejecutar cambio', modal: 'cambiar' } : null
    }
    return null
  }
  if (comp.egreso_tipo === 'DEVOLUCION_CLIENTE') {
    // Sin acción aquí: se aprueba en /tesoreria/confirmar y se paga desde
    // /tesoreria/caja-chica. Esta página es solo consulta/impresión.
    return null
  }
  return null
}

// For flow 2b — which modal to auto-open when the user arrives via QR scan.
function nextEgresoModal(
  comp: Comprobante,
  permissions: any,
  origenCodigo?: string | null,
  isRequester?: boolean,
): 'recibi' | 'entregar' | 'depositar' | 'ejecutar' | 'cambiar' | null {
  const a = egresoNextAction(comp, permissions, origenCodigo, isRequester)
  return a ? a.modal : null
}

// ─── Find-or-create a bank_transactions row for a bancarización deposit ────
// The BofA email auto-ingest (and statement loaders) may have ALREADY created
// this deposit. A unique constraint on (cuenta, referencia) rejects a second
// insert with 409, so we link to the existing row first and only insert when
// the deposit isn't in the system yet. Returns the bank_transactions id.
async function upsertDepositTx(payload: any): Promise<string> {
  if (payload.cuenta && payload.referencia) {
    const { data: existing } = await supabase
      .from('bank_transactions')
      .select('id')
      .eq('cuenta', payload.cuenta)
      .ilike('referencia', String(payload.referencia).trim())
      .limit(1)
    if (existing && existing.length > 0) {
      const id = (existing[0] as any).id
      // Link, don't duplicate: tag the ingested row as the bancarización.
      await supabase.from('bank_transactions').update({
        es_bancarizacion: true,
        matched: true,
        banc_depositante: payload.banc_depositante || null,
      }).eq('id', id)
      return id
    }
  }
  const { data, error } = await supabase
    .from('bank_transactions').insert(payload).select('id').single()
  if (error) throw new Error('No se pudo crear el registro bancario: ' + error.message)
  if (!data) throw new Error('No se obtuvo ID del registro bancario (revisa RLS de bank_transactions)')
  return (data as any).id
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