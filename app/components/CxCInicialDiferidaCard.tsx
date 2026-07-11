'use client'
import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (iso: string) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }

interface Compromiso {
  id: string
  deal_id: number
  negocio_num: string
  cliente_nombre: string
  cliente_apellidos: string | null
  monto_usd: number
  fecha_vencimiento: string
  fecha_compromiso: string | null
  estado: string
  custodia_motocentro: boolean
}

/**
 * CxC widget for Inicial Diferida — used in two places:
 *
 * - mode="vencidas-banner" (Auditoría list view):
 *   Renders ONLY when there are overdue compromisos. Red urgency.
 *   Silent when everything is on time. Top 3.
 *
 * - mode="card" (Admin dashboard):
 *   Always renders. Orange section. Vencidas first (red), then due soon (orange).
 *   Top 5.
 *
 * Both modes link to /inicial-diferida for full management.
 */
export default function CxCInicialDiferidaCard({ mode }: { mode: 'vencidas-banner' | 'card' }) {
  const [items, setItems] = useState<Compromiso[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('compromisos_inicial_diferida')
        .select('id, deal_id, negocio_num, cliente_nombre, cliente_apellidos, monto_usd, fecha_vencimiento, fecha_compromiso, estado, custodia_motocentro')
        .eq('estado', 'PENDIENTE')
        .order('fecha_vencimiento', { ascending: true })
      setItems(data || [])
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return null

  const today_iso = new Date().toISOString().slice(0, 10)
  const today = new Date()

  const enriched = items.map(c => {
    const venc = new Date(c.fecha_vencimiento + 'T12:00:00')
    const diasDiff = Math.floor((venc.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    const isVencida = c.fecha_vencimiento < today_iso
    return { ...c, diasDiff, isVencida }
  })

  const vencidas = enriched.filter(c => c.isVencida)
  const proximas = enriched.filter(c => !c.isVencida).slice(0, 5 - Math.min(vencidas.length, 5))

  // ─── Mode: vencidas-banner (Auditoría) ───
  if (mode === 'vencidas-banner') {
    if (vencidas.length === 0) return null

    const totalVencido = vencidas.reduce((s, c) => s + (c.monto_usd || 0), 0)
    const top3 = vencidas.slice(0, 3)

    return (
      <div style={{
        background: 'linear-gradient(135deg, rgba(187,22,43,0.12) 0%, rgba(187,22,43,0.05) 100%)',
        border: '2px solid rgba(187,22,43,0.5)',
        borderRadius: '12px',
        padding: '20px 24px',
        marginBottom: '24px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' as const, gap: '12px', marginBottom: '14px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
              <span style={{ fontSize: '18px' }}>⚠️</span>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '2px' }}>
                Iniciales Diferidas Vencidas — Acción Urgente
              </span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              {vencidas.length} compromiso{vencidas.length !== 1 ? 's' : ''} fuera de fecha · Total por cobrar: <strong style={{ color: '#BB162B' }}>{fmt(totalVencido)}</strong>
            </div>
          </div>
          <a href="/inicial-diferida"
            style={{ padding: '8px 16px', background: '#BB162B', color: '#fff', borderRadius: '8px', fontSize: '12px', fontWeight: 700, textDecoration: 'none', textTransform: 'uppercase' as const, letterSpacing: '1px', flexShrink: 0 }}>
            Gestionar →
          </a>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
          {top3.map(c => (
            <div key={c.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 14px', background: 'var(--bg-card)', borderRadius: '8px',
              border: '1px solid rgba(187,22,43,0.2)',
              flexWrap: 'wrap' as const, gap: '10px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' as const }}>
                <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>#{c.negocio_num}</span>
                <span style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{c.cliente_nombre} {c.cliente_apellidos || ''}</span>
                {c.custodia_motocentro && (
                  <span style={{ fontSize: '10px', padding: '2px 8px', background: 'rgba(184,114,10,0.15)', color: '#b8720a', borderRadius: '10px', fontWeight: 700 }}>
                    🔒 Custodia
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' as const }}>
                <div style={{ textAlign: 'right' as const }}>
                  <div style={{ fontSize: '15px', fontWeight: 700, color: '#BB162B', fontFamily: 'monospace' }}>{fmt(c.monto_usd)}</div>
                  <div style={{ fontSize: '10px', color: '#BB162B' }}>
                    Venció hace {Math.abs(c.diasDiff)} día{Math.abs(c.diasDiff) !== 1 ? 's' : ''} · {fmtDate(c.fecha_vencimiento)}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {vencidas.length > 3 && (
          <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--text-secondary)', textAlign: 'right' as const }}>
            + {vencidas.length - 3} vencida{vencidas.length - 3 !== 1 ? 's' : ''} más
          </div>
        )}
      </div>
    )
  }

  // ─── Mode: card (Admin dashboard) ───
  if (items.length === 0) {
    return (
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: '24px',
        marginBottom: '20px',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: '#e67e22', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '8px' }}>
          Cuentas por Cobrar — Iniciales Diferidas
        </div>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          ✓ No hay compromisos pendientes en este momento.
        </div>
      </div>
    )
  }

  // Order: vencidas first (most overdue first), then próximas (most urgent first)
  const ordered = [...vencidas, ...proximas].slice(0, 5)
  const totalPendiente = enriched.reduce((s, c) => s + (c.monto_usd || 0), 0)
  const totalVencido = vencidas.reduce((s, c) => s + (c.monto_usd || 0), 0)

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: `1px solid ${vencidas.length > 0 ? 'rgba(187,22,43,0.4)' : 'rgba(230,126,34,0.3)'}`,
      borderRadius: '12px',
      padding: '24px',
      marginBottom: '20px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' as const, gap: '12px', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--border)' }}>
        <div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#e67e22', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '4px' }}>
            Cuentas por Cobrar — Iniciales Diferidas
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            {items.length} pendiente{items.length !== 1 ? 's' : ''} · Total: <strong style={{ color: '#e67e22' }}>{fmt(totalPendiente)}</strong>
            {vencidas.length > 0 && (
              <> · <span style={{ color: '#BB162B', fontWeight: 700 }}>{vencidas.length} vencida{vencidas.length !== 1 ? 's' : ''} ({fmt(totalVencido)})</span></>
            )}
          </div>
        </div>
        <a href="/inicial-diferida"
          style={{ padding: '8px 16px', background: 'transparent', color: '#e67e22', border: '1px solid #e67e22', borderRadius: '8px', fontSize: '12px', fontWeight: 700, textDecoration: 'none', textTransform: 'uppercase' as const, letterSpacing: '1px', flexShrink: 0 }}>
          Ver Todas →
        </a>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
        {ordered.map(c => {
          const isVenc = c.isVencida
          const subtitle = isVenc
            ? `Venció hace ${Math.abs(c.diasDiff)} día${Math.abs(c.diasDiff) !== 1 ? 's' : ''}`
            : c.diasDiff === 0 ? 'Vence hoy'
            : `Faltan ${c.diasDiff} día${c.diasDiff !== 1 ? 's' : ''}`
          const urgencyColor = isVenc ? '#BB162B' : c.diasDiff <= 3 ? '#b8720a' : 'var(--text-secondary)'

          return (
            <div key={c.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '12px 14px',
              background: isVenc ? 'rgba(187,22,43,0.05)' : 'var(--bg-deep)',
              borderRadius: '8px',
              border: `1px solid ${isVenc ? 'rgba(187,22,43,0.25)' : 'transparent'}`,
              flexWrap: 'wrap' as const, gap: '10px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' as const }}>
                <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>#{c.negocio_num}</span>
                <span style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{c.cliente_nombre} {c.cliente_apellidos || ''}</span>
                {isVenc && (
                  <span style={{ fontSize: '10px', padding: '2px 8px', background: 'rgba(187,22,43,0.15)', color: '#BB162B', borderRadius: '10px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>
                    Vencida
                  </span>
                )}
                {c.custodia_motocentro && (
                  <span style={{ fontSize: '10px', padding: '2px 8px', background: 'rgba(184,114,10,0.15)', color: '#b8720a', borderRadius: '10px', fontWeight: 700 }}>
                    🔒 Custodia
                  </span>
                )}
              </div>
              <div style={{ textAlign: 'right' as const }}>
                <div style={{ fontSize: '14px', fontWeight: 700, color: isVenc ? '#BB162B' : '#e67e22', fontFamily: 'monospace' }}>{fmt(c.monto_usd)}</div>
                <div style={{ fontSize: '10px', color: urgencyColor }}>
                  {subtitle} · {fmtDate(c.fecha_vencimiento)}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {items.length > 5 && (
        <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--text-secondary)', textAlign: 'right' as const }}>
          + {items.length - 5} más pendiente{items.length - 5 !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  )
}