// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/bancarizadores/detail/page.tsx
// v1 (2026-05-26) — Single bancarizador detail page.
//
// URL: /tesoreria/bancarizadores/detail?id=BANC_ALEX
//
// Shows:
//   - Current saldo (positive = nos debe, negative = le debemos)
//   - Movement history (CASH_DELIVERED / WIRE_RECEIVED / SURPLUS / FEE)
//   - Each movement links to its comprobante (if any) and bank tx (if any)
//   - Running balance column
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronLeft, ExternalLink } from 'lucide-react'
import { useAuthGate } from '../../../components/useAuthGate'
import SessionErrorScreen from '../../../components/SessionErrorScreen'
import AdminShell from '../../../components/AdminShell'
import {
  type Bancarizador, type BancarizadorMovimiento,
  loadBancarizadores, loadBancarizadorMovimientos,
  fmtUSD, fmtUSDsigned, fmtDateDMY,
} from '../../../lib/bancarizaciones'
import { supabase } from '../../../supabase'

const NAVY = '#0D2257'
const GOLD = '#C49A2A'
const RED  = '#BB162B'
const GRN  = '#16A34A'
const MUTED = '#71717A'

const TIPO_LABEL: Record<string, { label: string; color: string; sign: 1 | -1 }> = {
  CASH_DELIVERED: { label: 'Cash entregado',  color: NAVY, sign:  1 },
  WIRE_RECEIVED:  { label: 'Wire recibido',    color: GRN,  sign: -1 },
  SURPLUS:        { label: 'Surplus (a favor)', color: GRN, sign: -1 },
  SHORTFALL:      { label: 'Faltante (en contra)', color: RED, sign:  1 },
  FEE:            { label: 'Comisión',          color: GOLD, sign: -1 },
  ADJUSTMENT:     { label: 'Ajuste',            color: MUTED, sign: 1 },
}

export default function BancarizadorDetailWrapper() {
  return (
    <Suspense fallback={
      <AdminShell active="tesoreria">
        <div style={{ padding: 60, textAlign: 'center', color: MUTED }}>Cargando…</div>
      </AdminShell>
    }>
      <BancarizadorDetail />
    </Suspense>
  )
}

