'use client'
// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/inicial-diferida/page.tsx
// AutoCore NPA — Inicial Diferida (compromisos)
//
// Phase 4.1 (2026-05-14): partial payment support
//   - Modal asks `monto a registrar` (defaults to saldo_pendiente, editable)
//   - Validates monto <= saldo_pendiente
//   - Live preview: "Saldo restante: $X. Quedará PARCIAL/PAGADA"
//   - Writes to new compromisos_inicial_diferida_pagos history table
//     (trigger auto-updates parent estado + monto_pagado_acumulado)
//   - Table gains progress column + saldo column
//   - Expandable history per row showing all partial payments
//   - Deal.pagos now gets the ACTUAL amount paid (not compromiso.monto_usd)
//
// Phase 4.2 (2026-05-14): admin Editar + Anular
//   - Editar: change monto/fecha/notas while PENDIENTE (no pagos yet)
//   - Anular: cancel a compromiso in any state, reverse all partial pagos via
//     is_reversal=true rows, scrub deal.pagos of related entries, log to
//     activity_log with optional 'es_correccion' flag to distinguish from real
//     cancellations in reporting
//
// Both new actions: admin-only (npa_can_admin || tesoreria_admin)
// ═══════════════════════════════════════════════════════════════════════════
import { useState, useEffect, Fragment, Suspense } from 'react'
import { supabase } from '../supabase'
import { useRouter, useSearchParams } from 'next/navigation'
import AdminShell from '../components/AdminShell'
import { useNPAPermissions } from '../components/useNPAPermissions'

