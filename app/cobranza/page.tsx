'use client'
import { useState, useEffect, Suspense } from 'react'
import { supabase } from '../supabase'
import { useRouter, useSearchParams } from 'next/navigation'
import NavBar from '../components/NavBar'
import { useNPAPermissions } from '../components/useNPAPermissions'

const fmt = (n: number) => `$${(n||0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (iso: string) => { if (!iso) return '—'; const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}` }
const today = () => new Date().toISOString().split('T')[0]
const isVencido = (fecha: string, status: string) => status === 'PENDIENTE' && fecha && fecha < today()

const METODOS = ['Efectivo','Zelle Roframi','Zelle Motocentro','Zelle Externo','Wire Transfer Roframi','Wire Transfer Motocentro','Wire Transfer Panama','Transferencia en Bolívares','Otro']

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif', color: 'var(--text-primary)', transition: 'background 0.35s ease' },
  content: { padding: '32px', maxWidth: '1400px', margin: '0 auto' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', marginBottom: '20px', transition: 'background 0.35s ease, border-color 0.35s ease' },
  sectionTitle: { fontSize: '11px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' },
  label: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', display: 'block', marginBottom: '6px' },
  input: { width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  inputGroup: { marginBottom: '14px' },
  btnRed: { padding: '10px 24px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px' },
  btnGray: { padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  btnGreen: { padding: '10px 24px', background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' },
  grid4: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '16px' },
}

const statusColor = (st: string, fecha?: string) => {
  if (st === 'PAGADO') return { bg: 'rgba(26,122,74,0.2)', color: '#2ecc8a' }
  if (st === 'PARCIAL') return { bg: 'rgba(184,114,10,0.2)', color: '#f39c12' }
  if (st === 'PENDIENTE' && fecha && fecha < today()) return { bg: 'rgba(187,22,43,0.2)', color: '#BB162B' }
  return { bg: 'rgba(26,58,74,0.4)', color: 'var(--text-secondary)' }
}

function PagoModal({ cuota, onSave, onClose }: { cuota: any, onSave: (data: any) => void, onClose: () => void }) {
  const [monto, setMonto] = useState(cuota.monto_pagado > 0 ? cuota.monto_pagado.toString() : cuota.monto_cuota.toString())
  const [metodo, setMetodo] = useState(cuota.metodo_pago || 'Efectivo')
  const [fecha, setFecha] = useState(cuota.fecha_pago || today())
  const [obs, setObs] = useState(cuota.observaciones || '')
  const montoNum = parseFloat(monto) || 0
  const status = montoNum >= cuota.monto_cuota ? 'PAGADO' : montoNum > 0 ? 'PARCIAL' : 'PENDIENTE'

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '32px', maxWidth: '480px', width: '100%' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Registrar Pago</div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '24px' }}>
          Cuota {cuota.cuota_label} — Vcto: {fmtDate(cuota.fecha_vencimiento)} — {fmt(cuota.monto_cuota)}
        </div>

        <div style={s.inputGroup}>
          <label style={s.label}>Monto Pagado (USD)</label>
          <input style={s.input} type="number" value={monto} onChange={e => setMonto(e.target.value)} step="0.01" />
          <div style={{ fontSize: '10px', color: montoNum >= cuota.monto_cuota ? '#2ecc8a' : montoNum > 0 ? '#f39c12' : 'var(--text-secondary)', marginTop: '4px' }}>
            {status} — Cuota: {fmt(cuota.monto_cuota)} {montoNum > 0 && montoNum < cuota.monto_cuota ? `— Saldo: ${fmt(cuota.monto_cuota - montoNum)}` : ''}
          </div>
        </div>
        <div style={s.inputGroup}>
          <label style={s.label}>Método de Pago</label>
          <select style={s.input} value={metodo} onChange={e => setMetodo(e.target.value)}>
            {METODOS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div style={s.inputGroup}>
          <label style={s.label}>Fecha de Pago</label>
          <input style={s.input} type="date" value={fecha} onChange={e => setFecha(e.target.value)} />
        </div>
        <div style={s.inputGroup}>
          <label style={s.label}>Observaciones / Nro. Recibo</label>
          <input style={s.input} value={obs} onChange={e => setObs(e.target.value)} placeholder="Zelle rec 129, Efectivo, etc." />
        </div>

        <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
          <button onClick={onClose} style={{ ...s.btnGray, flex: 1 }}>Cancelar</button>
          <button onClick={() => onSave({ monto_pagado: montoNum, metodo_pago: metodo, fecha_pago: fecha, observaciones: obs, status })} style={{ ...s.btnGreen, flex: 1 }}>✓ Guardar</button>
        </div>
      </div>
    </div>
  )
}

