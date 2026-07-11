// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/handoff/page.tsx
// AutoCore NPA — Handoff batch detail (pure cash transfer model)
//
// Two modes:
//   • Default: printable receipt + QR. The Punto de Cobro user stays here
//     after generating the batch.
//   • ?confirm=1: Tesorería receiver view. One button "Confirmar recepción"
//     writes the 2 movimientos (−1 PC_MIRLA / +1 CAJA_PPAL) and flips state.
//
// 2026-05-21 (Path B rewrite — no items)
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '../../supabase'
import AdminShell from '../../components/AdminShell'
import { useAuthGate } from '../../components/useAuthGate'
import { useIsMobile } from '../../components/useIsMobile'
import SessionErrorScreen from '../../components/SessionErrorScreen'
import TesoreriaQR from '../../components/TesoreriaQR'
import {
  anularHandoffBatch,
  confirmHandoffBatch,
  type HandoffBatch,
} from '../../handoff'

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  back: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', marginBottom: 14, padding: 0 },
  printArea: { background: '#fff', color: '#000', borderRadius: 12, padding: 24, marginBottom: 14, border: '1px solid var(--border)' },
  tipoLabel: { fontSize: 10, color: '#666', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 2 },
  title: { fontSize: 24, fontWeight: 800, fontFamily: 'monospace', color: '#000', lineHeight: 1.15 },
  meta: { fontSize: 11, color: '#666', marginTop: 4 },
  badge: { display: 'inline-block', padding: '4px 12px', borderRadius: 999, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1 },

  montoBig: { textAlign: 'center' as const, padding: '20px 0' },
  montoLabel: { fontSize: 10, color: '#888', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 6 },
  montoValue: { fontSize: 36, fontFamily: 'monospace', fontWeight: 800, color: '#1a7a4a', lineHeight: 1 },

  qrBox: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 6, margin: '12px 0' },
  qrCaption: { fontSize: 11, color: '#666' },

  notesBox: { padding: 12, background: '#f9f9f9', border: '1px solid #e5e5e5', borderRadius: 8, fontSize: 12, color: '#444', marginTop: 14 },

  btnRow: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' as const },
  btnGreen: { padding: '14px 22px', background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  btnSec: { padding: '12px 18px', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer' },

  stickyBar: { position: 'fixed' as const, bottom: 0, left: 0, right: 0, background: 'var(--bg-page)', borderTop: '1px solid var(--border)', padding: '12px 14px', paddingBottom: 'calc(12px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column' as const, gap: 8, zIndex: 1000, boxShadow: '0 -4px 12px rgba(0,0,0,0.08)' },

  err: { padding: '10px 14px', borderRadius: 8, background: 'rgba(187,22,43,0.1)', border: '1px solid #BB162B44', color: '#BB162B', fontSize: 13, marginBottom: 14 },
  success: { padding: '10px 14px', borderRadius: 8, background: 'rgba(26,122,74,0.1)', border: '1px solid #1a7a4a55', color: '#1a7a4a', fontSize: 13, marginBottom: 14 },

  banner: { padding: '12px 14px', borderRadius: 10, background: 'rgba(46,204,138,0.10)', border: '1px solid #1a7a4a55', marginBottom: 12 },
  bannerTitle: { fontSize: 15, fontWeight: 700, color: '#1a7a4a', marginBottom: 4 },
  bannerBody: { fontSize: 13, color: 'var(--text-primary)' },

  breakdown: { marginTop: 4, borderTop: '1px solid #e5e5e5', paddingTop: 14 },
  breakdownTitle: { fontSize: 10, color: '#888', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 8 },
  breakRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '7px 0', borderBottom: '1px solid #f0f0f0' },
  breakName: { fontSize: 13, color: '#000', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  breakNum: { fontSize: 11, color: '#999', fontFamily: 'monospace', marginTop: 1 },
  breakAmt: { fontSize: 13, color: '#000', fontWeight: 700, fontFamily: 'monospace', whiteSpace: 'nowrap' as const },
  breakSubRow: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#555', padding: '6px 0' },
  breakTotalRow: { display: 'flex', justifyContent: 'space-between', fontSize: 14, color: '#000', fontWeight: 800, padding: '9px 0 0', borderTop: '1px solid #ccc', marginTop: 4 },
  // — Cash statement (how PC_MIRLA reached the handed-over amount) —
  moveRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, padding: '6px 0', borderBottom: '1px solid #f3f3f3' },
  moveDate: { fontSize: 10, color: '#aaa', fontFamily: 'monospace', width: 42, flexShrink: 0, paddingTop: 2 },
  moveName: { fontSize: 12.5, color: '#000', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  moveSub: { fontSize: 10.5, color: '#999', marginTop: 1 },
  moveRight: { textAlign: 'right' as const, flexShrink: 0, whiteSpace: 'nowrap' as const },
  moveIn: { fontSize: 12.5, fontWeight: 700, fontFamily: 'monospace', color: '#1a7a4a' },
  moveOut: { fontSize: 12.5, fontWeight: 700, fontFamily: 'monospace', color: '#BB162B' },
  moveBal: { fontSize: 10, color: '#999', fontFamily: 'monospace', marginTop: 1 },
}

const ESTADO_LABEL: Record<string, string> = {
  PREPARADO: 'Preparado',
  RECIBIDO: 'Recibido',
  ANULADO: 'Anulado',
}
const ESTADO_COLOR: Record<string, string> = {
  PREPARADO: '#e67e22',
  RECIBIDO: '#1a7a4a',
  ANULADO: '#BB162B',
}

function fmt(n: number): string {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
// Short day/month for the statement rows (es-VE).
function fmtDay(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}
// Friendly label for a movimiento tipo (used when there's no comprobante).
const MOV_TIPO_LABEL: Record<string, string> = {
  INGRESO: 'Ingreso en efectivo',
  PICKUP_TRANSFER: 'Recogida por Tesorería',
  HANDOFF_TESORERIA: 'Entrega a Tesorería',
  BANCARIZACION: 'Bancarización',
  CAJA_CHICA_REPO: 'Reposición caja chica',
  EGRESO: 'Egreso',
  AJUSTE: 'Ajuste',
}
// One line of the "how the cash got here" statement.
interface CashMove {
  id: string
  fecha: string
  name: string
  sub: string
  signo: number
  monto: number
  saldo: number
}

function HandoffInner() {
  const router = useRouter()
  const params = useSearchParams()
  const id = params.get('id') || ''
  const isConfirmMode = params.get('confirm') === '1'
  const isMobile = useIsMobile()

  const gate = useAuthGate(p => p.tesoreria_can_pickup || p.tesoreria_admin || p.npa_can_admin)

  const [loading, setLoading] = useState(true)
  const [batch, setBatch] = useState<HandoffBatch | null>(null)
  const [items, setItems] = useState<any[]>([])
  const [cashMoves, setCashMoves] = useState<CashMove[]>([])
  const [puntoCobroId, setPuntoCobroId] = useState<string | null>(null)
  const [cajaPpalId, setCajaPpalId] = useState<string | null>(null)

  const [action, setAction] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  useEffect(() => { if (!id) router.replace('/tesoreria') }, [id, router])
  useEffect(() => { if (gate.status === 'denied') router.replace('/tesoreria/home') }, [gate.status, router])
  useEffect(() => { if (gate.status === 'ok' && id) load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.status, id])

  async function load() {
    setLoading(true); setErr(null)
    // Recompute saldos from movimiento truth before reading PC/CAJA_PPAL state.
    try { await supabase.rpc('tesoreria_recompute_saldos') } catch (e) {
      console.warn('[handoff/load] recompute RPC warning', e)
    }
    try {
      const [batchResp, ubicResp, itemsResp] = await Promise.all([
        supabase.from('tesoreria_handoff_batches').select('*').eq('id', id).single(),
        supabase.from('tesoreria_ubicaciones').select('id, codigo').in('codigo', ['PC_MIRLA', 'CAJA_PPAL']),
        supabase.from('tesoreria_handoff_batch_items').select('id, comprobante_id, monto_usd, kind').eq('batch_id', id),
      ])
      if (batchResp.error) throw batchResp.error
      if (ubicResp.error) throw ubicResp.error

      setBatch(batchResp.data as HandoffBatch)
      for (const u of (ubicResp.data || []) as any[]) {
        if (u.codigo === 'PC_MIRLA')  setPuntoCobroId(u.id)
        if (u.codigo === 'CAJA_PPAL') setCajaPpalId(u.id)
      }

      // Receipt breakdown: resolve each deposit line's client name.
      const rawItems = (itemsResp.error ? [] : (itemsResp.data || [])) as any[]
      const compIds = rawItems.filter(i => i.comprobante_id).map(i => i.comprobante_id)
      const compMap: Record<string, any> = {}
      if (compIds.length > 0) {
        const { data: comps } = await supabase
          .from('tesoreria_comprobantes')
          .select('id, numero, contraparte_nombre')
          .in('id', compIds)
        ;(comps || []).forEach((c: any) => { compMap[c.id] = c })
      }
      setItems(rawItems.map(i => ({
        ...i,
        numero: i.comprobante_id ? (compMap[i.comprobante_id]?.numero || '—') : null,
        cliente: i.comprobante_id ? (compMap[i.comprobante_id]?.contraparte_nombre || 'Cliente') : null,
      })))

      // ── Cash statement: how PC_MIRLA reached the handed-over amount ──────────
      // Reconstructed from immutable movimientos up to the prepare time, so the
      // receipt reprints identically. We compute a running balance over the full
      // PC_MIRLA history, find where the box was last empty (a prior handoff
      // depletes it to ~0), and show only the current fill cycle — the ingresos
      // in and the cash out (bancarización, vendor, caja chica, recogidas) that
      // net to this handoff. Read-only; never touches cash math.
      const pcId = ((ubicResp.data || []) as any[]).find(u => u.codigo === 'PC_MIRLA')?.id
      const preparadoAt = (batchResp.data as any)?.preparado_at
      let statement: CashMove[] = []
      if (pcId && preparadoAt) {
        const { data: movs } = await supabase
          .from('tesoreria_movimientos')
          .select('id, fecha, tipo, monto_usd, signo, descripcion, source_label, comprobante_id')
          .eq('ubicacion_id', pcId)
          .lte('fecha', preparadoAt)
          .order('fecha', { ascending: true })
        const rows = (movs || []) as any[]
        let run = 0
        const withRun = rows.map(m => { run += Number(m.monto_usd) * Number(m.signo); return { m, run } })
        let startIdx = 0
        for (let i = 0; i < withRun.length; i++) if (withRun[i].run <= 0.005) startIdx = i + 1
        const cycle = withRun.slice(startIdx)

        const mcIds = Array.from(new Set(cycle.map(x => x.m.comprobante_id).filter(Boolean))) as string[]
        const mcMap: Record<string, any> = {}
        if (mcIds.length > 0) {
          const { data: mc } = await supabase
            .from('tesoreria_comprobantes')
            .select('id, numero, contraparte_nombre, concepto')
            .in('id', mcIds)
          ;(mc || []).forEach((c: any) => { mcMap[c.id] = c })
        }
        statement = cycle.map(({ m, run: bal }) => {
          const comp = m.comprobante_id ? mcMap[m.comprobante_id] : null
          const name = comp
            ? (comp.contraparte_nombre || comp.concepto || 'Ingreso')
            : (m.source_label || m.descripcion || MOV_TIPO_LABEL[m.tipo] || 'Movimiento')
          const sub = comp ? (comp.numero || '') : (MOV_TIPO_LABEL[m.tipo] || m.tipo || '')
          return {
            id: m.id, fecha: m.fecha, name, sub,
            signo: Number(m.signo) < 0 ? -1 : 1,
            monto: Number(m.monto_usd),
            saldo: Math.round(bal * 100) / 100,
          }
        })
      }
      setCashMoves(statement)
    } catch (e: any) {
      setErr(e.message || 'Error cargando el batch')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm() {
    if (!batch) { setErr('Confirmación: batch no cargado.'); return }
    if (!gate.userId) { setErr('Confirmación: sesión no inicializada.'); return }
    if (!puntoCobroId) { setErr('Confirmación: PC_MIRLA no resuelto.'); return }
    if (!cajaPpalId)   { setErr('Confirmación: CAJA_PPAL no resuelto.'); return }

    // Hard block: PC_MIRLA must have enough cash to satisfy the batch.
    // DB trigger would reject, but check here for clean UX.
    try {
      const { data: pcRow } = await supabase
        .from('tesoreria_ubicaciones')
        .select('saldo_actual_usd')
        .eq('id', puntoCobroId)
        .single()
      const pcSaldo = Number(pcRow?.saldo_actual_usd || 0)
      if (pcSaldo < Number(batch.total_usd)) {
        setErr(
          `Punto de Cobro tiene saldo insuficiente: $${pcSaldo.toFixed(2)} disponible, ` +
          `$${Number(batch.total_usd).toFixed(2)} en este batch. ` +
          `Anula el batch y crea uno nuevo con el monto real.`
        )
        return
      }
    } catch (e: any) {
      console.warn('[handoff/confirm] saldo pre-check warning', e?.message)
      // Fall through to attempt — the DB trigger will block if needed
    }

    // eslint-disable-next-line no-console
    console.log('[handoff/confirm] starting', { batchId: batch.id, numero: batch.numero, monto: batch.total_usd })

    setAction(true); setErr(null); setSuccessMsg(null)
    try {
      const updated = await confirmHandoffBatch({
        batchId: batch.id,
        byUserId: gate.userId,
        puntoCobroUbicacionId: puntoCobroId,
        cajaPpalUbicacionId: cajaPpalId,
      })
      // eslint-disable-next-line no-console
      console.log('[handoff/confirm] success', updated)
      setBatch(updated)
      setSuccessMsg(`Entrega de ${fmt(updated.total_usd)} confirmada. Cash movido a Caja Principal.`)
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[handoff/confirm] FAILED', e)
      setErr(e?.message || 'Error confirmando la recepción')
    } finally { setAction(false) }
  }

  async function handleAnular() {
    if (!batch) return
    const motivo = prompt('Motivo para anular este batch (mín. 5 caracteres):')
    if (!motivo || motivo.trim().length < 5) return
    setAction(true); setErr(null)
    try {
      await anularHandoffBatch(batch.id, motivo)
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error anulando el batch')
    } finally { setAction(false) }
  }

  function handlePrint() {
    if (!batch) return
    const originalTitle = document.title
    document.title = batch.numero
    window.print()
    setTimeout(() => { document.title = originalTitle }, 1000)
  }

  if (gate.status === 'loading' || loading) {
    return <div style={{ ...s.page, padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>Cargando…</div>
  }
  if (gate.status === 'error') return <SessionErrorScreen homeHref="/tesoreria/home" />
  if (gate.status === 'denied') return null
  if (!batch) {
    return (
      <AdminShell active="tesoreria">
        <div style={{ padding: isMobile ? '14px' : '32px', maxWidth: isMobile ? '100%' : 720, margin: '0 auto' }}>
          <div style={s.err}>Batch no encontrado.</div>
          <button style={s.btnSec} onClick={() => router.push('/tesoreria')}>← Volver</button>
        </div>
      </AdminShell>
    )
  }

  const isTerminal = batch.estado === 'RECIBIDO' || batch.estado === 'ANULADO'
  const canAnular = batch.estado === 'PREPARADO'
  const showConfirmButton = isConfirmMode && batch.estado === 'PREPARADO'
  const estadoColor = ESTADO_COLOR[batch.estado] || '#999'

  return (
    <AdminShell active="tesoreria">
      <div style={{
        padding: isMobile ? '14px 14px 0' : '32px',
        maxWidth: isMobile ? '100%' : 720,
        margin: '0 auto',
        paddingBottom: isMobile ? 160 : 32,
      }}>
        <button style={s.back} onClick={() => router.push('/tesoreria')} className="no-print">← Volver al Dashboard</button>

        {successMsg && <div style={s.success} className="no-print">{successMsg}</div>}
        {err && <div style={s.err} className="no-print">{err}</div>}

        {showConfirmButton && (
          <div style={s.banner} className="no-print">
            <div style={s.bannerTitle}>📥 Recepción de entrega</div>
            <div style={s.bannerBody}>
              Confirma que recibiste físicamente {fmt(batch.total_usd)} en efectivo. Al confirmar, el dinero se mueve del Punto de Cobro a Caja Principal.
            </div>
          </div>
        )}

        <div style={s.printArea} id="print-area">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' as const }}>
            <div>
              <div style={s.tipoLabel}>Entrega a Tesorería</div>
              <div style={s.title}>{batch.numero}</div>
              <div style={s.meta}>
                MOTOCENTRO II<br />{new Date(batch.preparado_at).toLocaleString('es-VE')}
              </div>
            </div>
            <span style={{ ...s.badge, background: estadoColor + '22', color: estadoColor, border: `1px solid ${estadoColor}66` }}>
              {ESTADO_LABEL[batch.estado] || batch.estado}
            </span>
          </div>

          <div style={s.montoBig}>
            <div style={s.montoLabel}>Monto entregado</div>
            <div style={s.montoValue}>{fmt(batch.total_usd)}</div>
          </div>

          {cashMoves.length > 0 ? (() => {
            const totalIn = cashMoves.filter(m => m.signo > 0).reduce((sum, m) => sum + m.monto, 0)
            const totalOut = cashMoves.filter(m => m.signo < 0).reduce((sum, m) => sum + m.monto, 0)
            return (
              <div style={s.breakdown}>
                <div style={s.breakdownTitle}>Cómo se compone este efectivo</div>
                {cashMoves.map(m => (
                  <div key={m.id} style={s.moveRow}>
                    <div style={s.moveDate}>{fmtDay(m.fecha)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={s.moveName}>{m.name}</div>
                      {m.sub ? <div style={s.moveSub}>{m.sub}</div> : null}
                    </div>
                    <div style={s.moveRight}>
                      <div style={m.signo < 0 ? s.moveOut : s.moveIn}>{(m.signo < 0 ? '− ' : '+ ') + fmt(m.monto)}</div>
                      <div style={s.moveBal}>saldo {fmt(m.saldo)}</div>
                    </div>
                  </div>
                ))}
                <div style={s.breakSubRow}><span>Total ingresado</span><span>+ {fmt(totalIn)}</span></div>
                {totalOut > 0.005 && <div style={s.breakSubRow}><span>Total salidas (banco / vendor / caja chica)</span><span>− {fmt(totalOut)}</span></div>}
                <div style={s.breakTotalRow}>
                  <span>Saldo entregado a Tesorería</span>
                  <span>{fmt(batch.total_usd)}</span>
                </div>
              </div>
            )
          })() : items.length > 0 ? (() => {
            const pickup = items.filter(i => i.kind !== 'RESIDUAL')
            const residual = items
              .filter(i => i.kind === 'RESIDUAL')
              .reduce((sum, i) => sum + Number(i.monto_usd), 0)
            const subtotal = pickup.reduce((sum, i) => sum + Number(i.monto_usd), 0)
            return (
              <div style={s.breakdown}>
                <div style={s.breakdownTitle}>Detalle de la entrega</div>
                {pickup.map(it => (
                  <div key={it.id} style={s.breakRow}>
                    <div style={{ minWidth: 0 }}>
                      <div style={s.breakName}>{it.cliente || 'Cliente'}</div>
                      <div style={s.breakNum}>{it.numero}</div>
                    </div>
                    <div style={s.breakAmt}>{fmt(it.monto_usd)}</div>
                  </div>
                ))}
                {pickup.length > 0 && (
                  <div style={s.breakSubRow}>
                    <span>Subtotal depósitos ({pickup.length})</span>
                    <span>{fmt(subtotal)}</span>
                  </div>
                )}
                {residual > 0.005 && (
                  <div style={s.breakSubRow}>
                    <span>Excedente en efectivo</span>
                    <span>{fmt(residual)}</span>
                  </div>
                )}
                <div style={s.breakTotalRow}>
                  <span>Total entregado</span>
                  <span>{fmt(batch.total_usd)}</span>
                </div>
              </div>
            )
          })() : null}

          <div style={s.qrBox}>
            <TesoreriaQR payload={batch.qr_payload} size={isMobile ? 150 : 180} />
            <div style={s.qrCaption}>Escanear con la cámara del teléfono</div>
          </div>

          {batch.recibido_at && (
            <div style={{ ...s.notesBox, color: '#1a7a4a', borderColor: '#1a7a4a44', background: '#f0fdf4' }}>
              <strong>✓ Recibido:</strong> {new Date(batch.recibido_at).toLocaleString('es-VE')}
            </div>
          )}

          {batch.anulado_motivo && (
            <div style={{ ...s.notesBox, color: '#991b1b', borderColor: '#fecaca', background: '#fef2f2' }}>
              <strong>Anulado:</strong> {batch.anulado_motivo}
            </div>
          )}

          {batch.notas && (
            <div style={s.notesBox}>
              <strong>Notas:</strong> {batch.notas}
            </div>
          )}
        </div>

        {!isMobile && (
          <div style={s.btnRow} className="no-print">
            {showConfirmButton && (
              <button
                style={{ ...s.btnGreen, opacity: action ? 0.5 : 1 }}
                onClick={handleConfirm}
                disabled={action}
              >
                {action ? 'Confirmando…' : `✓ Confirmar recepción (${fmt(batch.total_usd)})`}
              </button>
            )}
            <button style={s.btnSec} onClick={handlePrint}>🖨 Imprimir</button>
            <button style={s.btnSec} onClick={() => load()}>↻ Refrescar</button>
            {canAnular && !isConfirmMode && (
              <button
                style={{ ...s.btnSec, color: '#BB162B', borderColor: '#BB162B' }}
                onClick={handleAnular} disabled={action}
              >
                ✕ Anular batch
              </button>
            )}
          </div>
        )}
      </div>

      {isMobile && (
        <div style={s.stickyBar} className="no-print">
          {showConfirmButton ? (
            <button
              style={{ ...s.btnGreen, width: '100%', opacity: action ? 0.5 : 1 }}
              onClick={handleConfirm}
              disabled={action}
            >
              {action ? 'Confirmando…' : `✓ Confirmar (${fmt(batch.total_usd)})`}
            </button>
          ) : (
            <>
              <button style={{ ...s.btnSec, width: '100%' }} onClick={handlePrint}>🖨 Imprimir</button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={{ ...s.btnSec, flex: 1 }} onClick={() => load()}>↻ Refrescar</button>
                {canAnular && (
                  <button
                    style={{ ...s.btnSec, flex: 1, color: '#BB162B', borderColor: '#BB162B' }}
                    onClick={handleAnular} disabled={action}
                  >
                    ✕ Anular
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <style jsx global>{`
        @media print {
          html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; color: #000 !important; }
          body * { visibility: hidden !important; }
          #print-area, #print-area * { visibility: visible !important; }
          #print-area {
            position: absolute !important;
            left: 0 !important; top: 0 !important;
            width: 100% !important; max-width: 100% !important;
            margin: 0 !important; padding: 16px !important;
            background: #fff !important;
            border: none !important; border-radius: 0 !important; box-shadow: none !important;
            font-size: 11pt !important; color: #000 !important;
          }
          #print-area * {
            background: transparent !important;
            background-color: transparent !important;
            box-shadow: none !important;
            border-color: transparent !important;
          }
          #print-area [class*="badge"] { border: 1px solid #999 !important; }
          #print-area svg { max-width: 160px !important; height: auto !important; }
          .no-print, nav { display: none !important; }
          @page { size: letter; margin: 0.4in; }
        }
      `}</style>
    </AdminShell>
  )
}

export default function HandoffPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', padding: 60, textAlign: 'center', color: '#888' }}>Cargando…</div>
    }>
      <HandoffInner />
    </Suspense>
  )
}