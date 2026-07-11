// TARGET: autocore-npa/app/tesoreria/page.tsx
// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/page.tsx
// AutoCore NPA — Tesorería Dashboard
//
// Permissions:
//   - tesoreria_can_view_balance  → required to access (anyone with any treasury flag has this)
//   - tesoreria_can_pickup        → enables "Pickup" actions on pending ingresos
//   - tesoreria_can_approve_salida → enables "Aprobar" actions on pending salidas
//
// Shows: 3 location balances, pending pickups, pending salidas, recent movements.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../supabase'
import AdminShell from '../components/AdminShell'
import { useAuthGate } from '../components/useAuthGate'
import SessionErrorScreen from '../components/SessionErrorScreen'
import { useIsMobile } from '../components/useIsMobile'

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
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const d = new Date(iso)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getFullYear()}`
}
const minutesAgo = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'hace un momento'
  if (min < 60) return `hace ${min} min`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `hace ${hr} h`
  const days = Math.floor(hr / 24)
  return `hace ${days} d`
}

// ─── Styles ───────────────────────────────────────────────────────────────
const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  content: { padding: '32px', maxWidth: '1500px', margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap' as const, gap: 16 },
  title: { fontSize: '24px', fontWeight: 700, color: 'var(--text-primary)' },
  subtitle: { fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: '4px' },
  btnRed: { padding: '10px 22px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnSec: { padding: '10px 18px', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '20px', marginBottom: 20 },
  kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 20 },
  kpiCard: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 22px', display: 'flex', flexDirection: 'column' as const, gap: 6 },
  kpiLabel: { fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.5 },
  kpiName:  { fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 },
  kpiValue: { fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'monospace' },
  kpiHint:  { fontSize: 11, color: 'var(--text-secondary)' },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 10 },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th: { padding: '10px 12px', textAlign: 'left' as const, fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.5, borderBottom: '1px solid var(--border)' },
  td: { padding: '12px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' },
  badge: { display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  empty: { padding: '40px 20px', textAlign: 'center' as const, color: 'var(--text-secondary)', fontSize: 13 },
  pillBtn: { padding: '5px 11px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none' },
  // Two-column board
  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 },
  colCard: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 },
  colHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  colDot: (c: string) => ({ width: 9, height: 9, borderRadius: '50%', background: c }),
  colTitle: { fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', textTransform: 'uppercase' as const, letterSpacing: 1 },
  colCount: { marginLeft: 'auto', fontSize: 12, fontWeight: 800, color: 'var(--text-secondary)' },
  // A pending row, shaded by state
  itemRow: (accent: string, bg: string) => ({
    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
    borderRadius: 9, marginBottom: 7, cursor: 'pointer',
    background: bg, borderLeft: `3px solid ${accent}`,
  }),
  itemNum: { fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' },
  itemConcepto: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  itemMeta: { fontSize: 11, color: 'var(--text-secondary)' },
  itemMonto: (c: string) => ({ marginLeft: 'auto', fontFamily: 'monospace', fontSize: 14, fontWeight: 800, color: c, whiteSpace: 'nowrap' as const }),
  stateChip: (accent: string) => ({
    display: 'inline-block', padding: '2px 8px', borderRadius: 999,
    fontSize: 9, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase' as const,
    background: accent + '22', color: accent,
  }),
  movItem: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 4px', borderBottom: '1px solid var(--border)' },
}

// Estado → { label, accent color, soft background } for shading pending items.
const ESTADO_STYLE: Record<string, { label: string; accent: string; bg: string }> = {
  PENDIENTE_PICKUP:       { label: 'Por recoger',  accent: '#e67e22', bg: 'rgba(230,126,34,0.08)' },
  SOLICITADO:             { label: 'Solicitado',   accent: '#b8720a', bg: 'rgba(184,114,10,0.08)' },
  EN_PODER_MIRLA:         { label: 'En poder Mirla', accent: '#3b82f6', bg: 'rgba(59,130,246,0.08)' },
  ENTREGADO_BANCARIZADOR: { label: 'Con bancarizador', accent: '#8b5cf6', bg: 'rgba(139,92,246,0.08)' },
  DEPOSITADO_PARCIAL: { label: 'Depósito parcial', accent: '#b8720a', bg: 'rgba(184,114,10,0.08)' },
}

const COLORS = {
  PUNTO_COBRO: '#e67e22',
  CAJA_PRINCIPAL: '#BB162B',
  CAJA_CHICA: '#3b82f6',
}

// ── Money-lifecycle visual: 4 active stages, left → right ───────────────────
// Once a bancarización is DEPOSITADO it drops off the graph (money is out).
// Each stage is a place the money physically sits.
const LIFECYCLE_STAGES = [
  { key: 'RECIBIDO', label: 'Recibido',    place: 'Punto de Cobro · Mirla',                            accent: '#e67e22', bg: 'rgba(230,126,34,0.10)' },
  { key: 'RECOGIDO', label: 'Recogido',    place: 'Tesorería · Caja Principal',                        accent: '#BB162B', bg: 'rgba(187,22,43,0.10)' },
  { key: 'ASIGNADO', label: 'Pendiente bancarizar', place: 'En Motocentro · Mirla → bancarizador',     accent: '#b8720a', bg: 'rgba(184,114,10,0.12)' },
  { key: 'TRANSITO', label: 'Con bancarizador',     place: 'Bancarizador → banco',                     accent: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
]

const lc: any = {
  wrap: { display: 'flex', alignItems: 'stretch', gap: 0, marginTop: 4 },
  stage: (accent: string, bg: string, clickable: boolean) => ({
    flex: 1, position: 'relative' as const, padding: '16px 12px',
    borderRadius: 10, border: `1px solid ${accent}33`,
    borderTop: `3px solid ${accent}`,
    background: bg, cursor: clickable ? 'pointer' : 'default',
    textAlign: 'center' as const,
  }),
  label: { fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' },
  place: { fontSize: 9, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.3 },
  amount: (accent: string) => ({ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: accent, marginTop: 10 }),
  count: { fontSize: 10, color: 'var(--text-secondary)', marginTop: 3 },
  arrow: { display: 'flex', alignItems: 'center', padding: '0 6px', color: 'var(--text-secondary)', fontSize: 16, fontWeight: 800 },
  total: { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' as const },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12 },
  summaryCard: { padding: '12px 14px', borderRadius: 9, background: 'var(--bg-deep)', textAlign: 'center' as const },
  summaryNum: { fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: 'var(--text-primary)' },
  summaryLabel: { fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1, marginTop: 3 },
  // Drill-in panel
  panel: { marginTop: 12, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' as const },
  panelHead: { padding: '10px 14px', background: 'var(--bg-deep)', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  panelRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderTop: '1px solid var(--border)', cursor: 'pointer' },
  panelNum: { fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' },
  panelConcepto: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  panelMeta: { fontSize: 11, color: 'var(--text-secondary)' },
  panelMonto: { marginLeft: 'auto', fontFamily: 'monospace', fontSize: 14, fontWeight: 800, color: '#BB162B', whiteSpace: 'nowrap' as const },
}


interface Ubicacion {
  id: string
  codigo: string
  nombre: string
  tipo: string
  saldo_actual_usd: number
  saldo_objetivo_usd: number | null
}

interface Comprobante {
  id: string
  numero: string
  tipo: string
  estado: string
  monto_usd: number
  concepto: string
  source_label: string | null
  solicitado_at: string
  ubicacion_origen_id: string | null
  ubicacion_destino_id: string | null
  egreso_tipo: string | null
  egreso_dirigido_a: string | null
  es_urgente: boolean | null
}

interface BancarizacionItem {
  id: string
  numero: string
  estado: string
  monto_usd: number
  monto_depositado: number | null // cumulative partial deposits (2026-06-12)
  monto_recibido: number | null  // from linked bank_transactions
  bancarizador_nombre: string | null
  concepto: string | null
  egreso_documento_url: string | null
  bank_transaction_id: string | null
  bank_cuenta: string | null     // motocentro/roframi/panama/UNKNOWN
  bank_referencia: string | null
  fecha_evento: string | null
}

interface BancResumen {
  thisMonthDespachado: number
  thisMonthRecibido: number
  thisMonthDiscrepancia: number
  thisMonthCount: number
  enTransitoMonto: number
  enTransitoCount: number
  saldoBancarizadoresNeto: number
}

interface Movimiento {
  id: string
  fecha: string
  tipo: string
  monto_usd: number
  signo: number
  saldo_resultante: number | null
  descripcion: string | null
  source_label: string | null
  ubicacion_id: string
  comprobante_id: string | null
}

// ─── Cash vaults section (Efectivo + USDT) — clickable drill-down ──────────
// Self-contained: fetches movimientos for the four treasury vaults and renders
// a "Todos" merged view plus per-vault drill-downs. A handoff "lote" collapses
// to one line that expands into the ingresos that composed it (read from the
// PICKUP_TRANSFER legs each batch writes, joined to the comprobante for the
// client name + recibo ref). Bancos (Zelle/Wire) is intentionally excluded —
// that lives in the Bancos module. Running balance is computed from the
// authoritative ubicacion.saldo_actual_usd, walking backward through the shown
// entries; per-row saldo_resultante is NOT trusted (stale under the pooler).
const VAULT_CODES = ['PC_MIRLA', 'CAJA_PPAL', 'USDT_WALLET', 'CAJA_CHICA']
const VAULT_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  efectivo: { label: 'Efectivo', bg: 'rgba(26,122,74,0.12)', fg: '#1a7a4a' },
  usdt:     { label: 'USDT',     bg: 'rgba(184,114,10,0.14)', fg: '#b8720a' },
}
const vaultType = (codigo: string) => (codigo === 'USDT_WALLET' ? 'usdt' : 'efectivo')

interface CashMov {
  id: string; fecha: string; tipo: string; monto_usd: number; signo: number
  descripcion: string | null; source_label: string | null
  ubicacion_id: string; comprobante_id: string | null
}
interface LedgerEntry {
  key: string; fecha: string; ubicacion_id: string; signedSum: number
  label: string; isLote: boolean; members: CashMov[]
  // Non-lote rows keep their comprobante link so the dashboard row can jump
  // straight to /tesoreria/comprobante?id=… (null = plain movimiento).
  comprobanteId: string | null
}

// Pull the batch number a PICKUP_TRANSFER / HANDOFF_TESORERIA leg belongs to.
// PICKUP_TRANSFER descripcion: "… (entrega H-0042) · <comprobante#>"
// HANDOFF_TESORERIA descripcion: "… (excedente) · batch H-0042"
const batchOf = (m: CashMov): string | null => {
  const d = m.descripcion || ''
  let mm = d.match(/\(entrega ([^)]+)\)/i)
  if (mm) return mm[1].trim()
  mm = d.match(/batch\s+([A-Za-z0-9._-]+)/i)
  if (mm) return mm[1].trim()
  return null
}

// Collapse handoff legs that share (batch, vault, direction) into one entry.
const buildEntries = (movs: CashMov[]): LedgerEntry[] => {
  const out: LedgerEntry[] = []
  const acc: Record<string, LedgerEntry> = {}
  for (const m of movs) {
    const isLeg = m.tipo === 'PICKUP_TRANSFER' || m.tipo === 'HANDOFF_TESORERIA'
    const batch = isLeg ? batchOf(m) : null
    if (batch) {
      const k = batch + '|' + m.ubicacion_id + '|' + (m.signo < 0 ? '-' : '+')
      let e = acc[k]
      if (!e) {
        e = {
          key: 'lote-' + k, fecha: m.fecha, ubicacion_id: m.ubicacion_id, signedSum: 0,
          label: (m.signo < 0 ? 'Entrega a tesorería · Lote ' : 'Entrega recibida · Lote ') + batch,
          isLote: true, members: [], comprobanteId: null,
        }
        acc[k] = e; out.push(e)
      }
      e.members.push(m)
      e.signedSum += m.signo * m.monto_usd
      if (m.fecha > e.fecha) e.fecha = m.fecha
    } else {
      out.push({
        key: m.id, fecha: m.fecha, ubicacion_id: m.ubicacion_id,
        signedSum: m.signo * m.monto_usd,
        label: m.source_label || m.descripcion || m.tipo,
        isLote: false, members: [], comprobanteId: m.comprobante_id || null,
      })
    }
  }
  out.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0))
  return out
}

function CashVaultsSection({ ubicaciones, isMobile }: { ubicaciones: Ubicacion[]; isMobile: boolean }) {
  const router = useRouter()
  const [selected, setSelected] = useState<string>('TODOS')
  const [movs, setMovs] = useState<CashMov[]>([])
  const [cmap, setCmap] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const vaults = useMemo(
    () => VAULT_CODES.map(c => ubicaciones.find(u => u.codigo === c)).filter(Boolean) as Ubicacion[],
    [ubicaciones]
  )
  const vaultIds = useMemo(() => vaults.map(v => v.id), [vaults])
  const idToVault = useMemo(() => {
    const m: Record<string, Ubicacion> = {}
    vaults.forEach(v => { m[v.id] = v })
    return m
  }, [vaults])
  const totalAll = useMemo(() => vaults.reduce((sum, v) => sum + Number(v.saldo_actual_usd || 0), 0), [vaults])

  useEffect(() => {
    let cancelled = false
    if (vaultIds.length === 0) { setLoading(false); return }
    ;(async () => {
      setLoading(true)
      const { data } = await supabase
        .from('tesoreria_movimientos')
        .select('id, fecha, tipo, monto_usd, signo, descripcion, source_label, ubicacion_id, comprobante_id')
        .in('ubicacion_id', vaultIds)
        .order('fecha', { ascending: false })
        .limit(150)
      const rows = (data || []) as CashMov[]
      const cids = Array.from(new Set(rows.map(r => r.comprobante_id).filter(Boolean))) as string[]
      const cm: Record<string, any> = {}
      if (cids.length > 0) {
        const { data: cs } = await supabase
          .from('tesoreria_comprobantes')
          .select('id, numero, contraparte_nombre, recibo_numero')
          .in('id', cids)
        for (const c of (cs || []) as any[]) cm[c.id] = c
      }
      if (cancelled) return
      setMovs(rows); setCmap(cm); setLoading(false)
    })()
    return () => { cancelled = true }
  }, [vaultIds])

  const toggle = (k: string) => setExpanded(e => ({ ...e, [k]: !e[k] }))

  const scopeMovs = useMemo(
    () => (selected === 'TODOS' ? movs : movs.filter(m => idToVault[m.ubicacion_id]?.codigo === selected)),
    [movs, selected, idToVault]
  )
  const entries = useMemo(() => buildEntries(scopeMovs).slice(0, 10), [scopeMovs])

  const selectedVault = selected === 'TODOS' ? null : vaults.find(v => v.codigo === selected) || null
  // Walk the authoritative balance backward: newest entry lands on the current
  // saldo; each older entry removes the newer entries' net effect.
  const saldoAfter: number[] = useMemo(() => {
    if (!selectedVault) return []
    const out: number[] = []
    let running = Number(selectedVault.saldo_actual_usd || 0)
    for (let i = 0; i < entries.length; i++) { out.push(running); running -= entries[i].signedSum }
    return out
  }, [entries, selectedVault])

  const memberLabel = (m: CashMov) => {
    if (!m.comprobante_id) return { name: 'Excedente (entrega directa)', ref: '—' }
    const c = cmap[m.comprobante_id]
    return {
      name: c?.contraparte_nombre || ('Comprobante ' + (c?.numero || '')),
      ref: c?.recibo_numero || c?.numero || '—',
    }
  }

  const card = (code: string, label: string, bal: number) => (
    <div key={code} onClick={() => setSelected(code)} style={{
      cursor: 'pointer', background: 'var(--bg-card)', borderRadius: 10, padding: '14px 16px',
      border: selected === code ? '2px solid #BB162B' : '2px solid transparent',
    }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{fmt(bal)}</div>
    </div>
  )

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={s.sectionTitle}>Movimientos de efectivo y USDT</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
        Toca Todos para ver todos los movimientos, o una bóveda para ver los suyos
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : `repeat(${vaults.length + 1}, 1fr)`, gap: 12, marginBottom: 16 }}>
        {card('TODOS', 'Todos', totalAll)}
        {vaults.map(v => card(v.codigo, v.nombre, Number(v.saldo_actual_usd || 0)))}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {selected === 'TODOS' ? 'Todas las bóvedas · últimos movimientos' : (selectedVault?.nombre || '') + ' · últimos movimientos'}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {selected === 'TODOS' ? 'total ' + fmt(totalAll) : 'saldo actual ' + fmt(Number(selectedVault?.saldo_actual_usd || 0))}
        </span>
      </div>

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--text-secondary)' }}>Cargando…</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--text-secondary)' }}>Sin movimientos</div>
        ) : entries.map((e, i) => {
          const outflow = e.signedSum < 0
          const color = outflow ? '#BB162B' : '#1a7a4a'
          const sign = outflow ? '−' : '+'
          const badge = selected === 'TODOS' ? VAULT_BADGE[vaultType(idToVault[e.ubicacion_id]?.codigo || '')] : null
          const open = !!expanded[e.key]
          // Non-lote rows with a comprobante link jump to the detail page.
          const clickable = e.isLote || !!e.comprobanteId
          return (
            <div key={e.key}>
              <div
                onClick={
                  e.isLote ? () => toggle(e.key)
                  : e.comprobanteId ? () => router.push('/tesoreria/comprobante?id=' + e.comprobanteId)
                  : undefined
                }
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                  borderBottom: '1px solid var(--border)', cursor: clickable ? 'pointer' : 'default',
                  background: e.isLote ? 'var(--bg-deep)' : 'transparent',
                }}
              >
                {e.isLote && (
                  <span style={{ fontSize: 16, lineHeight: 1, color: 'var(--text-secondary)', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: e.isLote ? 700 : 400, color: 'var(--text-primary)' }}>{e.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    {badge && <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 6, background: badge.bg, color: badge.fg }}>{badge.label}</span>}
                    <span>{fmtDateTime(e.fecha)}{e.isLote ? ' · ' + e.members.length + ' ingreso' + (e.members.length !== 1 ? 's' : '') : ''}</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 13, color }}>{sign}{fmt(Math.abs(e.signedSum))}</div>
                  {selected !== 'TODOS' && (
                    <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>{fmt(saldoAfter[i])}</div>
                  )}
                </div>
                {!e.isLote && e.comprobanteId && (
                  <span style={{ fontSize: 16, lineHeight: 1, color: 'var(--text-secondary)' }}>›</span>
                )}
              </div>
              {e.isLote && open && (
                <div style={{ padding: '4px 14px 12px 38px', background: 'var(--bg-deep)', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '8px 0 6px' }}>Compuesto por estos ingresos:</div>
                  {e.members.map(m => {
                    const ml = memberLabel(m)
                    return (
                      <div
                        key={m.id}
                        onClick={m.comprobante_id ? () => router.push('/tesoreria/comprobante?id=' + m.comprobante_id) : undefined}
                        style={{ display: 'flex', gap: 10, padding: '6px 0', borderTop: '1px solid var(--border)', cursor: m.comprobante_id ? 'pointer' : 'default', alignItems: 'center' }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{ml.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{fmtDateTime(m.fecha)} · Ref {ml.ref}</div>
                        </div>
                        <div style={{ fontFamily: 'monospace', fontSize: 12.5, color: 'var(--text-primary)' }}>{fmt(m.monto_usd)}</div>
                        {m.comprobante_id && (
                          <span style={{ fontSize: 14, lineHeight: 1, color: 'var(--text-secondary)' }}>›</span>
                        )}
                      </div>
                    )
                  })}
                  <div style={{ display: 'flex', gap: 10, padding: '8px 0 2px', borderTop: '1px solid var(--border)', marginTop: 2 }}>
                    <div style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>Total compone</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 800, color: '#1a7a4a' }}>{fmt(Math.abs(e.signedSum))}</div>
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

export default function TesoreriaDashboardPage() {
  const router = useRouter()
  const isMobile = useIsMobile()
  // Layer 2: auth gate. Data-loading `loading` below is separate.
  const gate = useAuthGate(p =>
    p.tesoreria_can_view_balance ||
    p.tesoreria_can_pickup ||
    p.tesoreria_can_dispatch ||
    p.tesoreria_can_approve_salida ||
    p.tesoreria_admin
  )
  const { permissions } = gate

  const [loading, setLoading] = useState(true)
  const [ubicaciones, setUbicaciones] = useState<Ubicacion[]>([])
  const [pendingIngresos, setPendingIngresos] = useState<Comprobante[]>([])
  const [pendingSalidas, setPendingSalidas] = useState<Comprobante[]>([])
  const [depositadoEgresos, setDepositadoEgresos] = useState<Comprobante[]>([])
  // Which lifecycle stage is expanded into a drill-in list (null = none).
  const [expandedStage, setExpandedStage] = useState<string | null>(null)
  // ── Bancarizaciones (NEW 2026-05-26) ──────────────────────────────────
  const [bancsThisMonth, setBancsThisMonth] = useState<BancarizacionItem[]>([])
  const [bancResumen, setBancResumen] = useState<BancResumen>({
    thisMonthDespachado: 0, thisMonthRecibido: 0, thisMonthDiscrepancia: 0,
    thisMonthCount: 0, enTransitoMonto: 0, enTransitoCount: 0, saldoBancarizadoresNeto: 0,
  })

  useEffect(() => {
    if (gate.status === 'denied') {
      router.replace('/dashboard')
      return
    }
    if (gate.status === 'ok') {
      load()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.status])

  async function load() {
    setLoading(true)
    // 2026-05-21: recompute saldos from movimiento truth before fetching.
    // This guarantees the dashboard never shows drift from a missed trigger
    // fire. The RPC is idempotent and fast (~10ms).
    try {
      await supabase.rpc('tesoreria_recompute_saldos')
    } catch (e) {
      // Non-fatal — fall through and show whatever's there
      console.warn('[tesoreria/load] recompute RPC warning', e)
    }

    // First day of the current calendar month — the summary window.
    const now = new Date()
    const since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const [ubicResp, ingresosResp, egresosResp, depositadoResp] = await Promise.all([
      supabase.from('tesoreria_ubicaciones').select('*').eq('activa', true),
      supabase.from('tesoreria_comprobantes')
        .select('*')
        .eq('tipo', 'INGRESO')
        .in('estado', ['PENDIENTE_PICKUP'])
        .order('solicitado_at', { ascending: false })
        .limit(20),
      // Phase 4 (2026-05-16): egresos in progress. The egreso module uses
      // tipo='EGRESO' (not 'SALIDA'). Pending = anything not yet finished.
      supabase.from('tesoreria_comprobantes')
        .select('*')
        .eq('tipo', 'EGRESO')
        .in('estado', ['SOLICITADO', 'EN_PODER_MIRLA', 'ENTREGADO_BANCARIZADOR', 'DEPOSITADO_PARCIAL'])
        .order('solicitado_at', { ascending: false })
        .limit(20),
      // Finished egresos this calendar month — the summary block below the
      // money-lifecycle graph.
      supabase.from('tesoreria_comprobantes')
        .select('*')
        .eq('tipo', 'EGRESO')
        .in('estado', ['DEPOSITADO', 'EJECUTADO'])
        .gte('solicitado_at', since)
        .order('solicitado_at', { ascending: false })
        .limit(100),
    ])

    setUbicaciones((ubicResp.data || []) as Ubicacion[])
    setPendingIngresos((ingresosResp.data || []) as Comprobante[])
    setPendingSalidas((egresosResp.data || []) as Comprobante[])
    setDepositadoEgresos((depositadoResp.data || []) as Comprobante[])

    // ── Bancarizaciones del mes — NEW 2026-05-26 ─────────────────────────
    // Pull every BANCARIZACION comprobante closed this calendar month plus
    // any still in flight. Then join with bank_transactions for the deposit
    // side (monto recibido + cuenta + ref).
    try {
      const { data: bancComps } = await supabase
        .from('tesoreria_comprobantes')
        .select('id, numero, estado, monto_usd, monto_depositado, concepto, bancarizador_nombre, egreso_documento_url, bank_transaction_id, cerrado_at, solicitado_at')
        .eq('egreso_tipo', 'BANCARIZACION')
        .or(`cerrado_at.gte.${since},estado.in.(SOLICITADO,EN_PODER_MIRLA,ENTREGADO_BANCARIZADOR,DEPOSITADO_PARCIAL)`)
        .order('cerrado_at', { ascending: false, nullsFirst: false })
        .limit(100)
      const comps = (bancComps || []) as any[]

      // Hydrate bank tx side
      const btIds = comps.map(c => c.bank_transaction_id).filter(Boolean)
      const btMap: Record<string, any> = {}
      if (btIds.length > 0) {
        const { data: bts } = await supabase
          .from('bank_transactions')
          .select('id, monto_usd, cuenta, referencia, fecha')
          .in('id', btIds)
        for (const t of (bts || []) as any[]) btMap[t.id] = t
      }

      const items: BancarizacionItem[] = comps.map(c => {
        const bt = c.bank_transaction_id ? btMap[c.bank_transaction_id] : null
        return {
          id: c.id, numero: c.numero, estado: c.estado,
          monto_usd: Number(c.monto_usd) || 0,
          monto_depositado: Number(c.monto_depositado) || 0,
          monto_recibido: bt ? Number(bt.monto_usd) : null,
          bancarizador_nombre: c.bancarizador_nombre,
          concepto: c.concepto,
          egreso_documento_url: c.egreso_documento_url,
          bank_transaction_id: c.bank_transaction_id,
          bank_cuenta: bt ? bt.cuenta : null,
          bank_referencia: bt ? bt.referencia : null,
          fecha_evento: c.cerrado_at || c.solicitado_at,
        }
      })
      setBancsThisMonth(items)

      // Saldo neto across all active bancarizadores
      const { data: bancs } = await supabase
        .from('bancarizadores')
        .select('saldo_usd')
        .eq('activo', true)
      const saldoNeto = (bancs || []).reduce((s: number, r: any) => s + (Number(r.saldo_usd) || 0), 0)

      // Resumen
      const depositados = items.filter(i => i.estado === 'DEPOSITADO')
      const parciales   = items.filter(i => i.estado === 'DEPOSITADO_PARCIAL')
      const enTransito  = items.filter(i =>
        i.estado === 'ENTREGADO_BANCARIZADOR' || i.estado === 'EN_PODER_MIRLA' || i.estado === 'SOLICITADO')
      const despachado = depositados.reduce((s, i) => s + i.monto_usd, 0)
      // Partials-aware: monto_depositado is the cumulative truth; legacy rows
      // fall back to the single linked tx amount (monto_recibido) or expected.
      const recibido   = depositados.reduce((s, i) => s + ((Number(i.monto_depositado) || 0) > 0 ? Number(i.monto_depositado) : (i.monto_recibido ?? i.monto_usd)), 0)
                       + parciales.reduce((s, i) => s + (Number(i.monto_depositado) || 0), 0)

      setBancResumen({
        thisMonthDespachado: despachado,
        thisMonthRecibido:   recibido,
        thisMonthDiscrepancia: recibido - despachado,
        thisMonthCount:      depositados.length,
        enTransitoMonto:     enTransito.reduce((s, i) => s + i.monto_usd, 0)
                           + parciales.reduce((s, i) => s + Math.max(0, i.monto_usd - (Number(i.monto_depositado) || 0)), 0),
        enTransitoCount:     enTransito.length + parciales.length,
        saldoBancarizadoresNeto: saldoNeto,
      })
    } catch (e) {
      console.warn('[tesoreria] bancarizaciones load failure:', e)
    }

    setLoading(false)
  }

  const ubicMap = useMemo(() => {
    const m: Record<string, Ubicacion> = {}
    ubicaciones.forEach(u => { m[u.id] = u })
    return m
  }, [ubicaciones])

  const sortedUbic = useMemo(() => {
    const order: Record<string, number> = { PUNTO_COBRO: 1, CAJA_PRINCIPAL: 2, CAJA_CHICA: 3 }
    return [...ubicaciones].sort((a, b) => (order[a.tipo] || 99) - (order[b.tipo] || 99))
  }, [ubicaciones])

  // ── Money lifecycle — 4 active stages ─────────────────────────────────────
  // 2026-05-21 (new debit timing):
  //   • Bancarización 'via_mirla' debits source caja at EN_PODER_MIRLA
  //   • Bancarización 'directa' / USDT debit at ENTREGADO_BANCARIZADOR
  //   • Vendor + Caja Chica debit at EJECUTADO
  //   • Pago Fijo debits at creation
  //
  // So an egreso in SOLICITADO still has cash in the source caja (no mov yet).
  // An egreso in EN_PODER_MIRLA or ENTREGADO_BANCARIZADOR has cash that's
  // already physically left — it sits with Mirla or with the bancarizador.
  //
  // Lifecycle stages:
  //   Recibido  = PC_MIRLA saldo (after subtracting SOLICITADO-from-PC)
  //   Recogido  = CAJA_PPAL saldo (after subtracting SOLICITADO-from-CAJA)
  //   Pendiente bancarizar = egresos EN_PODER_MIRLA (cash with Mirla)
  //   Con bancarizador     = egresos ENTREGADO_BANCARIZADOR
  const lifecycle = useMemo(() => {
    const pcMirla  = ubicaciones.find(u => u.codigo === 'PC_MIRLA')
    const cajaPpal = ubicaciones.find(u => u.codigo === 'CAJA_PPAL')

    // Only SOLICITADO egresos still have cash in their source caja (no
    // movimiento yet). EN_PODER_MIRLA and ENTREGADO_BANCARIZADOR egresos
    // have already debited the source.
    const stillInSource = pendingSalidas.filter(c => c.estado === 'SOLICITADO')
    const enPoderMirla  = pendingSalidas.filter(c => c.estado === 'EN_PODER_MIRLA')
    const conBancarizador = pendingSalidas.filter(c => c.estado === 'ENTREGADO_BANCARIZADOR' || c.estado === 'DEPOSITADO_PARCIAL')

    // Partials: only the un-deposited remainder is still with the bancarizador.
    const sumFor = (list: Comprobante[]) => list.reduce((s, c) =>
      s + ((Number(c.monto_usd) || 0) - (c.estado === 'DEPOSITADO_PARCIAL' ? (Number((c as any).monto_depositado) || 0) : 0)), 0)

    const stillInSourceBy = (cajaId: string | undefined) =>
      stillInSource
        .filter(c => c.ubicacion_origen_id === cajaId)
        .reduce((s, c) => s + (Number(c.monto_usd) || 0), 0)

    const pcStillIn   = stillInSourceBy(pcMirla?.id)
    const ppalStillIn = stillInSourceBy(cajaPpal?.id)

    const recibidoRaw = Number(pcMirla?.saldo_actual_usd) || 0
    const recogidoRaw = Number(cajaPpal?.saldo_actual_usd) || 0

    // ASIGNADO now means "cash with Mirla, en route to bancarizador" —
    // egresos in EN_PODER_MIRLA. Plus any SOLICITADO egresos still waiting
    // (so the user sees both unstarted and en-route in one bucket).
    const asignadoItems = [...stillInSource, ...enPoderMirla]
    const asignadoAmount = sumFor(enPoderMirla)  // cash that physically left

    const stages: Record<string, { amount: number; count: number; items: Comprobante[] }> = {
      RECIBIDO: { amount: Math.max(0, recibidoRaw - pcStillIn),   count: 0, items: [] },
      RECOGIDO: { amount: Math.max(0, recogidoRaw - ppalStillIn), count: 0, items: [] },
      ASIGNADO: { amount: asignadoAmount, count: asignadoItems.length, items: asignadoItems },
      TRANSITO: { amount: sumFor(conBancarizador), count: conBancarizador.length, items: conBancarizador },
    }
    const total = stages.RECIBIDO.amount + stages.RECOGIDO.amount
                + stages.ASIGNADO.amount + stages.TRANSITO.amount

    // Summary (below the graph) — finished egresos in the last 30 days.
    const conciliado = depositadoEgresos.filter(c => c.estado === 'DEPOSITADO')
    const ejecutado  = depositadoEgresos.filter(c => c.estado === 'EJECUTADO')
    const summary = {
      conciliadoMonto: conciliado.reduce((s, c) => s + (Number(c.monto_usd) || 0), 0),
      conciliadoCount: conciliado.length,
      ejecutadoMonto:  ejecutado.reduce((s, c) => s + (Number(c.monto_usd) || 0), 0),
      ejecutadoCount:  ejecutado.length,
      totalSalidaMonto: depositadoEgresos.reduce((s, c) => s + (Number(c.monto_usd) || 0), 0),
    }

    return { stages, total, summary }
  }, [ubicaciones, pendingSalidas, depositadoEgresos])

  if (gate.status === 'error') {
    return <SessionErrorScreen />
  }
  if (gate.status === 'loading' || gate.status === 'denied' || loading) {
    return (
      <AdminShell active="tesoreria">
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-secondary)' }}>Cargando…</div>
      </AdminShell>
    )
  }

  const totalSystem = ubicaciones.reduce((sum, u) => sum + Number(u.saldo_actual_usd || 0), 0)

  return (
    <AdminShell active="tesoreria">
      <div style={{ ...s.content, padding: isMobile ? '16px 14px 32px' : '32px', maxWidth: isMobile ? '100%' : 1500 }}>

        {/* Header */}
        <div style={{ ...s.header, marginBottom: isMobile ? 16 : 24 }}>
          <div>
            <div style={s.subtitle}>TESORERÍA</div>
            <h1 style={{ ...s.title, fontSize: isMobile ? 20 : 24 }}>Posición de Caja</h1>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              Total Sistema: <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{fmt(totalSystem)}</strong>
            </div>
          </div>
          <div style={{
            display: 'flex', gap: 10,
            flexDirection: isMobile ? 'column' : 'row',
            width: isMobile ? '100%' : 'auto',
          }}>
            <button style={{ ...s.btnSec, width: isMobile ? '100%' : 'auto' }} onClick={() => load()}>↻ Refrescar</button>
            {(permissions.tesoreria_can_pickup || permissions.tesoreria_admin || permissions.npa_can_admin) && (
              <>
                <button style={{ ...s.btnSec, width: isMobile ? '100%' : 'auto' }} onClick={() => router.push('/tesoreria/entrega')}>📦 Entrega a Tesorería</button>
                <button style={{ ...s.btnSec, width: isMobile ? '100%' : 'auto' }} onClick={() => router.push('/tesoreria/historial')}>📋 Historial</button>
              </>
            )}
            {(permissions.tesoreria_can_view_balance || permissions.tesoreria_can_pickup || permissions.tesoreria_admin || permissions.npa_can_admin) && (
              <>
                <button style={{ ...s.btnSec, width: isMobile ? '100%' : 'auto' }} onClick={() => router.push('/tesoreria/consultas')}>🔍 Consultas</button>
                <button style={{ ...s.btnSec, width: isMobile ? '100%' : 'auto' }} onClick={() => router.push('/tesoreria/reportes')}>📊 Reportes</button>
              </>
            )}
            <button style={{ ...s.btnSec, width: isMobile ? '100%' : 'auto' }} onClick={() => router.push('/tesoreria/egresos/nuevo')}>+ Nuevo Egreso</button>
            <button style={{ ...s.btnRed, width: isMobile ? '100%' : 'auto' }} onClick={() => router.push('/tesoreria/ingresos/nuevo')}>+ Nuevo Ingreso</button>
          </div>
        </div>

        {/* Balance cards */}
        <div style={s.kpiGrid}>
          {sortedUbic.map(u => {
            const color = COLORS[u.tipo as keyof typeof COLORS] || '#6b7280'
            const target = u.saldo_objetivo_usd
            const offTarget = target && Math.abs(Number(u.saldo_actual_usd) - Number(target)) > 50
            return (
              <div key={u.id} style={{ ...s.kpiCard, borderLeft: `4px solid ${color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={s.kpiLabel}>{u.tipo.replace('_', ' ')}</span>
                  <span style={{ ...s.badge, background: color + '22', color }}>{u.codigo}</span>
                </div>
                <div style={s.kpiName}>{u.nombre}</div>
                <div style={s.kpiValue}>{fmt(u.saldo_actual_usd)}</div>
                {target && (
                  <div style={s.kpiHint}>
                    Objetivo: {fmt(target)}
                    {offTarget && (
                      <span style={{ color: '#b8720a', marginLeft: 6, fontWeight: 700 }}>
                        {Number(u.saldo_actual_usd) < Number(target) ? '↓ Bajo' : '↑ Alto'}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* ── Bancarización KPI card — NEW 2026-05-26 ─────────────────── */}
          <div
            style={{ ...s.kpiCard, borderLeft: '4px solid #8B5CF6', cursor: 'pointer' }}
            onClick={() => router.push('/tesoreria/reportes/bancarizaciones')}
            title="Ver reporte completo de bancarizaciones"
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={s.kpiLabel}>Bancarización</span>
              <span style={{ ...s.badge, background: '#8B5CF622', color: '#8B5CF6' }}>BANC</span>
            </div>
            <div style={s.kpiName}>Depositado este mes</div>
            <div style={s.kpiValue}>{fmt(bancResumen.thisMonthRecibido)}</div>
            <div style={s.kpiHint}>
              {bancResumen.thisMonthCount} depósito{bancResumen.thisMonthCount === 1 ? '' : 's'}
              {bancResumen.enTransitoMonto > 0 && (
                <span style={{ color: '#D97706', marginLeft: 6, fontWeight: 700 }}>
                  · En tránsito: {fmt(bancResumen.enTransitoMonto)}
                </span>
              )}
              {bancResumen.thisMonthDiscrepancia !== 0 && (
                <span style={{ color: bancResumen.thisMonthDiscrepancia > 0 ? '#16A34A' : '#BB162B', marginLeft: 6, fontWeight: 700 }}>
                  · Δ {bancResumen.thisMonthDiscrepancia > 0 ? '+' : ''}{fmt(bancResumen.thisMonthDiscrepancia)}
                </span>
              )}
            </div>
          </div>

          {/* ── Saldo Bancarizadores KPI card — NEW 2026-05-26 ──────────── */}
          <div
            style={{
              ...s.kpiCard,
              borderLeft: '4px solid ' + (
                bancResumen.saldoBancarizadoresNeto > 0 ? '#16A34A'
                : bancResumen.saldoBancarizadoresNeto < 0 ? '#BB162B'
                : '#6b7280'
              ),
              cursor: 'pointer',
            }}
            onClick={() => router.push('/tesoreria/bancarizadores')}
            title="Ver saldos por bancarizador"
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={s.kpiLabel}>Bancarizadores</span>
              <span style={{ ...s.badge, background: '#6b728022', color: '#6b7280' }}>SALDO</span>
            </div>
            <div style={s.kpiName}>Cuenta corriente neta</div>
            <div style={{
              ...s.kpiValue,
              color: bancResumen.saldoBancarizadoresNeto > 0 ? '#16A34A'
                   : bancResumen.saldoBancarizadoresNeto < 0 ? '#BB162B'
                   : 'var(--text-primary)',
            }}>
              {bancResumen.saldoBancarizadoresNeto >= 0 ? '+' : '-'}${Math.abs(bancResumen.saldoBancarizadoresNeto).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div style={s.kpiHint}>
              {bancResumen.saldoBancarizadoresNeto > 0 ? 'nos deben'
                : bancResumen.saldoBancarizadoresNeto < 0 ? 'les debemos'
                : 'en cero'}
            </div>
          </div>
        </div>

        {/* ── Money lifecycle: 4 active stages. Row on desktop, stacked on mobile ── */}
        <div style={s.card}>
          <h2 style={s.sectionTitle}>Ciclo del dinero — ¿dónde está?</h2>
          <div style={{ ...lc.wrap, flexDirection: isMobile ? 'column' : 'row' }}>
            {LIFECYCLE_STAGES.map((st, i) => {
              const data = lifecycle.stages[st.key]
              const clickable = data.items.length > 0
              const isOpen = expandedStage === st.key
              return (
                <div key={st.key} style={{
                  display: 'flex',
                  flexDirection: isMobile ? 'column' : 'row',
                  // Desktop: each wrapper shares the row equally (flex:1).
                  // Mobile: full-width block, height driven by content.
                  ...(isMobile ? { width: '100%' } : { flex: 1 }),
                }}>
                  <div
                    style={{
                      ...lc.stage(st.accent, st.bg, clickable),
                      // On mobile the per-stage wrapper is a column flex with
                      // no fixed height — `flex:1` there collapses the card to
                      // 0 height. Drop flex, take full width, size by content.
                      ...(isMobile ? { flex: 'none', width: '100%' } : {}),
                      outline: isOpen ? `2px solid ${st.accent}` : 'none',
                    }}
                    onClick={() => {
                      // Toggle the drill-in panel. Stages 1-2 are caja
                      // balances (no items) — not expandable.
                      if (!clickable) return
                      setExpandedStage(isOpen ? null : st.key)
                    }}
                    title={clickable ? 'Ver transacciones' : ''}
                  >
                    <div style={lc.label}>{st.label}</div>
                    <div style={lc.place}>{st.place}</div>
                    <div style={lc.amount(st.accent)}>{fmt(data.amount)}</div>
                    {data.count > 0 && (
                      <div style={lc.count}>
                        {data.count} egreso{data.count !== 1 ? 's' : ''} {isOpen ? '▲' : '▼'}
                      </div>
                    )}
                  </div>
                  {i < LIFECYCLE_STAGES.length - 1 && (
                    <div style={{ ...lc.arrow, padding: isMobile ? '4px 0' : '0 6px', alignSelf: 'center' }}>
                      {isMobile ? '↓' : '→'}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div style={lc.total}>
            Total en movimiento: <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{fmt(lifecycle.total)}</strong>
            {' · '}al conciliarse, el dinero sale del gráfico
          </div>

          {/* Drill-in panel — lists every egreso in the expanded stage */}
          {expandedStage && lifecycle.stages[expandedStage] && lifecycle.stages[expandedStage].items.length > 0 && (
            <div style={lc.panel}>
              <div style={lc.panelHead}>
                <span>
                  {LIFECYCLE_STAGES.find(x => x.key === expandedStage)?.label}
                  {' — '}{lifecycle.stages[expandedStage].items.length} transacci
                  {lifecycle.stages[expandedStage].items.length !== 1 ? 'ones' : 'ón'}
                </span>
                <span
                  style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}
                  onClick={() => setExpandedStage(null)}
                >
                  ✕ Cerrar
                </span>
              </div>
              {lifecycle.stages[expandedStage].items.map((c: Comprobante) => (
                <div
                  key={c.id}
                  style={lc.panelRow}
                  onClick={() => router.push(`/tesoreria/comprobante?id=${c.id}`)}
                >
                  <span style={lc.panelNum}>{c.numero}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={lc.panelConcepto}>
                      {c.es_urgente && <span style={{ color: '#BB162B' }}>🔴 </span>}
                      {c.concepto}
                    </div>
                    <div style={lc.panelMeta}>
                      {c.egreso_dirigido_a ? `Dirigido a: ${c.egreso_dirigido_a}` : '—'}
                    </div>
                  </div>
                  <span style={lc.panelMonto}>−{fmt(c.monto_usd)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Summary — finished egresos this calendar month */}
          <div style={{ ...lc.summaryGrid, gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)' }}>
            <div style={lc.summaryCard}>
              <div style={lc.summaryNum}>{fmt(lifecycle.summary.conciliadoMonto)}</div>
              <div style={lc.summaryLabel}>Bancarizado · este mes</div>
              <div style={lc.count}>{lifecycle.summary.conciliadoCount} depósito{lifecycle.summary.conciliadoCount !== 1 ? 's' : ''}</div>
            </div>
            <div style={lc.summaryCard}>
              <div style={lc.summaryNum}>{fmt(lifecycle.summary.ejecutadoMonto)}</div>
              <div style={lc.summaryLabel}>Pagos ejecutados · este mes</div>
              <div style={lc.count}>{lifecycle.summary.ejecutadoCount} pago{lifecycle.summary.ejecutadoCount !== 1 ? 's' : ''}</div>
            </div>
            <div style={lc.summaryCard}>
              <div style={lc.summaryNum}>{fmt(lifecycle.summary.totalSalidaMonto)}</div>
              <div style={lc.summaryLabel}>Total salidas · este mes</div>
              <div style={lc.count}>completado</div>
            </div>
          </div>
        </div>

        {/* ── Bancarizaciones del mes — NEW 2026-05-26 ───────────────────
            Inline list of every bancarización in the current month so Mirla
            sees each one without leaving the dashboard. Click → comprobante
            detail with receipt + AI review + discrepancy banner.
        */}
        {bancsThisMonth.length > 0 && (
          <div style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ ...s.sectionTitle, marginBottom: 0 }}>Bancarizaciones del mes — {bancsThisMonth.length}</h2>
              <button
                onClick={() => router.push('/tesoreria/reportes/bancarizaciones')}
                style={{
                  background: 'transparent', border: 'none', color: '#8B5CF6',
                  fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}
              >
                Ver reporte completo →
              </button>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>N°</th>
                    <th style={s.th}>Estado</th>
                    <th style={s.th}>Bancarizador</th>
                    <th style={{ ...s.th, textAlign: 'right' as const }}>Despachado</th>
                    <th style={{ ...s.th, textAlign: 'right' as const }}>Recibido</th>
                    <th style={{ ...s.th, textAlign: 'right' as const }}>Δ</th>
                    <th style={s.th}>Banco</th>
                    <th style={s.th}>Ref</th>
                    <th style={s.th}>Fecha</th>
                    <th style={s.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {bancsThisMonth.slice(0, 15).map(b => {
                    const delta = b.monto_recibido != null ? b.monto_recibido - b.monto_usd : null
                    const estadoColor = (
                      b.estado === 'DEPOSITADO' ? '#16A34A' :
                      b.estado === 'DEPOSITADO_PARCIAL' ? '#b8720a' :
                      b.estado === 'ENTREGADO_BANCARIZADOR' ? '#D97706' :
                      b.estado === 'EN_PODER_MIRLA' ? '#7C3AED' :
                      b.estado === 'ANULADO' ? '#EF4444' : '#6b7280'
                    )
                    const bankLabel = (
                      b.bank_cuenta === 'motocentro'      ? 'BofA Motocentro' :
                      b.bank_cuenta === 'roframi'         ? 'BofA Roframi' :
                      b.bank_cuenta === 'roframi_regions' ? 'Regions Roframi' :
                      b.bank_cuenta === 'panama'          ? 'Mercantil PA' :
                      b.bank_cuenta === 'UNKNOWN'         ? '⚠ Sin clasificar' :
                      b.bank_cuenta || '—'
                    )
                    return (
                      <tr key={b.id} style={{ cursor: 'pointer' }}
                        onClick={() => router.push('/tesoreria/comprobante?id=' + b.id)}>
                        <td style={{ ...s.td, fontFamily: 'monospace', fontWeight: 700 }}>{b.numero}</td>
                        <td style={s.td}>
                          <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: estadoColor + '22', color: estadoColor, textTransform: 'uppercase' as const }}>
                            {b.estado.replace('_', ' ')}
                          </span>
                        </td>
                        <td style={s.td}>{b.bancarizador_nombre || '—'}</td>
                        <td style={{ ...s.td, textAlign: 'right' as const, fontFamily: 'monospace' }}>
                          {fmt(b.monto_usd)}
                        </td>
                        <td style={{ ...s.td, textAlign: 'right' as const, fontFamily: 'monospace' }}>
                          {b.monto_recibido != null ? fmt(b.monto_recibido) : '—'}
                        </td>
                        <td style={{
                          ...s.td, textAlign: 'right' as const, fontFamily: 'monospace',
                          color: delta == null ? 'var(--text-secondary)' : delta > 0 ? '#16A34A' : delta < 0 ? '#BB162B' : 'var(--text-secondary)',
                          fontWeight: delta != null && delta !== 0 ? 700 : 400,
                        }}>
                          {delta != null && delta !== 0 ? ((delta > 0 ? '+' : '') + fmt(delta)) : (delta === 0 ? '$0' : '—')}
                        </td>
                        <td style={s.td}>
                          {b.bank_cuenta === 'UNKNOWN'
                            ? <span style={{ color: '#D97706', fontWeight: 600 }}>{bankLabel}</span>
                            : bankLabel}
                        </td>
                        <td style={{ ...s.td, fontFamily: 'monospace', fontSize: 11 }}>{b.bank_referencia || '—'}</td>
                        <td style={{ ...s.td, fontSize: 11 }}>{fmtDate(b.fecha_evento)}</td>
                        <td style={s.td} onClick={e => e.stopPropagation()}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {b.egreso_documento_url && (
                              <a href={b.egreso_documento_url} target="_blank" rel="noopener noreferrer"
                                title="Ver comprobante / recibo"
                                style={{ fontSize: 11, color: '#8B5CF6', textDecoration: 'none', fontWeight: 700 }}>
                                📎
                              </a>
                            )}
                            {b.bank_transaction_id && (
                              <a onClick={e => { e.preventDefault(); router.push('/banco?tx=' + b.bank_transaction_id) }}
                                title="Ver en banco"
                                style={{ fontSize: 11, color: '#16A34A', cursor: 'pointer', fontWeight: 700 }}>
                                🏦
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {bancsThisMonth.length > 15 && (
                <div style={{ padding: '12px 0 0', textAlign: 'center' as const, fontSize: 12, color: 'var(--text-secondary)' }}>
                  Mostrando 15 de {bancsThisMonth.length} ·
                  <span onClick={() => router.push('/tesoreria/reportes/bancarizaciones')}
                    style={{ color: '#8B5CF6', cursor: 'pointer', fontWeight: 700, marginLeft: 4 }}>
                    Ver todas →
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Pending board: Ingresos | Egresos, two columns ── */}
        <div style={{ ...s.twoCol, gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>

          {/* Ingresos pendientes de recogida */}
          <div style={s.colCard}>
            <div style={s.colHead}>
              <div style={s.colDot('#1a7a4a')} />
              <span style={s.colTitle}>Ingresos por recoger</span>
              <span style={s.colCount}>{pendingIngresos.length}</span>
            </div>
            {pendingIngresos.length === 0 ? (
              <div style={s.empty}>Nada pendiente</div>
            ) : (
              pendingIngresos.map(c => {
                const st = ESTADO_STYLE[c.estado] || ESTADO_STYLE.PENDIENTE_PICKUP
                return (
                  <div key={c.id} style={s.itemRow(st.accent, st.bg)}
                    onClick={() => router.push(`/tesoreria/comprobante?id=${c.id}`)}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={s.itemConcepto}>{c.concepto}</div>
                      <div style={s.itemMeta}>
                        <span style={s.itemNum}>{c.numero}</span> · {minutesAgo(c.solicitado_at)}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        <span style={s.stateChip(st.accent)}>{st.label}</span>
                      </div>
                    </div>
                    <div style={s.itemMonto('#1a7a4a')}>+{fmt(c.monto_usd)}</div>
                  </div>
                )
              })
            )}
            {permissions.tesoreria_can_pickup && pendingIngresos.length > 0 && (
              <button style={{ ...s.pillBtn, background: '#1a7a4a', color: '#fff', marginTop: 8, padding: '8px 14px' }}
                onClick={() => router.push('/tesoreria/scan')}>
                📷 Escanear QR
              </button>
            )}
          </div>

          {/* Egresos en proceso */}
          <div style={s.colCard}>
            <div style={s.colHead}>
              <div style={s.colDot('#BB162B')} />
              <span style={s.colTitle}>Egresos en proceso</span>
              <span style={s.colCount}>{pendingSalidas.length}</span>
            </div>
            {pendingSalidas.length === 0 ? (
              <div style={s.empty}>Nada en proceso</div>
            ) : (
              pendingSalidas.map(c => {
                const st = ESTADO_STYLE[c.estado] || ESTADO_STYLE.SOLICITADO
                return (
                  <div key={c.id} style={s.itemRow(st.accent, st.bg)}
                    onClick={() => router.push(`/tesoreria/comprobante?id=${c.id}`)}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={s.itemConcepto}>
                        {c.es_urgente && <span style={{ color: '#BB162B' }}>🔴 </span>}
                        {c.concepto}
                      </div>
                      <div style={s.itemMeta}>
                        <span style={s.itemNum}>{c.numero}</span>
                        {c.egreso_dirigido_a && ` · ${c.egreso_dirigido_a}`}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        <span style={s.stateChip(st.accent)}>{st.label}</span>
                      </div>
                    </div>
                    <div style={s.itemMonto('#BB162B')}>−{fmt(c.monto_usd)}</div>
                  </div>
                )
              })
            )}
            <button style={{ ...s.pillBtn, background: '#BB162B', color: '#fff', marginTop: 8, padding: '8px 14px' }}
              onClick={() => router.push('/tesoreria/egresos/nuevo')}>
              + Nuevo Egreso
            </button>
          </div>

        </div>

        {/* ── Movimientos de efectivo y USDT — bóvedas con drill-down ── */}
        <CashVaultsSection ubicaciones={ubicaciones} isMobile={isMobile} />

      </div>
    </AdminShell>
  )
}