// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/entrega/page.tsx
// AutoCore NPA — Prepare end-of-day cash handoff to Tesorería
//
// MODEL (Path B):
//   The handoff is a PURE CASH TRANSFER. Mirla enters the amount she's
//   physically handing over to Tesorería (defaults to PC_MIRLA saldo).
//   Comprobantes are displayed for context but NOT bundled — the math is
//   monto-based, decoupled from the comprobante lifecycle.
//
//   Example: PC_MIRLA = $9,700 because $5,000 was bancarized from PC earlier
//   today. Mirla can hand over $9,700 (or less). The pending comprobantes
//   she shows in context still total $14,700 — that's fine. The accounting
//   is in dollars, not in comprobantes.
//
// 2026-05-21 (Path B rewrite)
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'
import AdminShell from '../../components/AdminShell'
import { useAuthGate } from '../../components/useAuthGate'
import { useIsMobile } from '../../components/useIsMobile'
import SessionErrorScreen from '../../components/SessionErrorScreen'
import {
  loadPendingComprobantes,
  getPuntoCobroSaldo,
  nextHandoffNumero,
  createHandoffBatch,
  type PendingComprobante,
} from '../../handoff'

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  back: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', marginBottom: 12, padding: 0 },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14 },
  title: { fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 6 },
  subtitle: { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.4 },

  saldoBox: { padding: 14, borderRadius: 10, background: 'var(--bg-deep)', border: '1px solid var(--border)', marginBottom: 14 },
  saldoLabel: { fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1, fontWeight: 700, marginBottom: 4 },
  saldoValue: { fontSize: 28, fontWeight: 800, color: '#1a7a4a', fontFamily: 'monospace', lineHeight: 1.1 },
  saldoHint: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 },

  fieldLabel: { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1, fontWeight: 700, marginBottom: 6 },
  input: { width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 18, fontFamily: 'monospace', fontWeight: 700, boxSizing: 'border-box' as const },
  inputHint: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 },
  textarea: { width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical' as const, boxSizing: 'border-box' as const },

  quickRow: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' as const },
  quickBtn: { padding: '6px 12px', borderRadius: 999, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' },

  pendingTitle: { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1, fontWeight: 700, marginTop: 18, marginBottom: 8 },
  pendingRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 4, fontSize: 12 },
  pendingMono: { fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-primary)' },
  pendingMonto: { fontFamily: 'monospace', fontWeight: 700, color: '#1a7a4a' },
  pendingMeta: { fontSize: 11, color: 'var(--text-secondary)' },

  emptyState: { padding: 24, textAlign: 'center' as const, color: 'var(--text-secondary)', fontSize: 13 },

  btnGreen: { padding: '14px 22px', background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  btnSec: { padding: '12px 18px', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  btnRow: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' as const },

  stickyBar: { position: 'fixed' as const, bottom: 0, left: 0, right: 0, background: 'var(--bg-page)', borderTop: '1px solid var(--border)', padding: '12px 14px', paddingBottom: 'calc(12px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column' as const, gap: 8, zIndex: 1000, boxShadow: '0 -4px 12px rgba(0,0,0,0.08)' },

  err: { padding: '10px 14px', borderRadius: 8, background: 'rgba(187,22,43,0.1)', border: '1px solid #BB162B44', color: '#BB162B', fontSize: 13, marginBottom: 14 },
  warning: { padding: '10px 14px', borderRadius: 8, background: 'rgba(230,126,34,0.10)', border: '1px solid #e67e2255', color: '#e67e22', fontSize: 12, marginBottom: 14 },
}

function fmt(n: number): string {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function EntregaPage() {
  const router = useRouter()
  const isMobile = useIsMobile()
  const gate = useAuthGate(p => p.tesoreria_can_pickup || p.tesoreria_admin || p.npa_can_admin)

  const [loading, setLoading]   = useState(true)
  const [creating, setCreating] = useState(false)
  const [err, setErr]           = useState<string | null>(null)

  const [puntoCobroId, setPuntoCobroId] = useState<string | null>(null)
  const [saldo, setSaldo]               = useState<number>(0)
  const [pending, setPending]           = useState<PendingComprobante[]>([])

  // Form state
  const [montoStr, setMontoStr] = useState<string>('')
  const [notas, setNotas]       = useState<string>('')

  useEffect(() => { if (gate.status === 'denied') router.replace('/tesoreria/home') }, [gate.status, router])
  useEffect(() => { if (gate.status === 'ok') load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.status])

  async function load() {
    setLoading(true); setErr(null)
    // Recompute saldos from movimiento truth before reading PC saldo.
    try { await supabase.rpc('tesoreria_recompute_saldos') } catch (e) {
      console.warn('[entrega/load] recompute RPC warning', e)
    }
    try {
      const { data: ubic, error: uErr } = await supabase
        .from('tesoreria_ubicaciones')
        .select('id')
        .eq('codigo', 'PC_MIRLA')
        .single()
      if (uErr) throw uErr
      setPuntoCobroId(ubic.id)

      const [s, p] = await Promise.all([
        getPuntoCobroSaldo(ubic.id),
        loadPendingComprobantes(ubic.id),
      ])
      setSaldo(s)
      setPending(p)

      // Pre-fill the amount with the current PC saldo (most common case)
      if (s > 0 && !montoStr) {
        setMontoStr(s.toFixed(2))
      }
    } catch (e: any) {
      setErr(e.message || 'Error cargando datos')
    } finally {
      setLoading(false)
    }
  }

  const monto = Number(montoStr.replace(/,/g, '')) || 0
  const pendingTotal = pending.reduce((sum, c) => sum + Number(c.monto_usd), 0)
  const exceedsSaldo = monto > saldo
  const mismatch = Math.abs(monto - pendingTotal) > 0.01

  async function handleGenerate() {
    if (!gate.userId) return
    if (monto <= 0) { setErr('Ingresa un monto mayor a 0.'); return }
    if (exceedsSaldo) {
      setErr(
        `El monto (${fmt(monto)}) supera el saldo de Punto de Cobro (${fmt(saldo)}). ` +
        `No se puede entregar más de lo que hay en caja.`
      )
      return
    }
    setCreating(true); setErr(null)
    try {
      const numero = await nextHandoffNumero()
      const batch = await createHandoffBatch({
        numero,
        fromUserId: gate.userId,
        montoUsd: monto,
        notas: notas.trim() || null,
        pending,
      })
      router.push('/tesoreria/handoff?id=' + batch.id)
    } catch (e: any) {
      setErr(e?.message || 'Error generando la entrega')
    } finally {
      setCreating(false)
    }
  }

  if (gate.status === 'loading' || loading) {
    return <div style={{ ...s.page, padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>Cargando…</div>
  }
  if (gate.status === 'error') return <SessionErrorScreen homeHref="/tesoreria/home" />
  if (gate.status === 'denied') return null

  return (
    <AdminShell active="tesoreria">
      <div style={{
        padding: isMobile ? '14px 14px 0' : '32px',
        maxWidth: isMobile ? '100%' : 720,
        margin: '0 auto',
        paddingBottom: isMobile ? 160 : 32,
      }}>
        <button style={s.back} onClick={() => router.push('/tesoreria')}>← Volver al Dashboard</button>

        <div style={s.card}>
          <div style={s.title}>Preparar entrega a Tesorería</div>
          <div style={s.subtitle}>
            Indica el monto en efectivo que estás entregando físicamente a Tesorería. Tesorería escaneará el QR para confirmar la recepción y mover el dinero a Caja Principal.
          </div>

          {err && <div style={s.err}>{err}</div>}

          <div style={s.saldoBox}>
            <div style={s.saldoLabel}>Saldo actual en Punto de Cobro</div>
            <div style={s.saldoValue}>{fmt(saldo)}</div>
            <div style={s.saldoHint}>
              Este es el cash disponible para entregar. Si lo deseas, puedes entregar menos.
            </div>
          </div>

          <div>
            <div style={s.fieldLabel}>Monto a entregar</div>
            <input
              type="text"
              inputMode="decimal"
              value={montoStr}
              onChange={e => setMontoStr(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0.00"
              style={s.input}
              disabled={creating}
            />
            <div style={s.quickRow}>
              <button style={s.quickBtn} onClick={() => setMontoStr(saldo.toFixed(2))} disabled={creating}>
                Todo el saldo ({fmt(saldo)})
              </button>
              {pendingTotal > 0 && pendingTotal !== saldo && (
                <button style={s.quickBtn} onClick={() => setMontoStr(pendingTotal.toFixed(2))} disabled={creating}>
                  Pendientes ({fmt(pendingTotal)})
                </button>
              )}
            </div>
            {exceedsSaldo && (
              <div style={{ ...s.warning, marginTop: 10, marginBottom: 0 }}>
                ⚠ El monto supera el saldo. No podrás generar la entrega hasta que sea ≤ {fmt(saldo)}.
              </div>
            )}
            {!exceedsSaldo && mismatch && pending.length > 0 && (
              <div style={s.inputHint}>
                Nota: los comprobantes pendientes suman {fmt(pendingTotal)}. La diferencia con el monto puede ser por cash que ya salió (bancarización, vendor, caja chica) o que estás reteniendo.
              </div>
            )}
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={s.fieldLabel}>Notas (opcional)</div>
            <textarea
              rows={2}
              value={notas}
              onChange={e => setNotas(e.target.value)}
              placeholder="Ej: Entrega del cierre del día"
              style={s.textarea}
              disabled={creating}
            />
          </div>

          <div style={s.pendingTitle}>
            Comprobantes en Punto de Cobro ({pending.length})
          </div>
          {pending.length === 0 ? (
            <div style={s.emptyState}>No hay comprobantes en Punto de Cobro.</div>
          ) : (
            <div>
              {pending.map(c => (
                <div key={c.id} style={s.pendingRow}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={s.pendingMono}>{c.numero}</div>
                    <div style={s.pendingMeta}>
                      {c.concepto} · {c.estado === 'PENDIENTE_PICKUP' ? 'pendiente' : 'recogido'}
                    </div>
                  </div>
                  <div style={s.pendingMonto}>{fmt(c.monto_usd)}</div>
                </div>
              ))}
              <div style={{ ...s.pendingRow, fontWeight: 700, marginTop: 6 }}>
                <div>Total comprobantes</div>
                <div style={s.pendingMonto}>{fmt(pendingTotal)}</div>
              </div>
            </div>
          )}

          {!isMobile && (
            <div style={s.btnRow}>
              <button
                style={{
                  ...s.btnGreen,
                  opacity: monto > 0 && !exceedsSaldo && !creating ? 1 : 0.5,
                  cursor: monto > 0 && !exceedsSaldo && !creating ? 'pointer' : 'not-allowed',
                }}
                onClick={handleGenerate}
                disabled={monto <= 0 || exceedsSaldo || creating}
              >
                {creating ? 'Generando…' : `📦 Generar entrega (${fmt(monto)})`}
              </button>
              <button style={s.btnSec} onClick={() => load()} disabled={creating}>↻ Refrescar</button>
            </div>
          )}
        </div>
      </div>

      {isMobile && (
        <div style={s.stickyBar}>
          <button
            style={{
              ...s.btnGreen, width: '100%',
              opacity: monto > 0 && !exceedsSaldo && !creating ? 1 : 0.5,
              cursor: monto > 0 && !exceedsSaldo && !creating ? 'pointer' : 'not-allowed',
            }}
            onClick={handleGenerate}
            disabled={monto <= 0 || exceedsSaldo || creating}
          >
            {creating ? 'Generando…' : `📦 Generar entrega (${fmt(monto)})`}
          </button>
          <button style={{ ...s.btnSec, width: '100%' }} onClick={() => load()} disabled={creating}>↻ Refrescar</button>
        </div>
      )}
    </AdminShell>
  )
}