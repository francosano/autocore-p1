// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/clientes/page.tsx
// AutoCore NPA — Client Account (search + 360° view)
//
// Search any client (name / cédula / RIF), with or without a deal, then open
// their account: datos, negocios (deals by cédula/RIF), pagos (comprobantes by
// cliente_id) and documentos — the client cédula/RIF scan, payment proofs
// (comprobante.foto_url) and per-negocio deal docs (Factura/CDO/Cédula listed
// from comprobantes/deals/{negocio_num}/). Read-only. Static-export safe.
// Private-bucket files open via short-lived signed URLs.
// ═══════════════════════════════════════════════════════════════════════════
'use client'

import { useState } from 'react'
import { supabase } from '../supabase'
import NavBar from '../components/NavBar'
import { useNPAPermissions } from '../components/useNPAPermissions'

const STORAGE_BUCKET = 'comprobantes'

interface Cliente {
  id: string
  tipo_cliente: string
  nombre: string | null
  razon_social: string | null
  cedula_tipo: string | null
  cedula_num: string | null
  rif: string | null
  telefono: string | null
  email: string | null
  direccion: string | null
  cedula_imagen: string | null
}
interface Negocio {
  id: number
  negocio_num: string | null
  status: string | null
  inventory_vin: string | null
  total_recibido: number | null
  cliente_nombre: string | null
}
interface Pago {
  id: string
  numero: string | null
  recibo_numero: string | null
  solicitado_at: string | null
  confirmado_at: string | null
  monto_usd: number | null
  monto_bs: number | null
  tasa_aplicada: number | null
  tasa_bcv_usada: number | null
  banco_bs_nombre: string | null
  categoria: string | null
  estado: string | null
  revision_estado: string | null
  concepto: string | null
  source_label: string | null
  foto_url: string | null
}
interface DealDoc {
  negocioNum: string
  label: string
  path: string
}

