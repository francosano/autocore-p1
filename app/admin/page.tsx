// TARGET: autocore-npa/app/admin/page.tsx
'use client'
import { useState, useEffect, useRef, Suspense } from 'react'
import { supabase } from '../supabase'
import { useRouter, useSearchParams } from 'next/navigation'
import AdminShell from '../components/AdminShell'
import { useNPAPermissions } from '../components/useNPAPermissions'
import CxCInicialDiferidaCard from '../components/CxCInicialDiferidaCard'
// Documentos de Entrega (Nota + Declaración Zelle + Legitimación) — compartido
// con /auditoria para que Deisi los imprima en negocios aprobados.
import NotaEntregaPrint from '../components/NotaEntregaPrint'
import { upsertBankTxBatch } from '../lib/bankUpsert'

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtBs = (n: number) => `Bs ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (iso: string) => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }
const fmtDateTime = (iso: string) => { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString('es-VE') + ' ' + d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }) }

const METODOS_REQUIEREN_COMPROBANTE = ['Zelle Roframi', 'Zelle Motocentro', 'Zelle Externo', 'Wire Transfer Roframi', 'Wire Transfer Motocentro', 'Wire Transfer Panama']

// Métodos excluidos de los formularios de Legitimación de Capitales y Declaración de Pagos por Zelle/Transferencias.
// Estos formularios solo aplican para fondos efectivamente recibidos en USD.
// - "Transferencia en Bolívares" y "Retención": pagos en BS, no aplican.
// - "Saldo a Financiar": financiamiento interno BHPH, no es un pago recibido.
const METODOS_EXCLUIDOS_FORMS_USD = ['Transferencia en Bolívares', 'Retención', 'Saldo a Financiar']
const isPagoUSD = (p: any) => !METODOS_EXCLUIDOS_FORMS_USD.includes(p?.metodo)
// Legitimacion de Capitales: WHITELIST. Solo fondos recibidos fisicamente en
// divisas (efectivo USD) o USDT. Wires/Zelles quedan fuera (van en la
// Declaracion de Pagos por Zelle/Transferencias); Bs/Retencion/financiamiento
// nunca aplican. Case-insensitive para tolerar 'efectivo'/'Efectivo'/'USDT'.
const isPagoCashUSD = (p: any) => {
  const m = String(p?.metodo || '').toLowerCase()
  return m.includes('efectivo') || m.includes('usdt') || m.includes('cash')
}

// KIA Logo (PNG, transparent background, dark navy fill — recolored from the source CMYK JPG
// at supabase://comprobantes/assets/22527_Kia_Logo.jpg). Embedded as base64 so printed forms
// work offline and don't depend on a network fetch when the print dialog opens.
// KIA Logo — hosted in Supabase Storage. Update path here if logo is moved.
const KIA_LOGO_DATA_URI = 'https://xwyiatmeyonodgncobps.supabase.co/storage/v1/object/public/comprobantes/assets/22527_Kia_Logo.jpg'

// ── DOCUMENT RENDER HELPERS (added 2026-05-07) ────────────────────────────────
const STORAGE_BUCKET = 'comprobantes'

// Detect MIME from a base64 data URL or raw base64 by inspecting magic bytes.
// Used because legacy comprobante_imagen entries had hardcoded "image/jpeg" prefix
// regardless of actual file type — this caused broken thumbnails for PDFs/PNGs.
function detectMimeFromBase64(b64orDataUrl: string): string {
  if (!b64orDataUrl) return 'image/jpeg'
  let raw = b64orDataUrl
  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',')
    if (comma >= 0) raw = raw.slice(comma + 1)
  }
  try {
    const head = atob(raw.slice(0, 16))
    const bytes = Array.from(head).map(c => c.charCodeAt(0))
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf'
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp'
  } catch { /* ignore */ }
  return 'image/jpeg'
}

// Rebuild data URL with correct MIME prefix detected from bytes.
function fixDataUrlMime(dataUrl: string): string {
  if (!dataUrl) return dataUrl
  const mime = detectMimeFromBase64(dataUrl)
  if (dataUrl.startsWith(`data:${mime};`)) return dataUrl  // already correct
  if (dataUrl.startsWith('data:')) {
    const comma = dataUrl.indexOf(',')
    return `data:${mime};base64,${dataUrl.slice(comma + 1)}`
  }
  return `data:${mime};base64,${dataUrl}`
}

// Hook: get a signed URL for a storage path (or null if path is missing/invalid).
function useSignedUrl(path: string | undefined | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!path) { setUrl(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(path, 604800)
        if (!cancelled) setUrl(data?.signedUrl || null)
      } catch { if (!cancelled) setUrl(null) }
    })()
    return () => { cancelled = true }
  }, [path])
  return url
}

// ── ComprobanteThumb: render a payment receipt thumbnail with PDF/image awareness
//
// Three rendering paths in priority order:
//   1. comprobante_path (storage)  → fetch signed URL, render as <img> if image
//      or 📄 PDF icon button if PDF
//   2. comprobante_imagen (legacy data URL) → render with corrected MIME
//   3. nothing → render "Sin comprobante" notice
function ComprobanteThumb({ pago, dealNum, idx, onLightbox }: {
  pago: any
  dealNum: string | number
  idx: number
  onLightbox: (url: string, isPdf: boolean) => void
}) {
  const signedUrl = useSignedUrl(pago.comprobante_path)
  const storedMime = pago.comprobante_mime || ''

  // Tesoreria receipt fallback: saldo/pulled pagos carry no image of their own
  // but reference the source deposit (_pago_recibido_id), whose comprob_url may
  // hold the receipt. comprob_url is stored as a full URL in some rows and a
  // bucket path in others, so handle both.
  const needsFallback = !pago.comprobante_path && !pago.comprobante_imagen && !!pago._pago_recibido_id
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [prLoading, setPrLoading] = useState(false)
  useEffect(() => {
    if (!needsFallback) { setPrUrl(null); return }
    let cancelled = false
    setPrLoading(true)
    ;(async () => {
      try {
        const { data } = await (supabase.from('pagos_recibidos').select('comprob_url').eq('id', pago._pago_recibido_id).single() as any)
        const raw: string | null = data?.comprob_url || null
        if (!raw) { if (!cancelled) { setPrUrl(null); setPrLoading(false) } ; return }
        if (/^https?:\/\//i.test(raw)) {
          if (!cancelled) { setPrUrl(raw); setPrLoading(false) }
        } else {
          const { data: signed } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(raw, 604800)
          if (!cancelled) { setPrUrl(signed?.signedUrl || null); setPrLoading(false) }
        }
      } catch { if (!cancelled) { setPrUrl(null); setPrLoading(false) } }
    })()
    return () => { cancelled = true }
  }, [needsFallback, pago._pago_recibido_id])

  // Decide source. Storage path wins; legacy data URL is fallback.
  let src: string | null = null
  let mime: string = ''
  let isPdf = false
  let fromTesoreria = false
  if (signedUrl) {
    src = signedUrl
    mime = storedMime || (pago.comprobante_path?.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg')
    isPdf = mime === 'application/pdf'
  } else if (pago.comprobante_imagen) {
    src = fixDataUrlMime(pago.comprobante_imagen)
    mime = detectMimeFromBase64(pago.comprobante_imagen)
    isPdf = mime === 'application/pdf'
  } else if (prUrl) {
    src = prUrl
    isPdf = /\.pdf($|\?)/i.test(prUrl)
    mime = isPdf ? 'application/pdf' : 'image/jpeg'
    fromTesoreria = true
  }

  // Loading state: storage path exists but URL hasn't been signed yet
  if (pago.comprobante_path && !signedUrl) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ height: '56px', width: '72px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-deep)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', color: 'var(--text-secondary)' }}>
          ⏳ Cargando...
        </div>
        <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Generando enlace seguro…</div>
      </div>
    )
  }

  if (needsFallback && prLoading) {
    return (
      <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>⏳ Cargando comprobante de tesorería…</div>
    )
  }

  if (!src) {
    if (needsFallback) return null
    return (
      <div style={{ fontSize: '10px', color: '#b8720a' }}>⚠ Sin comprobante adjunto</div>
    )
  }

  const ext = isPdf ? 'pdf' : (mime.split('/')[1] || 'jpg')
  const downloadName = `comprobante_${dealNum}_${idx + 1}.${ext}`

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      {isPdf ? (
        // PDF preview: large clickable icon (no <img>; PDFs don't render in <img>)
        <button
          onClick={() => onLightbox(src!, true)}
          style={{
            height: '56px', width: '72px', borderRadius: '6px',
            border: '1px solid var(--border)', background: 'var(--bg-deep)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-in', padding: 0,
          }}
          title="Abrir PDF"
        >
          <div style={{ fontSize: '20px' }}>📄</div>
          <div style={{ fontSize: '8px', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '1px' }}>PDF</div>
        </button>
      ) : (
        <img
          src={src}
          alt="comprobante"
          onClick={() => onLightbox(src!, false)}
          style={{ height: '56px', width: '72px', objectFit: 'cover', borderRadius: '6px', border: '1px solid var(--border)', cursor: 'zoom-in' }}
        />
      )}
      <div>
        <div style={{ fontSize: '10px', color: '#2ecc8a', fontWeight: 600, marginBottom: '3px' }}>{fromTesoreria ? '✓ Comprobante de tesorería' : '✓ Comprobante adjunto'}</div>
        <a href={src} download={downloadName} target="_blank" rel="noreferrer"
           style={{ fontSize: '10px', color: '#4a9eff', textDecoration: 'none' }}>
          {isPdf ? 'Abrir PDF' : 'Descargar'}
        </a>
      </div>
    </div>
  )
}

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif', transition: 'background 0.35s ease' },
  content: { padding: '32px', maxWidth: '1300px', margin: '0 auto' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', marginBottom: '20px', transition: 'background 0.35s ease, border-color 0.35s ease' },
  sectionTitle: { fontSize: '12px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' },
  btnRed: { padding: '10px 24px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px' },
  btnGray: { padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  btnGreen: { padding: '10px 24px', background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px' },
  input: { width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  label: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', display: 'block', marginBottom: '6px' },
  textarea: { width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const, resize: 'vertical' as const, minHeight: '80px' },
}

const thTd: any = { padding: '10px 12px', textAlign: 'left', fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }

// ── DocViewer (2026-05-07 rewrite): two-source lookup
//    1. PRIMARY: read deal.documentos_meta — JSONB map with explicit paths and metadata
//    2. FALLBACK: list the comprobantes/deals/{negocio_num}/ folder (legacy behavior)
//
//    The fallback exists because old deals that pre-date the documentos_meta
//    column may have files in storage with no JSONB record. Eventually this
//    fallback can be removed once bucket C (backfill historicals) runs.
// Get a signed URL for a comprobantes path. Prefers the edge worker (signs server-side
// with the service key — never stalls on the browser's Supabase auth token / slow
// refresh). Falls back to client-side signing (with a watchdog) if the worker is
// unreachable, so documents still open before the worker is deployed.
async function signDoc(path: string): Promise<string | null> {
  try {
    const r = await fetch(`https://autocore-docsign.sano-franco.workers.dev/?path=${encodeURIComponent(path)}`)
    if (r.ok) { const j = await r.json(); if (j?.signedUrl) return j.signedUrl as string }
  } catch { /* fall through to client signing */ }
  try {
    const signP = supabase.storage.from('comprobantes').createSignedUrl(path, 604800)
    const toP = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
    const res = await Promise.race([signP, toP]) as { data?: { signedUrl?: string } }
    return res?.data?.signedUrl || null
  } catch { return null }
}