const fmt = (n: number) => `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (iso: string) => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif', transition: 'background 0.35s ease' },
  content: { padding: '32px', maxWidth: '1300px', margin: '0 auto' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', marginBottom: '20px' },
  btnRed: { padding: '10px 24px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  btnGray: { padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  btnGreen: { padding: '10px 24px', background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  modalShell: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' },
  modalCard: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '32px', maxWidth: '480px', width: '100%', maxHeight: '95vh', overflowY: 'auto' as const },
  inputBase: { width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', boxSizing: 'border-box' as const },
  label: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px', display: 'block', marginBottom: '6px' },
}

const thTd: any = { padding: '10px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px' }

// ─── Modal 1: chooser (AI vs manual) ────────────────────────────────────────
function RegistrarPagoModal({
  compromiso, canMarkManual, onChooseAI, onChooseManual, onCancel,
}: {
  compromiso: any
  canMarkManual: boolean
  onChooseAI: () => void
  onChooseManual: () => void
  onCancel: () => void
}) {
  const pagado = compromiso.monto_pagado_acumulado || 0
  const saldo = compromiso.saldo_pendiente ?? (compromiso.monto_usd - pagado)
  return (
    <div style={s.modalShell}>
      <div style={s.modalCard}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Registrar Pago de Inicial Diferida</div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
          Negocio #{compromiso.negocio_num} — {compromiso.cliente_nombre} {compromiso.cliente_apellidos || ''}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '20px', padding: '12px', background: 'var(--bg-deep)', borderRadius: '8px' }}>
          <div>
            <div style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.2, marginBottom: 2 }}>Total</div>
            <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{fmt(compromiso.monto_usd)}</div>
          </div>
          <div>
            <div style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.2, marginBottom: 2 }}>Pagado</div>
            <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace', color: '#2ecc8a' }}>{fmt(pagado)}</div>
          </div>
          <div>
            <div style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.2, marginBottom: 2 }}>Saldo</div>
            <div style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace', color: '#e67e22' }}>{fmt(saldo)}</div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '10px' }}>
          <button onClick={onChooseAI} style={{ ...s.btnRed, padding: '14px', textAlign: 'left' as const, display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: '20px' }}>🤖</span>
            <div>
              <div>Subir Comprobante con IA</div>
              <div style={{ fontSize: '10px', fontWeight: 500, opacity: 0.85, marginTop: 2 }}>Detecta el monto desde el recibo</div>
            </div>
          </button>
          {canMarkManual && (
            <button onClick={onChooseManual} style={{ ...s.btnGreen, padding: '14px', textAlign: 'left' as const, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: '20px' }}>✍️</span>
              <div>
                <div>Marcar Manualmente</div>
                <div style={{ fontSize: '10px', fontWeight: 500, opacity: 0.85, marginTop: 2 }}>Efectivo, pago parcial o sin comprobante</div>
              </div>
            </button>
          )}
          <button onClick={onCancel} style={{ ...s.btnGray, padding: '12px' }}>Cancelar</button>
        </div>
      </div>
    </div>
  )
}

// ─── Modal 2: manual mark-paid form (PARTIAL SUPPORT) ────────────────────────
function MarcarManualModal({ compromiso, onConfirm, onCancel }: { compromiso: any, onConfirm: (data: any) => void, onCancel: () => void }) {
  const pagado = compromiso.monto_pagado_acumulado || 0
  const saldoPendiente = compromiso.saldo_pendiente ?? (compromiso.monto_usd - pagado)

  const [monto, setMonto] = useState<string>(saldoPendiente.toString())
  const [metodo, setMetodo] = useState('')
  const [referencia, setReferencia] = useState('')
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10))
  const [comentario, setComentario] = useState('')
  const METODOS = ['Efectivo', 'Zelle Roframi', 'Zelle Motocentro', 'Wire Transfer Roframi', 'Wire Transfer Motocentro', 'USDT', 'Transferencia en Bolívares']

  const montoNum = parseFloat(monto) || 0
  const isValidMonto = montoNum > 0 && montoNum <= saldoPendiente
  const saldoRestante = Math.max(saldoPendiente - montoNum, 0)
  const willBeFullyPaid = saldoRestante <= 0.005
  const willBeEstado = willBeFullyPaid ? 'PAGADA' : 'PARCIAL'
  const willBeColor = willBeFullyPaid ? '#2ecc8a' : '#e67e22'

  return (
    <div style={s.modalShell}>
      <div style={s.modalCard}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Registrar Pago Manual</div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
          Negocio #{compromiso.negocio_num} — {compromiso.cliente_nombre} {compromiso.cliente_apellidos || ''}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '20px', padding: '10px', background: 'var(--bg-deep)', borderRadius: '8px' }}>
          <div>
            <div style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.2 }}>Total</div>
            <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace' }}>{fmt(compromiso.monto_usd)}</div>
          </div>
          <div>
            <div style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.2 }}>Pagado</div>
            <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', color: '#2ecc8a' }}>{fmt(pagado)}</div>
          </div>
          <div>
            <div style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.2 }}>Saldo</div>
            <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', color: '#e67e22' }}>{fmt(saldoPendiente)}</div>
          </div>
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label style={s.label}>Monto a Registrar (USD) <span style={{ color: '#BB162B' }}>*</span></label>
          <input
            type="number" step="0.01" min="0.01" max={saldoPendiente}
            value={monto} onChange={e => setMonto(e.target.value)}
            style={{ ...s.inputBase, padding: '12px 14px', fontSize: '16px', fontWeight: 700, fontFamily: 'monospace' }}
            placeholder="0.00"
          />
          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: 4 }}>
            Máximo: {fmt(saldoPendiente)} (saldo pendiente)
          </div>
        </div>

        {montoNum > 0 && (
          <div style={{
            padding: '12px 14px', marginBottom: '14px',
            background: willBeFullyPaid ? 'rgba(46,204,138,0.08)' : 'rgba(230,126,34,0.08)',
            border: `1px solid ${willBeColor}55`,
            borderRadius: '8px',
            fontSize: '12px',
          }}>
            <div style={{ color: 'var(--text-secondary)', fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 6 }}>Después de este pago</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Saldo restante</div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{fmt(saldoRestante)}</div>
              </div>
              <div style={{ padding: '4px 12px', borderRadius: 4, background: willBeColor + '22', color: willBeColor, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>
                {willBeEstado}
              </div>
            </div>
          </div>
        )}

        <div style={{ marginBottom: '14px' }}>
          <label style={s.label}>Método de Pago <span style={{ color: '#BB162B' }}>*</span></label>
          <select value={metodo} onChange={e => setMetodo(e.target.value)} style={s.inputBase}>
            <option value="">Seleccionar...</option>
            {METODOS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label style={s.label}>Referencia / Confirmación</label>
          <input value={referencia} onChange={e => setReferencia(e.target.value)} style={s.inputBase} placeholder="Número de operación" />
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label style={s.label}>Fecha del Pago <span style={{ color: '#BB162B' }}>*</span></label>
          <input type="date" value={fecha} onChange={e => setFecha(e.target.value)} style={s.inputBase} />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={s.label}>Comentario (opcional)</label>
          <input value={comentario} onChange={e => setComentario(e.target.value)} style={s.inputBase} placeholder="Ej: parte de Zelle $2,800; resto va a cuota #1" />
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={onCancel} style={{ ...s.btnGray, flex: 1 }}>Cancelar</button>
          <button
            onClick={() => {
              if (!isValidMonto) { alert('El monto debe ser mayor a 0 y no exceder el saldo pendiente.'); return }
              if (!metodo) { alert('Selecciona un método de pago.'); return }
              onConfirm({ monto: montoNum, metodo, referencia, fecha, comentario })
            }}
            disabled={!isValidMonto || !metodo}
            style={{ ...s.btnGreen, flex: 1, opacity: (!isValidMonto || !metodo) ? 0.5 : 1 }}
          >
            ✓ Registrar Pago
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Modal 3: Editar (admin only, PENDIENTE only) ────────────────────────────
function EditarCompromisoModal({ compromiso, onConfirm, onCancel }: { compromiso: any, onConfirm: (data: any) => void, onCancel: () => void }) {
  const [monto, setMonto] = useState<string>(String(compromiso.monto_usd))
  const [fechaVenc, setFechaVenc] = useState<string>(compromiso.fecha_vencimiento || '')
  const [notas, setNotas] = useState<string>(compromiso.notas || '')

  const montoNum = parseFloat(monto) || 0
  const isValid = montoNum > 0 && !!fechaVenc

  return (
    <div style={s.modalShell}>
      <div style={s.modalCard}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Editar Compromiso</div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
          Negocio #{compromiso.negocio_num} — {compromiso.cliente_nombre} {compromiso.cliente_apellidos || ''}
        </div>
        <div style={{ fontSize: '10px', color: '#b8720a', background: 'rgba(184,114,10,0.08)', border: '1px solid rgba(184,114,10,0.25)', borderRadius: '6px', padding: '8px 12px', marginBottom: '20px', lineHeight: 1.5 }}>
          ⚠ Solo disponible mientras el compromiso esté en estado PENDIENTE y sin pagos registrados.
          Para compromisos con pagos parciales, usa Anular.
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label style={s.label}>Monto USD <span style={{ color: '#BB162B' }}>*</span></label>
          <input
            type="number" step="0.01" min="0.01"
            value={monto} onChange={e => setMonto(e.target.value)}
            style={{ ...s.inputBase, padding: '12px 14px', fontSize: '16px', fontWeight: 700, fontFamily: 'monospace' }}
          />
          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: 4 }}>
            Original: {fmt(compromiso.monto_usd)}
          </div>
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label style={s.label}>Fecha de Vencimiento <span style={{ color: '#BB162B' }}>*</span></label>
          <input type="date" value={fechaVenc} onChange={e => setFechaVenc(e.target.value)} style={s.inputBase} />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={s.label}>Notas</label>
          <textarea value={notas} onChange={e => setNotas(e.target.value)}
            style={{ ...s.inputBase, minHeight: 60, resize: 'vertical' as const, fontFamily: 'inherit' }}
            placeholder="Notas internas (opcional)" />
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={onCancel} style={{ ...s.btnGray, flex: 1 }}>Cancelar</button>
          <button
            onClick={() => {
              if (!isValid) { alert('Verifica el monto y la fecha de vencimiento.'); return }
              if (montoNum !== compromiso.monto_usd && !confirm('Vas a cambiar el monto del compromiso. ¿Confirmas?')) return
              onConfirm({ monto_usd: montoNum, fecha_vencimiento: fechaVenc, notas })
            }}
            disabled={!isValid}
            style={{ ...s.btnGreen, flex: 1, opacity: !isValid ? 0.5 : 1 }}
          >
            ✓ Guardar Cambios
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Modal 4: Anular (admin only) ────────────────────────────────────────────
function AnularCompromisoModal({ compromiso, pagosCount, onConfirm, onCancel }: {
  compromiso: any
  pagosCount: number   // number of non-reversal pagos that will be reversed
  onConfirm: (data: { motivo: string, esCorreccion: boolean }) => void
  onCancel: () => void
}) {
  const [motivo, setMotivo] = useState('')
  const [esCorreccion, setEsCorreccion] = useState(true)  // default ON since most admin anulars are corrections

  const pagado = compromiso.monto_pagado_acumulado || 0

  return (
    <div style={s.modalShell}>
      <div style={s.modalCard}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: '#BB162B', marginBottom: '4px' }}>✕ Anular Compromiso</div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
          Negocio #{compromiso.negocio_num} — {compromiso.cliente_nombre} {compromiso.cliente_apellidos || ''}
        </div>

        <div style={{ background: 'rgba(187,22,43,0.08)', border: '1px solid rgba(187,22,43,0.3)', borderRadius: '8px', padding: '12px 14px', marginBottom: '20px', fontSize: '12px', color: 'var(--text-primary)', lineHeight: 1.6 }}>
          <strong style={{ color: '#BB162B' }}>Esta acción es irreversible.</strong>
          <div style={{ marginTop: 8 }}>Se realizará lo siguiente:</div>
          <ul style={{ marginTop: 6, marginBottom: 0, paddingLeft: 18, fontSize: 11 }}>
            <li>Compromiso marcado como <strong>CANCELADA</strong></li>
            {pagosCount > 0 && (
              <li><strong>{pagosCount}</strong> pago{pagosCount === 1 ? '' : 's'} parcial{pagosCount === 1 ? '' : 'es'} ({fmt(pagado)}) reversado{pagosCount === 1 ? '' : 's'} en el historial</li>
            )}
            <li>Entradas correspondientes en deals.pagos serán eliminadas</li>
            <li>total_recibido del deal será recalculado</li>
          </ul>
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label style={s.label}>Motivo <span style={{ color: '#BB162B' }}>*</span></label>
          <textarea value={motivo} onChange={e => setMotivo(e.target.value)}
            style={{ ...s.inputBase, minHeight: 70, resize: 'vertical' as const, fontFamily: 'inherit' }}
            placeholder="Ej: cliente solicitó cancelación / error en registro original / etc." />
        </div>

        <div style={{ marginBottom: '20px', padding: '10px 12px', background: 'var(--bg-deep)', borderRadius: '8px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <input
            type="checkbox" id="esCorreccion"
            checked={esCorreccion}
            onChange={e => setEsCorreccion(e.target.checked)}
            style={{ marginTop: 3, cursor: 'pointer' }}
          />
          <label htmlFor="esCorreccion" style={{ fontSize: 12, color: 'var(--text-primary)', cursor: 'pointer', lineHeight: 1.5 }}>
            <strong>Esto es una corrección de error</strong>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
              Se marcará como corrección en los reportes (no cuenta como cancelación real).
            </div>
          </label>
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={onCancel} style={{ ...s.btnGray, flex: 1 }}>Cancelar</button>
          <button
            onClick={() => {
              if (!motivo.trim()) { alert('Debes ingresar un motivo.'); return }
              if (!confirm(`¿Anular definitivamente el compromiso #${compromiso.negocio_num}?\n\nEsta acción no se puede deshacer.`)) return
              onConfirm({ motivo: motivo.trim(), esCorreccion })
            }}
            disabled={!motivo.trim()}
            style={{ ...s.btnRed, flex: 1, opacity: !motivo.trim() ? 0.5 : 1 }}
          >
            ✕ Anular Definitivo
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────
function InicialDiferidaPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { permissions, loading: permsLoading } = useNPAPermissions()
  const [user, setUser] = useState<any>(null)
  const [diferidas, setDiferidas] = useState<any[]>([])
  const [pagosByCompromiso, setPagosByCompromiso] = useState<Record<string, any[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'PENDIENTE' | 'PARCIAL' | 'PAGADA' | 'VENCIDA' | 'CANCELADA' | 'TODAS'>('PENDIENTE')
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  const [registrando, setRegistrando] = useState<any>(null)
  const [marcandoManual, setMarcandoManual] = useState<any>(null)
  const [editando, setEditando] = useState<any>(null)
  const [anulando, setAnulando] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  const canMarkManual = permissions.npa_can_audit_deals || permissions.npa_can_admin || permissions.npa_can_approve_deals
  const isAdmin = permissions.npa_can_admin || permissions.tesoreria_admin

  useEffect(() => {
    if (!permsLoading && !permissions.npa_can_audit_deals && !permissions.npa_can_admin) {
      router.replace('/dashboard')
    }
  }, [permsLoading, permissions, router])

  useEffect(() => {
    const init = async () => {
      const { data: authData } = await supabase.auth.getUser()
      if (!authData.user) { router.push('/'); return }
      setUser(authData.user)
      await load()
      setLoading(false)
    }
    init()
  // eslint-disable-next-line
  }, [])

  // Handle ?id=ID from global search — auto-expand the row, switch to TODAS filter, highlight
  useEffect(() => {
    const id = searchParams?.get('id')
    if (id && diferidas.length > 0) {
      const target = diferidas.find((d: any) => String(d.id) === id)
      if (target) {
        // Filter must include the row's estado for it to appear
        setFilter('TODAS')
        setExpanded(prev => ({ ...prev, [id]: true }))
        setHighlightedId(id)
        setTimeout(() => {
          const el = document.getElementById(`diferida-row-${id}`)
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          window.history.replaceState({}, '', '/inicial-diferida')
        }, 100)
        setTimeout(() => setHighlightedId(null), 4000)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diferidas])

  const load = async () => {
    const [{ data: compData }, { data: pagosData }] = await Promise.all([
      supabase.from('compromisos_inicial_diferida').select('*').order('fecha_vencimiento', { ascending: true }),
      supabase.from('compromisos_inicial_diferida_pagos').select('*').order('fecha', { ascending: true }),
    ])
    setDiferidas(compData || [])
    const grouped: Record<string, any[]> = {}
    ;(pagosData || []).forEach((p: any) => {
      if (!grouped[p.compromiso_id]) grouped[p.compromiso_id] = []
      grouped[p.compromiso_id].push(p)
    })
    setPagosByCompromiso(grouped)
  }

  const handleAIFlow = (compromiso: any) => {
    const url = `/auditoria?open_deal=${encodeURIComponent(compromiso.deal_id)}&open_scanner=ingreso&compromiso_id=${encodeURIComponent(compromiso.id)}`
    router.push(url)
  }

  // ── Phase 4.1: register a partial OR full payment manually ──────────────────
  const handleMarcarManual = async (pagoData: any) => {
    if (!marcandoManual) return
    setBusy(true)
    const compromiso = marcandoManual
    try {
      const { error: pErr } = await supabase.from('compromisos_inicial_diferida_pagos').insert({
        compromiso_id: compromiso.id,
        deal_id:       compromiso.deal_id,
        monto_usd:     pagoData.monto,
        fecha:         pagoData.fecha,
        metodo:        pagoData.metodo,
        referencia:    pagoData.referencia || null,
        comentario:    pagoData.comentario || null,
        registered_by: user?.id || null,
      })
      if (pErr) throw pErr

      const { data: deal } = await supabase.from('deals').select('pagos, tasa_bcv').eq('id', compromiso.deal_id).single()
      if (deal) {
        const tasa = parseFloat(deal.tasa_bcv) || 0
        const newPagos = (deal.pagos || []).filter((p: any) => !(p._inicial_diferida && p._pendiente))
        newPagos.push({
          metodo:     pagoData.metodo,
          fecha:      pagoData.fecha,
          monto_usd:  pagoData.monto,
          monto_bs:   pagoData.monto * tasa,
          referencia: pagoData.referencia || '',
          comentario: pagoData.comentario || `Pago Inicial Diferida — Compromiso ${compromiso.id.slice(0, 8)}`,
          _inicial_diferida_pago: true,
          _compromiso_id: compromiso.id,
        })
        const total_recibido = newPagos.reduce((sum: number, p: any) => sum + (parseFloat(p.monto_usd) || 0), 0)
        await supabase.from('deals').update({ pagos: newPagos, total_recibido }).eq('id', compromiso.deal_id)
      }

      if (user) {
        await supabase.from('activity_log').insert({
          user_id: user.id, user_email: user.email,
          action: 'inicial_diferida_pago_registrado',
          target_type: 'compromiso_inicial_diferida',
          target_id: String(compromiso.id),
          details: {
            negocio_num: compromiso.negocio_num, cliente_nombre: compromiso.cliente_nombre,
            monto_obligacion: compromiso.monto_usd, monto_pagado_ahora: pagoData.monto,
            metodo: pagoData.metodo, referencia: pagoData.referencia, fecha: pagoData.fecha,
          },
        })
      }

      setMarcandoManual(null)
      await load()
    } catch (e: any) {
      alert('Error al registrar el pago:\n\n' + (e?.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  // ── Phase 4.2: Editar (admin only, PENDIENTE only, no pagos) ────────────────
  const handleEditar = async (data: { monto_usd: number, fecha_vencimiento: string, notas: string }) => {
    if (!editando) return
    setBusy(true)
    try {
      const { error } = await supabase
        .from('compromisos_inicial_diferida')
        .update({
          monto_usd:         data.monto_usd,
          fecha_vencimiento: data.fecha_vencimiento,
          notas:             data.notas || null,
          updated_at:        new Date().toISOString(),
        })
        .eq('id', editando.id)
      if (error) throw error

      if (user) {
        await supabase.from('activity_log').insert({
          user_id: user.id, user_email: user.email,
          action: 'compromiso_diferida_editado',
          target_type: 'compromiso_inicial_diferida',
          target_id: String(editando.id),
          details: {
            negocio_num: editando.negocio_num,
            cliente_nombre: editando.cliente_nombre,
            antes: {
              monto_usd: editando.monto_usd,
              fecha_vencimiento: editando.fecha_vencimiento,
              notas: editando.notas,
            },
            despues: data,
          },
        })
      }

      setEditando(null)
      await load()
    } catch (e: any) {
      alert('Error al guardar cambios:\n\n' + (e?.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  // ── Phase 4.2: Anular (admin only) ──────────────────────────────────────────
  const handleAnular = async (data: { motivo: string, esCorreccion: boolean }) => {
    if (!anulando) return
    setBusy(true)
    const compromiso = anulando
    try {
      // 1. Reverse all non-reversal pagos in the history table
      //    The trigger will recompute parent to 0 / PENDIENTE — we override below
      const existingPagos = (pagosByCompromiso[compromiso.id] || []).filter((p: any) => !p.is_reversal)
      if (existingPagos.length > 0) {
        const reversals = existingPagos.map((p: any) => ({
          compromiso_id: compromiso.id,
          deal_id:       compromiso.deal_id,
          monto_usd:     p.monto_usd,
          fecha:         new Date().toISOString().slice(0, 10),
          metodo:        p.metodo,
          referencia:    p.referencia,
          comentario:    `Reverso por anulación: ${data.motivo}`,
          registered_by: user?.id || null,
          is_reversal:   true,
        }))
        const { error: revErr } = await supabase
          .from('compromisos_inicial_diferida_pagos')
          .insert(reversals)
        if (revErr) throw revErr
      }

      // 2. Force the compromiso to CANCELADA state (overriding trigger's PENDIENTE)
      //    Also clear pagado_at/ref/metodo fields and set cancelado fields
      const { error: cErr } = await supabase
        .from('compromisos_inicial_diferida')
        .update({
          estado:             'CANCELADA',
          cancelado_at:       new Date().toISOString(),
          cancelado_motivo:   data.motivo + (data.esCorreccion ? ' [CORRECCIÓN DE ERROR]' : ''),
          pagado_at:          null,
          pagado_pago_ref:    null,
          pagado_pago_metodo: null,
          pagado_pago_index:  null,
          updated_at:         new Date().toISOString(),
        })
        .eq('id', compromiso.id)
      if (cErr) throw cErr

      // 3. Scrub deal.pagos of entries related to this compromiso
      //    We match on two patterns:
      //    (a) NEW: pagos with _compromiso_id = this id (Phase 4.1+)
      //    (b) OLD: pagos with comentario LIKE 'Pago de Inicial Diferida — Compromiso <prefix>%' (pre-4.1 buggy code)
      const { data: deal } = await supabase
        .from('deals')
        .select('pagos')
        .eq('id', compromiso.deal_id)
        .single()

      if (deal && Array.isArray(deal.pagos)) {
        const prefix = compromiso.id.slice(0, 8)
        const cleanedPagos = deal.pagos.filter((p: any) => {
          // (a) New tag
          if (p._compromiso_id === compromiso.id) return false
          // (a') New diferida placeholder
          if (p._inicial_diferida_pago && p._compromiso_id === compromiso.id) return false
          // (b) Legacy comentario pattern
          const c = (p.comentario || '') as string
          if (c.includes(`Compromiso ${prefix}`)) return false
          if (c.includes(`Pago de Inicial Diferida — Compromiso ${prefix}`)) return false
          return true
        })
        const new_total = cleanedPagos.reduce((sum: number, p: any) => sum + (parseFloat(p.monto_usd) || 0), 0)
        const { error: dErr } = await supabase
          .from('deals')
          .update({ pagos: cleanedPagos, total_recibido: new_total })
          .eq('id', compromiso.deal_id)
        if (dErr) throw dErr
      }

      // 4. Activity log
      if (user) {
        await supabase.from('activity_log').insert({
          user_id: user.id, user_email: user.email,
          action: data.esCorreccion ? 'compromiso_diferida_corregido' : 'compromiso_diferida_anulado',
          target_type: 'compromiso_inicial_diferida',
          target_id: String(compromiso.id),
          details: {
            negocio_num: compromiso.negocio_num,
            cliente_nombre: compromiso.cliente_nombre,
            monto_usd: compromiso.monto_usd,
            monto_pagado_revertido: compromiso.monto_pagado_acumulado || 0,
            pagos_revertidos_count: existingPagos.length,
            motivo: data.motivo,
            es_correccion: data.esCorreccion,
          },
        })
      }

      setAnulando(null)
      await load()
    } catch (e: any) {
      alert('Error al anular:\n\n' + (e?.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  const toggleExpanded = (id: string) => setExpanded(p => ({ ...p, [id]: !p[id] }))

  const today_iso = new Date().toISOString().slice(0, 10)
  const filtered = diferidas
    .map(d => {
      let _displayEstado = d.estado as string
      if ((d.estado === 'PENDIENTE' || d.estado === 'PARCIAL') && d.fecha_vencimiento < today_iso) {
        _displayEstado = 'VENCIDA'
      }
      return { ...d, _displayEstado }
    })
    .filter(d => {
      if (filter === 'TODAS') return true
      if (filter === 'VENCIDA') return d._displayEstado === 'VENCIDA'
      return d._displayEstado === filter || d.estado === filter
    })

  const countPendiente = diferidas.filter(d => d.estado === 'PENDIENTE' && d.fecha_vencimiento >= today_iso).length
  const countParcial   = diferidas.filter(d => d.estado === 'PARCIAL').length
  const countVencidas  = diferidas.filter(d => (d.estado === 'PENDIENTE' || d.estado === 'PARCIAL') && d.fecha_vencimiento < today_iso).length
  const totalPendiente = diferidas
    .filter(d => d.estado === 'PENDIENTE' || d.estado === 'PARCIAL')
    .reduce((sum, d) => sum + (d.saldo_pendiente ?? (d.monto_usd - (d.monto_pagado_acumulado || 0))), 0)
  const countPagadas = diferidas.filter(d => d.estado === 'PAGADA').length

  if (loading) return <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={{ color: 'var(--text-secondary)' }}>Cargando...</div></div>

  const EstadoBadge = ({ estado }: { estado: string }) => {
    const config: Record<string, { color: string, bg: string }> = {
      PENDIENTE: { color: '#b8720a', bg: 'rgba(184,114,10,0.15)' },
      PARCIAL:   { color: '#e67e22', bg: 'rgba(230,126,34,0.15)' },
      VENCIDA:   { color: '#BB162B', bg: 'rgba(187,22,43,0.15)' },
      PAGADA:    { color: '#2ecc8a', bg: 'rgba(46,204,138,0.15)' },
      CANCELADA: { color: '#888',    bg: 'rgba(136,136,136,0.15)' },
    }
    const c = config[estado] || config.PENDIENTE
    return (
      <span style={{ padding: '3px 10px', borderRadius: '4px', background: c.bg, color: c.color, fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '1px' }}>
        {estado}
      </span>
    )
  }

  return (
    <AdminShell active="inicial-diferida">
      {registrando && (
        <RegistrarPagoModal
          compromiso={registrando}
          canMarkManual={canMarkManual}
          onChooseAI={() => { handleAIFlow(registrando); setRegistrando(null) }}
          onChooseManual={() => { setMarcandoManual(registrando); setRegistrando(null) }}
          onCancel={() => setRegistrando(null)}
        />
      )}
      {marcandoManual && (
        <MarcarManualModal
          compromiso={marcandoManual}
          onConfirm={handleMarcarManual}
          onCancel={() => !busy && setMarcandoManual(null)}
        />
      )}
      {editando && (
        <EditarCompromisoModal
          compromiso={editando}
          onConfirm={handleEditar}
          onCancel={() => !busy && setEditando(null)}
        />
      )}
      {anulando && (
        <AnularCompromisoModal
          compromiso={anulando}
          pagosCount={(pagosByCompromiso[anulando.id] || []).filter((p: any) => !p.is_reversal).length}
          onConfirm={handleAnular}
          onCancel={() => !busy && setAnulando(null)}
        />
      )}

      <div style={s.content}>
        <div style={{ marginBottom: '28px', marginTop: '8px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '2px' }}>Módulo</div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary)' }}>Iniciales Diferidas</div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px', marginBottom: '24px' }}>
          {[
            { label: 'Pendientes',          value: countPendiente.toString(), color: '#b8720a' },
            { label: 'Parciales',           value: countParcial.toString(),   color: '#e67e22' },
            { label: 'Vencidas',            value: countVencidas.toString(),  color: '#BB162B' },
            { label: 'Total por cobrar',    value: fmt(totalPendiente),       color: '#e67e22' },
            { label: 'Pagadas (histórico)', value: countPagadas.toString(),   color: '#2ecc8a' },
          ].map(k => (
            <div key={k.label} style={{ ...s.card, marginBottom: 0, borderLeft: `4px solid ${k.color}` }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '12px' }}>{k.label}</div>
              <div style={{ fontSize: '22px', fontWeight: 900, color: k.color, fontFamily: 'monospace' }}>{k.value}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' as const }}>
          {(['PENDIENTE', 'PARCIAL', 'VENCIDA', 'PAGADA', 'CANCELADA', 'TODAS'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '8px 16px', borderRadius: '8px',
                border: `1px solid ${filter === f ? '#e67e22' : 'var(--border)'}`,
                background: filter === f ? 'rgba(230,126,34,0.15)' : 'transparent',
                color: filter === f ? '#e67e22' : 'var(--text-secondary)',
                fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                textTransform: 'uppercase' as const, letterSpacing: '1px',
              }}
            >
              {f}
            </button>
          ))}
        </div>

        <div style={s.card}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center' as const, padding: '40px', color: 'var(--text-secondary)' }}>
              No hay compromisos en este estado
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['', 'Negocio #', 'Cliente', 'Total', 'Pagado', 'Saldo', 'Progreso', 'Vencimiento', 'Estado', 'Acciones'].map(h => (
                    <th key={h} style={thTd}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(d => {
                  const venc = new Date(d.fecha_vencimiento + 'T12:00:00')
                  const today = new Date()
                  const diasDiff = Math.floor((venc.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
                  const subtitle = d._displayEstado === 'PAGADA'
                    ? `Pagada ${d.pagado_at ? fmtDate(d.pagado_at.slice(0, 10)) : ''}`
                    : d._displayEstado === 'CANCELADA'
                    ? `Cancelada ${d.cancelado_at ? fmtDate(d.cancelado_at.slice(0, 10)) : ''}`
                    : diasDiff < 0
                    ? `Venció hace ${Math.abs(diasDiff)} día${Math.abs(diasDiff) !== 1 ? 's' : ''}`
                    : diasDiff === 0
                    ? 'Vence hoy'
                    : `Faltan ${diasDiff} día${diasDiff !== 1 ? 's' : ''}`
                  const subtitleColor = d._displayEstado === 'PAGADA' ? '#2ecc8a'
                    : d._displayEstado === 'CANCELADA' ? '#888'
                    : diasDiff < 0 ? '#BB162B'
                    : diasDiff <= 3 ? '#b8720a'
                    : 'var(--text-secondary)'

                  const pagado = d.monto_pagado_acumulado || 0
                  const saldo = d.saldo_pendiente ?? (d.monto_usd - pagado)
                  const pct = d.monto_usd > 0 ? Math.min(100, (pagado / d.monto_usd) * 100) : 0
                  const pagosHist = pagosByCompromiso[d.id] || []
                  const isExpanded = !!expanded[d.id]
                  const hasHistory = pagosHist.length > 0
                  const nonReversalCount = pagosHist.filter((p: any) => !p.is_reversal).length

                  // Editar visible: admin + PENDIENTE + no pagos
                  const canEdit = isAdmin && d.estado === 'PENDIENTE' && nonReversalCount === 0
                  // Anular visible: admin + not already CANCELADA
                  const canAnular = isAdmin && d.estado !== 'CANCELADA'

                  return (
                    <Fragment key={d.id}>
                      <tr id={`diferida-row-${d.id}`} style={{
                        borderBottom: isExpanded ? 'none' : '1px solid var(--border)',
                        background: highlightedId === String(d.id) ? 'rgba(139,92,246,0.15)' : undefined,
                        transition: 'background 0.5s',
                      }}>
                        <td style={{ padding: '12px', textAlign: 'center' as const, width: 32 }}>
                          {hasHistory && (
                            <button
                              onClick={() => toggleExpanded(d.id)}
                              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 14, padding: 0 }}
                              aria-label={isExpanded ? 'Ocultar historial' : 'Ver historial'}
                            >
                              {isExpanded ? '▼' : '▶'}
                            </button>
                          )}
                        </td>
                        <td style={{ padding: '12px', fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{d.negocio_num}</td>
                        <td style={{ padding: '12px', fontSize: '13px', color: 'var(--text-primary)' }}>
                          <div>{d.cliente_nombre} {d.cliente_apellidos || ''}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{d.vehiculo_marca || ''} {d.vehiculo_modelo || ''}</div>
                        </td>
                        <td style={{ padding: '12px', fontSize: '13px', fontFamily: 'monospace', color: 'var(--text-primary)', fontWeight: 700 }}>{fmt(d.monto_usd)}</td>
                        <td style={{ padding: '12px', fontSize: '13px', fontFamily: 'monospace', color: pagado > 0 ? '#2ecc8a' : 'var(--text-secondary)' }}>{fmt(pagado)}</td>
                        <td style={{ padding: '12px', fontSize: '13px', fontFamily: 'monospace', color: '#e67e22', fontWeight: 700 }}>{fmt(saldo)}</td>
                        <td style={{ padding: '12px', minWidth: 120 }}>
                          <div style={{ background: 'var(--bg-deep)', height: 6, borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{
                              width: `${pct}%`, height: '100%',
                              background: pct >= 100 ? '#2ecc8a' : pct > 0 ? '#e67e22' : 'transparent',
                              transition: 'width 0.3s',
                            }} />
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4, textAlign: 'right' as const }}>{pct.toFixed(0)}%</div>
                        </td>
                        <td style={{ padding: '12px' }}>
                          <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{fmtDate(d.fecha_vencimiento)}</div>
                          <div style={{ fontSize: '10px', color: subtitleColor, marginTop: '2px' }}>{subtitle}</div>
                        </td>
                        <td style={{ padding: '12px' }}><EstadoBadge estado={d._displayEstado} /></td>
                        <td style={{ padding: '12px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
                          <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' as const }}>
                            {(d._displayEstado === 'PENDIENTE' || d._displayEstado === 'PARCIAL' || d._displayEstado === 'VENCIDA') && (
                              <button onClick={() => setRegistrando(d)} style={{ padding: '6px 10px', background: 'transparent', border: '1px solid #2ecc8a', borderRadius: '6px', color: '#2ecc8a', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                                💰 Pago
                              </button>
                            )}
                            {canEdit && (
                              <button onClick={() => setEditando(d)} style={{ padding: '6px 10px', background: 'transparent', border: '1px solid #3a7ad4', borderRadius: '6px', color: '#3a7ad4', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                                ✏️ Editar
                              </button>
                            )}
                            {canAnular && (
                              <button onClick={() => setAnulando(d)} style={{ padding: '6px 10px', background: 'transparent', border: '1px solid #BB162B', borderRadius: '6px', color: '#BB162B', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                                ✕ Anular
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && hasHistory && (
                        <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-deep)' }}>
                          <td colSpan={10} style={{ padding: '12px 24px' }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 8 }}>
                              Historial de pagos ({pagosHist.length})
                            </div>
                            <table style={{ width: '100%', fontSize: 12 }}>
                              <thead>
                                <tr style={{ color: 'var(--text-secondary)', fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: 1 }}>
                                  <th style={{ textAlign: 'left' as const, padding: '4px 8px' }}>Fecha</th>
                                  <th style={{ textAlign: 'left' as const, padding: '4px 8px' }}>Método</th>
                                  <th style={{ textAlign: 'right' as const, padding: '4px 8px' }}>Monto</th>
                                  <th style={{ textAlign: 'left' as const, padding: '4px 8px' }}>Referencia</th>
                                  <th style={{ textAlign: 'left' as const, padding: '4px 8px' }}>Comentario</th>
                                </tr>
                              </thead>
                              <tbody>
                                {pagosHist.map((p: any) => (
                                  <tr key={p.id} style={{ color: p.is_reversal ? '#BB162B' : 'var(--text-primary)' }}>
                                    <td style={{ padding: '4px 8px' }}>{fmtDate(p.fecha)}</td>
                                    <td style={{ padding: '4px 8px' }}>{p.metodo}</td>
                                    <td style={{ padding: '4px 8px', textAlign: 'right' as const, fontFamily: 'monospace', fontWeight: 700 }}>
                                      {p.is_reversal ? '-' : ''}{fmt(p.monto_usd)}
                                    </td>
                                    <td style={{ padding: '4px 8px' }}>{p.referencia || '—'}</td>
                                    <td style={{ padding: '4px 8px', fontStyle: 'italic' as const, color: 'var(--text-secondary)' }}>{p.comentario || '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic' as const, marginTop: '12px', lineHeight: 1.6, padding: '12px 16px', background: 'var(--bg-deep)', borderRadius: '8px' }}>
          💡 <strong>Pagos parciales:</strong> Al hacer clic en &quot;Pago&quot; puedes ingresar el monto exacto recibido. El compromiso quedará PARCIAL si el saldo no se cubre completo, o PAGADA si se completa.
          {isAdmin && <span> <strong>Editar</strong> está disponible solo en estado PENDIENTE sin pagos. <strong>Anular</strong> revierte todos los pagos parciales y limpia las entradas correspondientes del deal.</span>}
        </div>

      </div>
    </AdminShell>
  )
}


export default function InicialDiferidaPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--bg-page)' }} />}>
      <InicialDiferidaPageInner />
    </Suspense>
  )
}