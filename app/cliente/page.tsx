// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/cliente/page.tsx
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
  solicitado_at: string | null
  monto_usd: number | null
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

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif', color: 'var(--text-primary)', transition: 'background 0.35s ease' },
  content: { padding: '32px', maxWidth: '900px', margin: '0 auto' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', marginBottom: '20px' },
  sectionTitle: { fontSize: '11px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' },
  label: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px', display: 'block', marginBottom: '4px' },
  input: { width: '100%', padding: '12px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '14px', outline: 'none', boxSizing: 'border-box' as const },
  btnRed: { padding: '12px 24px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px', whiteSpace: 'nowrap' as const },
  btnGray: { padding: '8px 18px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' as const },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '12px 0', borderBottom: '1px solid var(--border)', gap: 12 },
  muted: { fontSize: '12px', color: 'var(--text-secondary)' },
  badge: { display: 'inline-block', fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '10px', textTransform: 'uppercase' as const, letterSpacing: '0.5px' },
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
  const [results, setResults] = useState<Cliente[] | null>(null)
  const [cliente, setCliente] = useState<Cliente | null>(null)
  const [negocios, setNegocios] = useState<Negocio[]>([])
  const [pagos, setPagos] = useState<Pago[]>([])
  const [dealDocs, setDealDocs] = useState<DealDoc[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function buscar() {
    const term = q.trim().replace(/[%,]/g, '')
    if (term.length < 2) { setMsg('Escribe al menos 2 caracteres.'); return }
    setSearching(true); setMsg(null); setResults(null); setCliente(null)
    try {
      const like = '%' + term + '%'
      const { data, error } = await (supabase
        .from('clientes')
        .select('id, tipo_cliente, nombre, razon_social, cedula_tipo, cedula_num, rif, telefono, email, direccion, cedula_imagen')
        .or('nombre.ilike.' + like + ',razon_social.ilike.' + like + ',cedula_num.ilike.' + like + ',rif.ilike.' + like)
        .order('nombre', { ascending: true })
        .limit(30) as any)
      if (error) throw error
      const rows = (Array.isArray(data) ? data : []) as Cliente[]
      setResults(rows)
      if (rows.length === 0) setMsg('No se encontró ningún cliente con ese criterio.')
    } catch (e: any) {
      setMsg('Error buscando: ' + (e.message || 'desconocido'))
    } finally {
      setSearching(false)
    }
  }

  async function abrirCuenta(c: Cliente) {
    setCliente(c); setResults(null); setLoading(true); setNegocios([]); setPagos([]); setDealDocs([])
    try {
      const idNum = (c.tipo_cliente === 'juridico' ? (c.rif || c.cedula_num) : c.cedula_num) || ''
      const [negRes, pagRes] = await Promise.all([
        idNum
          ? (supabase.from('deals')
              .select('id, negocio_num, status, inventory_vin, total_recibido, cliente_nombre')
              .eq('cliente_rif', idNum) as any)
          : Promise.resolve({ data: [] }),
        (supabase.from('tesoreria_comprobantes')
          .select('id, numero, solicitado_at, monto_usd, categoria, estado, revision_estado, concepto, source_label, foto_url')
          .eq('cliente_id', c.id).eq('tipo', 'INGRESO')
          .order('solicitado_at', { ascending: false }) as any),
      ])
      const negociosArr = (Array.isArray(negRes && negRes.data) ? negRes.data : []) as Negocio[]
      setNegocios(negociosArr)
      setPagos((Array.isArray(pagRes && pagRes.data) ? pagRes.data : []) as Pago[])

      // Deal documents: list each negocio's folder (comprobantes/deals/{negocio_num}/)
      // and surface every scanned file. Same convention the auditoría detail uses.
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

  function volver() { setCliente(null); setNegocios([]); setPagos([]); setDealDocs([]); setMsg(null) }

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
  const displayName = (c: Cliente) => (c.tipo_cliente === 'juridico' ? (c.razon_social || c.nombre) : c.nombre) || 'Sin nombre'
  const displayDoc = (c: Cliente) => c.tipo_cliente === 'juridico' ? ('RIF ' + (c.rif || '—')) : ((c.cedula_tipo || 'V') + '-' + (c.cedula_num || '—'))

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
                  <div key={c.id} style={{ ...s.row, cursor: 'pointer' }} onClick={() => abrirCuenta(c)}>
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
            <button type="button" style={{ ...s.btnGray, marginBottom: 16 }} onClick={volver}>← Volver a la búsqueda</button>

            <div style={s.card}>
              <div style={s.sectionTitle}>👤 Datos</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{displayName(cliente)}</div>
              <div style={s.muted}>{displayDoc(cliente)}</div>
              <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
                <div><span style={s.label}>Teléfono</span>{cliente.telefono || '— sin teléfono'}</div>
                <div><span style={s.label}>Email</span>{cliente.email || '—'}</div>
                <div style={{ gridColumn: '1 / -1' }}><span style={s.label}>Dirección</span>{cliente.direccion || '—'}</div>
              </div>
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
                          <div style={{ textAlign: 'right', minWidth: 120 }}>
                            <div style={{ fontWeight: 700, fontSize: 15 }}>{fmtUsd(p.monto_usd)}</div>
                            <a href={'/tesoreria/comprobante?id=' + p.id} style={s.link}>Ver recibo →</a>
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
                            <div style={{ fontWeight: 700 }}>{cliente.tipo_cliente === 'juridico' ? 'RIF escaneado' : 'Cédula escaneada'}</div>
                            <div style={s.muted}>Documento de identidad del cliente</div>
                          </div>
                          <button type="button" style={s.btnGray} onClick={() => verDoc(cliente.cedula_imagen)}>Ver</button>
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