function DocViewer({ documentosMeta, negocioNum, dealId }: { documentosMeta?: Record<string, any>, negocioNum: string, dealId?: string }) {
  // Buttons render SYNCHRONOUSLY from the deal's documentos_meta (already loaded with
  // the deal via select('*')). No fetch is needed to show them, so browsing between
  // deals or clicking one can never blank them. Signing happens on click.
  const meta = (documentosMeta || {}) as Record<string, any>
  const metaPaths: Record<string, string> = {}
  for (const k of ['factura', 'cdo', 'cedula']) if (meta[k]?.path) metaPaths[k] = meta[k].path

  // Folder fallback ONLY for the doc types missing from meta (legacy / empty-meta deals
  // like ones created before scanning). Non-blocking — the meta buttons already show;
  // this just fills gaps. Never overrides a meta path.
  const [extra, setExtra] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const missing = ['factura', 'cdo', 'cedula'].filter(d => !metaPaths[d])
    if (missing.length === 0) { setExtra({}); return }
    ;(async () => {
      const found: Record<string, string> = {}
      const folders = [
        negocioNum ? `deals/${negocioNum}` : null,
        dealId ? `deals/borrador_${dealId}` : null,
      ].filter(Boolean) as string[]
      for (const folder of folders) {
        const { data: files } = await supabase.storage.from('comprobantes').list(folder, { limit: 50 })
        if (cancelled) return
        if (!files || files.length === 0) continue
        for (const doc of missing) {
          if (found[doc]) continue
          const match = files.find(f => f.name.toLowerCase().startsWith(doc))
          if (match) found[doc] = `${folder}/${match.name}`
        }
      }
      if (!cancelled) setExtra(found)
    })()
    return () => { cancelled = true }
  }, [negocioNum, dealId, JSON.stringify(metaPaths)])

  const paths: Record<string, string> = { ...extra, ...metaPaths }   // meta always wins

  // Pre-sign all the doc links ONCE when the panel opens (a single token fetch, not one
  // per click) and render them as NATIVE links. A native link needs no JS and no signing
  // at click time, so it can't hang or be popup-blocked on repeat clicks. Watchdog avoids
  // a perpetual spinner if the auth token lock stalls (multi-tab contention).
  const [signed, setSigned] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const keys = Object.keys(paths)
    if (keys.length === 0) { setSigned({}); return }
    ;(async () => {
      const out: Record<string, string> = {}
      for (const k of keys) {
        const url = await signDoc(paths[k])
        if (cancelled) return
        if (url) out[k] = url
        else console.warn('[DocViewer] no se pudo prefirmar', k)
      }
      if (!cancelled) setSigned(out)
    })()
    return () => { cancelled = true }
  }, [JSON.stringify(paths)])

  // Fallback for a link not pre-signed in time: open a tab synchronously (never popup-
  // blocked), sign with a watchdog, then redirect — error message instead of a perpetual
  // blank if the token lock stalls.
  const openDoc = async (docType: string) => {
    const path = paths[docType]
    if (!path) return
    const w = window.open('about:blank', '_blank')
    if (!w) { alert('El navegador bloqueó la ventana. Permite ventanas emergentes para este sitio.'); return }
    try { w.document.write('<title>Cargando…</title><p style="font:14px sans-serif;padding:24px;color:#555">Cargando documento…</p>') } catch {}
    const url = await signDoc(path)
    if (url) {
      w.location.href = url
    } else {
      console.warn('[DocViewer] no se pudo abrir el documento', { docType, path })
      try { w.document.body.innerHTML = '<p style="font:14px sans-serif;padding:24px;color:#b00">No se pudo abrir el documento. Cierra esta pestaña e intenta de nuevo.</p>' } catch {}
    }
  }

  const docTypes = [
    { key: 'factura', label: '📋 Factura' },
    { key: 'cdo',     label: '📜 CDO' },
    { key: 'cedula',  label: '🪪 Cédula' },
  ]
  const linkStyle = { padding: '6px 12px', fontSize: '11px', borderRadius: '6px', border: '1px solid rgba(74,158,255,0.4)', background: 'rgba(74,158,255,0.08)', color: '#4a9eff', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'none', display: 'inline-block' as const }
  const hasAny = Object.keys(paths).length > 0

  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: '10px', paddingBottom: '6px', borderBottom: '1px solid var(--border)' }}>
        Documentos Escaneados
      </div>
      {hasAny ? (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' as const }}>
          {docTypes.map(({ key, label }) => {
            if (!paths[key]) return null
            // Native link once pre-signed (reliable on every click); button fallback if not yet.
            return signed[key]
              ? <a key={key} href={signed[key]} target="_blank" rel="noopener noreferrer" style={linkStyle}>{label}</a>
              : <button key={key} onClick={() => openDoc(key)} style={linkStyle}>{label}</button>
          })}
        </div>
      ) : (
        <div style={{ padding: '10px 14px', background: 'var(--bg-deep)', borderRadius: '8px', fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
          Sin documentos escaneados — este negocio fue creado antes del módulo de escaneo, o los archivos no se subieron correctamente.
        </div>
      )}
    </div>
  )
}

function KpiCard({ label, value, color }: { label: string, value: string, color: string }) {
  // Corporate stat tile: el número va en tinta (text-primary); el color de la
  // serie vive solo en el borde-acento. Números tabulares para alineación.
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderLeft: `3px solid ${color}`, borderRadius: '6px', padding: '16px 18px', transition: 'background 0.35s ease, border-color 0.35s ease' }}>
      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.2px', marginBottom: '10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontSize: '26px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.5px', lineHeight: 1 }}>{value}</div>
    </div>
  )
}

