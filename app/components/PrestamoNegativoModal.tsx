// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/components/PrestamoNegativoModal.tsx
// AutoCore NPA — "¿A quién le debemos?" (préstamo por saldo negativo)
//
// 2026-06-09. Aparece cuando un egreso dejaría la caja en negativo. En vez de
// bloquear, captura el préstamo: nombre del prestamista + monto (pre-llenado
// con el faltante, editable). Al confirmar, el sitio de llamada registra el
// préstamo y permite el negativo.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

const fmt = (n: number) =>
  `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export interface PrestamoPrompt {
  cajaNombre: string        // ej. "Caja Principal"
  who: string               // 'Viviana' | 'Mirla'
  montoEgreso: number       // monto total del egreso
  saldoDisponible: number   // saldo de la caja antes del egreso
}

const s: any = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal: { background: 'var(--bg-card, #131a2e)', border: '1px solid #BB162B', borderRadius: 14, width: '100%', maxWidth: 420, overflow: 'hidden' },
  head: { background: 'rgba(187,22,43,0.12)', borderBottom: '1px solid #BB162B', padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 9 },
  headTitle: { fontSize: 14.5, fontWeight: 700, color: 'var(--text-primary, #e8ecf3)' },
  close: { marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-secondary, #9aa4b2)', cursor: 'pointer', display: 'flex' },
  body: { padding: 18 },
  intro: { fontSize: 13, color: 'var(--text-secondary, #9aa4b2)', lineHeight: 1.6, marginBottom: 16 },
  neg: { color: '#e88', fontWeight: 700 },
  strong: { color: 'var(--text-primary, #e8ecf3)', fontWeight: 600 },
  field: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 },
  label: { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary, #9aa4b2)', textTransform: 'uppercase', letterSpacing: 1 },
  required: { color: '#BB162B', marginLeft: 4 },
  input: { padding: '12px 14px', background: 'var(--bg-input, var(--bg-deep, #0a0f1e))', border: '1px solid var(--border, #2c3a57)', borderRadius: 8, fontSize: 16, color: 'var(--text-primary, #e8ecf3)', width: '100%', boxSizing: 'border-box' },
  hint: { fontSize: 11, color: 'var(--text-secondary, #6b7794)' },
  err: { padding: '9px 12px', borderRadius: 8, background: 'rgba(187,22,43,0.1)', border: '1px solid #BB162B44', color: '#BB162B', fontSize: 12.5, marginBottom: 12 },
  actions: { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 },
  btnSec: { padding: '10px 16px', borderRadius: 8, fontSize: 13, background: 'transparent', color: 'var(--text-secondary, #9aa4b2)', border: '1px solid var(--border, #2c3a57)', cursor: 'pointer' },
  btnRed: { padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: '#1B4AAA', color: '#fff', border: 'none', cursor: 'pointer' },
}

export default function PrestamoNegativoModal({ prompt, saving, onConfirm, onCancel }: {
  prompt: PrestamoPrompt
  saving: boolean
  onConfirm: (prestamista: string, monto: number) => void
  onCancel: () => void
}) {
  const saldo = Math.max(0, prompt.saldoDisponible)
  const shortfall = Math.max(0, prompt.montoEgreso - saldo)
  const resultante = prompt.saldoDisponible - prompt.montoEgreso
  const [prestamista, setPrestamista] = useState('')
  const [monto, setMonto] = useState(shortfall > 0 ? shortfall.toFixed(2) : '')
  const [localErr, setLocalErr] = useState<string | null>(null)

  function confirm() {
    setLocalErr(null)
    if (!prestamista.trim()) { setLocalErr('Indica a quién le debemos'); return }
    const m = parseFloat(monto) || 0
    if (!m || m <= 0) { setLocalErr('Indica el monto del préstamo'); return }
    onConfirm(prestamista.trim(), m)
  }

  return (
    <div style={s.overlay} onClick={() => !saving && onCancel()}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={s.head}>
          <AlertTriangle size={19} color="#e88" strokeWidth={2.3} />
          <span style={s.headTitle}>Saldo insuficiente en {prompt.cajaNombre}</span>
          <button style={s.close} onClick={onCancel} aria-label="Cancelar"><X size={18} /></button>
        </div>
        <div style={s.body}>
          <div style={s.intro}>
            Disponible <span style={s.strong}>{fmt(prompt.saldoDisponible)}</span> · este egreso es <span style={s.strong}>{fmt(prompt.montoEgreso)}</span>.
            Quedaría en <span style={s.neg}>{fmt(resultante)}</span>. Eso significa que pediste prestado para cubrirlo — {prompt.who}, ¿a quién?
          </div>

          {localErr && <div style={s.err}>{localErr}</div>}

          <div style={s.field}>
            <label style={s.label}>¿A quién le debemos?<span style={s.required}>*</span></label>
            <input style={s.input} type="text" value={prestamista} onChange={e => setPrestamista(e.target.value)} placeholder="Nombre del prestamista" autoFocus />
          </div>
          <div style={s.field}>
            <label style={s.label}>Monto del préstamo<span style={s.required}>*</span></label>
            <input style={s.input} type="number" inputMode="decimal" step="0.01" min="0.01" value={monto} onChange={e => setMonto(e.target.value)} placeholder="0.00" />
            <span style={s.hint}>Pre-llenado con lo que queda en negativo. Editable.</span>
          </div>

          <div style={s.actions}>
            <button style={s.btnSec} onClick={onCancel} disabled={saving}>Cancelar</button>
            <button style={s.btnRed} onClick={confirm} disabled={saving}>{saving ? 'Registrando…' : 'Registrar préstamo y continuar'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}