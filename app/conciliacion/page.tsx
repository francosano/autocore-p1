// TARGET: autocore-npa/app/conciliacion/page.tsx
// AutoCore NPA — Conciliación de cuentas (every-penny reconciliation board)
//
// Buckets every bank transaction: Conciliado en banco / Entrada sin explicar /
// Salida sin explicar / Interna. Deterministic high-confidence proposals are
// computed locally (engine); the ambiguous remainder is sent to the AI pass in
// ONE batched call (token-efficient, per Franco's instruction). Read-only by
// design — every "Conciliar" is a human click that runs the existing merge.

'use client'

import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import AdminShell from '../components/AdminShell'
import { useNPAPermissions } from '../components/useNPAPermissions'
import {
  reconcileWindow, COMPROBANTE_WORKER,
  type ReconRow, type ReconResult, type Proposal, type Counterpart, type BankTx,
} from '../lib/conciliacion'

const RED = '#BB162B'
const fmt = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (d: string | null) => { if (!d) return '—'; const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}` }
const CUENTA_LABELS: Record<string, string> = {
  roframi: 'Roframi BofA', roframi_regions: 'Roframi Regions',
  motocentro: 'Motocentro', panama: 'Panamá', bolivares: 'Bolívares',
}

function monthRange(d: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10)
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
  return { from, to }
}

export default function ConciliacionPage() {
  const router = useRouter()
  const { permissions, loading: permsLoading } = useNPAPermissions()

  const [from, setFrom] = useState(() => monthRange(new Date()).from)
  const [to, setTo] = useState(() => monthRange(new Date()).to)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ReconResult | null>(null)
  const [aiProposals, setAiProposals] = useState<Map<string, Proposal>>(new Map())
  const [aiBusy, setAiBusy] = useState(false)
  const [aiRan, setAiRan] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'sin_explicar' | 'entrada' | 'salida'>('sin_explicar')

  useEffect(() => {
    if (!permsLoading && !permissions.npa_can_admin) router.replace('/dashboard')
  }, [permsLoading, permissions])

  async function run() {
    setLoading(true); setErr(null); setAiProposals(new Map()); setAiRan(false)
    try {
      const r = await reconcileWindow(from, to)
      setResult(r)
    } catch (e: any) {
      setErr(e?.message || 'Error al cargar la conciliación')
    } finally { setLoading(false) }
  }

  useEffect(() => { if (!permsLoading && permissions.npa_can_admin) run() }, [permsLoading])

  // ── AI pass: ONE batched call for all unexplained txs without a
  //    deterministic proposal. The engine already filtered them into needsAI. ──
  async function analizarConIA() {
    if (!result) return
    setAiBusy(true); setErr(null); setAiRan(false)
    try {
      if (result.needsAI.length === 0 || result.openCounterparts.length === 0) {
        setAiRan(true); setAiBusy(false); return
      }
      const slimTx = (t: BankTx) => ({
        id: t.id, dir: t.direccion || 'credit', fecha: t.fecha, monto: Number(t.monto_usd),
        tipo: t.tipo || null, sender: t.sender_name || null, ref: t.referencia || null,
        cuenta: t.cuenta || null,
      })
      const slimC = (c: Counterpart) => ({
        id: c.id, kind: c.kind, dir: c.direccion, fecha: c.fecha, monto: c.monto,
        ref: c.ref, label: c.label,
      })
      const prompt = `Eres un analista de conciliación bancaria de un concesionario en Venezuela. Tienes transacciones bancarias SIN EXPLICAR y registros de tesorería ABIERTOS (ingresos, egresos, bancarizaciones, pagos de cuota/diferida) que aún no tienen transacción bancaria ligada.

Para cada transacción, propón el registro de tesorería que le corresponde, O indica que no hay candidato (investigar).

REGLAS ESTRICTAS:
- La dirección debe coincidir: credit (entrada) ↔ ingreso/bancarización/cuota/diferida; debit (salida) ↔ egreso.
- El monto debe ser igual (tolerancia $1) o, para bancarizaciones, MENOR O IGUAL al restante (depósito parcial).
- Los senders pueden diferir del titular (Zelle: paga un familiar; bancarizador usa nombre de empresa, ej. "MEDROD CORP" ↔ "Javier Medina"). Explica la relación en "razon".
- Los depósitos llegan días DESPUÉS del registro, nunca antes.
- Cada registro de tesorería puede proponerse para UNA sola transacción.
- Omite propuestas con confianza menor a 60 (esas van como "sin candidato").

TRANSACCIONES = ${JSON.stringify(result.needsAI.map(slimTx))}
REGISTROS ABIERTOS = ${JSON.stringify(result.openCounterparts.map(slimC))}

