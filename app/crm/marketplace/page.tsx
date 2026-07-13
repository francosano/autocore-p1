// TARGET: autocore-p1/app/crm/marketplace/page.tsx
// ═══════════════════════════════════════════════════════════════════════════
// Marketplace — fb_listings manager (the Facebook publishing queue).
//
// Staff draft listings here (optionally prefilled from an inventory_units
// row), review them, and mark them "Listo para publicar". The Chrome
// extension picks up 'ready_to_publish' rows, prefills the FB create-listing
// form, the HUMAN publishes, and the extension stores fb_listing_id/fb_url
// and flips status to 'published'.
//
// Pipeline: draft → ready_to_publish → published → paused/sold/removed.
// Requires migrations/002_fb_listings.sql — until Franco runs it, loading
// shows a clear "tabla no existe" style error instead of data.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useNPAPermissions } from '../../components/useNPAPermissions'
import { buildFbDescription } from '../../lib/fbDescription'

interface Listing {
  id: string
  inventory_vin: string | null
  titulo: string
  precio_usd: number | null
  descripcion: string | null
  fotos: any
  status: 'draft' | 'ready_to_publish' | 'published' | 'paused' | 'sold' | 'removed'
  fb_listing_id: string | null
  fb_url: string | null
  published_at: string | null
  last_synced_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

interface InvUnit {
  vin: string
  modelo: string
  año: number
  color: string | null
  estado: string
}

const STATUS_META: Record<Listing['status'], { label: string; color: string }> = {
  draft:            { label: 'Borrador',           color: '#8A93A0' },
  ready_to_publish: { label: 'Listo p/ publicar',  color: 'var(--brand-primary)' },
  published:        { label: 'Publicado',          color: 'var(--brand-success)' },
  paused:           { label: 'Pausado',            color: '#E0A23C' },
  sold:             { label: 'Vendido',            color: '#15A06E' },
  removed:          { label: 'Removido',           color: '#E5556A' },
}
const STATUS_ORDER: Listing['status'][] = ['draft', 'ready_to_publish', 'published', 'paused', 'sold', 'removed']

const fmtUsd = (n: number | null) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—'

const s: any = {
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '18px', marginBottom: '14px' },
  input: { width: '100%', padding: '9px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  label: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.2px', display: 'block', marginBottom: '5px' },
  btnPrimary: { padding: '9px 18px', background: 'var(--brand-primary)', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' },
  btnGhost: { padding: '9px 18px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' },
  btnMini: (color: string) => ({ padding: '4px 10px', background: 'transparent', color, border: `1px solid ${color}55`, borderRadius: '6px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }),
  th: { padding: '9px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '1px', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' as const },
  td: { padding: '10px 12px', fontSize: '12.5px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' as const },
  chip: (active: boolean, color: string) => ({ padding: '5px 12px', borderRadius: 999, fontSize: '11px', fontWeight: 700, cursor: 'pointer', border: `1px solid ${active ? color : 'var(--border)'}`, background: active ? 'var(--bg-deep)' : 'transparent', color: active ? color : 'var(--text-muted)' }),
  badge: (color: string) => ({ display: 'inline-block', padding: '2px 9px', borderRadius: '4px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.5px', color, border: `1px solid ${color}55`, whiteSpace: 'nowrap' as const }),
  overlay: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' },
  modal: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', width: '100%', maxWidth: '560px', maxHeight: '90vh', overflowY: 'auto' as const },
  err: { background: 'rgba(240,85,106,0.1)', border: '1px solid rgba(240,85,106,0.3)', borderRadius: '8px', padding: '10px 13px', fontSize: '12.5px', color: 'var(--danger)', marginBottom: '12px' },
}

// ── Create/edit modal ────────────────────────────────────────────────────────
function ListingModal({ listing, userId, onClose, onSaved }: {
  listing: Listing | null   // null = new
  userId: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = !listing
  const [form, setForm] = useState({
    inventory_vin: listing?.inventory_vin || '',
    titulo: listing?.titulo || '',
    precio_usd: listing?.precio_usd == null ? '' : String(listing.precio_usd),
    descripcion: listing?.descripcion || '',
  })
  const [inv, setInv] = useState<InvUnit[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Inventory picker: EN_STOCK units to seed titulo (there is no sale-price
  // column in inventory_units, so precio stays manual).
  useEffect(() => {
    ;(async () => {
      const { data } = await (supabase
        .from('inventory_units')
        .select('vin, modelo, año, color, estado')
        .eq('estado', 'EN_STOCK')
        .order('modelo', { ascending: true }) as any)
      setInv(Array.isArray(data) ? data : [])
    })()
  }, [])

  const pickVin = (vin: string) => {
    const u = inv.find(x => x.vin === vin)
    setForm(f => ({
      ...f,
      inventory_vin: vin,
      // Prefill titulo only if the user has not typed one yet.
      titulo: f.titulo || (u ? [u.modelo, u.año, u.color].filter(Boolean).join(' ') : f.titulo),
    }))
  }

  const save = async () => {
    const titulo = form.titulo.trim()
    if (!titulo) { setError('El título es obligatorio.'); return }
    const precio = form.precio_usd === '' ? null : Number(form.precio_usd)
    if (precio != null && (isNaN(precio) || precio < 0)) { setError('Precio inválido.'); return }
    setSaving(true); setError('')
    const payload: any = {
      inventory_vin: form.inventory_vin || null,
      titulo,
      precio_usd: precio,
      descripcion: form.descripcion.trim() || null,
    }
    if (isNew) payload.created_by = userId || null
    const q = isNew
      ? supabase.from('fb_listings').insert(payload)
      : supabase.from('fb_listings').update(payload).eq('id', listing!.id)
    const { error: e } = await (q as any)
    setSaving(false)
    if (e) { setError('No se pudo guardar: ' + e.message); return }
    onSaved()
  }

  return (
    <div style={s.overlay} onClick={() => !saving && onClose()}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px' }}>
          {isNew ? 'Nueva publicación' : 'Editar publicación'}
        </div>
        {error && <div style={s.err}>{error}</div>}

        <div style={{ marginBottom: '13px' }}>
          <label style={s.label}>Unidad de inventario (opcional)</label>
          <select style={s.input} value={form.inventory_vin} onChange={e => pickVin(e.target.value)}>
            <option value="">Sin unidad — publicación libre</option>
            {inv.map(u => (
              <option key={u.vin} value={u.vin}>
                {[u.modelo, u.año, u.color].filter(Boolean).join(' ')} · {u.vin}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '13px' }}>
          <label style={s.label}>Título *</label>
          <input style={s.input} value={form.titulo} onChange={e => setForm(f => ({ ...f, titulo: e.target.value }))} placeholder="Ej: Toyota Corolla 2019 automático" />
        </div>

        <div style={{ marginBottom: '13px' }}>
          <label style={s.label}>Precio (USD)</label>
          <input style={s.input} type="number" min={0} value={form.precio_usd} onChange={e => setForm(f => ({ ...f, precio_usd: e.target.value }))} placeholder="Ej: 12500" />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <label style={s.label}>Descripción</label>
            <button
              type="button"
              onClick={() => {
                const u = inv.find(x => x.vin === form.inventory_vin)
                setForm(f => ({
                  ...f,
                  descripcion: buildFbDescription({
                    titulo: f.titulo.trim() || (u ? [u.modelo, u.año, u.color].filter(Boolean).join(' ') : 'Vehículo'),
                    precioUsd: f.precio_usd === '' ? null : Number(f.precio_usd),
                    vin: form.inventory_vin || null,
                    colorExterior: u?.color || null,
                  }),
                }))
              }}
              style={{ background: 'transparent', border: '1px solid var(--brand-primary)', color: 'var(--brand-primary)', borderRadius: '6px', padding: '3px 10px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
            >
              Generar descripción
            </button>
          </div>
          <textarea style={{ ...s.input, minHeight: '150px', resize: 'vertical' as const }} value={form.descripcion} onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} placeholder="Detalles del vehículo... o usa Generar descripción (bilingüe + CTA de WhatsApp)." />
        </div>

        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Las fotos se adjuntan manualmente en Facebook al publicar (limitación del flujo con la extensión).
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button style={s.btnGhost} onClick={onClose} disabled={saving}>Cancelar</button>
          <button style={s.btnPrimary} onClick={save} disabled={saving}>{saving ? 'Guardando...' : 'Guardar'}</button>
        </div>
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function MarketplacePage() {
  const router = useRouter()
  const { permissions, loading: permsLoading, userId } = useNPAPermissions()
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState<'all' | Listing['status']>('all')
  const [modal, setModal] = useState<{ open: boolean; listing: Listing | null }>({ open: false, listing: null })
  const [acting, setActing] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    const { data, error } = await (supabase
      .from('fb_listings')
      .select('*')
      .order('updated_at', { ascending: false }) as any)
    if (error) {
      setLoadError('No se pudieron cargar las publicaciones: ' + error.message +
        ' (si la tabla no existe, faltan las migraciones 001-003 en Supabase).')
      setListings([])
    } else {
      setListings(Array.isArray(data) ? data : [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (permsLoading) return
    if (!permissions.npa_can_view_crm && !permissions.npa_can_admin) { router.replace('/dashboard'); return }
    load()
    // eslint-disable-next-line
  }, [permsLoading])

  const setStatus = async (l: Listing, status: Listing['status']) => {
    if (acting) return
    setActing(l.id)
    const { error } = await (supabase.from('fb_listings').update({ status }).eq('id', l.id) as any)
    setActing(null)
    if (!error) load()
  }

  const filtered = filter === 'all' ? listings : listings.filter(l => l.status === filter)
  const countBy = (st: Listing['status']) => listings.filter(l => l.status === st).length

  // Per-status actions (the extension owns the ready_to_publish → published hop).
  const actionsFor = (l: Listing) => {
    switch (l.status) {
      case 'draft':            return [{ label: 'Listo para publicar', to: 'ready_to_publish' as const, color: 'var(--brand-primary)' }]
      case 'ready_to_publish': return [{ label: 'Volver a borrador', to: 'draft' as const, color: '#8A93A0' }]
      case 'published':        return [
        { label: 'Pausar', to: 'paused' as const, color: '#E0A23C' },
        { label: 'Vendido', to: 'sold' as const, color: '#15A06E' },
        { label: 'Removido', to: 'removed' as const, color: '#E5556A' },
      ]
      case 'paused':           return [
        { label: 'Reactivar (cola)', to: 'ready_to_publish' as const, color: 'var(--brand-primary)' },
        { label: 'Vendido', to: 'sold' as const, color: '#15A06E' },
      ]
      default:                 return []
    }
  }

  return (
    <CrmShell active="marketplace">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '16px', flexWrap: 'wrap' as const, gap: '10px' }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: '4px' }}>CRM · Facebook Marketplace</div>
          <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)' }}>Publicaciones</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            Cola de publicación: borrador → listo para publicar → publicado (la extensión asiste el paso final; un humano siempre hace clic en Publicar).
          </div>
        </div>
        <button style={s.btnPrimary} onClick={() => setModal({ open: true, listing: null })}>Nueva publicación</button>
      </div>

      {/* Status pipeline chips */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' as const }}>
        <button style={s.chip(filter === 'all', 'var(--accent-solid)')} onClick={() => setFilter('all')}>
          Todas ({listings.length})
        </button>
        {STATUS_ORDER.map(st => (
          <button key={st} style={s.chip(filter === st, STATUS_META[st].color)} onClick={() => setFilter(st)}>
            {STATUS_META[st].label} ({countBy(st)})
          </button>
        ))}
      </div>

      {loadError && <div style={s.err}>{loadError}</div>}

      <div style={{ ...s.card, padding: 0, overflowX: 'auto' as const }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center' as const, color: 'var(--text-muted)', fontSize: '13px' }}>Cargando...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center' as const, color: 'var(--text-muted)', fontSize: '13px' }}>
            {listings.length === 0 ? 'No hay publicaciones todavía. Crea la primera con "Nueva publicación".' : 'Ninguna publicación con este estado.'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
            <thead>
              <tr>
                <th style={s.th}>Título</th>
                <th style={s.th}>Precio</th>
                <th style={s.th}>VIN</th>
                <th style={s.th}>Estado</th>
                <th style={s.th}>Facebook</th>
                <th style={s.th}>Actualizado</th>
                <th style={{ ...s.th, textAlign: 'right' as const }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(l => (
                <tr key={l.id}>
                  <td style={{ ...s.td, maxWidth: '260px' }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{l.titulo}</div>
                    {l.descripcion && <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{l.descripcion}</div>}
                  </td>
                  <td style={{ ...s.td, fontVariantNumeric: 'tabular-nums' as const }}>{fmtUsd(l.precio_usd)}</td>
                  <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '11px' }}>{l.inventory_vin || '—'}</td>
                  <td style={s.td}><span style={s.badge(STATUS_META[l.status].color)}>{STATUS_META[l.status].label}</span></td>
                  <td style={s.td}>
                    {l.fb_url
                      ? <a href={l.fb_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand-primary)', fontSize: '12px' }}>Ver en FB</a>
                      : <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{l.status === 'ready_to_publish' ? 'En cola' : '—'}</span>}
                  </td>
                  <td style={{ ...s.td, fontSize: '11px', color: 'var(--text-secondary)' }}>{fmtDate(l.updated_at)}</td>
                  <td style={{ ...s.td, textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
                    <span style={{ display: 'inline-flex', gap: '6px' }}>
                      {(l.status === 'draft' || l.status === 'paused') && (
                        <button style={s.btnMini('var(--text-secondary)')} onClick={() => setModal({ open: true, listing: l })} disabled={acting === l.id}>Editar</button>
                      )}
                      {actionsFor(l).map(a => (
                        <button key={a.to} style={s.btnMini(a.color)} onClick={() => setStatus(l, a.to)} disabled={acting === l.id}>{a.label}</button>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal.open && (
        <ListingModal
          listing={modal.listing}
          userId={userId}
          onClose={() => setModal({ open: false, listing: null })}
          onSaved={() => { setModal({ open: false, listing: null }); load() }}
        />
      )}
    </CrmShell>
  )
}