// A unified directory entry (one client, deduped across all modules by
// digits-only document). May or may not have a `clientes` row yet.
interface DirEntry {
  doc_norm: string
  doc_display: string | null
  tipo: string | null
  nombre: string | null
  telefono: string | null
  email: string | null
  clientes_id: string | null
  in_clientes: boolean
  in_deals: boolean
  in_compromisos: boolean
  in_cobranza: boolean
  in_solicitudes: boolean
  in_crm: boolean
  // hydrated after opening, from the clientes row when one exists
  direccion?: string | null
  cedula_imagen?: string | null
}
interface Compromiso {
  id: string
  negocio_num: string | null
  monto_usd: number | null
  monto_pagado_acumulado: number | null
  saldo_pendiente: number | null
  estado: string | null
  fecha_vencimiento: string | null
  vehiculo_modelo: string | null
}
interface Contrato {
  id: string
  modelo: string | null
  placa: string | null
  factura_numero: string | null
  status: string | null
  saldo_financiar: number | null
  nro_cuotas: number | null
  cliente_nombre: string | null
}
interface Solicitud {
  id: string
  status: string | null
  vehiculo_modelo: string | null
  monto_solicitado_usd: number | null
  created_at: string | null
}

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif', color: 'var(--text-primary)', transition: 'background 0.35s ease' },
  content: { padding: '32px', maxWidth: '900px', margin: '0 auto' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', padding: '20px', marginBottom: '16px' },
  sectionTitle: { fontSize: '11px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' },
  label: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px', display: 'block', marginBottom: '4px' },
  input: { width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '13.5px', outline: 'none', boxSizing: 'border-box' as const },
  btnRed: { padding: '10px 20px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '12.5px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px', whiteSpace: 'nowrap' as const },
  btnGray: { padding: '8px 18px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' as const },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '12px 0', borderBottom: '1px solid var(--border)', gap: 12 },
  muted: { fontSize: '12px', color: 'var(--text-secondary)' },
  badge: { display: 'inline-block', fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '3px', textTransform: 'uppercase' as const, letterSpacing: '0.5px' },
  link: { color: '#4a9eff', textDecoration: 'none', fontSize: '12px', fontWeight: 700 },
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('es-VE', { year: 'numeric', month: 'short', day: '2-digit' })
}
function fmtUsd(n: number | null): string {
  return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function docLabel(fileName: string): string {
  const l = (fileName || '').toLowerCase()
  if (l.startsWith('factura')) return 'Factura'
  if (l.startsWith('cdo')) return 'CDO'
  if (l.startsWith('cedula')) return 'Cédula'
  return fileName
}

export default function ClienteCuenta() {
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<DirEntry[] | null>(null)
  const [cliente, setCliente] = useState<DirEntry | null>(null)
  const [negocios, setNegocios] = useState<Negocio[]>([])
  const [compromisos, setCompromisos] = useState<Compromiso[]>([])
  const [contratos, setContratos] = useState<Contrato[]>([])
  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([])
  const [pagos, setPagos] = useState<Pago[]>([])
  const [dealDocs, setDealDocs] = useState<DealDoc[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // Management-only client edit (roles: admin/administrador/manager/gerente).
  const { role } = useNPAPermissions()
  const isManagement = ['admin', 'administrador', 'manager', 'gerente'].includes((role || '').toLowerCase())
  const [editOpen, setEditOpen] = useState(false)
  const [editSaving, setEditSaving] = useState(false)
  const [editMsg, setEditMsg] = useState<string | null>(null)
  const [editResult, setEditResult] = useState<any>(null)
  const [editForm, setEditForm] = useState({
    tipo_cliente: 'natural', nombre: '', razon_social: '',
    cedula_tipo: 'V', cedula_num: '', rif: '',
    telefono: '', email: '', direccion: '',
  })

  async function openEdit() {
    if (!cliente?.clientes_id) return
    setEditMsg(null); setEditResult(null)
    const { data, error } = await (supabase
      .from('clientes')
      .select('nombre,razon_social,tipo_cliente,cedula_tipo,cedula_num,rif,telefono,email,direccion')
      .eq('id', cliente.clientes_id).single() as any)
    if (error || !data) { setEditMsg('No se pudo cargar el cliente.'); setEditOpen(true); return }
    setEditForm({
      tipo_cliente: data.tipo_cliente || 'natural',
      nombre: data.nombre || '', razon_social: data.razon_social || '',
      cedula_tipo: data.cedula_tipo || 'V', cedula_num: data.cedula_num || '',
      rif: data.rif || '',
      telefono: data.telefono || '', email: data.email || '', direccion: data.direccion || '',
    })
    setEditOpen(true)
  }

  async function saveEdit() {
    if (!cliente?.clientes_id) return
    setEditSaving(true); setEditMsg(null); setEditResult(null)
    try {
      const { data, error } = await (supabase.rpc('admin_update_cliente', {
        p_cliente_id: cliente.clientes_id,
        p_nombre: editForm.nombre,
        p_razon_social: editForm.razon_social,
        p_telefono: editForm.telefono,
        p_email: editForm.email,
        p_direccion: editForm.direccion,
        p_cedula_tipo: editForm.cedula_tipo,
        p_cedula_num: editForm.cedula_num,
        p_rif: editForm.rif,
      }) as any)
      if (error) { setEditMsg(error.message || 'Error al guardar.'); return }
      setEditResult(data)
      const isJur = editForm.tipo_cliente === 'juridico'
      const newDoc = isJur ? editForm.rif : editForm.cedula_num
      setCliente(prev => prev ? {
        ...prev,
        nombre: (isJur ? editForm.razon_social : editForm.nombre) || prev.nombre,
        telefono: editForm.telefono || null,
        email: editForm.email || null,
        direccion: editForm.direccion || null,
        doc_display: newDoc || prev.doc_display,
      } : prev)
    } catch (e: any) {
      setEditMsg(e?.message || 'Error inesperado.')
    } finally {
      setEditSaving(false)
    }
  }

  async function buscar() {
    const term = q.trim().replace(/[%,]/g, '')
    if (term.length < 2) { setMsg('Escribe al menos 2 caracteres.'); return }
    setSearching(true); setMsg(null); setResults(null); setCliente(null)
    try {
      const like = '%' + term + '%'
      const digits = term.replace(/[^0-9]/g, '')
      // Search the unified directory (clientes + deals + compromisos + cobranza +
      // solicitudes + CRM, deduped by digits-only document). Finds any client,
      // in any module, regardless of whether a `clientes` row exists.
      const ors = ['nombre.ilike.' + like, 'doc_display.ilike.' + like]
      if (digits.length >= 3) ors.push('doc_norm.ilike.%' + digits + '%')
      const { data, error } = await (supabase
        .from('client_directory')
        .select('*')
        .or(ors.join(','))
        .limit(40) as any)
      if (error) throw error
      const rows = (Array.isArray(data) ? data : []) as DirEntry[]
      rows.sort((a, b) =>
        (Number(b.in_clientes) - Number(a.in_clientes)) ||
        String(a.nombre || '').localeCompare(String(b.nombre || '')))
      setResults(rows)
      if (rows.length === 0) setMsg('No se encontró ningún cliente con ese criterio.')
    } catch (e: any) {
      setMsg('Error buscando: ' + (e.message || 'desconocido'))
    } finally {
      setSearching(false)
    }
  }

  async function abrirCuenta(c: DirEntry) {
    setCliente(c); setResults(null); setLoading(true)
    setNegocios([]); setPagos([]); setDealDocs([]); setCompromisos([]); setContratos([]); setSolicitudes([])
    try {
      // 360° pull across all modules, matched on the digit-normalized document
      // (server-side) so RIF/cédula formatting differences never split a client.
      const { data: acct, error: acctErr } = await (supabase.rpc('client_account', { p_doc_norm: c.doc_norm }) as any)
      if (acctErr) throw acctErr
      const A = acct || {}
      const negociosArr = (Array.isArray(A.deals) ? A.deals : []) as Negocio[]
      setNegocios(negociosArr)
      setCompromisos((Array.isArray(A.compromisos) ? A.compromisos : []) as Compromiso[])
      setContratos((Array.isArray(A.contratos) ? A.contratos : []) as Contrato[])
      setSolicitudes((Array.isArray(A.solicitudes) ? A.solicitudes : []) as Solicitud[])

      // Tesorería ingresos + the extra client fields (dirección, cédula scan)
      // live on the clientes row and only exist when the client is registered.
      if (c.clientes_id) {
        const [cliR, pagR] = await Promise.all([
          (supabase.from('clientes').select('direccion, email, telefono, cedula_imagen').eq('id', c.clientes_id).single() as any),
          (supabase.from('tesoreria_comprobantes')
            .select('id, numero, recibo_numero, solicitado_at, confirmado_at, monto_usd, monto_bs, tasa_aplicada, tasa_bcv_usada, banco_bs_nombre, categoria, estado, revision_estado, concepto, source_label, foto_url')
            .eq('cliente_id', c.clientes_id).eq('tipo', 'INGRESO')
            .order('solicitado_at', { ascending: false }) as any),
        ])
        const cli = cliR && cliR.data
        if (cli) setCliente(prev => prev ? { ...prev, direccion: cli.direccion, email: prev.email || cli.email, telefono: prev.telefono || cli.telefono, cedula_imagen: cli.cedula_imagen } : prev)
        setPagos((Array.isArray(pagR && pagR.data) ? pagR.data : []) as Pago[])
      }

      // Deal documents: list each negocio's folder (comprobantes/deals/{negocio_num}/).
      const dd: DealDoc[] = []
      for (const n of negociosArr) {
        if (!n.negocio_num) continue
        try {
          const folder = 'deals/' + n.negocio_num
          const { data: files } = await supabase.storage.from(STORAGE_BUCKET).list(folder, { limit: 50 })
          if (Array.isArray(files)) {
            for (const f of files) {
              if (!f || !f.name) continue
              dd.push({ negocioNum: n.negocio_num, label: docLabel(f.name), path: folder + '/' + f.name })
            }
          }
        } catch { /* folder may not exist for this negocio */ }
      }
      setDealDocs(dd)
    } catch (e: any) {
      setMsg('Error cargando la cuenta: ' + (e.message || 'desconocido'))
    } finally {
      setLoading(false)
    }
  }

  function volver() { setCliente(null); setNegocios([]); setPagos([]); setDealDocs([]); setCompromisos([]); setContratos([]); setSolicitudes([]); setMsg(null) }

  // Private bucket: open a scan via a short-lived signed URL. If already a full URL, open directly.
  async function verDoc(ref: string | null) {
    if (!ref) return
    if (ref.startsWith('http')) { window.open(ref, '_blank'); return }
    try {
      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(ref, 120)
      if (error || !data || !data.signedUrl) { setMsg('No se pudo abrir el documento (revisa permisos de storage).'); return }
      window.open(data.signedUrl, '_blank')
    } catch {
      setMsg('No se pudo abrir el documento.')
    }
  }

  const totalPagos = pagos.reduce((sum, p) => sum + (Number(p.monto_usd) || 0), 0)
  const proofs = pagos.filter(p => p.foto_url)
  const docCount = ((cliente && cliente.cedula_imagen) ? 1 : 0) + proofs.length + dealDocs.length
  const displayName = (c: DirEntry) => c.nombre || 'Sin nombre'
  const displayDoc = (c: DirEntry) => (c.tipo === 'juridico' ? 'RIF ' : '') + (c.doc_display || '—')

  return (
    <div style={s.page}>
      <NavBar />
      <div style={s.content}>
        <div style={{ marginBottom: '24px', marginTop: '8px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '2px' }}>Módulo</div>
          <div style={{ fontSize: '28px', fontWeight: 700 }}>Cuenta de Cliente</div>
        </div>

        {msg && (
          <div style={{ background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', fontSize: '13px', color: 'var(--text-secondary)' }}>{msg}</div>
        )}

        {!cliente && (
          <div style={s.card}>
            <div style={s.sectionTitle}>🔍 Buscar cliente</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <input style={s.input} value={q} onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') buscar() }}
                placeholder="Nombre, cédula o RIF — ej: Anuncia, 13261180" />
              <button type="button" style={s.btnRed} onClick={buscar} disabled={searching}>
                {searching ? 'Buscando…' : 'Buscar'}
              </button>
            </div>
            <div style={{ ...s.muted, marginTop: 8 }}>Encuentra cualquier cliente, tenga negocio o no.</div>

            {results && results.length > 0 && (
              <div style={{ marginTop: 16 }}>
                {results.map(c => (
                  <div key={c.doc_norm} style={{ ...s.row, cursor: 'pointer' }} onClick={() => abrirCuenta(c)}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{displayName(c)}</div>
                      <div style={s.muted}>{displayDoc(c)}{c.telefono ? (' · 📱 ' + c.telefono) : ' · sin teléfono'}</div>
                    </div>
                    <span style={s.link}>Ver cuenta →</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {cliente && (
          <>

            {editOpen && (
              <div onClick={() => !editSaving && setEditOpen(false)}
                style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', zIndex: 1000, overflowY: 'auto' }}>
                <div onClick={e => e.stopPropagation()} style={{ ...s.card, width: '100%', maxWidth: 520, marginBottom: 0 }}>
                  <div style={s.sectionTitle}>✏️ Editar cliente</div>

                  {editForm.tipo_cliente === 'juridico' ? (
                    <div style={{ marginBottom: 12 }}>
                      <label style={s.label}>Razón social</label>
                      <input style={s.input} value={editForm.razon_social}
                        onChange={e => setEditForm(f => ({ ...f, razon_social: e.target.value }))} />
                    </div>
                  ) : (
                    <div style={{ marginBottom: 12 }}>
                      <label style={s.label}>Nombre</label>
                      <input style={s.input} value={editForm.nombre}
                        onChange={e => setEditForm(f => ({ ...f, nombre: e.target.value }))} />
                    </div>
                  )}

                  {editForm.tipo_cliente === 'juridico' ? (
                    <div style={{ marginBottom: 12 }}>
                      <label style={s.label}>RIF</label>
                      <input style={s.input} value={editForm.rif}
                        onChange={e => setEditForm(f => ({ ...f, rif: e.target.value }))} />
                    </div>
                  ) : (
                    <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
                      <div style={{ width: 96 }}>
                        <label style={s.label}>Tipo</label>
                        <select style={s.input} value={editForm.cedula_tipo}
                          onChange={e => setEditForm(f => ({ ...f, cedula_tipo: e.target.value }))}>
                          <option value="V">V</option>
                          <option value="E">E</option>
                          <option value="J">J</option>
                          <option value="G">G</option>
                          <option value="P">P</option>
                        </select>
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={s.label}>Cédula</label>
                        <input style={s.input} value={editForm.cedula_num} inputMode="numeric"
                          onChange={e => setEditForm(f => ({ ...f, cedula_num: e.target.value.replace(/[^0-9]/g, '') }))} />
                      </div>
                    </div>
                  )}

                  <div style={{ marginBottom: 12 }}>
                    <label style={s.label}>Teléfono</label>
                    <input style={s.input} value={editForm.telefono}
                      onChange={e => setEditForm(f => ({ ...f, telefono: e.target.value }))} />
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={s.label}>Email</label>
                    <input style={s.input} value={editForm.email}
                      onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} />
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={s.label}>Dirección</label>
                    <input style={s.input} value={editForm.direccion}
                      onChange={e => setEditForm(f => ({ ...f, direccion: e.target.value }))} />
                  </div>

                  <div style={{ fontSize: 11, color: '#b8720a', marginBottom: 14 }}>
                    Cambiar la {editForm.tipo_cliente === 'juridico' ? 'RIF' : 'cédula'} actualiza también ventas, pagos, contratos y solicitudes de este cliente. No afecta fiadores, cónyuges ni pagos de terceros.
                  </div>

                  {editMsg && (
                    <div style={{ fontSize: 12, color: '#BB162B', marginBottom: 12 }}>{editMsg}</div>
                  )}

                  {editResult && (
                    <div style={{ fontSize: 12, color: '#1a7a4a', background: 'rgba(26,122,74,0.08)', border: '1px solid rgba(26,122,74,0.25)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>✓ Guardado</div>
                      {editResult.identifier_changed ? (
                        <>
                          <div>Documento: {editResult.old_identifier} → {editResult.new_identifier}</div>
                          <div style={{ marginTop: 4 }}>Filas actualizadas: {Object.entries(editResult.rows || {}).map(([k, v]) => k + ': ' + v).join('  ·  ')}</div>
                          {editResult.unallocated_payments_on_new > 0 && (
                            <div style={{ marginTop: 4, color: '#b8720a' }}>Aviso: {editResult.unallocated_payments_on_new} pago(s) sin asignar con esta cédula.</div>
                          )}
                        </>
                      ) : (
                        <div>Datos de contacto actualizados.</div>
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" style={s.btnGray} disabled={editSaving}
                      onClick={() => setEditOpen(false)}>{editResult ? 'Cerrar' : 'Cancelar'}</button>
                    {!editResult && (
                      <button type="button" disabled={editSaving}
                        style={{ padding: '8px 18px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: editSaving ? 'default' : 'pointer', opacity: editSaving ? 0.6 : 1 }}
                        onClick={saveEdit}>{editSaving ? 'Guardando…' : 'Guardar cambios'}</button>
                    )}
                  </div>
                </div>
              </div>
            )}
            <button type="button" style={{ ...s.btnGray, marginBottom: 16 }} onClick={volver}>← Volver a la búsqueda</button>

            <div style={s.card}>
              <div style={{ ...s.sectionTitle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>👤 Datos</span>
                {isManagement && cliente.clientes_id && (
                  <button type="button" onClick={openEdit}
                    style={{ ...s.btnGray, padding: '5px 12px', textTransform: 'none', letterSpacing: 'normal' }}>✏️ Editar</button>
                )}
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{displayName(cliente)}</div>
              <div style={s.muted}>{displayDoc(cliente)}</div>
              <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
                <div><span style={s.label}>Teléfono</span>{cliente.telefono || '— sin teléfono'}</div>
                <div><span style={s.label}>Email</span>{cliente.email || '—'}</div>
                <div style={{ gridColumn: '1 / -1' }}><span style={s.label}>Dirección</span>{cliente.direccion || '—'}</div>
              </div>
              <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {([
                  ['Registrado', cliente.in_clientes],
                  ['Ventas', cliente.in_deals],
                  ['Inicial diferida', cliente.in_compromisos],
                  ['Préstamo', cliente.in_cobranza],
                  ['Solicitud', cliente.in_solicitudes],
                  ['CRM', cliente.in_crm],
                ] as [string, boolean][]).filter(([, on]) => on).map(([lbl]) => (
                  <span key={lbl} style={{ ...s.badge, background: 'rgba(74,158,255,0.12)', color: '#4a9eff' }}>{lbl}</span>
                ))}
              </div>
              {!cliente.in_clientes && (
                <div style={{ marginTop: 10, fontSize: 12, color: '#b8720a' }}>
                  Existe en otros módulos pero no en el registro de clientes — la dirección y los recibos de tesorería no estarán disponibles hasta registrarlo.
                </div>
              )}
            </div>

            {loading ? (
              <div style={s.card}><div style={s.muted}>Cargando negocios, pagos y documentos…</div></div>
            ) : (
              <>
                <div style={s.card}>
                  <div style={s.sectionTitle}>🚗 Negocios ({negocios.length})</div>
                  {negocios.length === 0 ? (
                    <div style={s.muted}>Sin negocios registrados para este cliente.</div>
                  ) : negocios.map(n => (
                    <div key={n.id} style={s.row}>
                      <div>
                        <div style={{ fontWeight: 700 }}>#{n.negocio_num || n.id}<span style={{ ...s.badge, background: 'var(--bg-deep)', color: 'var(--text-secondary)', marginLeft: 8 }}>{n.status || '—'}</span></div>
                        <div style={s.muted}>{n.inventory_vin ? ('VIN ' + n.inventory_vin) : 'sin VIN asignado'}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={s.label}>Ingresos</div>
                        <div style={{ fontWeight: 700 }}>{fmtUsd(n.total_recibido)}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {compromisos.length > 0 && (
                  <div style={s.card}>
                    <div style={s.sectionTitle}>📌 Inicial diferida ({compromisos.length})</div>
                    {compromisos.map(c => (
                      <div key={c.id} style={s.row}>
                        <div>
                          <div style={{ fontWeight: 700 }}>{c.negocio_num ? ('#' + c.negocio_num) : 'Compromiso'}{c.vehiculo_modelo ? (' · ' + c.vehiculo_modelo) : ''}
                            <span style={{ ...s.badge, marginLeft: 8, background: c.estado === 'PAGADA' ? 'rgba(46,204,138,0.15)' : 'rgba(184,114,10,0.15)', color: c.estado === 'PAGADA' ? '#2ecc8a' : '#b8720a' }}>{c.estado || '—'}</span>
                          </div>
                          <div style={s.muted}>Vence {fmtDate(c.fecha_vencimiento)} · Pagado {fmtUsd(c.monto_pagado_acumulado)} de {fmtUsd(c.monto_usd)}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={s.label}>Saldo</div>
                          <div style={{ fontWeight: 700, color: (Number(c.saldo_pendiente) || 0) > 0 ? '#BB162B' : '#2ecc8a' }}>{fmtUsd(c.saldo_pendiente)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {contratos.length > 0 && (
                  <div style={s.card}>
                    <div style={s.sectionTitle}>🏦 Préstamos / Cobranza ({contratos.length})</div>
                    {contratos.map(k => (
                      <div key={k.id} style={s.row}>
                        <div>
                          <div style={{ fontWeight: 700 }}>{k.modelo || 'Contrato'}{k.placa ? (' · ' + k.placa) : ''}
                            <span style={{ ...s.badge, marginLeft: 8, background: 'var(--bg-deep)', color: 'var(--text-secondary)' }}>{k.status || '—'}</span>
                          </div>
                          <div style={s.muted}>{k.factura_numero ? ('Factura ' + k.factura_numero + ' · ') : ''}{k.nro_cuotas ? (k.nro_cuotas + ' cuotas') : ''}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={s.label}>Financiado</div>
                          <div style={{ fontWeight: 700 }}>{fmtUsd(k.saldo_financiar)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {solicitudes.length > 0 && (
                  <div style={s.card}>
                    <div style={s.sectionTitle}>📝 Solicitudes de préstamo ({solicitudes.length})</div>
                    {solicitudes.map(sl => (
                      <div key={sl.id} style={s.row}>
                        <div>
                          <div style={{ fontWeight: 700 }}>{sl.vehiculo_modelo || 'Solicitud'}<span style={{ ...s.badge, marginLeft: 8, background: 'var(--bg-deep)', color: 'var(--text-secondary)' }}>{sl.status || '—'}</span></div>
                          <div style={s.muted}>{fmtDate(sl.created_at)}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={s.label}>Solicitado</div>
                          <div style={{ fontWeight: 700 }}>{fmtUsd(sl.monto_solicitado_usd)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div style={s.card}>
                  <div style={s.sectionTitle}>💵 Pagos / Historial ({pagos.length})</div>
                  {pagos.length === 0 ? (
                    <div style={s.muted}>Sin pagos registrados para este cliente.</div>
                  ) : (
                    <>
                      {pagos.map(p => (
                        <div key={p.id} style={s.row}>
                          <div>
                            <div style={{ fontWeight: 700 }}>{p.numero || p.id.slice(0, 8)}<span style={s.muted}> · {fmtDate(p.solicitado_at)}</span></div>
                            <div style={s.muted}>{p.categoria || '—'}{p.concepto ? (' · ' + p.concepto) : ''}{p.source_label ? (' · ' + p.source_label) : ''}</div>
                            <div style={{ marginTop: 4 }}>
                              <span style={{ ...s.badge, background: 'var(--bg-deep)', color: 'var(--text-secondary)' }}>{p.estado || '—'}</span>
                              {p.revision_estado && <span style={{ ...s.badge, marginLeft: 6, background: p.revision_estado === 'aprobado' ? 'rgba(46,204,138,0.15)' : 'rgba(184,114,10,0.15)', color: p.revision_estado === 'aprobado' ? '#2ecc8a' : '#b8720a' }}>{p.revision_estado}</span>}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', minWidth: 150 }}>
                            <div style={{ fontWeight: 700, fontSize: 15 }}>{fmtUsd(p.monto_usd)}</div>
                          </div>
                        </div>
                      ))}
                      <div style={{ ...s.row, borderBottom: 'none', fontWeight: 700, marginTop: 4 }}>
                        <div>Total recibido</div>
                        <div>{fmtUsd(totalPagos)}</div>
                      </div>
                    </>
                  )}
                </div>

                <div style={s.card}>
                  <div style={s.sectionTitle}>📎 Documentos ({docCount})</div>
                  {docCount === 0 ? (
                    <div style={s.muted}>No hay documentos escaneados para este cliente.</div>
                  ) : (
                    <>
                      {cliente.cedula_imagen && (
                        <div style={s.row}>
                          <div>
                            <div style={{ fontWeight: 700 }}>{cliente.tipo === 'juridico' ? 'RIF escaneado' : 'Cédula escaneada'}</div>
                            <div style={s.muted}>Documento de identidad del cliente</div>
                          </div>
                          <button type="button" style={s.btnGray} onClick={() => verDoc(cliente.cedula_imagen ?? null)}>Ver</button>
                        </div>
                      )}
                      {dealDocs.map((d, i) => (
                        <div key={'dd-' + i} style={s.row}>
                          <div>
                            <div style={{ fontWeight: 700 }}>{d.label}</div>
                            <div style={s.muted}>Documento del negocio #{d.negocioNum}</div>
                          </div>
                          <button type="button" style={s.btnGray} onClick={() => verDoc(d.path)}>Ver</button>
                        </div>
                      ))}
                      {proofs.map(p => (
                        <div key={'doc-' + p.id} style={s.row}>
                          <div>
                            <div style={{ fontWeight: 700 }}>Soporte de pago — {p.numero || p.id.slice(0, 8)}</div>
                            <div style={s.muted}>{fmtUsd(p.monto_usd)} · {fmtDate(p.solicitado_at)}</div>
                          </div>
                          <button type="button" style={s.btnGray} onClick={() => verDoc(p.foto_url)}>Ver</button>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}