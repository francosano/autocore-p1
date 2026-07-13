// TARGET: autocore-p1/app/inventario/importar/page.tsx
// ═══════════════════════════════════════════════════════════════════════════
// Inventario → Importar del sitio web. Review UI over site_inventory_staging
// (filled by the p1-site-sync Worker). Nothing auto-imports: staff review each
// scraped row and promote it into inventory_units, ignore it, or seed a
// Facebook Marketplace draft from it. Scraped data is untrusted input.
//
// Requires migrations/004_site_inventory.sql (staging) and, for the FB draft
// action, 002_fb_listings.sql. Until applied, loading shows a clear error.
//
// Import mapping note: inventory_units is built around a PURCHASE invoice
// (factura_compra_*, costo). Scraped listings have a RETAIL price and no
// invoice, so import writes placeholders (factura 'WEB-IMPORT', costo 0) and
// records the scraped context in notas. The retail price is NOT written as a
// cost. VIN may be absent → a WEB-<stock> placeholder with a warning flag.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'
import NavBar from '../../components/NavBar'
import { useNPAPermissions } from '../../components/useNPAPermissions'
import { buildFbDescription } from '../../lib/fbDescription'

interface StagingRow {
  id: string
  source_url: string
  titulo: string | null
  marca: string | null
  modelo: string | null
  anio: number | null
  precio_usd: number | null
  millas: number | null
  vin: string | null
  fotos: string[] | null
  raw: any
  first_seen: string
  last_seen: string
  status: 'new' | 'updated' | 'imported' | 'ignored' | 'removed_from_site'
  imported_inventory_ref: string | null
  imported_at: string | null
}

const STATUS_META: Record<StagingRow['status'], { label: string; color: string }> = {
  new:                { label: 'Nuevo',            color: 'var(--brand-primary)' },
  updated:            { label: 'Actualizado',      color: '#E0A23C' },
  imported:           { label: 'Importado',        color: 'var(--brand-success)' },
  ignored:            { label: 'Ignorado',         color: '#8A93A0' },
  removed_from_site:  { label: 'Retirado del sitio', color: '#E5556A' },
}
const STATUS_ORDER: StagingRow['status'][] = ['new', 'updated', 'imported', 'ignored', 'removed_from_site']