function BancarizadorDetail() {
  const router = useRouter()
  const params = useSearchParams()
  const id = params.get('id')

  const gate = useAuthGate(p =>
    p.tesoreria_can_view_balance ||
    p.tesoreria_can_pickup ||
    p.tesoreria_admin ||
    p.npa_can_admin
  )

  const [banc, setBanc] = useState<Bancarizador | null>(null)
  const [movs, setMovs] = useState<BancarizadorMovimiento[]>([])
  const [compNumbers, setCompNumbers] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (gate.status === 'denied') router.replace('/tesoreria/home')
  }, [gate.status, router])

  useEffect(() => {
    if (gate.status !== 'ok' || !id) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      loadBancarizadores().then(all => all.find(b => b.id === id) || null),
      loadBancarizadorMovimientos(id),
    ]).then(async ([b, m]) => {
      if (cancelled) return
      setBanc(b); setMovs(m)
      // Resolve comprobante numbers for the links
      const cIds = Array.from(new Set(m.map(x => x.comprobante_id).filter(Boolean) as string[]))
      if (cIds.length > 0) {
        const { data: comps } = await supabase
          .from('tesoreria_comprobantes')
          .select('id, numero')
          .in('id', cIds)
        const map: Record<string, string> = {}
        for (const c of (comps || []) as any[]) map[c.id] = c.numero
        if (!cancelled) setCompNumbers(map)
      }
    }).catch(e => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [gate.status, id])

  if (!id) {
    return (
      <AdminShell active="tesoreria">
        <div style={{ padding: 40, color: RED, textAlign: 'center' }}>Falta parámetro id en la URL</div>
      </AdminShell>
    )
  }
  if (gate.status === 'loading') return <AdminShell active="tesoreria"><div style={{ padding: 60, textAlign: 'center', color: MUTED }}>Cargando…</div></AdminShell>
  if (gate.status === 'error') return <SessionErrorScreen homeHref="/tesoreria/home" />
  if (gate.status !== 'ok') return null

  // Compute running balance in chronological order (oldest first)
  const movsSorted = [...movs].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  let running = 0
  const movsWithRunning = movsSorted.map(m => {
    const meta = TIPO_LABEL[m.tipo] || { label: m.tipo, color: MUTED, sign: 1 as const }
    running += meta.sign * Number(m.monto)
    return { m, running, meta }
  }).reverse() // display newest first

  return (
    <AdminShell active="tesoreria">
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 20px 80px' }}>
        <button onClick={() => router.push('/tesoreria/bancarizadores')}
          style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: NAVY, fontSize: 13, cursor: 'pointer', marginBottom: 16 }}>
          <ChevronLeft size={16} /> Volver a Bancarizadores
        </button>

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center', color: MUTED }}>Cargando…</div>
        ) : err ? (
          <div style={{ padding: 24, color: RED }}>{err}</div>
        ) : !banc ? (
          <div style={{ padding: 24, color: RED }}>Bancarizador no encontrado</div>
        ) : (
          <>
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 11, color: GOLD, textTransform: 'uppercase', letterSpacing: 2, fontWeight: 700 }}>Bancarizador</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: NAVY }}>{banc.nombre}</div>
              {banc.contacto && <div style={{ fontSize: 13, color: '#52525B', marginTop: 4 }}>{banc.contacto}</div>}
            </div>

            <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderLeft: '6px solid ' + (banc.saldo_usd > 0 ? GRN : banc.saldo_usd < 0 ? RED : MUTED), borderRadius: 8, padding: '20px 24px', marginBottom: 24 }}>
              <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 700 }}>Saldo actual</div>
              <div style={{ fontSize: 36, fontWeight: 800, color: banc.saldo_usd > 0 ? GRN : banc.saldo_usd < 0 ? RED : MUTED, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                {fmtUSDsigned(banc.saldo_usd)}
              </div>
              <div style={{ fontSize: 13, color: '#52525B', marginTop: 4 }}>
                {banc.saldo_usd > 0
                  ? <><b>{banc.nombre}</b> nos debe esta cantidad. Se le entregó más cash del que ha depositado.</>
                  : banc.saldo_usd < 0
                  ? <>Le debemos a <b>{banc.nombre}</b> esta cantidad. Depositó más de lo que se le entregó en cash.</>
                  : <>Cuenta cuadrada — sin saldo pendiente.</>}
              </div>
            </div>

            <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid #E5E2D8', fontSize: 12, color: GOLD, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700 }}>
                Historial de movimientos · {movs.length}
              </div>
              {movs.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: MUTED, fontSize: 13 }}>Sin movimientos</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#F5F1E8', color: NAVY }}>
                      <th style={th}>Fecha</th>
                      <th style={th}>Tipo</th>
                      <th style={{ ...th, textAlign: 'right' }}>Monto</th>
                      <th style={{ ...th, textAlign: 'right' }}>Saldo acum.</th>
                      <th style={th}>Comprobante</th>
                      <th style={th}>Notas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movsWithRunning.map(({ m, running, meta }) => (
                      <tr key={m.id} style={{ borderTop: '1px solid #E5E2D8' }}>
                        <td style={td}>{fmtDateDMY(m.created_at)}</td>
                        <td style={td}>
                          <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: meta.color + '22', color: meta.color, textTransform: 'uppercase' }}>
                            {meta.label}
                          </span>
                        </td>
                        <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums', color: meta.sign > 0 ? NAVY : GRN }}>
                          {meta.sign > 0 ? '+' : '−'}{fmtUSD(Number(m.monto))}
                        </td>
                        <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums', color: running > 0 ? GRN : running < 0 ? RED : MUTED, fontWeight: 700 }}>
                          {fmtUSDsigned(running)}
                        </td>
                        <td style={td}>
                          {m.comprobante_id && compNumbers[m.comprobante_id] ? (
                            <a onClick={(e) => { e.preventDefault(); router.push('/tesoreria/comprobante?id=' + m.comprobante_id) }}
                              style={{ color: NAVY, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              {compNumbers[m.comprobante_id]} <ExternalLink size={11} />
                            </a>
                          ) : <span style={{ color: MUTED }}>—</span>}
                        </td>
                        <td style={{ ...td, fontSize: 11, color: '#52525B', maxWidth: 280, whiteSpace: 'normal' }}>{m.notas || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </AdminShell>
  )
}

const th: React.CSSProperties = { padding: '10px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '9px 12px', whiteSpace: 'nowrap' }