Responde SOLO con un array JSON, sin markdown:
[{"tx_id":"<uuid>","counterpart_id":"<uuid>","confianza":<0-100>,"razon":"<máx 25 palabras en español>"}]`

      const resp = await fetch(COMPROBANTE_WORKER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 4000,
        }),
      })
      const data = await resp.json()
      // Surface a real API error instead of a generic JSON message.
      if (data?.type === 'error' || data?.error) {
        throw new Error('La IA devolvió un error: ' + (data?.error?.message || data?.message || 'desconocido'))
      }
      const tb = (data.content || []).find((b: any) => b.type === 'text')
      let rawText = (tb?.text || '').trim()
      if (!rawText) throw new Error('La IA no devolvió contenido. Reduce el rango de fechas e intenta de nuevo.')
      // Tolerate markdown fences and any prose around the array: grab the
      // outermost [ ... ] block. Large windows sometimes wrap the JSON.
      rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      const firstBracket = rawText.indexOf('[')
      const lastBracket = rawText.lastIndexOf(']')
      const jsonSlice = (firstBracket >= 0 && lastBracket > firstBracket)
        ? rawText.slice(firstBracket, lastBracket + 1) : rawText
      let parsed: any[] = []
      try { parsed = JSON.parse(jsonSlice) }
      catch { throw new Error('La respuesta de la IA quedó incompleta (demasiadas transacciones). Filtra por entradas o salidas, o acorta el rango, e intenta de nuevo.') }
      if (!Array.isArray(parsed)) parsed = []

      // Re-validate deterministically before trusting any of it.
      const txMap = new Map(result.needsAI.map(t => [t.id, t]))
      const cMap = new Map(result.openCounterparts.map(c => [c.id, c]))
      const usedC = new Set<string>()
      const m = new Map<string, Proposal>()
      for (const p of parsed) {
        const tx = txMap.get(p?.tx_id); const c = cMap.get(p?.counterpart_id)
        if (!tx || !c) continue
        const dir = (tx.direccion || 'credit')
        if (c.direccion !== dir) continue
        const key = c.kind + ':' + c.id
        if (usedC.has(key)) continue
        // Amount rule: exact (±1) OR bancarización partial (≤ restante).
        const okExact = Math.abs(Number(tx.monto_usd) - c.monto) <= 1
        const okPartial = c.kind === 'bancarizacion_deposito' && Number(tx.monto_usd) <= c.monto + 0.005
        if (!okExact && !okPartial) continue
        const conf = Math.max(0, Math.min(100, Number(p.confianza) || 0))
        if (conf < 60) continue
        usedC.add(key)
        m.set(tx.id, { strength: 'ai', confianza: conf, counterpart: c, razon: String(p.razon || '').slice(0, 300) })
      }
      setAiProposals(m)
      setAiRan(true)
    } catch (e: any) {
      setErr(e?.message || 'Error en el análisis con IA')
      setAiRan(true)
    } finally { setAiBusy(false) }
  }

  // ── Confirm a proposal: route to the right merge by counterpart kind. All
  //    writes mirror the existing flows; nothing new invented. ──
  async function conciliar(tx: BankTx, prop: Proposal) {
    if (!prop.counterpart) return
    setConfirming(tx.id); setErr(null)
    try {
      const c = prop.counterpart
      const { data: au } = await supabase.auth.getUser()
      const uid = au?.user?.id || null

      if (c.kind === 'bancarizacion_deposito') {
        // Partial-deposit machinery (same as comprobante detail page).
        const { data: comp } = await (supabase.from('tesoreria_comprobantes')
          .select('id, numero, monto_usd, monto_depositado, estado, bancarizador_nombre, egreso_dirigido_a')
          .eq('id', c.id).single() as any)
        if (!comp) throw new Error('Bancarización no encontrada')
        const monto = Math.min(Number(tx.monto_usd), Number(comp.monto_usd) - Number(comp.monto_depositado || 0))
        const { error: depErr } = await supabase.from('tesoreria_comprobante_depositos').insert({
          comprobante_id: comp.id, bank_transaction_id: tx.id, monto_usd: monto,
          fecha: tx.fecha, referencia: tx.referencia || null, cuenta: tx.cuenta || 'UNKNOWN',
          documento_url: null, ai_review: { source: 'conciliacion', confianza: prop.confianza, razon: prop.razon },
          registered_by: uid,
        })
        if (depErr) throw new Error('No se pudo registrar el depósito: ' + depErr.message)
        await supabase.from('bank_transactions').update({
          es_bancarizacion: true, banc_depositante: comp.bancarizador_nombre || comp.egreso_dirigido_a || null, matched: true,
        }).eq('id', tx.id)
        const nuevoTotal = Number(comp.monto_depositado || 0) + monto
        const completo = nuevoTotal >= Number(comp.monto_usd) - 0.005
        await supabase.from('tesoreria_comprobantes').update({
          estado: completo ? 'DEPOSITADO' : 'DEPOSITADO_PARCIAL',
          cerrado_at: completo ? new Date().toISOString() : null,
          monto_depositado: nuevoTotal, bank_transaction_id: tx.id,
        }).eq('id', comp.id).in('estado', ['ENTREGADO_BANCARIZADOR', 'DEPOSITADO_PARCIAL'])
        await supabase.from('tesoreria_comprobante_eventos').insert({
          comprobante_id: comp.id, evento: completo ? 'DEPOSITADO' : 'DEPOSITO_PARCIAL',
          actor_user_id: uid, actor_label: 'Conciliación (confirmada)',
          notas: `Conciliado desde /conciliacion: ${fmt(monto)} · ${completo ? 'cierra' : 'parcial, faltan ' + fmt(Number(comp.monto_usd) - nuevoTotal)}. ${prop.razon}`,
        })
      } else if (c.kind === 'cuota_pago') {
        const { error } = await supabase.from('cobranza_cuota_pagos')
          .update({ bank_tx_id: tx.id, bank_match_strength: prop.strength === 'ai' ? 'ai' : 'manual' }).eq('id', c.id)
        if (error) throw new Error(error.message)
        await supabase.from('bank_transactions').update({ matched: true }).eq('id', tx.id)
      } else if (c.kind === 'diferida_pago') {
        const { error } = await supabase.from('compromisos_inicial_diferida_pagos')
          .update({ bank_tx_id: tx.id, bank_match_strength: prop.strength === 'ai' ? 'ai' : 'manual' }).eq('id', c.id)
        if (error) throw new Error(error.message)
        await supabase.from('bank_transactions').update({ matched: true }).eq('id', tx.id)
      } else {
        // ingreso / egreso comprobante. Link via the comprobante's existing
        // bank_transaction_id column (same column bancarizaciones use), then
        // mark the bank row matched. No phantom columns.
        const { error: cErr } = await supabase.from('tesoreria_comprobantes')
          .update({ bank_transaction_id: tx.id }).eq('id', c.id)
        if (cErr) throw new Error('No se pudo ligar el comprobante: ' + cErr.message)
        const { error: tErr } = await supabase.from('bank_transactions')
          .update({ matched: true }).eq('id', tx.id)
        if (tErr) throw new Error('Comprobante ligado pero la transacción no se marcó: ' + tErr.message)
        await supabase.from('tesoreria_comprobante_eventos').insert({
          comprobante_id: c.id, evento: 'CONCILIADO_BANCO', actor_user_id: uid,
          actor_label: 'Conciliación (confirmada)',
          notas: `Conciliado en banco desde /conciliacion: ${fmt(Number(tx.monto_usd))} · ${prop.razon}`,
        })
      }
      await run()
    } catch (e: any) {
      setErr(e?.message || 'Error al conciliar')
    } finally { setConfirming(null) }
  }

  if (permsLoading || (!permissions.npa_can_admin)) {
    return <AdminShell active="conciliacion"><div /></AdminShell>
  }

  const rows = result?.rows || []
  const proposalFor = (r: ReconRow): Proposal | undefined => r.proposal || aiProposals.get(r.tx.id)
  const sinExplicar = rows.filter(r => r.bucket === 'entrada_sin_explicar' || r.bucket === 'salida_sin_explicar')
  const conciliados = rows.filter(r => r.bucket === 'conciliado')
  const internas = rows.filter(r => r.bucket === 'interna')

  const visible = sinExplicar.filter(r =>
    filter === 'all' || filter === 'sin_explicar' ? true :
    filter === 'entrada' ? r.bucket === 'entrada_sin_explicar' :
    r.bucket === 'salida_sin_explicar')

  return (
    <AdminShell active="conciliacion">
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px 60px' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 2 }}>Módulo</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-primary)' }}>Conciliación de cuentas</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              style={{ padding: '8px 10px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 }} />
            <span style={{ color: 'var(--text-secondary)' }}>→</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              style={{ padding: '8px 10px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 }} />
            <button onClick={run} disabled={loading}
              style={{ padding: '9px 16px', background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              {loading ? 'Cargando…' : 'Actualizar'}
            </button>
            <button onClick={analizarConIA} disabled={aiBusy || loading || !result || result.needsAI.length === 0}
              style={{ padding: '9px 16px', background: '#7C3AED', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: (aiBusy || !result || result.needsAI.length === 0) ? 0.6 : 1 }}>
              {aiBusy ? 'Analizando…' : '🤖 Analizar con IA'}
            </button>
          </div>
        </div>

        {err && <div style={{ padding: '10px 14px', background: 'rgba(187,22,43,0.1)', border: '1px solid rgba(187,22,43,0.35)', borderRadius: 8, color: RED, fontSize: 13, marginBottom: 16 }}>{err}</div>}

        {/* Summary cards */}
        {result && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
            {[
              { l: 'Transacciones', v: result.counts.total, c: 'var(--text-primary)' },
              { l: 'Conciliado en banco', v: result.counts.conciliado, c: '#16A34A' },
              { l: 'Sin explicar', v: result.counts.entrada + result.counts.salida, c: '#D97706' },
              { l: 'Internas', v: result.counts.interna, c: 'var(--text-secondary)' },
            ].map((k, i) => (
              <div key={i} style={{ background: 'var(--bg-card)', borderRadius: 8, padding: '14px 16px' }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{k.l}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: k.c }}>{k.v}</div>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        {result && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {([
              ['sin_explicar', `Sin explicar (${result.counts.entrada + result.counts.salida})`],
              ['entrada', 'Entradas'],
              ['salida', 'Salidas'],
              ['all', 'Todas las sin explicar'],
            ] as [typeof filter, string][]).map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)}
                style={{ fontSize: 12, padding: '5px 12px', borderRadius: 99, cursor: 'pointer',
                  background: filter === k ? 'rgba(124,58,237,0.15)' : 'transparent',
                  color: filter === k ? '#7C3AED' : 'var(--text-secondary)',
                  border: filter === k ? 'none' : '1px solid var(--border)' }}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Unexplained rows */}
        {result && (
          <>
            <div style={{ fontSize: 11, color: '#D97706', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, marginBottom: 8 }}>
              Requieren tu atención
            </div>
            {visible.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '12px 0' }}>
                {sinExplicar.length === 0 ? 'Todo conciliado en este periodo. ✓' : 'Nada en este filtro.'}
              </div>
            )}
            {aiRan && result.needsAI.length > 0 && aiProposals.size === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                La IA no encontró candidatos para las transacciones sin explicar — requieren registro manual o son internas.
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
              {visible.map(r => {
                const prop = proposalFor(r)
                const isIn = r.bucket === 'entrada_sin_explicar'
                return (
                  <div key={r.tx.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 240, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: isIn ? '#16A34A' : RED, fontSize: 16 }}>{isIn ? '↓' : '↑'}</span>
                          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{fmt(r.tx.monto_usd)}</span>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            · {fmtDate(r.tx.fecha)} · {(r.tx.tipo || '').toUpperCase()} · {CUENTA_LABELS[r.tx.cuenta || ''] || r.tx.cuenta || '—'}
                          </span>
                        </div>
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{r.tx.sender_name || '—'}</div>
                        {prop && prop.counterpart ? (
                          <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(55,138,221,0.1)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary)' }}>
                            <b style={{ color: '#378ADD' }}>Propuesta{prop.strength === 'ai' ? ' IA' : ''}:</b> {prop.counterpart.label} — {prop.razon}
                          </div>
                        ) : (
                          <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(217,119,6,0.1)', borderRadius: 8, fontSize: 12, color: '#D97706' }}>
                            {aiRan ? 'Sin registro en tesorería — investigar o registrar.' : 'Sin coincidencia automática. Ejecuta “Analizar con IA” o regístralo.'}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {prop && prop.counterpart ? (
                          <>
                            <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 99, background: prop.confianza >= 85 ? 'rgba(22,163,74,0.15)' : 'rgba(217,119,6,0.15)', color: prop.confianza >= 85 ? '#16A34A' : '#D97706' }}>
                              {prop.confianza}%
                            </span>
                            <button onClick={() => conciliar(r.tx, prop)} disabled={confirming === r.tx.id}
                              style={{ padding: '7px 14px', background: '#16A34A', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: confirming === r.tx.id ? 0.6 : 1 }}>
                              {confirming === r.tx.id ? 'Conciliando…' : '✓ Conciliar'}
                            </button>
                          </>
                        ) : (
                          <button onClick={() => router.push(isIn ? '/tesoreria/ingresos/nuevo' : '/tesoreria/egresos/nuevo')}
                            style={{ padding: '7px 14px', background: 'var(--bg-deep)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                            + Registrar {isIn ? 'ingreso' : 'egreso'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Conciliado list (collapsed reference) */}
            {conciliados.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: '#16A34A', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, marginBottom: 8 }}>
                  Conciliado en banco ({conciliados.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 24 }}>
                  {conciliados.slice(0, 50).map(r => (
                    <div key={r.tx.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ color: '#16A34A', fontSize: 15 }}>✓</span>
                        <span style={{ fontSize: 14, color: 'var(--text-primary)' }}>{fmt(r.tx.monto_usd)}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>· {r.tx.sender_name || '—'} · {fmtDate(r.tx.fecha)}</span>
                      </div>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{r.linkedLabel}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {internas.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                {internas.length} transacción(es) interna(s) / comisiones — excluidas de la conciliación.
              </div>
            )}
          </>
        )}
      </div>
    </AdminShell>
  )
}