function NuevoContrato({ onSave, onClose }: { onSave: () => void, onClose: () => void }) {
  const [form, setForm] = useState({
    cliente_nombre: '', cliente_cedula: '', fiador: '', modelo: '', placa: '',
    precio_venta: '', inicial: '', saldo_financiar: '', interes_pct: '',
    nro_cuotas: '12', monto_cuota: '', fecha_venta: today(), fecha_primera_cuota: '', notas: ''
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    if (!form.cliente_nombre || !form.modelo || !form.fecha_primera_cuota || !form.monto_cuota || !form.nro_cuotas) {
      setError('Cliente, modelo, monto cuota, nro cuotas y fecha primera cuota son obligatorios.')
      return
    }
    setSaving(true)
    setError('')

    const { data: authData } = await supabase.auth.getUser()
    const { data: contrato, error: err } = await supabase.from('cobranza_contratos').insert({
      cliente_nombre: form.cliente_nombre,
      cliente_cedula: form.cliente_cedula,
      fiador: form.fiador,
      modelo: form.modelo,
      placa: form.placa,
      precio_venta: parseFloat(form.precio_venta) || 0,
      inicial: parseFloat(form.inicial) || 0,
      saldo_financiar: parseFloat(form.saldo_financiar) || 0,
      interes_pct: parseFloat(form.interes_pct) || 0,
      nro_cuotas: parseInt(form.nro_cuotas) || 12,
      monto_cuota: parseFloat(form.monto_cuota) || 0,
      fecha_venta: form.fecha_venta,
      fecha_primera_cuota: form.fecha_primera_cuota,
      notas: form.notas,
      created_by: authData?.user?.id
    }).select().single()

    if (err || !contrato) { setError('Error: ' + (err?.message || 'unknown')); setSaving(false); return }

    const cuotas = []
    const nro = parseInt(form.nro_cuotas)
    const monto = parseFloat(form.monto_cuota)
    const firstDate = new Date(form.fecha_primera_cuota + 'T12:00:00')

    for (let i = 0; i < nro; i++) {
      const d = new Date(firstDate)
      d.setMonth(d.getMonth() + i)
      const fechaStr = d.toISOString().split('T')[0]
      cuotas.push({
        contrato_id: contrato.id,
        cuota_num: i + 1,
        cuota_label: `${i + 1}/${nro}`,
        fecha_vencimiento: fechaStr,
        monto_cuota: monto,
        status: fechaStr < today() ? 'VENCIDO' : 'PENDIENTE'
      })
    }

    const { error: err2 } = await supabase.from('cobranza_cuotas').insert(cuotas)
    if (err2) { setError('Error creando cuotas: ' + err2.message); setSaving(false); return }

    setSaving(false)
    onSave()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 9999, overflowY: 'auto', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '32px', maxWidth: '700px', margin: '0 auto' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '24px' }}>➕ Nuevo Contrato de Crédito</div>

        {error && (
          <div style={{ background: 'rgba(187,22,43,0.1)', border: '1px solid rgba(187,22,43,0.3)', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: '#BB162B' }}>{error}</div>
        )}

        <div style={s.sectionTitle}>👤 Cliente</div>
        <div style={s.grid2}>
          <div style={s.inputGroup}>
            <label style={s.label}>Nombre del Cliente *</label>
            <input style={s.input} value={form.cliente_nombre} onChange={e => set('cliente_nombre', e.target.value)} placeholder="Apellido Nombre" />
          </div>
          <div style={s.inputGroup}>
            <label style={s.label}>Cédula</label>
            <input style={s.input} value={form.cliente_cedula} onChange={e => set('cliente_cedula', e.target.value)} placeholder="V-12345678" />
          </div>
        </div>
        <div style={s.inputGroup}>
          <label style={s.label}>Fiador</label>
          <input style={s.input} value={form.fiador} onChange={e => set('fiador', e.target.value)} placeholder="Nombre del fiador (opcional)" />
        </div>

        <div style={{ ...s.sectionTitle, marginTop: '8px' }}>🚗 Vehículo</div>
        <div style={s.grid2}>
          <div style={s.inputGroup}>
            <label style={s.label}>Modelo *</label>
            <input style={s.input} value={form.modelo} onChange={e => set('modelo', e.target.value)} placeholder="Kia Seltos" />
          </div>
          <div style={s.inputGroup}>
            <label style={s.label}>Placa</label>
            <input style={s.input} value={form.placa} onChange={e => set('placa', e.target.value)} placeholder="AH123CD" />
          </div>
        </div>

        <div style={{ ...s.sectionTitle, marginTop: '8px' }}>💰 Financiamiento</div>
        <div style={s.grid3}>
          <div style={s.inputGroup}>
            <label style={s.label}>Precio de Venta ($)</label>
            <input style={s.input} type="number" value={form.precio_venta} onChange={e => set('precio_venta', e.target.value)} />
          </div>
          <div style={s.inputGroup}>
            <label style={s.label}>Inicial ($)</label>
            <input style={s.input} type="number" value={form.inicial} onChange={e => set('inicial', e.target.value)} />
          </div>
          <div style={s.inputGroup}>
            <label style={s.label}>Saldo a Financiar ($)</label>
            <input style={s.input} type="number" value={form.saldo_financiar} onChange={e => set('saldo_financiar', e.target.value)} />
          </div>
        </div>
        <div style={s.grid4}>
          <div style={s.inputGroup}>
            <label style={s.label}>Interés %</label>
            <input style={s.input} type="number" value={form.interes_pct} onChange={e => set('interes_pct', e.target.value)} placeholder="18" />
          </div>
          <div style={s.inputGroup}>
            <label style={s.label}>Nro. Cuotas *</label>
            <input style={s.input} type="number" value={form.nro_cuotas} onChange={e => set('nro_cuotas', e.target.value)} />
          </div>
          <div style={s.inputGroup}>
            <label style={s.label}>Monto Cuota ($) *</label>
            <input style={s.input} type="number" value={form.monto_cuota} onChange={e => set('monto_cuota', e.target.value)} />
          </div>
          <div style={s.inputGroup}>
            <label style={s.label}>Fecha de Venta</label>
            <input style={s.input} type="date" value={form.fecha_venta} onChange={e => set('fecha_venta', e.target.value)} />
          </div>
        </div>
        <div style={s.inputGroup}>
          <label style={s.label}>Fecha Primera Cuota *</label>
          <input style={s.input} type="date" value={form.fecha_primera_cuota} onChange={e => set('fecha_primera_cuota', e.target.value)} />
        </div>
        <div style={s.inputGroup}>
          <label style={s.label}>Notas</label>
          <input style={s.input} value={form.notas} onChange={e => set('notas', e.target.value)} placeholder="Observaciones del contrato" />
        </div>

        <div style={{ background: 'var(--bg-deep)', borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', fontSize: '11px', color: 'var(--text-secondary)' }}>
          ℹ️ Se generarán automáticamente <strong style={{ color: 'var(--text-primary)' }}>{form.nro_cuotas || '?'} cuotas mensuales</strong> de <strong style={{ color: 'var(--text-primary)' }}>{form.monto_cuota ? fmt(parseFloat(form.monto_cuota)) : '$0.00'}</strong> a partir del {form.fecha_primera_cuota ? fmtDate(form.fecha_primera_cuota) : '—'}
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={onClose} style={{ ...s.btnGray, flex: 1 }}>Cancelar</button>
          <button onClick={handleSave} disabled={saving} style={{ ...s.btnRed, flex: 1, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Guardando...' : '✓ Crear Contrato'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ContratoDetalle({ contrato, onClose, onRefresh }: { contrato: any, onClose: () => void, onRefresh: () => void }) {
  const [cuotas, setCuotas] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [pagoModal, setPagoModal] = useState<any>(null)

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from('cobranza_cuotas').select('*').eq('contrato_id', contrato.id).order('cuota_num')
      setCuotas(data || [])
      setLoading(false)
    }
    load()
  }, [contrato.id])

  const handlePago = async (cuotaId: string, data: any) => {
    await supabase.from('cobranza_cuotas').update({ ...data, updated_at: new Date().toISOString() }).eq('id', cuotaId)
    const { data: updated } = await supabase.from('cobranza_cuotas').select('*').eq('contrato_id', contrato.id).order('cuota_num')
    setCuotas(updated || [])
    setPagoModal(null)
    onRefresh()
  }

  const totalCuotas = cuotas.reduce((s, c) => s + c.monto_cuota, 0)
  const totalCobrado = cuotas.reduce((s, c) => s + (c.monto_pagado || 0), 0)
  const cxc = totalCuotas - totalCobrado
  const vencidas = cuotas.filter(c => isVencido(c.fecha_vencimiento, c.status))

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 9999, overflowY: 'auto', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '32px', maxWidth: '900px', margin: '0 auto' }}>
        {pagoModal && <PagoModal cuota={pagoModal} onSave={(data) => handlePago(pagoModal.id, data)} onClose={() => setPagoModal(null)} />}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>{contrato.cliente_nombre}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              {contrato.modelo} {contrato.placa ? `· ${contrato.placa}` : ''} {contrato.cliente_cedula ? `· ${contrato.cliente_cedula}` : ''}
            </div>
            {contrato.fiador && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>Fiador: {contrato.fiador}</div>}
          </div>
          <button onClick={onClose} style={s.btnGray}>← Volver</button>
        </div>

        {/* Summary */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginBottom: '24px' }}>
          {[
            { label: 'Total Cuotas', value: fmt(totalCuotas), color: 'var(--text-primary)' },
            { label: 'Total Cobrado', value: fmt(totalCobrado), color: '#2ecc8a' },
            { label: 'CXC (Saldo)', value: fmt(cxc), color: cxc > 0 ? '#BB162B' : '#2ecc8a' },
            { label: 'Cuotas Vencidas', value: vencidas.length.toString(), color: vencidas.length > 0 ? '#BB162B' : '#2ecc8a' },
          ].map(k => (
            <div key={k.label} style={{ background: 'var(--bg-deep)', borderRadius: '10px', padding: '14px' }}>
              <div style={{ fontSize: '18px', fontWeight: 900, color: k.color, fontFamily: 'monospace' }}>{k.value}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginTop: '4px' }}>{k.label}</div>
            </div>
          ))}
        </div>

        {/* Cuotas Table */}
        {loading ? (
          <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>Cargando...</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Cuota', 'Vcto', 'Monto', 'F. Pago', 'Pagado', 'Método', 'Observaciones', 'Estado', ''].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cuotas.map(c => {
                const efectivoVencido = isVencido(c.fecha_vencimiento, c.status)
                const displayStatus = efectivoVencido ? 'VENCIDO' : c.status
                const sc = statusColor(c.status, c.fecha_vencimiento)
                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--border)', background: efectivoVencido ? 'rgba(187,22,43,0.04)' : 'transparent' }}>
                    <td style={{ padding: '10px', fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{c.cuota_label}</td>
                    <td style={{ padding: '10px', fontSize: '12px', color: efectivoVencido ? '#BB162B' : 'var(--text-secondary)' }}>{fmtDate(c.fecha_vencimiento)}</td>
                    <td style={{ padding: '10px', fontSize: '12px', color: 'var(--text-primary)', fontFamily: 'monospace' }}>{fmt(c.monto_cuota)}</td>
                    <td style={{ padding: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>{c.fecha_pago ? fmtDate(c.fecha_pago) : '—'}</td>
                    <td style={{ padding: '10px', fontSize: '12px', color: c.monto_pagado > 0 ? '#2ecc8a' : 'var(--text-secondary)', fontFamily: 'monospace' }}>{c.monto_pagado > 0 ? fmt(c.monto_pagado) : '—'}</td>
                    <td style={{ padding: '10px', fontSize: '11px', color: 'var(--text-secondary)' }}>{c.metodo_pago || '—'}</td>
                    <td style={{ padding: '10px', fontSize: '11px', color: 'var(--text-secondary)', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.observaciones || '—'}</td>
                    <td style={{ padding: '10px' }}>
                      <span style={{ padding: '3px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 700, background: sc.bg, color: sc.color }}>{displayStatus}</span>
                    </td>
                    <td style={{ padding: '10px' }}>
                      {c.status !== 'PAGADO' && (
                        <button onClick={() => setPagoModal(c)} style={{ padding: '5px 12px', background: '#BB162B', border: 'none', borderRadius: '6px', color: '#fff', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                          Pagar
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function CobranzaInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { permissions, loading: permsLoading } = useNPAPermissions()
  const [contratos, setContratos] = useState<any[]>([])
  const [cuotasResumen, setCuotasResumen] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showNuevo, setShowNuevo] = useState(false)
  const [selectedContrato, setSelectedContrato] = useState<any>(null)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('TODOS')

  const loadData = async () => {
    const { data: cont } = await supabase.from('cobranza_contratos').select('*').order('created_at', { ascending: false })
    const { data: cuotas } = await supabase.from('cobranza_cuotas').select('*')
    setContratos(cont || [])
    setCuotasResumen(cuotas || [])
    setLoading(false)

    // Handle ?open_contrato=ID from global search click
    const openId = searchParams?.get('open_contrato')
    if (openId) {
      const target = (cont || []).find((c: any) => String(c.id) === openId)
      if (target) {
        setSelectedContrato(target)
        window.history.replaceState({}, '', '/cobranza')
      }
    }
  }

  useEffect(() => { loadData() }, [])

  // Permission guard
  useEffect(() => {
    if (!permsLoading && !permissions.npa_can_view_cobranza) {
      router.replace('/dashboard')
    }
  }, [permsLoading, permissions, router])

  const getResumen = (contratoId: string) => {
    const cs = cuotasResumen.filter(c => c.contrato_id === contratoId)
    const total = cs.reduce((s, c) => s + c.monto_cuota, 0)
    const cobrado = cs.reduce((s, c) => s + (c.monto_pagado || 0), 0)
    const vencidas = cs.filter(c => isVencido(c.fecha_vencimiento, c.status)).length
    const proxima = cs.filter(c => c.status === 'PENDIENTE' && !isVencido(c.fecha_vencimiento, c.status)).sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento))[0]
    return { total, cobrado, cxc: total - cobrado, vencidas, proxima, nCuotas: cs.length, pagadas: cs.filter(c => c.status === 'PAGADO').length }
  }

  const totalCXC = cuotasResumen.filter(c => c.status !== 'PAGADO').reduce((s, c) => s + c.monto_cuota - (c.monto_pagado || 0), 0)
  const totalVencido = cuotasResumen.filter(c => isVencido(c.fecha_vencimiento, c.status)).reduce((s, c) => s + c.monto_cuota - (c.monto_pagado || 0), 0)
  const cobradoMes = (() => {
    const inicio = new Date(); inicio.setDate(1); const inicioStr = inicio.toISOString().split('T')[0]
    return cuotasResumen.filter(c => c.fecha_pago && c.fecha_pago >= inicioStr).reduce((s, c) => s + (c.monto_pagado || 0), 0)
  })()
  const contratosActivos = contratos.filter(c => c.status === 'ACTIVO').length

  const filtered = contratos.filter(c => {
    const q = search.toLowerCase()
    const matchSearch = !q || c.cliente_nombre?.toLowerCase().includes(q) || c.cliente_cedula?.includes(q) || c.modelo?.toLowerCase().includes(q)
    if (!matchSearch) return false
    if (filterStatus === 'TODOS') return true
    if (filterStatus === 'VENCIDOS') return getResumen(c.id).vencidas > 0
    if (filterStatus === 'AL_DIA') return getResumen(c.id).vencidas === 0 && getResumen(c.id).cxc > 0
    if (filterStatus === 'PAGADOS') return getResumen(c.id).cxc <= 0
    return true
  })

  return (
    <div style={s.page}>
      {showNuevo && <NuevoContrato onSave={() => { setShowNuevo(false); loadData() }} onClose={() => setShowNuevo(false)} />}
      {selectedContrato && <ContratoDetalle contrato={selectedContrato} onClose={() => setSelectedContrato(null)} onRefresh={loadData} />}

      <NavBar />

      <div style={s.content}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '28px', marginTop: '8px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '2px' }}>Módulo</div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary)' }}>Cobranza — Crédito Interno</div>
          </div>
          <button onClick={() => setShowNuevo(true)} style={s.btnRed}>+ Nuevo Contrato</button>
        </div>

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '16px', marginBottom: '24px' }}>
          {[
            { label: 'Contratos Activos', value: contratosActivos.toString(), color: 'var(--text-primary)', icon: '📋' },
            { label: 'CXC Total', value: fmt(totalCXC), color: '#BB162B', icon: '💳' },
            { label: 'Monto Vencido', value: fmt(totalVencido), color: totalVencido > 0 ? '#BB162B' : '#2ecc8a', icon: '⚠️' },
            { label: 'Cobrado este mes', value: fmt(cobradoMes), color: '#2ecc8a', icon: '✅' },
          ].map(k => (
            <div key={k.label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '20px', transition: 'background 0.35s ease, border-color 0.35s ease' }}>
              <div style={{ fontSize: '24px', marginBottom: '8px' }}>{k.icon}</div>
              <div style={{ fontSize: '22px', fontWeight: 900, color: k.color, fontFamily: 'monospace' }}>{k.value}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '1px' }}>{k.label}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', alignItems: 'center' }}>
          <input style={{ ...s.input, maxWidth: '280px' }} placeholder="Buscar por cliente, cédula o modelo..." value={search} onChange={e => setSearch(e.target.value)} />
          {['TODOS', 'VENCIDOS', 'AL_DIA', 'PAGADOS'].map(f => (
            <button key={f} onClick={() => setFilterStatus(f)} style={{
              padding: '8px 16px',
              background: filterStatus === f ? '#BB162B' : 'transparent',
              border: filterStatus === f ? 'none' : '1px solid var(--border)',
              borderRadius: '6px',
              color: filterStatus === f ? '#fff' : 'var(--text-secondary)',
              fontSize: '12px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const
            }}>{f === 'AL_DIA' ? 'AL DÍA' : f}</button>
          ))}
        </div>

        {/* Contratos Table */}
        <div style={s.card}>
          <div style={s.sectionTitle}>Contratos de Crédito ({filtered.length})</div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Cargando...</div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
              {contratos.length === 0 ? 'No hay contratos registrados. Crea el primero.' : 'No se encontraron contratos con ese filtro.'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Cliente', 'Modelo', 'Cuotas', 'CXC', 'Vencidas', 'Próxima Cuota', 'Estado', ''].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const r = getResumen(c.id)
                  const isPagado = r.cxc <= 0.01
                  return (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => setSelectedContrato(c)}>
                      <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600 }}>
                        {c.cliente_nombre}
                        {c.cliente_cedula && <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>{c.cliente_cedula}</div>}
                      </td>
                      <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{c.modelo}</td>
                      <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>
                        <span style={{ color: 'var(--text-primary)' }}>{r.pagadas}</span>/{r.nCuotas}
                      </td>
                      <td style={{ padding: '12px', color: isPagado ? '#2ecc8a' : '#BB162B', fontSize: '13px', fontFamily: 'monospace', fontWeight: 700 }}>{fmt(r.cxc)}</td>
                      <td style={{ padding: '12px' }}>
                        {r.vencidas > 0
                          ? <span style={{ background: 'rgba(187,22,43,0.2)', color: '#BB162B', padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 700 }}>⚠️ {r.vencidas}</span>
                          : <span style={{ color: '#2ecc8a', fontSize: '12px' }}>✓</span>
                        }
                      </td>
                      <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                        {r.proxima ? (
                          <div>
                            <div style={{ color: 'var(--text-primary)' }}>{fmtDate(r.proxima.fecha_vencimiento)}</div>
                            <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>{fmt(r.proxima.monto_cuota)}</div>
                          </div>
                        ) : isPagado ? <span style={{ color: '#2ecc8a' }}>Pagado</span> : '—'}
                      </td>
                      <td style={{ padding: '12px' }}>
                        <span style={{
                          padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 700,
                          background: isPagado ? 'rgba(26,122,74,0.2)' : r.vencidas > 0 ? 'rgba(187,22,43,0.2)' : 'rgba(26,58,74,0.4)',
                          color: isPagado ? '#2ecc8a' : r.vencidas > 0 ? '#BB162B' : 'var(--text-secondary)'
                        }}>
                          {isPagado ? 'PAGADO' : r.vencidas > 0 ? 'VENCIDO' : 'AL DÍA'}
                        </span>
                      </td>
                      <td style={{ padding: '12px' }}>
                        <button onClick={e => { e.stopPropagation(); setSelectedContrato(c) }} style={{ padding: '5px 14px', background: '#BB162B', border: 'none', borderRadius: '6px', color: '#fff', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>Ver</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}


export default function Cobranza() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--bg-page)' }} />}>
      <CobranzaInner />
    </Suspense>
  )
}