const fmtUsd = (n: number | null) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
const fmtMiles = (n: number | null) => n == null ? '—' : Number(n).toLocaleString('en-US') + ' mi'
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—'
const stockFromUrl = (u: string) => {
  const seg = u.replace(/\/+$/, '').split('/').pop() || ''
  return seg.toUpperCase()
}

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  content: { padding: '28px 32px', maxWidth: '1400px', margin: '0 auto' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '14px' },
  chip: (active: boolean, color: string) => ({ padding: '5px 12px', borderRadius: 999, fontSize: '11px', fontWeight: 700, cursor: 'pointer', border: `1px solid ${active ? color : 'var(--border)'}`, background: active ? 'var(--bg-deep)' : 'transparent', color: active ? color : 'var(--text-muted)' }),
  th: { padding: '9px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '1px', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' as const },
  td: { padding: '10px 12px', fontSize: '12.5px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' as const },
  badge: (color: string) => ({ display: 'inline-block', padding: '2px 9px', borderRadius: '4px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.5px', color, border: `1px solid ${color}55`, whiteSpace: 'nowrap' as const }),
  btnMini: (color: string) => ({ padding: '4px 10px', background: 'transparent', color, border: `1px solid ${color}55`, borderRadius: '6px', fontSize: '11px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const }),
  btnPrimary: { padding: '9px 18px', background: 'var(--brand-primary)', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' },
  thumb: { width: '54px', height: '40px', objectFit: 'cover' as const, borderRadius: '4px', background: 'var(--bg-deep)', border: '1px solid var(--border)' },
  warn: { display: 'inline-block', marginLeft: '6px', fontSize: '9px', fontWeight: 700, color: '#E0A23C', border: '1px solid #E0A23C55', borderRadius: '3px', padding: '0 4px' },
  err: { background: 'rgba(240,85,106,0.1)', border: '1px solid rgba(240,85,106,0.3)', borderRadius: '8px', padding: '10px 13px', fontSize: '12.5px', color: 'var(--danger)', marginBottom: '12px' },
  ok: { background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '8px', padding: '10px 13px', fontSize: '12.5px', color: 'var(--brand-success)', marginBottom: '12px' },
}

export default function ImportarPage() {
  const router = useRouter()
  const { permissions, loading: permsLoading, userId } = useNPAPermissions()
  const [rows, setRows] = useState<StagingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [flash, setFlash] = useState('')
  const [filter, setFilter] = useState<'all' | StagingRow['status']>('new')
  const [acting, setActing] = useState<string | null>(null)

  const canManage = permissions.can_manage_inventory || permissions.npa_can_admin

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    const { data, error } = await (supabase
      .from('site_inventory_staging')
      .select('*')
      .order('last_seen', { ascending: false }) as any)
    if (error) {
      setLoadError('No se pudo cargar el staging: ' + error.message +
        ' (si la tabla no existe, falta la migración 004_site_inventory.sql en Supabase).')
      setRows([])
    } else {
      setRows(Array.isArray(data) ? data : [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (permsLoading) return
    if (!canManage) { router.replace('/inventario'); return }
    load()
    // eslint-disable-next-line
  }, [permsLoading])

  const showFlash = (msg: string) => { setFlash(msg); setTimeout(() => setFlash(''), 4000) }

  // Build the inventory_units payload from a scraped row (placeholders for the
  // purchase-invoice / cost fields the website cannot provide).
  const toInventoryPayload = (r: StagingRow) => {
    const vin = (r.vin && r.vin.trim()) ? r.vin.trim().toUpperCase() : ('WEB-' + stockFromUrl(r.source_url)).slice(0, 40)
    const color = (r.raw && r.raw.jsonld_car && r.raw.jsonld_car.color) || null
    const modelo = [r.marca, r.modelo].filter(Boolean).join(' ').trim().toUpperCase() || (r.titulo || 'SIN MODELO').toUpperCase()
    const notaBits = [
      'Importado del sitio web.',
      r.precio_usd != null ? `Precio de lista: ${fmtUsd(r.precio_usd)}.` : null,
      r.millas != null ? `Millas: ${fmtMiles(r.millas)}.` : null,
      (!r.vin || !r.vin.trim()) ? 'VIN no disponible en el sitio (placeholder).' : null,
      r.source_url,
    ].filter(Boolean).join(' ')
    return {
      vin,
      modelo,
      año: r.anio ?? new Date().getFullYear(),
      color,
      factura_compra_num: 'WEB-IMPORT',
      factura_compra_fecha: new Date().toISOString().slice(0, 10),
      costo_unidad_usd: 0,               // retail price is NOT a cost — do not fabricate
      estado: 'EN_STOCK',
      notas: notaBits,
      created_by: userId || null,
      updated_by: userId || null,
      _vinWasPlaceholder: !(r.vin && r.vin.trim()),
    }
  }

  const importRow = async (r: StagingRow): Promise<{ ok: boolean; msg?: string }> => {
    const payload: any = toInventoryPayload(r)
    delete payload._vinWasPlaceholder
    const { error: insErr } = await (supabase.from('inventory_units').insert(payload) as any)
    if (insErr) {
      // Most likely a duplicate VIN (unit already exists). Surface it.
      return { ok: false, msg: insErr.message }
    }
    await (supabase.from('site_inventory_staging').update({
      status: 'imported',
      imported_inventory_ref: payload.vin,
      imported_at: new Date().toISOString(),
      imported_by: userId || null,
    }).eq('id', r.id) as any)
    return { ok: true }
  }

  const onImport = async (r: StagingRow) => {
    if (acting) return
    setActing(r.id)
    const res = await importRow(r)
    setActing(null)
    if (res.ok) { showFlash(`Unidad importada al inventario.`); load() }
    else setLoadError('No se pudo importar (' + (res.msg || 'error') + '). ¿VIN ya existe en inventario?')
  }

  const onBulkImportNew = async () => {
    if (acting) return
    const targets = rows.filter(r => r.status === 'new')
    if (targets.length === 0) return
    setActing('bulk')
    let ok = 0, fail = 0
    for (const r of targets) {
      const res = await importRow(r)
      if (res.ok) ok++; else fail++
    }
    setActing(null)
    showFlash(`Importación masiva: ${ok} importadas${fail ? `, ${fail} con error` : ''}.`)
    load()
  }

  const setStatus = async (r: StagingRow, status: StagingRow['status']) => {
    if (acting) return
    setActing(r.id)
    await (supabase.from('site_inventory_staging').update({ status }).eq('id', r.id) as any)
    setActing(null)
    load()
  }

  // Seed a Facebook Marketplace draft (fb_listings) from a scraped row.
  // The description is generated ready-to-paste (bilingual + WhatsApp CTA)
  // from the REAL scraped specs — see app/lib/fbDescription.ts.
  const onCrearBorradorFB = async (r: StagingRow) => {
    if (acting) return
    setActing(r.id)
    const car = (r.raw && r.raw.jsonld_car) || {}
    const fields = (r.raw && r.raw.fields) || {}
    const descripcion = buildFbDescription({
      titulo: r.titulo || [r.marca, r.modelo].filter(Boolean).join(' ') || 'Vehículo',
      precioUsd: r.precio_usd,
      millas: r.millas,
      vin: r.vin,
      bodyType: car.bodyType || null,
      fuel: car.fuelType || null,
      transmission: car.vehicleTransmission || fields['Transmission'] || null,
      engine: car.vehicleEngine || fields['Engine'] || null,
      colorExterior: car.color || fields['Exterior Color'] || null,
      colorInterior: fields['Interior Color'] || null,
      drivetrain: fields['Drivetrain'] || null,
      trim: fields['Trim'] || null,
    })
    const { error } = await (supabase.from('fb_listings').insert({
      inventory_vin: r.status === 'imported' ? r.imported_inventory_ref : null,
      titulo: r.titulo || [r.marca, r.modelo].filter(Boolean).join(' ') || 'Publicación',
      precio_usd: r.precio_usd,
      descripcion,
      fotos: Array.isArray(r.fotos) ? r.fotos : [],
      status: 'draft',
      created_by: userId || null,
    }) as any)
    setActing(null)
    if (error) setLoadError('No se pudo crear el borrador FB (' + error.message + '). ¿Falta la migración 002_fb_listings.sql?')
    else showFlash('Borrador de Facebook Marketplace creado. Ábrelo en CRM → Marketplace.')
  }

  const filtered = filter === 'all' ? rows : rows.filter(r => r.status === filter)
  const countBy = (st: StagingRow['status']) => rows.filter(r => r.status === st).length
  const newCount = countBy('new')

  return (
    <div style={s.page}>
      <NavBar />
      <div style={s.content}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '16px', flexWrap: 'wrap' as const, gap: '10px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: '4px' }}>Inventario · Importar del sitio web</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)' }}>Revisión de importación</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px', maxWidth: '760px' }}>
              Filas capturadas de www.p1autosales.com por el Worker p1-site-sync. Nada se importa solo: revisa y promueve a inventario, ignora, o crea un borrador de Facebook. Datos scrapeados = entrada no confiable.
            </div>
          </div>
          <button style={{ ...s.btnPrimary, opacity: newCount === 0 || acting ? 0.5 : 1 }} disabled={newCount === 0 || !!acting} onClick={onBulkImportNew}>
            Importar todos los nuevos ({newCount})
          </button>
        </div>

        <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' as const }}>
          <button style={s.chip(filter === 'all', 'var(--accent-solid)')} onClick={() => setFilter('all')}>Todos ({rows.length})</button>
          {STATUS_ORDER.map(st => (
            <button key={st} style={s.chip(filter === st, STATUS_META[st].color)} onClick={() => setFilter(st)}>
              {STATUS_META[st].label} ({countBy(st)})
            </button>
          ))}
        </div>

        {flash && <div style={s.ok}>{flash}</div>}
        {loadError && <div style={s.err}>{loadError}</div>}

        <div style={{ ...s.card, overflowX: 'auto' as const }}>
          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center' as const, color: 'var(--text-muted)', fontSize: '13px' }}>Cargando...</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center' as const, color: 'var(--text-muted)', fontSize: '13px' }}>
              {rows.length === 0 ? 'Sin filas de staging todavía. Ejecuta el Worker p1-site-sync (cron diario o /sync manual).' : 'Ninguna fila con este estado.'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
              <thead>
                <tr>
                  <th style={s.th}>Foto</th>
                  <th style={s.th}>Vehículo</th>
                  <th style={s.th}>Precio</th>
                  <th style={s.th}>Millas</th>
                  <th style={s.th}>VIN</th>
                  <th style={s.th}>Estado</th>
                  <th style={s.th}>Visto</th>
                  <th style={{ ...s.th, textAlign: 'right' as const }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const vinMissing = !(r.vin && r.vin.trim())
                  const photo = Array.isArray(r.fotos) && r.fotos.length ? r.fotos[0] : null
                  const busy = acting === r.id
                  return (
                    <tr key={r.id}>
                      <td style={s.td}>
                        {photo
                          ? <img src={photo} alt="" style={s.thumb} loading="lazy" />
                          : <div style={{ ...s.thumb, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', color: 'var(--text-muted)' }}>sin foto</div>}
                      </td>
                      <td style={{ ...s.td, maxWidth: '260px' }}>
                        <div style={{ fontWeight: 600 }}>{r.titulo || [r.marca, r.modelo].filter(Boolean).join(' ') || '—'}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {r.anio || '—'} · {Array.isArray(r.fotos) ? r.fotos.length : 0} fotos ·{' '}
                          <a href={r.source_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand-primary)' }}>ver en el sitio</a>
                        </div>
                      </td>
                      <td style={{ ...s.td, fontVariantNumeric: 'tabular-nums' as const }}>{fmtUsd(r.precio_usd)}</td>
                      <td style={{ ...s.td, fontVariantNumeric: 'tabular-nums' as const }}>{fmtMiles(r.millas)}</td>
                      <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '11px' }}>
                        {vinMissing ? <span style={{ color: 'var(--text-muted)' }}>—<span style={s.warn}>SIN VIN</span></span> : r.vin}
                      </td>
                      <td style={s.td}><span style={s.badge(STATUS_META[r.status].color)}>{STATUS_META[r.status].label}</span></td>
                      <td style={{ ...s.td, fontSize: '11px', color: 'var(--text-secondary)' }}>{fmtDate(r.last_seen)}</td>
                      <td style={{ ...s.td, textAlign: 'right' as const }}>
                        <span style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap' as const, justifyContent: 'flex-end' }}>
                          {(r.status === 'new' || r.status === 'updated') && (
                            <>
                              <button style={s.btnMini('var(--brand-success)')} disabled={busy} onClick={() => onImport(r)}>
                                {busy ? '…' : (vinMissing ? 'Importar (sin VIN)' : 'Importar')}
                              </button>
                              <button style={s.btnMini('#8A93A0')} disabled={busy} onClick={() => setStatus(r, 'ignored')}>Ignorar</button>
                            </>
                          )}
                          {r.status === 'ignored' && (
                            <button style={s.btnMini('var(--brand-primary)')} disabled={busy} onClick={() => setStatus(r, 'new')}>Reconsiderar</button>
                          )}
                          {r.status === 'removed_from_site' && r.imported_inventory_ref && (
                            <button style={s.btnMini('#E5556A')} disabled={busy}
                              onClick={() => { window.location.href = '/inventario?vin=' + encodeURIComponent(r.imported_inventory_ref!) }}>
                              Marcar vendido en inventario
                            </button>
                          )}
                          <button style={s.btnMini('var(--brand-primary)')} disabled={busy} onClick={() => onCrearBorradorFB(r)}>Crear borrador FB</button>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px', lineHeight: 1.6 }}>
          Al importar se crea una unidad en inventario con placeholders de compra (factura WEB-IMPORT, costo 0): el sitio no publica ni factura ni costo, solo el precio de lista. Corrige esos datos en Inventario si hace falta. Las filas "Retirado del sitio" que ya fueron importadas son candidatas a marcar vendidas.
        </div>
      </div>
    </div>
  )
}