// ── DELETE CONFIRM MODAL ──────────────────────────────────────────────────────
function DeleteModal({ deal, onConfirm, onCancel }: { deal: any, onConfirm: () => void, onCancel: () => void }) {
  const [step, setStep] = useState<'warn' | 'confirm'>('warn')
  const [typed, setTyped] = useState('')
  const expected = String(deal.negocio_num || '')

  if (step === 'confirm') return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '2px solid #BB162B', borderRadius: '16px', padding: '32px', maxWidth: '440px', width: '100%' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: '#BB162B', marginBottom: '8px', textAlign: 'center' }}>Confirmación Final</div>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '20px', textAlign: 'center', lineHeight: 1.6 }}>
          Escribe el número de negocio <strong style={{ color: 'var(--text-primary)' }}>#{expected}</strong> para confirmar la eliminación permanente.
        </div>
        <input
          type="text"
          style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: `1px solid ${typed === expected ? '#2ecc8a' : 'var(--border)'}`, borderRadius: '8px', color: 'var(--text-primary)', fontSize: '15px', fontWeight: 700, outline: 'none', boxSizing: 'border-box' as const, textAlign: 'center', letterSpacing: '2px', marginBottom: '20px' }}
          value={typed}
          onChange={e => setTyped(e.target.value)}
          placeholder={expected}
          autoFocus
        />
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={onCancel} style={{ padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', flex: 1 }}>Cancelar</button>
          <button onClick={onConfirm} disabled={typed !== expected} style={{ padding: '10px 24px', background: typed === expected ? '#BB162B' : 'rgba(187,22,43,0.3)', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: typed === expected ? 'pointer' : 'not-allowed', flex: 1, transition: 'background 0.2s' }}>
            Eliminar Definitivamente
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '2px solid #BB162B', borderRadius: '16px', padding: '32px', maxWidth: '460px', width: '100%', textAlign: 'center' }}>
        <div style={{ width: '56px', height: '56px', borderRadius: '12px', background: 'rgba(187,22,43,0.15)', border: '2px solid rgba(187,22,43,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: '22px', color: '#BB162B', fontWeight: 900 }}>⚠</div>
        <div style={{ fontSize: '15px', fontWeight: 700, color: '#BB162B', marginBottom: '8px' }}>Eliminar Negocio #{deal.negocio_num}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: 1.6 }}>{deal.cliente_nombre}{(deal as any).cliente_apellidos ? " " + (deal as any).cliente_apellidos : ""} · {deal.banco}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-primary)', background: 'rgba(187,22,43,0.08)', border: '1px solid rgba(187,22,43,0.25)', borderRadius: '8px', padding: '12px 16px', marginBottom: '24px', lineHeight: 1.7, textAlign: 'left' as const }}>
          Esta acción es <strong>irreversible</strong>. Se eliminará permanentemente:<br />
          · Todos los datos del negocio<br />
          · Todos los pagos registrados<br />
          · Todos los comprobantes adjuntos<br />
          · El registro de imágenes duplicadas
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={onCancel} style={{ padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', flex: 1 }}>Cancelar</button>
          <button onClick={() => setStep('confirm')} style={{ padding: '10px 24px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', flex: 1 }}>Continuar →</button>
        </div>
      </div>
    </div>
  )
}

// ── DEAL DETAIL SLIDE-IN PANEL ────────────────────────────────────────────────
function DealPanel({ deal, onClose, onDelete, canDelete }: { deal: any, onClose: () => void, onDelete: () => void, canDelete: boolean }) {
  const [lightboxImg, setLightboxImg] = useState<string | null>(null)
  const [showDelete, setShowDelete] = useState(false)

  const pagos: any[] = Array.isArray(deal.pagos) ? deal.pagos : []
  const total_ingresos = pagos.reduce((sum: number, p: any) => sum + (parseFloat(p.monto_usd) || 0), 0)
  const pv_total = [deal.pv_precio, deal.pv_gastos_admin, deal.pv_seguro, deal.pv_igtf, deal.pv_accesorios, deal.pv_placas].reduce((a: number, b: any) => a + (b || 0), 0)
  // ★ IGTF surplus recovery (mirrors auditoria/page.tsx calcTotals)
  //   When au_igtf < pv_igtf, the difference represents IGTF that was charged to the
  //   client inside the factura but doesn't get paid out — so it's recovered revenue.
  const igtf_recovered = Math.max(0, (deal.pv_igtf || 0) - (deal.au_igtf || 0))
  // total_cliente is what auditoria page persisted; if older deals have a stale value
  // that doesn't include the surplus, we recompute from fields instead.
  const au_total_fields = [deal.au_precio, deal.au_gastos_admin, deal.au_seguro, deal.au_igtf, deal.au_accesorios, deal.au_comision_flat, deal.au_placas].reduce((a: number, b: any) => a + (b || 0), 0)
  const au_total = au_total_fields + igtf_recovered
  const neto = au_total - total_ingresos
  const resultColor = deal.resultado_tipo === 'CUADRADO' ? '#2ecc8a' : deal.resultado_tipo === 'FALTANTE' ? '#BB162B' : '#b8720a'
  const statusColor = deal.status === 'APROBADO' ? '#2ecc8a' : '#b8720a'

  // Section header
  const SH = ({ title, color = '#BB162B' }: { title: string, color?: string }) => (
    <div style={{ fontSize: '11px', fontWeight: 700, color, textTransform: 'uppercase' as const, letterSpacing: '2px', marginBottom: '10px', paddingBottom: '6px', borderBottom: `1px solid var(--border)` }}>{title}</div>
  )

  // Key-value row
  const Row = ({ label, value, mono = false, color }: { label: string, value: any, mono?: boolean, color?: string }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', flexShrink: 0, marginRight: '12px' }}>{label}</span>
      <span style={{ fontSize: '12px', fontWeight: 600, color: color || 'var(--text-primary)', textAlign: 'right', fontFamily: mono ? 'monospace' : 'inherit' }}>{value ?? '—'}</span>
    </div>
  )

  // Two-column money row for Proyecto vs Auditoría
  const DualRow = ({ label, pv, au }: { label: string, pv: any, au: any }) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr', gap: '8px', padding: '5px 0', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
      <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-primary)', textAlign: 'right' as const }}>{pv ? fmt(pv) : '$0.00'}</span>
      <span style={{ fontSize: '11px', fontFamily: 'monospace', color: '#2ecc8a', textAlign: 'right' as const }}>{au ? fmt(au) : '$0.00'}</span>
    </div>
  )

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9000 }} />

      {lightboxImg && (
        <div onClick={() => setLightboxImg(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.95)', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}>
          <img src={lightboxImg} alt="comprobante" style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: '8px' }} />
          <div onClick={() => setLightboxImg(null)} style={{ position: 'absolute', top: '20px', right: '24px', color: '#fff', fontSize: '28px', cursor: 'pointer', fontWeight: 300 }}>✕</div>
        </div>
      )}

      {showDelete && <DeleteModal deal={deal} onConfirm={onDelete} onCancel={() => setShowDelete(false)} />}

      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: '600px', background: 'var(--bg-card)', borderLeft: '1px solid var(--border)', zIndex: 9001, overflowY: 'auto', boxShadow: '-8px 0 40px rgba(0,0,0,0.35)', transition: 'background 0.35s ease' }}>

        {/* ── HEADER ── */}
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 10 }}>
          <div>
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '2px' }}>Detalle del Negocio</div>
            <div style={{ fontSize: '22px', fontWeight: 900, color: 'var(--text-primary)' }}>#{deal.negocio_num || '—'}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: deal.status === 'APROBADO' ? 'rgba(26,122,74,0.2)' : 'rgba(184,114,10,0.2)', color: statusColor }}>{deal.status || 'BORRADOR'}</span>
            {canDelete && (
              <button onClick={() => setShowDelete(true)} style={{ background: 'none', border: '1px solid rgba(187,22,43,0.4)', borderRadius: '8px', color: '#BB162B', cursor: 'pointer', padding: '6px 12px', fontSize: '12px', fontWeight: 700 }}>Eliminar</button>
            )}
            <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-secondary)', cursor: 'pointer', padding: '6px 12px', fontSize: '12px' }}>✕ Cerrar</button>
          </div>
        </div>

        <div style={{ padding: '20px 24px' }}>

          {/* ── RESULT BANNER ── */}
          <div style={{ background: resultColor, borderRadius: '10px', padding: '14px 20px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' as const, gap: '12px' }}>
              <div>
                <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: '2px' }}>Resultado</div>
                <div style={{ fontSize: '24px', fontWeight: 900, color: '#fff' }}>{deal.resultado_tipo || '—'}</div>
              </div>
              <div style={{ display: 'flex', gap: '24px' }}>
                {[
                  { l: 'Proyecto', v: fmt(pv_total) },
                  { l: 'Audit Total', v: fmt(au_total) },
                  { l: 'Ingresos', v: fmt(total_ingresos) },
                  { l: neto > 0 ? 'Faltante' : neto < 0 ? 'Sobrante' : 'Neto', v: fmt(Math.abs(neto)) },
                ].map(item => (
                  <div key={item.l} style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.65)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '3px' }}>{item.l}</div>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: '#fff', fontFamily: 'monospace' }}>{item.v}</div>
                  </div>
                ))}
              </div>
            </div>
            {deal.ajuste_cuadre ? (
              <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.2)', fontSize: '11px', color: 'rgba(255,255,255,0.85)' }}>
                Ajuste de Cuadre aprobado: <strong>{fmt(deal.ajuste_cuadre)}</strong>
              </div>
            ) : null}
          </div>

          {/* ── 1. INFORMACIÓN DEL NEGOCIO ── */}
          <div style={{ marginBottom: '20px' }}>
            <SH title="1 — Información del Negocio" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
              <div>
                <Row label="Negocio #" value={deal.negocio_num} />
                <Row label="Fecha de Factura" value={deal.fecha_factura ? fmtDate(deal.fecha_factura) : '—'} />
                <Row label="Fecha de Entrega" value={deal.fecha_entrega ? fmtDate(deal.fecha_entrega) : '—'} />
                <Row label="VIN" value={deal.vin} />
              </div>
              <div>
                <Row label="Cliente" value={deal.cliente_nombre} />
                <Row label="RIF / Cédula" value={`${deal.cliente_rif_tipo || 'V'}-${deal.cliente_rif || '—'}`} />
                <Row label="Vendedor" value={deal.vendedor} />
              </div>
            </div>
          </div>

          {/* ── 2. BANCO Y TASAS ── */}
          <div style={{ marginBottom: '20px' }}>
            <SH title="2 — Banco y Tasas de Cambio" />
            <Row label="Banco / Tipo" value={deal.banco} />
            <Row label="Tasa BCV" value={deal.tasa_bcv} mono />
            <Row label="Tasa Variable" value={deal.tasa_variable} mono />
            {deal.banco === 'FINANCIAMIENTO INTERNO' && (
              <div style={{ marginTop: '8px', padding: '10px 14px', background: 'rgba(187,22,43,0.07)', border: '1px solid rgba(187,22,43,0.2)', borderRadius: '8px' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }}>Seguro 2do Año</div>
                <Row label="¿Se cobró renovación?" value={deal.seguro_2do_ano ? 'Sí' : 'No'} />
                {deal.seguro_2do_ano && <Row label="Monto cobrado" value={fmt(deal.seguro_2do_ano_monto || 0)} mono color="#2ecc8a" />}
              </div>
            )}
            {deal.banco === 'PIVCA' && (
              <div style={{ marginTop: '8px', padding: '10px 14px', background: 'rgba(74,158,255,0.07)', border: '1px solid rgba(74,158,255,0.2)', borderRadius: '8px' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, color: '#4a9eff', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }}>Comisión PIVCA</div>
                <Row label="Monto a Financiar" value={fmt(deal.pv_monto_financiar || 0)} mono />
                <Row label="Comisión Flat (Banco)" value={fmt(deal.pv_comision_banco || 0)} mono />
                <Row label="Comisión Flat (Cobrado)" value={fmt(deal.pv_comision_flat_cobrado || 0)} mono />
              </div>
            )}
          </div>

          {/* ── 3. PROYECTO VS AUDITORÍA ── */}
          <div style={{ marginBottom: '20px' }}>
            <SH title="3 — Proyecto de Venta vs. Auditoría" />
            {/* Column headers */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr', gap: '8px', padding: '4px 0 8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>Concepto</span>
              <span style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', textAlign: 'right' as const }}>Proyecto</span>
              <span style={{ fontSize: '9px', color: '#2ecc8a', textTransform: 'uppercase', letterSpacing: '1px', textAlign: 'right' as const }}>Auditoría</span>
            </div>
            <DualRow label="Precio Vehículo (IVA inc.)" pv={deal.pv_precio} au={deal.au_precio} />
            <DualRow label="Gastos Administrativos" pv={deal.pv_gastos_admin} au={deal.au_gastos_admin} />
            <DualRow label="Seguro" pv={deal.pv_seguro} au={deal.au_seguro} />
            <DualRow label="IGTF" pv={deal.pv_igtf} au={deal.au_igtf} />
            <DualRow label="Accesorios" pv={deal.pv_accesorios} au={deal.au_accesorios} />
            <DualRow label="Placas" pv={deal.pv_placas} au={deal.au_placas} />
            <DualRow label="Comisión Flat" pv={null} au={deal.au_comision_flat} />
            {igtf_recovered > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr', gap: '8px', padding: '5px 0', borderBottom: '1px solid var(--border)', alignItems: 'center', background: 'rgba(46,204,138,0.06)' }}>
                <span style={{ fontSize: '11px', color: '#2ecc8a', fontWeight: 600 }}>+ IGTF Recuperado (en factura)</span>
                <span style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-secondary)', textAlign: 'right' as const }}>—</span>
                <span style={{ fontSize: '11px', fontFamily: 'monospace', color: '#2ecc8a', fontWeight: 700, textAlign: 'right' as const }}>{fmt(igtf_recovered)}</span>
              </div>
            )}
            {/* Totals row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr', gap: '8px', padding: '8px 0 4px', borderTop: '2px solid var(--border)', marginTop: '2px' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase' as const }}>Total</span>
              <span style={{ fontSize: '12px', fontWeight: 900, fontFamily: 'monospace', color: 'var(--text-primary)', textAlign: 'right' as const }}>{fmt(pv_total)}</span>
              <span style={{ fontSize: '12px', fontWeight: 900, fontFamily: 'monospace', color: '#2ecc8a', textAlign: 'right' as const }}>{fmt(au_total)}</span>
            </div>
            {/* Estructura financiamiento */}
            {(deal.pv_inicial > 0 || deal.pv_monto_financiar > 0) && (
              <div style={{ marginTop: '12px', padding: '10px 14px', background: 'var(--bg-deep)', borderRadius: '8px' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '8px' }}>Estructura de Financiamiento</div>
                <Row label="Inicial" value={fmt(deal.pv_inicial || 0)} mono />
                <Row label="Monto a Financiar" value={fmt(deal.pv_monto_financiar || 0)} mono />
                {deal.banco !== 'PIVCA' && deal.pv_comision_banco > 0 && <Row label="Comisión Flat (Banco)" value={fmt(deal.pv_comision_banco || 0)} mono />}
                {deal.pv_comision_flat_cobrado > 0 && <Row label="Comisión Flat (Cobrado)" value={fmt(deal.pv_comision_flat_cobrado || 0)} mono />}
              </div>
            )}
          </div>

          {/* ── Documentos Escaneados ── */}
          {deal.negocio_num && <DocViewer documentosMeta={deal.documentos_meta} negocioNum={deal.negocio_num} dealId={deal.id} />}

          {/* ── 4. INGRESOS ── */}
          <div style={{ marginBottom: '20px' }}>
            <SH title={`4 — Ingresos Recibidos (${pagos.length} pagos)`} />
            {pagos.length === 0 ? (
              <div style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '12px', textAlign: 'center' }}>Sin pagos registrados</div>
            ) : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
                  {pagos.map((p: any, i: number) => (
                    <div key={i} style={{ background: 'var(--bg-deep)', borderRadius: '8px', padding: '10px 14px', border: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{p.metodo}</span>
                        <span style={{ fontSize: '14px', fontWeight: 900, color: '#2ecc8a', fontFamily: 'monospace' }}>{fmt(parseFloat(p.monto_usd) || 0)}</span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: '10px', marginBottom: (p.comprobante_imagen || p.comprobante_path || p._pago_recibido_id) ? '8px' : 0 }}>
                        <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>📅 {p.fecha ? fmtDate(p.fecha) : '—'}</span>
                        <span style={{ fontSize: '10px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{fmtBs(parseFloat(p.monto_bs) || 0)}</span>
                        {p.referencia && <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Ref: <strong>{p.referencia}</strong></span>}
                        {p.notas_ai && <span style={{ fontSize: '10px', color: '#4a9eff', fontStyle: 'italic' }}>{p.notas_ai}</span>}
                      </div>
                      {(p.comprobante_imagen || p.comprobante_path || p._pago_recibido_id) ? (
                        <ComprobanteThumb
                          pago={p}
                          dealNum={deal.negocio_num}
                          idx={i}
                          onLightbox={(url, isPdf) => {
                            // PDFs open in new tab; images go to lightbox
                            if (isPdf) window.open(url, '_blank', 'noopener,noreferrer')
                            else setLightboxImg(url)
                          }}
                        />
                      ) : METODOS_REQUIEREN_COMPROBANTE.includes(p.metodo) ? (
                        <div style={{ fontSize: '10px', color: '#b8720a' }}>⚠ Sin comprobante adjunto</div>
                      ) : null}
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: '10px', padding: '10px 16px', background: 'rgba(46,204,138,0.1)', border: '1px solid rgba(46,204,138,0.3)', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#2ecc8a' }}>Total Ingresos</span>
                  <span style={{ fontSize: '16px', fontWeight: 900, color: '#2ecc8a', fontFamily: 'monospace' }}>{fmt(total_ingresos)}</span>
                </div>
              </>
            )}
          </div>

          {/* ── 5. HISTORIAL DE APROBACIÓN ── */}
          <div style={{ marginBottom: '20px' }}>
            <SH title="5 — Historial de Aprobación" />
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
              {deal.approved_at ? (
                <div style={{ background: 'rgba(26,122,74,0.1)', border: '1px solid rgba(46,204,138,0.3)', borderRadius: '8px', padding: '10px 14px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: '#2ecc8a', marginBottom: '4px' }}>✓ Aprobado</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{fmtDateTime(deal.approved_at)}</div>
                  {deal.ajuste_cuadre ? <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '3px' }}>Ajuste de cuadre: <strong style={{ color: 'var(--text-primary)' }}>{fmt(deal.ajuste_cuadre)}</strong></div> : null}
                </div>
              ) : (
                <div style={{ padding: '10px 14px', background: 'rgba(184,114,10,0.1)', border: '1px solid rgba(184,114,10,0.3)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '11px', color: '#b8720a' }}>Pendiente de aprobación por Gerencia</div>
                </div>
              )}
              {deal.unlocked_at && (
                <div style={{ background: 'rgba(184,114,10,0.1)', border: '1px solid rgba(184,114,10,0.3)', borderRadius: '8px', padding: '10px 14px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: '#b8720a', marginBottom: '4px' }}>Desbloqueado</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>{fmtDateTime(deal.unlocked_at)}</div>
                  {deal.unlock_reason && <div style={{ fontSize: '11px', color: 'var(--text-primary)', fontStyle: 'italic' }}>"{deal.unlock_reason}"</div>}
                </div>
              )}
              {deal.nota_entrega_at && (
                <div style={{ background: 'rgba(74,158,255,0.1)', border: '1px solid rgba(74,158,255,0.3)', borderRadius: '8px', padding: '10px 14px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a9eff', marginBottom: '4px' }}>Nota de Entrega Emitida</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{fmtDateTime(deal.nota_entrega_at)}</div>
                </div>
              )}
            </div>
          </div>

          {/* ── FOOTER ── */}
          <div style={{ padding: '10px 14px', background: 'var(--bg-deep)', borderRadius: '8px', fontSize: '10px', color: 'var(--text-secondary)' }}>
            Creado el {fmtDateTime(deal.created_at)} · ID: {deal.id}
          </div>

        </div>
      </div>
    </>
  )
}

// ── UNLOCK MODAL ──────────────────────────────────────────────────────────────
function UnlockModal({ deal, onConfirm, onCancel }: { deal: any, onConfirm: (reason: string) => void, onCancel: () => void }) {
  const [reason, setReason] = useState('')
  const [step, setStep] = useState<'input' | 'confirm'>('input')

  if (step === 'confirm') return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid rgba(184,114,10,0.4)', borderRadius: '16px', padding: '32px', maxWidth: '480px', width: '100%' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: '#b8720a', marginBottom: '20px', textAlign: 'center' }}>Confirmar Desbloqueo</div>
        <div style={{ background: 'var(--bg-deep)', borderRadius: '10px', padding: '16px', marginBottom: '16px' }}>
          {[{ label: 'Negocio #', value: deal.negocio_num }, { label: 'Cliente', value: deal.cliente_nombre + ((deal as any).cliente_apellidos ? ' ' + (deal as any).cliente_apellidos : '') }, { label: 'Banco', value: deal.banco }, { label: 'Audit Total', value: fmt(deal.total_cliente || 0) }].map(f => (
            <div key={f.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{f.label}</span>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{f.value}</span>
            </div>
          ))}
          <div style={{ padding: '10px 0 0' }}>
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Motivo</div>
            <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontStyle: 'italic' }}>"{reason}"</div>
          </div>
        </div>
        <div style={{ fontSize: '11px', color: '#b8720a', background: 'rgba(184,114,10,0.1)', border: '1px solid rgba(184,114,10,0.3)', borderRadius: '8px', padding: '10px 14px', marginBottom: '20px' }}>
          El negocio volverá a estado BORRADOR y podrá ser editado nuevamente. Deberá ser re-aprobado por Gerencia.
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={() => setStep('input')} style={{ ...s.btnGray, flex: 1 }}>← Volver</button>
          <button onClick={() => onConfirm(reason)} style={{ padding: '10px 24px', background: '#b8720a', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', flex: 1 }}>Desbloquear</button>
        </div>
      </div>
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '32px', maxWidth: '480px', width: '100%' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Desbloquear Negocio #{deal.negocio_num}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '24px' }}>{deal.cliente_nombre}{(deal as any).cliente_apellidos ? " " + (deal as any).cliente_apellidos : ""} · {deal.banco}</div>
        <div style={{ marginBottom: '20px' }}>
          <label style={s.label}>Motivo del Desbloqueo *</label>
          <textarea style={s.textarea} value={reason} onChange={e => setReason(e.target.value)} placeholder="Describa el motivo por el que se desbloquea este negocio aprobado..." />
          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '6px' }}>Este motivo quedará registrado en el historial del negocio. Mínimo 5 caracteres.</div>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={onCancel} style={{ ...s.btnGray, flex: 1 }}>Cancelar</button>
          <button onClick={() => { if (reason.trim().length < 5) { alert('Por favor ingrese un motivo más detallado.'); return } setStep('confirm') }} style={{ padding: '10px 24px', background: '#b8720a', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', flex: 1 }}>Continuar →</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// ApprovalModal v2 (2026-05-15) — Bank reconciliation gate.
//
// Every pago in the deal must be ✓ verified against bank_transactions before
// "Aprobar definitivamente" enables. Three paths for Mirla:
//
//   1. NORMAL: pagos already verified by /scan + autoMatch in /banco.
//      Modal shows green ✓ on each, Aprobar enables, click → done.
//
//   2. QUICK RECON: pagos not yet verified, but customer is here waiting for
//      delivery. Click "📤 Subir estado de cuenta" inside the modal,
//      AI parses → autoMatch fires → modal refreshes → pagos turn green.
//      Total time: ~30 seconds.
//
//   3. EMERGENCY OVERRIDE: bank statement unavailable, deal must ship NOW.
//      Click "🔓 Aprobar sin verificación", type reason, confirm.
//      Reason stored on the deal record permanently for audit.
//
// "Cancelar" and "Cerrar" both close without changes.
// ═══════════════════════════════════════════════════════════════════════════
function ApprovalModal({ deal, onConfirm, onOverride, onCancel, onPagosRefreshed }: {
  deal: any,
  onConfirm: (ajuste: number) => void,
  onOverride: (ajuste: number, reason: string) => void,
  onCancel: () => void,
  onPagosRefreshed: (freshDeal: any) => void,
}) {
  const [ajuste, setAjuste] = useState('')
  const [step, setStep] = useState<'input' | 'confirm' | 'override'>('input')
  const [overrideReason, setOverrideReason] = useState('')
  const [uploadingStatement, setUploadingStatement] = useState(false)
  const [reconStatus, setReconStatus] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Crédito interno: aviso al aprobar + estado del préstamo vinculado en Portal
  // (cobranza_contratos.deal_id). Si la lectura falla, el banner degrada a solo-informativo.
  const esCreditoInterno = deal.banco === 'FINANCIAMIENTO INTERNO'
  const [prestamoLink, setPrestamoLink] = useState<{ id: string, nro_cuotas: number, monto_cuota: number, status: string } | null>(null)
  const [prestamoChecked, setPrestamoChecked] = useState(false)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await supabase
          .from('cobranza_contratos')
          .select('id, nro_cuotas, monto_cuota, status')
          .eq('deal_id', deal.id)
          .limit(1)
        if (!cancelled) setPrestamoLink(data && data.length > 0 ? (data[0] as any) : null)
      } catch { /* sin acceso o error: banner muestra solo el aviso */ }
      if (!cancelled) setPrestamoChecked(true)
    })()
    return () => { cancelled = true }
  }, [deal.id])

  // Pagos that need bank verification (excludes Bolívar/Retención/Saldo a Financiar
  // since those don't appear on USD bank statements). Internal cash methods like
  // "Efectivo Caja" also don't need bank match — handled by Tesorería QR instead.
  const NEEDS_BANK_MATCH = ['Zelle Roframi', 'Zelle Motocentro', 'Zelle Externo',
                             'Wire Transfer Roframi', 'Wire Transfer Motocentro',
                             'Wire Transfer Panama']
  const allPagos: any[] = Array.isArray(deal.pagos) ? deal.pagos : []
  const pagosThatNeedMatch = allPagos.filter(p => NEEDS_BANK_MATCH.includes(p?.metodo))
  // Pagos ingresados a mano desde Auditoria (sin origen de tesoreria ni comprobante).
  const manualPagos: any[] = allPagos.filter((p: any) => p && (p._manual === true || (!p._from_saldo && !p._pago_recibido_id && !p._imageHash && !p._imageFilename && !p._inicial_diferida && !p._pendiente)))
  const unverifiedPagos = pagosThatNeedMatch.filter(p => !p._verified_by_bank)
  const verifiedCount = pagosThatNeedMatch.length - unverifiedPagos.length
  const allVerified = unverifiedPagos.length === 0

  const total_ingresos = allPagos.reduce((sum: number, p: any) => sum + (parseFloat(p.monto_usd) || 0), 0)
  const neto = (deal.total_cliente || 0) - total_ingresos
  const ajusteNum = parseFloat(ajuste) || 0
  const finalBalance = neto - ajusteNum

  // ──────────────────────────────────────────────────────────────────────────
  // Quick recon: parse a bank statement inside the modal and autoMatch.
  // Uses the same AI worker + classifyMatch logic as /scan and /banco — just
  // doesn't navigate away. Refreshes the deal from DB after match runs so the
  // modal's verification badges update in real time.
  // ──────────────────────────────────────────────────────────────────────────
  const handleQuickRecon = async (file: File) => {
    setUploadingStatement(true)
    setReconStatus('Leyendo estado de cuenta con IA...')
    try {
      // ── 1. Read file as base64 ──
      const base64 = await new Promise<string>((res, rej) => {
        const r = new FileReader()
        r.onload = ev => res((ev.target?.result as string).split(',')[1])
        r.onerror = rej
        r.readAsDataURL(file)
      })
      const isPdf = file.type === 'application/pdf' || file.name.endsWith('.pdf')
      const contentBlock = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
        : { type: 'image', source: { type: 'base64', media_type: file.type || 'image/jpeg', data: base64 } }

      // ── 2. Call worker — same prompt as /scan/page.tsx, kept compact here ──
      const res = await fetch('https://autocore-comprobante.sano-franco.workers.dev', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 8000,
          messages: [{
            role: 'user',
            content: [contentBlock, {
              type: 'text',
              text: `Bank statement parser. Return JSON array of transactions. Schema:
{"fecha":"YYYY-MM-DD","monto_usd":number,"monto_bs":number|null,"sender_name":"string","referencia":"string (Conf# or SNDR REF)","referencia_alt":"string|null (bank TRN)","tipo":"zelle|wire|ach|deposit|transfer_out|card_charge|bank_fee|other","descripcion":"string","payment_memo":"string|null","flujo":"ingreso|egreso","is_internal":bool,"is_bank_fee":bool,"categoria_gasto":"string|null","proveedor":"string|null"}
Rules: VELROD/VELASQUEZ/YARI/OLMOS/MEDROD/ZAMBRANO/SOLARTE/MATERIALES SORRENTO/ROFRAMI/MOTOCENTRO/LACE INVESTMENTS → is_internal=true. Wire fees, COMI, ITBMS commission → is_bank_fee=true. VENEKIA → categoria_gasto="KIA Distribuciones". For Zelle, referencia=Conf# only. For Wire IN, referencia=SNDR REF, referencia_alt=TRN. Amounts positive; sign in flujo. Only JSON array.`
            }]
          }]
        })
      })
      const data = await res.json()
      if (data.stop_reason === 'max_tokens') throw new Error('Estado de cuenta muy largo. Divide en archivos más pequeños.')
      if (data.error || data.type === 'error') throw new Error('IA no pudo leer: ' + (data.error?.message || 'error'))
      const text = (data.content?.[0]?.text || '[]').replace(/```json|```/g, '').trim()
      const txs: any[] = JSON.parse(text)

      setReconStatus(`IA extrajo ${txs.length} transacciones. Guardando...`)

      // ── 3. Insert into bank_transactions, skipping duplicates ──
      // We need the cuenta: pick based on deal's payment methods. For simplicity,
      // use 'motocentro' if any Zelle/Wire Motocentro pago, else 'roframi', else 'motocentro'.
      const hasMotoPago = pagosThatNeedMatch.some(p => /Motocentro/.test(p.metodo))
      const cuenta = hasMotoPago ? 'motocentro' : 'roframi'

      const matchable = txs.filter(t => !t.is_internal && !t.is_bank_fee && t.flujo === 'ingreso')
      if (matchable.length === 0) {
        setReconStatus('No se encontraron ingresos en este estado de cuenta.')
        setUploadingStatement(false)
        return
      }

      const { data: userRes } = await supabase.auth.getUser()
      const inputs = matchable.map(tx => ({
        cuenta, fecha: tx.fecha, monto_usd: tx.monto_usd, monto_bs: tx.monto_bs,
        sender_name: tx.sender_name, referencia: tx.referencia, referencia_alt: tx.referencia_alt,
        tipo: tx.tipo || 'other', descripcion: tx.descripcion, payment_memo: tx.payment_memo,
        raw_text: JSON.stringify(tx), flujo: 'ingreso' as const,
        is_third_party: false, is_internal: false, is_bank_fee: false,
        source: 'admin_quick_recon', uploaded_by: userRes.user?.id ?? null,
      }))

      // Cross-source upsert: statement rows merge into existing email/screenshot
      // rows by (cuenta, referencia) or (cuenta, fecha, monto, sender).
      const batch = await upsertBankTxBatch(inputs, 'statement')
      if (batch.errors > 0) {
        console.error('[admin quick-recon] upsert errors:', batch.errorDetails)
        throw new Error('Error al guardar: ' + (batch.errorDetails[0] || 'desconocido'))
      }

      setReconStatus(`Buscando coincidencias con los ${pagosThatNeedMatch.length} pagos del negocio...`)

      // ── 4. Run autoMatch ONLY for this deal's pagos ──
      // Pull all unmatched bank_transactions for the cuenta, classify against
      // this deal's pagos, mark verified.
      const { data: bankTxs } = await supabase.from('bank_transactions')
        .select('*').eq('cuenta', cuenta).eq('matched', false).eq('is_internal', false).eq('is_bank_fee', false)
      let verified = 0
      const updatedPagos = [...allPagos]
      for (const tx of (bankTxs || [])) {
        for (let i = 0; i < updatedPagos.length; i++) {
          const p = updatedPagos[i]
          if (!NEEDS_BANK_MATCH.includes(p?.metodo) || p._verified_by_bank) continue
          const strength = classifyMatchLocal(tx, p)
          if (strength !== 'exact' && strength !== 'strong') continue
          // names match check
          const senderOK = namesMatchLocal(tx.sender_name || '', deal.cliente_nombre || '', deal.cliente_apellidos || '')
          if (!senderOK && strength !== 'exact') continue  // require sender for 'strong' but not 'exact'

          updatedPagos[i] = { ...p, _verified_by_bank: true, _verified_at: new Date().toISOString(), _bank_tx_id: tx.id, _match_strength: strength }
          await supabase.from('bank_transactions')
            .update({ deal_id: deal.id, matched: true, ingreso_confirmed: true })
            .eq('id', tx.id)
          verified++
          break
        }
      }

      if (verified > 0) {
        const { error: dealErr } = await supabase.from('deals')
          .update({ pagos: updatedPagos })
          .eq('id', deal.id)
        if (dealErr) throw new Error('Error al actualizar deal: ' + dealErr.message)

        // Refetch the deal to give the parent fresh data
        const { data: fresh } = await supabase.from('deals').select('*').eq('id', deal.id).single()
        if (fresh) onPagosRefreshed(fresh)
        setReconStatus(`✓ ${verified} pago${verified === 1 ? '' : 's'} verificado${verified === 1 ? '' : 's'} contra el banco.`)
      } else {
        setReconStatus(`⚠ No se encontraron coincidencias. Revisa /banco para conciliar manualmente, o usa la opción de override.`)
      }
    } catch (e: any) {
      setReconStatus('Error: ' + (e?.message || e))
    } finally {
      setUploadingStatement(false)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step: override (reason input)
  // ──────────────────────────────────────────────────────────────────────────
  if (step === 'override') return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '32px', maxWidth: '520px', width: '100%' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#b8720a', marginBottom: 10 }}>⚠ Aprobación SIN verificación bancaria</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.5 }}>
          Vas a aprobar este negocio sin que sus pagos hayan sido conciliados contra el estado de cuenta del banco.
          Esto queda registrado permanentemente en el negocio. Solo úsalo para emergencias de entrega.
        </div>
        <div style={{ background: 'rgba(184,114,10,0.08)', border: '1px solid rgba(184,114,10,0.3)', borderRadius: 8, padding: 12, marginBottom: 18, fontSize: 11, color: '#b8720a', lineHeight: 1.5 }}>
          <strong>{unverifiedPagos.length} pago{unverifiedPagos.length === 1 ? '' : 's'} sin verificar:</strong>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {unverifiedPagos.map((p: any, i: number) => (
              <li key={i}>{p.metodo} · {fmt(parseFloat(p.monto_usd) || 0)} {p.referencia ? `· Ref. ${p.referencia}` : ''}</li>
            ))}
          </ul>
        </div>
        <label style={s.label}>Razón de la aprobación sin verificación (obligatorio)</label>
        <textarea
          value={overrideReason}
          onChange={e => setOverrideReason(e.target.value)}
          rows={3}
          placeholder="Ej: Cliente esperando entrega del Sportage, banco aún no genera estado de cuenta de hoy. Verificación pendiente para conciliación posterior."
          style={{ ...s.input, fontFamily: 'inherit', resize: 'vertical', marginBottom: 18 }}
        />
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={() => setStep('input')} style={{ ...s.btnGray, flex: 1 }}>← Volver</button>
          <button
            onClick={() => onOverride(ajusteNum, overrideReason.trim())}
            disabled={overrideReason.trim().length < 15}
            style={{ ...s.btnRed, flex: 1, opacity: overrideReason.trim().length < 15 ? 0.5 : 1, cursor: overrideReason.trim().length < 15 ? 'not-allowed' : 'pointer' }}>
            🔓 Aprobar con override
          </button>
        </div>
        {overrideReason.trim().length < 15 && (
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 8, textAlign: 'center' }}>
            La razón debe tener al menos 15 caracteres
          </div>
        )}
      </div>
    </div>
  )

  // ──────────────────────────────────────────────────────────────────────────
  // Step: confirm
  // ──────────────────────────────────────────────────────────────────────────
  if (step === 'confirm') return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '32px', maxWidth: '520px', width: '100%' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '20px', textAlign: 'center' }}>Confirmar Aprobación</div>
        <div style={{ background: 'var(--bg-deep)', borderRadius: '10px', padding: '16px', marginBottom: '20px' }}>
          {[{ label: 'Negocio #', value: deal.negocio_num }, { label: 'Cliente', value: deal.cliente_nombre + ((deal as any).cliente_apellidos ? ' ' + (deal as any).cliente_apellidos : '') }, { label: 'Banco', value: deal.banco }, { label: 'Audit Total', value: fmt(deal.total_cliente || 0) }, { label: 'Total Ingresos', value: fmt(total_ingresos) }, { label: 'Resultado', value: deal.resultado_tipo || '—' }, { label: 'Ajuste de Cuadre', value: fmt(ajusteNum) }, { label: 'Balance Final', value: fmt(Math.abs(finalBalance)) }].map(f => (
            <div key={f.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{f.label}</span>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{f.value}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Verificación bancaria</span>
            <span style={{ fontSize: '12px', fontWeight: 700, color: '#2ecc8a' }}>✓ {verifiedCount}/{pagosThatNeedMatch.length} pagos verificados</span>
          </div>
        </div>
        <div style={{ fontSize: '11px', color: '#b8720a', background: 'rgba(184,114,10,0.1)', border: '1px solid rgba(184,114,10,0.3)', borderRadius: '8px', padding: '10px 14px', marginBottom: '20px' }}>Una vez aprobado, el negocio quedará bloqueado y no podrá ser modificado.</div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={() => setStep('input')} style={{ ...s.btnGray, flex: 1 }}>← Volver</button>
          <button onClick={() => onConfirm(ajusteNum)} style={{ ...s.btnGreen, flex: 1 }}>Aprobar definitivamente</button>
        </div>
      </div>
    </div>
  )

  // ──────────────────────────────────────────────────────────────────────────
  // Step: input (main view with reconciliation gate)
  // ──────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '32px', maxWidth: '560px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Aprobar Negocio #{deal.negocio_num}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '20px' }}>{deal.cliente_nombre}{(deal as any).cliente_apellidos ? " " + (deal as any).cliente_apellidos : ""} · {deal.banco}</div>

        {(esCreditoInterno || prestamoLink) && (
          <div style={{ background: 'rgba(46,204,138,0.08)', border: '1px solid rgba(46,204,138,0.35)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#2ecc8a', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 }}>
              Crédito interno
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {prestamoLink ? (
                <>Este negocio tiene un préstamo vinculado en Portal: <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{prestamoLink.nro_cuotas} cuotas de {fmt(prestamoLink.monto_cuota || 0)}</span> · estado <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{prestamoLink.status || '—'}</span>.</>
              ) : prestamoChecked ? (
                <>Este negocio es <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>financiamiento interno</span> y aún no tiene un préstamo vinculado en Portal. Crea el préstamo en Portal usando “Importar desde NPA” con el N° {deal.negocio_num}.</>
              ) : (
                <>Este negocio es financiamiento interno. Verificando préstamo en Portal...</>
              )}
            </div>
          </div>
        )}

        {manualPagos.length > 0 && (
          <div style={{ background: 'rgba(187,22,43,0.08)', border: '1px solid rgba(187,22,43,0.35)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 8 }}>
              ⚠ {manualPagos.length} pago{manualPagos.length === 1 ? '' : 's'} agregado{manualPagos.length === 1 ? '' : 's'} manualmente desde Auditoría
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
              Estos pagos se ingresaron a mano (sin comprobante ni origen de tesorería). Revísalos antes de aprobar.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {manualPagos.map((p: any, i: number) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.15)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-primary)' }}>
                    {p.metodo || '—'} · {fmt(parseFloat(p.monto_usd) || 0)}
                    {p.referencia && <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', marginLeft: 6 }}>{p.referencia}</span>}
                    {p.fecha && <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>· {p.fecha}</span>}
                  </div>
                  {p._manual_by && <span style={{ fontSize: 10, color: '#b8720a', fontWeight: 700 }}>{String(p._manual_by).split('@')[0]}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Reconciliation panel */}
        <div style={{ background: allVerified ? 'rgba(46,204,138,0.08)' : 'rgba(184,114,10,0.08)', border: `1px solid ${allVerified ? 'rgba(46,204,138,0.3)' : 'rgba(184,114,10,0.3)'}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: allVerified ? '#2ecc8a' : '#b8720a', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 10 }}>
            Conciliación Bancaria — {verifiedCount}/{pagosThatNeedMatch.length} {allVerified ? '✓' : 'pendientes'}
          </div>
          {pagosThatNeedMatch.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              Este negocio no tiene pagos que requieran verificación bancaria.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pagosThatNeedMatch.map((p: any, i: number) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', borderRadius: 6, background: p._verified_by_bank ? 'rgba(46,204,138,0.1)' : 'rgba(0,0,0,0.15)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-primary)' }}>
                    <span style={{ marginRight: 6 }}>{p._verified_by_bank ? '✓' : '○'}</span>
                    {p.metodo} · {fmt(parseFloat(p.monto_usd) || 0)}
                    {p.referencia && <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', marginLeft: 6 }}>{p.referencia}</span>}
                  </div>
                  <span style={{ fontSize: 10, color: p._verified_by_bank ? '#2ecc8a' : '#b8720a', fontWeight: 700 }}>
                    {p._verified_by_bank ? (p._match_strength === 'exact' ? 'Exacto' : 'Verificado') : 'Sin verificar'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {!allVerified && (
            <div style={{ marginTop: 12 }}>
              <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleQuickRecon(f) }} />
              <button onClick={() => fileRef.current?.click()} disabled={uploadingStatement}
                style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid #3B82F6', background: 'rgba(59,130,246,0.1)', color: '#60A5FA', fontSize: 12, fontWeight: 700, cursor: uploadingStatement ? 'wait' : 'pointer' }}>
                {uploadingStatement ? '⏳ Procesando...' : '📤 Subir estado de cuenta y reconciliar'}
              </button>
              {reconStatus && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center', padding: '6px 8px', background: 'rgba(0,0,0,0.2)', borderRadius: 6 }}>
                  {reconStatus}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Audit totals */}
        <div style={{ background: 'var(--bg-deep)', borderRadius: '10px', padding: '16px', marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}><span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Audit Total</span><span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{fmt(deal.total_cliente || 0)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}><span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Total Ingresos</span><span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{fmt(total_ingresos)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '8px', borderTop: '1px solid var(--border)' }}><span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>Diferencia</span><span style={{ fontSize: '14px', fontWeight: 900, fontFamily: 'monospace', color: Math.abs(neto) <= 0.05 ? '#2ecc8a' : neto > 0 ? '#BB162B' : '#b8720a' }}>{fmt(Math.abs(neto))}</span></div>
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={s.label}>Ajuste de Cuadre (USD)</label>
          <input type="number" style={s.input} value={ajuste} onChange={e => setAjuste(e.target.value)} placeholder="0.00" step="0.01" />
          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '6px' }}>Ingrese el monto que ajusta el negocio para su aprobación</div>
        </div>

        <div style={{ display: 'flex', gap: '12px', marginBottom: 10 }}>
          <button onClick={onCancel} style={{ ...s.btnGray, flex: 1 }}>Cancelar</button>
          <button
            onClick={() => setStep('confirm')}
            disabled={!allVerified}
            style={{ ...s.btnRed, flex: 1, opacity: allVerified ? 1 : 0.4, cursor: allVerified ? 'pointer' : 'not-allowed' }}>
            {allVerified ? 'Aprobar →' : `🔒 Aprobar (${unverifiedPagos.length} sin verificar)`}
          </button>
        </div>

        {!allVerified && (
          <button onClick={() => setStep('override')}
            style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(184,114,10,0.5)', background: 'transparent', color: '#b8720a', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
            🔓 Aprobar sin verificación (emergencia de entrega)
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Match classification helpers (local copies, same logic as /banco) ────
// Phase 4 (2026-05-15): Levenshtein-based reference similarity matches the
// Balanced preset in /banco. Keep both files in lockstep.
const normalizeRefLocal = (r: string | null | undefined): string => {
  if (!r) return ''
  return r.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+/, '')
}
const levenshteinLocal = (a: string, b: string): number => {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array(n + 1).fill(0).map((_, i) => i)
  let curr = new Array(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}
const refSimilarityLocal = (a: string | null | undefined, b: string | null | undefined): number => {
  const na = normalizeRefLocal(a), nb = normalizeRefLocal(b)
  if (!na || !nb) return 0
  if (na === nb) return 1.0
  const shorter = na.length <= nb.length ? na : nb
  const longer  = na.length <= nb.length ? nb : na
  if (shorter.length >= 6 && longer.includes(shorter)) {
    return Math.max(0.80, shorter.length / longer.length)
  }
  const dist = levenshteinLocal(na, nb)
  const maxLen = Math.max(na.length, nb.length)
  return Math.max(0, 1 - dist / maxLen)
}
// Kept for backwards compat with any UI showing "X chars" (admin doesn't currently).
const refOverlapLocal = (a: string | null | undefined, b: string | null | undefined, _minLen = 6): number => {
  const na = normalizeRefLocal(a), nb = normalizeRefLocal(b)
  if (!na || !nb) return 0
  const sim = refSimilarityLocal(a, b)
  if (sim < 0.50) return 0
  return Math.round(sim * Math.min(na.length, nb.length))
}
const amountsMatchLocal = (txUsd: number | null, txBs: number | null, tipo: string, pUsd: number, pBs: number): boolean => {
  const isUsd = tipo === 'zelle' || tipo === 'wire'
  if (isUsd && txUsd != null) return Math.abs(txUsd - pUsd) <= 0.5
  if (txBs != null) { const tol = Math.max(1, pBs * 0.01); return Math.abs(txBs - pBs) <= tol }
  if (txUsd != null) return Math.abs(txUsd - pUsd) <= 0.5
  return false
}
const datesMatchLocal = (a: string | null | undefined, b: string | null | undefined, max = 2): boolean => {
  if (!a || !b) return false
  const parse = (s: string) => { const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`) : null }
  const da = parse(a), db = parse(b)
  if (!da || !db) return false
  return Math.abs((da.getTime() - db.getTime()) / 86400000) <= max
}
// Balanced thresholds — see /banco/page.tsx for full rationale.
//   exact   ≥ 0.90 + amount + date ±0  (or normalized identical)
//   strong  ≥ 0.70 + amount + date ±2
//   partial ≥ 0.60 + amount + date ±5  (NOT auto-applied by quick-recon; surfaces in /banco Sugerencias)
const classifyMatchLocal = (tx: any, p: any): 'exact' | 'strong' | 'partial' | 'none' => {
  const sim = Math.max(refSimilarityLocal(tx.referencia, p.referencia), refSimilarityLocal(tx.referencia_alt, p.referencia))
  if (sim === 0) return 'none'
  const amtOk = amountsMatchLocal(tx.monto_usd, tx.monto_bs, tx.tipo, parseFloat(p.monto_usd) || 0, parseFloat(p.monto_bs) || 0)
  const date0 = datesMatchLocal(tx.fecha, p.fecha, 0)
  const date2 = datesMatchLocal(tx.fecha, p.fecha, 2)
  const date5 = datesMatchLocal(tx.fecha, p.fecha, 5)
  if (sim >= 0.99) return 'exact'
  if (sim >= 0.90 && amtOk && date0) return 'exact'
  if (sim >= 0.70 && amtOk && date2) return 'strong'
  if (sim >= 0.60 && amtOk && date5) return 'partial'
  if (sim >= 0.40 && amtOk && date0) return 'partial'
  return 'none'
}
const namesMatchLocal = (sender: string, nombre: string, apellidos: string): boolean => {
  if (!sender) return false
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
  const sw = norm(sender).split(/\s+/).filter(w => w.length > 2)
  const bw = norm(`${nombre} ${apellidos}`).split(/\s+/).filter(w => w.length > 2)
  return sw.filter(s => bw.some(b => b === s || b.startsWith(s) || s.startsWith(b))).length >= 2
}

// Un solo matiz para magnitud (barras): el color no codifica identidad aquí,
// la etiqueta lo hace — nada de arcoíris por fila.
const CHART_ACCENT = '#1B6EC2'

function SimpleBar({ label, value, max, total }: { label: string, value: number, max: number, total?: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0
  const share = total && total > 0 ? Math.round((value / total) * 100) : null
  return (
    <div style={{ marginBottom: '14px' }} title={`${label}: ${fmt(value)}${share !== null ? ` · ${share}% del total` : ''}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '5px', gap: '8px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexShrink: 0 }}>
          <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(value)}</span>
          {share !== null && <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', width: '34px', textAlign: 'right' }}>{share}%</span>}
        </span>
      </div>
      <div style={{ height: '8px', background: 'var(--bg-deep)', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: CHART_ACCENT, borderRadius: '0 4px 4px 0', transition: 'width 0.6s ease' }} />
      </div>
    </div>
  )
}

function DonutChart({ data }: { data: { label: string, value: number, color: string }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (total === 0) return <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '20px', fontSize: '12px' }}>Sin datos</div>
  // Anillo (stroke) con separación de 2.5px entre segmentos y total como
  // número héroe en el centro. El SVG va rotado -90°; el centro es HTML
  // superpuesto para que el texto no rote.
  const size = 172, cx = size / 2, cy = size / 2, r = 66, strokeW = 22
  const C = 2 * Math.PI * r
  const nonZero = data.filter(d => d.value > 0)
  const gapPx = nonZero.length > 1 ? 2.5 : 0
  let acc = 0
  const segs = nonZero.map(d => {
    const frac = d.value / total
    const seg = { ...d, frac, len: Math.max(frac * C - gapPx, 1), offset: acc }
    acc += frac * C
    return seg
  })
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '28px', flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--bg-deep)" strokeWidth={strokeW} />
          {segs.map(sg => (
            <circle
              key={sg.label} cx={cx} cy={cy} r={r} fill="none" stroke={sg.color} strokeWidth={strokeW}
              strokeDasharray={`${sg.len} ${C - sg.len}`} strokeDashoffset={-(sg.offset + gapPx / 2)}
            >
              <title>{`${sg.label}: ${sg.value} (${Math.round(sg.frac * 100)}%)`}</title>
            </circle>
          ))}
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: '30px', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{total}</div>
          <div style={{ fontSize: '9.5px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1.5px', marginTop: '5px' }}>negocios</div>
        </div>
      </div>
      <div style={{ flex: 1, minWidth: '190px' }}>
        {data.map((d, i) => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: i < data.length - 1 ? '1px solid var(--border)' : 'none' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: d.color, flexShrink: 0 }} />
            <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)', flex: 1 }}>{d.label}</span>
            <span style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{d.value}</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', width: '40px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(100 * d.value / total)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── CLICKABLE ROW HELPER ──────────────────────────────────────────────────────
function ClickableRow({ d, onOpen, children }: { d: any, onOpen: (d: any) => void, children: React.ReactNode }) {
  return (
    <tr
      onClick={() => onOpen(d)}
      style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.15s' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(187,22,43,0.04)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </tr>
  )
}

// ── MAIN PAGE ─────────────────────────────────────────────────────────────────
function AdminInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { permissions, loading: permsLoading } = useNPAPermissions()
  const [user, setUser] = useState<any>(null)
  const [userRole, setUserRole] = useState<string>('')
  const [deals, setDeals] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [approvingDeal, setApprovingDeal] = useState<any>(null)
  const [unlockingDeal, setUnlockingDeal] = useState<any>(null)
  const [showNota, setShowNota] = useState<any>(null)
  const [approving, setApproving] = useState(false)
  const [panelDeal, setPanelDeal] = useState<any>(null)
  const [diferidas, setDiferidas] = useState<any[]>([])

  useEffect(() => {
    if (!permsLoading && !permissions.npa_can_approve_deals && !permissions.npa_can_admin) {
      router.replace('/dashboard')
    }
  }, [permsLoading, permissions, router])

  useEffect(() => {
    const init = async () => {
      const { data: authData } = await supabase.auth.getUser()
      if (!authData.user) { router.push('/'); return }
      setUser(authData.user)
      const { data: roleData } = await supabase.from('user_roles').select('role').eq('user_id', authData.user.id).single()
      const role = roleData?.role || ''
      setUserRole(role)
      if (role === 'admin' || role === 'manager') {
        const { data } = await supabase.from('deals').select('*').order('created_at', { ascending: false })
        const allDeals = data || []
        setDeals(allDeals)
        const { data: difs } = await supabase
          .from('compromisos_inicial_diferida')
          .select('*')
          .eq('estado', 'PENDIENTE')
          .order('fecha_vencimiento', { ascending: true })
        setDiferidas(difs || [])
        // Handle ?open_deal=ID from global search click
        const openId = searchParams?.get('open_deal')
        if (openId) {
          const target = allDeals.find((d: any) => String(d.id) === openId)
          if (target) {
            setPanelDeal(target)
            // Clean URL without reload
            window.history.replaceState({}, '', '/admin')
          }
        }
      }
      setLoading(false)
    }
    init()
  }, [])

  // ═══════════════════════════════════════════════════════════════════════════
  // ★ FIX: Supabase Realtime subscription
  // When Deisi saves a deal (or Mirla approves elsewhere), the row is updated
  // in the DB. This subscription keeps the admin list in sync live, so Mirla
  // never sees stale data on her screen. Without this, she'd have to refresh
  // the page to see changes from other users — exactly the scenario that led
  // to deal #55890 getting approved based on stale numbers.
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!userRole) return
    if (userRole !== 'admin' && userRole !== 'manager') return

    const channel = supabase
      .channel('admin-deals-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'deals' },
        (payload: any) => {
          if (payload.eventType === 'INSERT' && payload.new) {
            setDeals(prev => {
              // Avoid duplicates if this client made the insert itself
              if (prev.some(d => d.id === payload.new.id)) return prev
              return [payload.new, ...prev]
            })
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            setDeals(prev => prev.map(d => d.id === payload.new.id ? { ...d, ...payload.new } : d))
            // Also update the open slide panel if it's showing this deal
            setPanelDeal((p: any) => (p && p.id === payload.new.id ? { ...p, ...payload.new } : p))
          } else if (payload.eventType === 'DELETE' && payload.old) {
            setDeals(prev => prev.filter(d => d.id !== payload.old.id))
            setPanelDeal((p: any) => (p && p.id === payload.old.id ? null : p))
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userRole])

  const logAction = async (action: string, targetType: string, targetId: string, details: any) => {
    if (!user) return
    await supabase.from('activity_log').insert({
      user_id: user.id, user_email: user.email,
      action, target_type: targetType, target_id: String(targetId), details,
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ★ FIX: Hardened approve
  // 1. Fresh DB read before approving — if someone else already approved this
  //    deal (or the deal data changed significantly), don't silently overwrite.
  // 2. Idempotent UPDATE with .eq('status', 'BORRADOR') filter — the UPDATE
  //    only fires if the row is still in BORRADOR state. This is atomic at the
  //    database level, so even concurrent clicks can't both approve.
  // 3. Clear user feedback on edge cases.
  // ═══════════════════════════════════════════════════════════════════════════
  const handleApprove = async (ajuste: number, overrideReason: string | null = null) => {
    if (!approvingDeal) return
    if (!user) { alert('Sesión no iniciada. Recarga la página.'); return }
    setApproving(true)

    // 1. Fresh read to detect concurrent state changes
    const { data: current, error: readErr } = await supabase
      .from('deals')
      .select('id, status, approved_at, approved_by, pagos, total_cliente, total_recibido, resultado_tipo')
      .eq('id', approvingDeal.id)
      .single()

    if (readErr) {
      alert('No se pudo verificar el estado actual del negocio. Intenta de nuevo.')
      setApproving(false)
      return
    }

    if (current?.status === 'APROBADO') {
      alert(
        `Este negocio ya fue APROBADO.\n\n` +
        `Fecha de aprobación: ${current.approved_at ? new Date(current.approved_at).toLocaleString('es-VE') : '—'}\n\n` +
        `La pantalla se actualizará con el estado real.`
      )
      setDeals(ds => ds.map(d => d.id === current.id ? { ...d, ...current } : d))
      setApprovingDeal(null)
      setApproving(false)
      return
    }

    // ── Re-check bank verification on FRESH pagos (not stale modal state) ──
    // If a pago lost _verified_by_bank between modal load and approval click
    // (e.g. Mirla in another tab reverted a match), prevent silent failure.
    const NEEDS_MATCH = ['Zelle Roframi', 'Zelle Motocentro', 'Zelle Externo', 'Wire Transfer Roframi', 'Wire Transfer Motocentro', 'Wire Transfer Panama']
    const freshPagos = Array.isArray(current.pagos) ? current.pagos : []
    const freshNeedMatch = freshPagos.filter((p: any) => NEEDS_MATCH.includes(p?.metodo))
    const freshUnverified = freshNeedMatch.filter((p: any) => !p._verified_by_bank)
    if (freshUnverified.length > 0 && !overrideReason) {
      alert(
        `${freshUnverified.length} pago(s) ya no están verificados en la base de datos. ` +
        `La pantalla se actualizará. Vuelve a abrir la aprobación.`
      )
      setDeals(ds => ds.map(d => d.id === current.id ? { ...d, ...current } : d))
      setApprovingDeal(null)
      setApproving(false)
      return
    }

    // Warn (don't block) if the fresh pagos/totals differ from what was shown in the modal
    const staleTotalIngresos = (approvingDeal.pagos || []).reduce((s: number, p: any) => s + (parseFloat(p.monto_usd) || 0), 0)
    const freshTotalIngresos = freshPagos.reduce((s: number, p: any) => s + (parseFloat(p.monto_usd) || 0), 0)
    if (Math.abs(freshTotalIngresos - staleTotalIngresos) > 0.01) {
      const proceed = window.confirm(
        `Los totales del negocio cambiaron mientras revisabas:\n\n` +
        `Total Ingresos que viste: ${fmt(staleTotalIngresos)}\n` +
        `Total Ingresos actual:    ${fmt(freshTotalIngresos)}\n\n` +
        `¿Deseas continuar con la aprobación de todas formas?\n` +
        `(Cancela para ver los nuevos números antes de aprobar.)`
      )
      if (!proceed) {
        setDeals(ds => ds.map(d => d.id === current.id ? { ...d, ...current } : d))
        setApprovingDeal(null)
        setApproving(false)
        return
      }
    }

    // 2. Atomic UPDATE guarded by status='BORRADOR'. If the row is no longer
    //    BORRADOR at the instant the UPDATE hits the DB, zero rows are
    //    affected and we can detect it.
    const updatePayload: any = {
      status: 'APROBADO',
      approved_by: user?.id ?? null,
      approved_at: new Date().toISOString(),
      ajuste_cuadre: ajuste,
      unlock_reason: null,
      unlocked_by: null,
      unlocked_at: null,
    }
    if (overrideReason) {
      updatePayload.unverified_override_reason = overrideReason
      updatePayload.unverified_override_by = user?.id ?? null
      updatePayload.unverified_override_at = new Date().toISOString()
    }

    const { data: updated, error } = await supabase
      .from('deals')
      .update(updatePayload)
      .eq('id', approvingDeal.id)
      .eq('status', 'BORRADOR')
      .select()

    if (error) { alert('Error: ' + error.message); setApproving(false); return }

    if (!updated || updated.length === 0) {
      // Another admin approved at the exact same moment. Our UPDATE affected
      // zero rows because the status filter no longer matched.
      alert('El negocio fue aprobado por otro administrador en este mismo momento. La pantalla se actualizará.')
      // Re-fetch to get the canonical state
      const { data: refreshed } = await supabase.from('deals').select('*').eq('id', approvingDeal.id).single()
      if (refreshed) setDeals(ds => ds.map(d => d.id === refreshed.id ? refreshed : d))
      setApprovingDeal(null)
      setApproving(false)
      return
    }

    await logAction(
      overrideReason ? 'deal_approved_with_override' : 'deal_approved',
      'deal',
      String(approvingDeal.id),
      {
        negocio_num: approvingDeal.negocio_num,
        cliente_nombre: approvingDeal.cliente_nombre,
        ajuste_cuadre: ajuste,
        override_reason: overrideReason,
      }
    )

    const approved = updated[0]
    setDeals(ds => ds.map(d => d.id === approved.id ? approved : d))
    setApprovingDeal(null)
    setApproving(false)
    setShowNota(approved)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ★ FIX: Hardened unlock
  // Same pattern — fresh read + atomic guarded UPDATE. If the row is no longer
  // APROBADO (e.g., someone else already unlocked it), warn instead of
  // silently duplicating the unlock action.
  // ═══════════════════════════════════════════════════════════════════════════
  const handleUnlock = async (reason: string) => {
    if (!unlockingDeal) return
    if (!user) { alert('Sesión no iniciada. Recarga la página.'); return }

    const { data: current, error: readErr } = await supabase
      .from('deals')
      .select('id, status, unlock_reason, unlocked_at')
      .eq('id', unlockingDeal.id)
      .single()

    if (readErr) {
      alert('No se pudo verificar el estado actual del negocio. Intenta de nuevo.')
      return
    }

    if (current?.status !== 'APROBADO') {
      alert(
        `Este negocio ya no está APROBADO (estado actual: ${current?.status || 'BORRADOR'}).\n\n` +
        `Probablemente fue desbloqueado por otro administrador. La pantalla se actualizará.`
      )
      setDeals(ds => ds.map(d => d.id === current.id ? { ...d, ...current } : d))
      setUnlockingDeal(null)
      return
    }

    const { data: updated, error } = await supabase
      .from('deals')
      .update({
        status: 'BORRADOR',
        unlocked_by: user?.id ?? null,
        unlocked_at: new Date().toISOString(),
        unlock_reason: reason,
        approved_by: null,
        approved_at: null,
      })
      .eq('id', unlockingDeal.id)
      .eq('status', 'APROBADO')
      .select()

    if (error) { alert('Error al desbloquear: ' + error.message); return }

    if (!updated || updated.length === 0) {
      alert('El negocio fue desbloqueado por otro administrador en este mismo momento. La pantalla se actualizará.')
      const { data: refreshed } = await supabase.from('deals').select('*').eq('id', unlockingDeal.id).single()
      if (refreshed) setDeals(ds => ds.map(d => d.id === refreshed.id ? refreshed : d))
      setUnlockingDeal(null)
      return
    }

    try {
      await logAction('deal_unlocked', 'deal', String(unlockingDeal.id), {
        negocio_num: unlockingDeal.negocio_num,
        cliente_nombre: unlockingDeal.cliente_nombre,
        reason,
      })
    } catch (e) { console.warn('logAction failed:', e) }

    const unlocked = updated[0]
    setDeals(ds => ds.map(d => d.id === unlocked.id ? unlocked : d))
    if (panelDeal?.id === unlocked.id) setPanelDeal((p: any) => ({ ...p, ...unlocked }))
    setUnlockingDeal(null)
  }

  const handleNotaPrinted = async (deal: any) => {
    await supabase.from('deals').update({ nota_entrega_at: new Date().toISOString() }).eq('id', deal.id)
    setShowNota(null)
  }

  const handleDelete = async () => {
    if (!panelDeal) return
    await logAction('deal_deleted', 'deal', String(panelDeal.id), { negocio_num: panelDeal.negocio_num, cliente_nombre: panelDeal.cliente_nombre, banco: panelDeal.banco })
    await supabase.from('deal_image_registry').delete().eq('deal_id', panelDeal.id)
    const { error } = await supabase.from('deals').delete().eq('id', panelDeal.id)
    if (error) { alert('Error al eliminar: ' + error.message); return }
    setDeals(ds => ds.filter(d => d.id !== panelDeal.id))
    setPanelDeal(null)
  }

  const openPanel = (d: any) => { setPanelDeal(d) }

  if (loading) return <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={{ color: 'var(--text-secondary)' }}>Cargando...</div></div>

  const hasAccess = userRole === 'admin' || userRole === 'manager'
  if (!hasAccess) return (
    <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: '48px', height: '48px', borderRadius: '10px', background: 'rgba(187,22,43,0.1)', border: '1px solid rgba(187,22,43,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: '18px', color: '#BB162B', fontWeight: 900, fontFamily: 'monospace' }}>—</div>
        <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>Acceso Restringido</div>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '24px' }}>No tienes permisos para acceder al módulo Admin.</div>
        <button onClick={() => router.push('/dashboard')} style={s.btnGray}>← Volver</button>
      </div>
    </div>
  )

  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay() + 1)

  const thisMonthDeals = deals.filter(d => new Date(d.created_at) >= startOfMonth)
  const thisWeekDeals = deals.filter(d => { const fd = d.fecha_entrega ? new Date(d.fecha_entrega + 'T12:00:00') : null; return fd && fd >= startOfWeek && fd <= now })
  const pendingDeals = deals.filter(d => d.status !== 'APROBADO')
  const approvedDeals = deals.filter(d => d.status === 'APROBADO')
  const notasEmitidas = deals.filter(d => d.nota_entrega_at && new Date(d.nota_entrega_at) >= startOfMonth)
  const totalRevenue = thisMonthDeals.reduce((s, d) => s + (d.total_cliente || 0), 0)

  const resultados = [
    { label: 'Cuadrado', value: deals.filter(d => d.resultado_tipo === 'CUADRADO').length, color: '#2ecc8a' },
    { label: 'Faltante',  value: deals.filter(d => d.resultado_tipo === 'FALTANTE').length,  color: '#BB162B' },
    { label: 'Sobrante',  value: deals.filter(d => d.resultado_tipo === 'SOBRANTE').length,  color: '#b8720a' },
  ]

  const vendedores = ['Roberto Hernandez', 'Mariangel Acosta', 'Maurice Rodriguez', 'Vendedor Externo', 'Gerencia']
  const revenueByVendedor = vendedores.map(v => ({ label: v.split(' ')[0], value: deals.filter(d => d.vendedor === v).reduce((s, d) => s + (d.total_cliente || 0), 0) })).filter(v => v.value > 0)
    .sort((a, b) => b.value - a.value)
  const maxRevenue = Math.max(...revenueByVendedor.map(v => v.value), 1)
  const totalVendedor = revenueByVendedor.reduce((s, v) => s + v.value, 0)

  const bancos = ['CONTADO', 'FINANCIAMIENTO INTERNO', 'PIVCA', 'Banesco', 'Banco de Venezuela', 'Mercantil', 'BOD', 'Bicentenario', 'Banco Provincial', 'Otro Banco']
  const revenueByBanco = bancos.map(b => ({ label: b, value: deals.filter(d => d.banco === b).reduce((s, d) => s + (d.total_cliente || 0), 0) })).filter(b => b.value > 0)
    .sort((a, b) => b.value - a.value)
  const maxBanco = Math.max(...revenueByBanco.map(b => b.value), 1)
  const totalBanco = revenueByBanco.reduce((s, b) => s + b.value, 0)

  const today_iso = new Date().toISOString().slice(0, 10)
  const diferidasCount = diferidas.length
  const diferidasTotal = diferidas.reduce((s: number, d: any) => s + (parseFloat(d.monto_usd) || 0), 0)
  const diferidasVencidas = diferidas.filter((d: any) => d.fecha_vencimiento < today_iso)

  const ResultBadge = ({ tipo }: { tipo: string }) => (
    <span style={{ padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 700, background: tipo === 'CUADRADO' ? 'rgba(26,122,74,0.15)' : tipo === 'FALTANTE' ? 'rgba(187,22,43,0.15)' : 'rgba(184,114,10,0.15)', color: tipo === 'CUADRADO' ? '#2ecc8a' : tipo === 'FALTANTE' ? '#BB162B' : '#b8720a' }}>
      {tipo || '—'}
    </span>
  )

  return (
    <AdminShell active="admin">
      {approvingDeal && <ApprovalModal
        deal={approvingDeal}
        onConfirm={(ajuste) => handleApprove(ajuste, null)}
        onOverride={(ajuste, reason) => handleApprove(ajuste, reason)}
        onCancel={() => setApprovingDeal(null)}
        onPagosRefreshed={(freshDeal) => {
          setApprovingDeal(freshDeal)
          setDeals(ds => ds.map(d => d.id === freshDeal.id ? freshDeal : d))
        }}
      />}
      {unlockingDeal && <UnlockModal deal={unlockingDeal} onConfirm={handleUnlock} onCancel={() => setUnlockingDeal(null)} />}
      {showNota && <NotaEntregaPrint deal={showNota} onPrint={() => handleNotaPrinted(showNota)} onDismiss={() => setShowNota(null)} />}
      {panelDeal && <DealPanel key={panelDeal.id} deal={panelDeal} onClose={() => setPanelDeal(null)} onDelete={handleDelete} canDelete={userRole === 'manager'} />}

      <div style={s.content}>
        <div style={{ marginBottom: '28px', marginTop: '8px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '2px' }}>Administración de Negocios</div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary)' }}>Resumen del Mes</div>
        </div>

        {/* KPI Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px', marginBottom: '24px' }}>
          <KpiCard label="Negocios este mes"     value={thisMonthDeals.length.toString()} color="#BB162B" />
          <KpiCard label="Ingresos este mes"      value={fmt(totalRevenue)}                color="#2ecc8a" />
          <KpiCard label="Pendientes aprobación"  value={pendingDeals.length.toString()}   color="#b8720a" />
          <KpiCard label="Notas de Entrega (mes)" value={notasEmitidas.length.toString()}  color="#4a9eff" />
          <KpiCard label="Inicial Diferida pend." value={`${diferidasCount}`}              color="#e67e22" />
        </div>

        {/* Charts — donut compacto a la izquierda, ranking de vendedores a la derecha */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(380px, 5fr) 7fr', gap: '20px', marginBottom: '24px' }}>
          <div style={s.card}><div style={s.sectionTitle}>Resultado de Negocios</div><DonutChart data={resultados} /></div>
          <div style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={s.sectionTitle}>Ingresos por Vendedor</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalVendedor)} total</div>
            </div>
            {revenueByVendedor.length === 0 ? <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Sin datos</div>
              : revenueByVendedor.map(v => <SimpleBar key={v.label} label={v.label} value={v.value} max={maxRevenue} total={totalVendedor} />)}
          </div>
        </div>

        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={s.sectionTitle}>Ingresos por Banco</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalBanco)} total</div>
          </div>
          <div style={{ maxWidth: '860px' }}>
            {revenueByBanco.length === 0 ? <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Sin datos</div>
              : revenueByBanco.map(b => <SimpleBar key={b.label} label={b.label} value={b.value} max={maxBanco} total={totalBanco} />)}
          </div>
        </div>

        <CxCInicialDiferidaCard mode="card" />
        
        {/* Tip for row click */}
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', fontStyle: 'italic' }}>
          Haz clic en cualquier fila para ver el detalle completo del negocio →
        </div>

        {/* Pending Approval */}
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '2px' }}>Pendientes de Aprobación</div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{pendingDeals.length} negocios</div>
          </div>
          {pendingDeals.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px', color: '#2ecc8a', fontSize: '13px' }}>Sin pendientes</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Negocio #', 'Cliente', 'Vendedor', 'Banco', 'F. Entrega', 'Audit Total', 'Resultado', ''].map(h => <th key={h} style={thTd}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {pendingDeals.map(d => (
                  <ClickableRow key={d.id} d={d} onOpen={openPanel}>
                    <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700 }}>{d.negocio_num}</td>
                    <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px' }}>{d.cliente_nombre}{d.cliente_apellidos ? ' ' + d.cliente_apellidos : ''}</td>
                    <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.vendedor}</td>
                    <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.banco}</td>
                    <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.fecha_entrega ? fmtDate(d.fecha_entrega) : '—'}</td>
                    <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace' }}>{fmt(d.total_cliente || 0)}</td>
                    <td style={{ padding: '12px' }}><ResultBadge tipo={d.resultado_tipo} /></td>
                    <td style={{ padding: '12px' }} onClick={e => e.stopPropagation()}>
                      <button onClick={() => setApprovingDeal(d)} style={{ padding: '6px 16px', background: '#BB162B', border: 'none', borderRadius: '6px', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer', letterSpacing: '1px' }}>APROBAR</button>
                    </td>
                  </ClickableRow>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* This Week */}
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '2px' }}>Negocios de Esta Semana</div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{thisWeekDeals.length} entregas</div>
          </div>
          {thisWeekDeals.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)', fontSize: '13px' }}>No hay negocios entregados esta semana</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Negocio #', 'Cliente', 'Vendedor', 'Banco', 'F. Entrega', 'Audit Total', 'Estado', 'Nota Entrega'].map(h => <th key={h} style={thTd}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {thisWeekDeals.map(d => (
                  <ClickableRow key={d.id} d={d} onOpen={openPanel}>
                    <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700 }}>{d.negocio_num}</td>
                    <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px' }}>{d.cliente_nombre}{d.cliente_apellidos ? ' ' + d.cliente_apellidos : ''}</td>
                    <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.vendedor}</td>
                    <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.banco}</td>
                    <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.fecha_entrega ? fmtDate(d.fecha_entrega) : '—'}</td>
                    <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace' }}>{fmt(d.total_cliente || 0)}</td>
                    <td style={{ padding: '12px' }}>
                      <span style={{ padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 700, background: d.status === 'APROBADO' ? 'rgba(26,122,74,0.15)' : 'rgba(184,114,10,0.15)', color: d.status === 'APROBADO' ? '#2ecc8a' : '#b8720a' }}>{d.status === 'APROBADO' ? 'APROBADO' : 'BORRADOR'}</span>
                    </td>
                    <td style={{ padding: '12px' }}>
                      {d.nota_entrega_at ? <span style={{ color: '#2ecc8a', fontSize: '11px', fontWeight: 600 }}>{fmtDate(d.nota_entrega_at.split('T')[0])}</span> : <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>—</span>}
                    </td>
                  </ClickableRow>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* All Approved — with Unlock */}
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '2px' }}>Todos los Negocios Aprobados</div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{approvedDeals.length} negocios</div>
          </div>
          {approvedDeals.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)', fontSize: '13px' }}>No hay negocios aprobados aún</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Negocio #', 'Cliente', 'Vendedor', 'Banco', 'F. Entrega', 'Audit Total', 'Resultado', 'Motivo Desbloqueo', ''].map(h => <th key={h} style={thTd}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {approvedDeals.map(d => (
                  <ClickableRow key={d.id} d={d} onOpen={openPanel}>
                    <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700 }}>{d.negocio_num}</td>
                    <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px' }}>{d.cliente_nombre}{d.cliente_apellidos ? ' ' + d.cliente_apellidos : ''}</td>
                    <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.vendedor}</td>
                    <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.banco}</td>
                    <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.fecha_entrega ? fmtDate(d.fecha_entrega) : '—'}</td>
                    <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace' }}>{fmt(d.total_cliente || 0)}</td>
                    <td style={{ padding: '12px' }}><ResultBadge tipo={d.resultado_tipo} /></td>
                    <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '11px', fontStyle: 'italic', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.unlock_reason ? `"${d.unlock_reason}"` : '—'}
                    </td>
                    <td style={{ padding: '12px' }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => setShowNota(d)} style={{ padding: '6px 12px', background: 'transparent', border: '1px solid rgba(74,158,255,0.5)', borderRadius: '6px', color: '#4a9eff', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>🖨 NOTA</button>
                        <button onClick={() => setUnlockingDeal(d)} style={{ padding: '6px 14px', background: 'transparent', border: '1px solid #b8720a', borderRadius: '6px', color: '#b8720a', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>DESBLOQUEAR</button>
                      </div>
                    </td>
                  </ClickableRow>
                ))}
              </tbody>
            </table>
          )}
        </div>

      </div>
    </AdminShell>
  )
}


export default function Admin() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--bg-page)' }} />}>
      <AdminInner />
    </Suspense>
  )
}