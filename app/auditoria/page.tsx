// TARGET: autocore-npa/app/auditoria/page.tsx
'use client'
import { useState, useEffect, useRef, Suspense, useCallback } from 'react'
import { supabase } from '../supabase'
import { useRouter, useSearchParams } from 'next/navigation'
import AdminShell from '../components/AdminShell'
import { useNPAPermissions } from '../components/useNPAPermissions'
import CxCInicialDiferidaCard from '../components/CxCInicialDiferidaCard'
import TesoreriaQRScanner, { type ScannedComprobante } from '../components/TesoreriaQRScanner'
// Documentos de Entrega (Nota + Declaración Zelle + Legitimación) — Deisi los
// imprime aquí en negocios APROBADOS sin depender de Mirla (/admin).
import NotaEntregaPrint from '../components/NotaEntregaPrint'

const VENDEDORES = ['Roberto Hernandez', 'Mariangel Acosta', 'Maurice Rodriguez', 'Vendedor Externo', 'Gerencia']
const BANCOS = ['CONTADO', 'FINANCIAMIENTO INTERNO', 'PIVCA', 'Banesco', 'Banco de Venezuela', 'Mercantil', 'BOD', 'Bicentenario', 'Banco Provincial', 'Otro Banco']
const METODOS_PAGO = ['Efectivo', 'Zelle Roframi', 'Zelle Motocentro', 'Zelle Externo', 'Wire Transfer Roframi', 'Wire Transfer Motocentro', 'Wire Transfer Panama', 'USDT', 'Transferencia en Bolívares', 'Retención', 'Liquidación PIVCA', 'Saldo a Financiar']
const METODOS_REQUIEREN_COMPROBANTE = ['Zelle Roframi', 'Zelle Motocentro', 'Zelle Externo', 'Wire Transfer Roframi', 'Wire Transfer Motocentro', 'Wire Transfer Panama']
const RIF_TIPOS = ['V', 'J', 'E', 'G']
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
const DIAS = ['Lu','Ma','Mi','Ju','Vi','Sa','Do']

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtBs = (n: number) => `Bs ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (iso: string) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }
const n = (v: any): number | null => {
  if (v === '' || v === null || v === undefined) return null
  const parsed = parseFloat(String(v).replace(/[$,]/g, ''))
  return isNaN(parsed) ? null : parsed
}

// ── IMAGE HASH UTILITY ────────────────────────────────────────────────────────
async function computeFileHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

// Check both hash AND filename across ALL deals (excluding current deal if editing)
async function checkImageDuplicate(hash: string, filename: string, currentDealId?: any): Promise<{ isDuplicate: boolean; reason: string; dealNum?: string }> {
  // Wrap the whole check in a 6-second timeout — if Supabase is slow, skip the check and allow the upload
  const timeoutPromise = new Promise<{ isDuplicate: boolean; reason: string }>((resolve) =>
    setTimeout(() => resolve({ isDuplicate: false, reason: '' }), 6000)
  )

  const checkPromise = (async () => {
    try {
      // Check by hash
      const { data: hashMatches } = await supabase
        .from('deal_image_registry')
        .select('deal_id, negocio_num, original_filename')
        .eq('file_hash', hash)
      
      if (hashMatches && hashMatches.length > 0) {
        const external = hashMatches.filter(r => String(r.deal_id) !== String(currentDealId))
        if (external.length > 0) {
          return {
            isDuplicate: true,
            reason: `Este archivo ya fue escaneado en el Negocio #${external[0].negocio_num}. No se puede adjuntar el mismo comprobante a dos negocios.`,
            dealNum: external[0].negocio_num,
          }
        }
      }

      // Check by filename
      const { data: nameMatches } = await supabase
        .from('deal_image_registry')
        .select('deal_id, negocio_num, file_hash')
        .eq('original_filename', filename)

      if (nameMatches && nameMatches.length > 0) {
        const external = nameMatches.filter(r => String(r.deal_id) !== String(currentDealId))
        if (external.length > 0) {
          return {
            isDuplicate: true,
            reason: `Un archivo con el nombre "${filename}" ya fue registrado en el Negocio #${external[0].negocio_num}. Verifique que no sea el mismo comprobante.`,
            dealNum: external[0].negocio_num,
          }
        }
      }

      return { isDuplicate: false, reason: '' }
    } catch {
      // If DB check fails for any reason, allow the upload to proceed
      return { isDuplicate: false, reason: '' }
    }
  })()

  return Promise.race([checkPromise, timeoutPromise])
}

// Register image in registry after confirmed upload
async function registerImage(dealId: string, negocioNum: string, hash: string, filename: string) {
  await supabase.from('deal_image_registry').upsert({
    deal_id: dealId,
    negocio_num: negocioNum,
    file_hash: hash,
    original_filename: filename,
    registered_at: new Date().toISOString(),
  }, { onConflict: 'file_hash' })
}

// ── DOCUMENT STORAGE HELPERS (added 2026-05-07) ───────────────────────────────
//
// Three responsibilities:
//   (a) Upload a source doc (factura/cdo/cedula/comprobante) to Supabase storage
//       under deals/{negocio_num}/<type>_<timestamp>.<ext>
//   (b) Detect MIME type from a base64 string OR from a File
//   (c) Classify a doc as 'factura' | 'cdo' | 'cedula' from its filename if obvious
//
// Storage convention:
//   comprobantes bucket
//     deals/{negocio_num}/factura_<ts>.<ext>
//     deals/{negocio_num}/cdo_<ts>.<ext>
//     deals/{negocio_num}/cedula_<ts>.<ext>
//     deals/{negocio_num}/pago_<ts>.<ext>
//   For BORRADOR deals without a negocio_num yet, use:
//     deals/borrador_<deal_uuid>/...
//   When negocio_num is later assigned, the parent flow can rename if needed
//   (or just keep the borrador path in documentos_meta — the path is the path).

const STORAGE_BUCKET = 'comprobantes'

function fileExtension(file: File): string {
  if (file.type === 'application/pdf') return 'pdf'
  if (file.type === 'image/png') return 'png'
  if (file.type === 'image/webp') return 'webp'
  if (file.type === 'image/jpeg' || file.type === 'image/jpg') return 'jpg'
  // Fallback: use the file name extension if recognizable, else jpg
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  if (['pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext
  return 'jpg'
}

function fileMime(file: File): string {
  if (file.type) return file.type
  const ext = fileExtension(file)
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

// Detects MIME from a base64 data URL or raw base64 by inspecting magic bytes.
// Used for legacy comprobante_imagen rendering when the data: prefix is wrong.
function detectMimeFromBase64(b64orDataUrl: string): string {
  if (!b64orDataUrl) return 'image/jpeg'
  let raw = b64orDataUrl
  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',')
    if (comma >= 0) raw = raw.slice(comma + 1)
  }
  // Decode just the first ~12 bytes (16 base64 chars)
  try {
    const head = atob(raw.slice(0, 16))
    const bytes = Array.from(head).map(c => c.charCodeAt(0))
    // PDF: 0x25 0x50 0x44 0x46 ('%PDF')
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf'
    // PNG: 0x89 0x50 0x4E 0x47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
    // JPEG: 0xFF 0xD8 0xFF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
    // WEBP: bytes 0-3 = 'RIFF', bytes 8-11 = 'WEBP'
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp'
  } catch { /* ignore */ }
  return 'image/jpeg'
}

// Build a properly-prefixed data: URL by detecting actual MIME from the bytes.
// Use this when storing comprobante_imagen as legacy data URL (back-compat path).
function buildDataUrl(base64: string): string {
  if (base64.startsWith('data:')) return base64  // already a data URL
  const mime = detectMimeFromBase64(base64)
  return `data:${mime};base64,${base64}`
}

// Try to classify a file as factura/cdo/cedula from its name. Returns null if unsure.
function classifyDocFromFilename(name: string): 'factura' | 'cdo' | 'cedula' | null {
  const n = name.toLowerCase()
  if (n.includes('factura') || n.includes('fact ') || /\bfact\b/.test(n)) return 'factura'
  if (n.includes('cdo') || n.includes('certificado') || n.includes('origen')) return 'cdo'
  if (n.includes('cedula') || n.includes('cédula') || n.includes('rif') || n.includes('ci_') || n.startsWith('ci ')) return 'cedula'
  return null
}

// Upload a single file to storage under deals/<negocioOrUuid>/<type>_<ts>.<ext>
// Returns { path, mime, ext } on success or { error } on failure.
async function uploadDealDoc(opts: {
  file: File
  negocioNum?: string | null
  dealId?: string | null
  type: 'factura' | 'cdo' | 'cedula' | 'pago'
}): Promise<{ path?: string; mime?: string; ext?: string; error?: string }> {
  const { file, negocioNum, dealId, type } = opts
  const folder = negocioNum
    ? `deals/${negocioNum}`
    : (dealId ? `deals/borrador_${dealId}` : null)
  if (!folder) return { error: 'No negocio_num ni dealId — no se puede determinar carpeta de almacenamiento' }
  const ext = fileExtension(file)
  const mime = fileMime(file)
  const ts = Date.now()
  const path = `${folder}/${type}_${ts}.${ext}`
  try {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, {
      upsert: true,
      contentType: mime,
    })
    if (error) return { error: error.message }
    return { path, mime, ext }
  } catch (err: any) {
    return { error: err?.message || String(err) }
  }
}

// Sign a storage path for viewing/downloading (returns signed URL or null).
async function signStoragePath(path: string, ttl = 3600): Promise<string | null> {
  if (!path) return null
  try {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(path, ttl)
    if (error || !data?.signedUrl) return null
    return data.signedUrl
  } catch { return null }
}

// Extract factura-de-venta P&L fields from a file using the worker's auto-classifier
// (the SAME extractor the backfill uses, so factura_venta_body_neto is defined
// identically to already-backfilled deals). Returns a patch of only the present
// fields, or null. Used by BOTH the new-deal scanner and the detail-view attach so
// every factura de venta feeds reportes the same way.
async function extractVentaFields(file: File): Promise<Record<string, any> | null> {
  try {
    const b64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = ev => resolve(((ev.target?.result as string) || '').split(',')[1] || '')
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
    const isPdf = file.type === 'application/pdf'
    const res = await fetch('https://autocore-comprobante.sano-franco.workers.dev', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scan: 'auto', base64: b64, mediaType: isPdf ? 'application/pdf' : file.type, isPdf }),
    })
    const json = await res.json().catch(() => null)
    const docs = Array.isArray(json?.documents) ? json.documents : []
    const venta = docs.find((d: any) => d?.type === 'factura_venta')?.extracted || null
    if (!venta) return null
    const patch: Record<string, any> = {}
    const setIf = (k: string) => { const v = venta[k]; if (v !== null && v !== undefined && v !== '') patch[k] = v }
    setIf('factura_venta_numero'); setIf('factura_venta_control')
    setIf('factura_venta_body_neto'); setIf('factura_venta_iva')
    setIf('factura_venta_igtf_real'); setIf('factura_venta_tasa_bcv')
    setIf('factura_venta_placa'); setIf('factura_venta_total'); setIf('factura_venta_modo_igtf')
    return Object.keys(patch).length > 0 ? patch : null
  } catch (e) { console.warn('[extractVentaFields] failed:', e); return null }
}


function DatePicker({ value, onChange, placeholder, disabled }: { value: string, onChange: (v: string) => void, placeholder?: string, disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const today = new Date()
  const initDate = value ? new Date(value + 'T12:00:00') : today
  const [viewYear, setViewYear] = useState(initDate.getFullYear())
  const [viewMonth, setViewMonth] = useState(initDate.getMonth())
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (value) { const d = new Date(value + 'T12:00:00'); setViewYear(d.getFullYear()); setViewMonth(d.getMonth()) }
  }, [value])

  const getDays = () => {
    const first = new Date(viewYear, viewMonth, 1)
    const startDow = first.getDay()
    const offset = startDow === 0 ? 6 : startDow - 1
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
    const cells: (number | null)[] = Array(offset).fill(null)
    for (let i = 1; i <= daysInMonth; i++) cells.push(i)
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }

  const selectDay = (day: number) => {
    const mm = String(viewMonth + 1).padStart(2, '0')
    const dd = String(day).padStart(2, '0')
    onChange(`${viewYear}-${mm}-${dd}`)
    setOpen(false)
  }

  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1) } else setViewMonth(m => m - 1) }
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1) } else setViewMonth(m => m + 1) }

  const selectedDay = value ? new Date(value + 'T12:00:00').getDate() : null
  const selectedMonth = value ? new Date(value + 'T12:00:00').getMonth() : null
  const selectedYear = value ? new Date(value + 'T12:00:00').getFullYear() : null
  const isSelected = (day: number) => day === selectedDay && viewMonth === selectedMonth && viewYear === selectedYear
  const isToday = (day: number) => day === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear()

  if (disabled) return (
    <div style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-input-dis)', border: '1px solid var(--border-dis)', borderRadius: '8px', color: 'var(--text-secondary)', fontSize: '13px' }}>
      {value ? fmtDate(value) : '—'}
    </div>
  )

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div onClick={() => setOpen(o => !o)} style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: value ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer', boxSizing: 'border-box' as const, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{value ? fmtDate(value) : placeholder || 'DD/MM/AAAA'}</span>
        <span style={{ color: '#BB162B', fontSize: '14px' }}>▼</span>
      </div>
      {open && (
        <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 1000, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '16px', width: '280px', boxShadow: 'var(--shadow-card)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <button onClick={prevMonth} style={{ background: 'none', border: 'none', color: '#BB162B', cursor: 'pointer', fontSize: '18px', padding: '0 4px' }}>‹</button>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <select value={viewMonth} onChange={e => setViewMonth(Number(e.target.value))} style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: '6px', padding: '4px 8px', fontSize: '13px', fontWeight: 700 }}>
                {MESES.map((m, i) => <option key={i} value={i}>{m}</option>)}
              </select>
              <select value={viewYear} onChange={e => setViewYear(Number(e.target.value))} style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: '6px', padding: '4px 8px', fontSize: '13px', fontWeight: 700 }}>
                {Array.from({ length: 10 }, (_, i) => today.getFullYear() - 3 + i).map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <button onClick={nextMonth} style={{ background: 'none', border: 'none', color: '#BB162B', cursor: 'pointer', fontSize: '18px', padding: '0 4px' }}>›</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: '4px' }}>
            {DIAS.map(d => <div key={d} style={{ textAlign: 'center', fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', padding: '4px 0' }}>{d}</div>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
            {getDays().map((day, i) => (
              <div key={i} onClick={() => day && selectDay(day)} style={{ textAlign: 'center', padding: '6px 0', borderRadius: '6px', fontSize: '13px', cursor: day ? 'pointer' : 'default', color: day ? (isSelected(day) ? '#fff' : isToday(day) ? '#BB162B' : 'var(--text-primary)') : 'transparent', background: day && isSelected(day) ? '#BB162B' : day && isToday(day) ? 'rgba(187,22,43,0.15)' : 'transparent', fontWeight: isSelected(day as number) ? 700 : 400 }}>{day || ''}</div>
            ))}
          </div>
          <div style={{ marginTop: '12px', textAlign: 'center' }}>
            <button onClick={() => { const y = today.getFullYear(), m = String(today.getMonth() + 1).padStart(2, '0'), d = String(today.getDate()).padStart(2, '0'); onChange(`${y}-${m}-${d}`); setOpen(false) }} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', padding: '4px 16px', fontSize: '11px', cursor: 'pointer' }}>Hoy</button>
          </div>
        </div>
      )}
    </div>
  )
}

// Race a thenable against a timeout so a hung Supabase query can never leave
// the page stuck on a phantom empty list. Resolves/rejects with the query, or
// rejects with 'timeout:<label>' after `ms`.
function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout:' + label)), ms)
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif', transition: 'background 0.35s ease' },
  content: { padding: '32px', maxWidth: '1200px', margin: '0 auto' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', marginBottom: '20px', transition: 'background 0.35s ease, border-color 0.35s ease' },
  cardGreen: { background: 'var(--bg-card-green)', border: '1px solid var(--border-green)', borderRadius: '12px', padding: '24px', marginBottom: '20px', transition: 'background 0.35s ease, border-color 0.35s ease' },
  sectionTitle: { fontSize: '12px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' },
  sectionTitleGreen: { fontSize: '12px', fontWeight: 700, color: '#2ecc8a', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--border-green)' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' },
  grid4: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '16px' },
  grid5: { display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr 1fr 1fr', gap: '16px' },
  label: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', display: 'block', marginBottom: '6px' },
  input: { width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  inputDisabled: { width: '100%', padding: '10px 14px', background: 'var(--bg-input-dis)', border: '1px solid var(--border-dis)', borderRadius: '8px', color: 'var(--text-secondary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  inputAuto: { width: '100%', padding: '10px 14px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', color: '#2ecc8a', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  inputLocked: { width: '100%', padding: '10px 14px', background: 'var(--bg-card)', border: '1px solid rgba(187,22,43,0.3)', borderRadius: '8px', color: '#BB162B', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const, fontWeight: 700 },
  select: { width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  selectDisabled: { width: '100%', padding: '10px 14px', background: 'var(--bg-input-dis)', border: '1px solid var(--border-dis)', borderRadius: '8px', color: 'var(--text-secondary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  btnRed: { padding: '10px 24px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px' },
  btnGray: { padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  btnGreen: { padding: '10px 24px', background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px' },
}

const PROYECTO_FIELDS = [
  { label: 'Precio Vehículo (IVA incluido)', key: 'pv_precio' },
  { label: 'Gastos Administrativos', key: 'pv_gastos_admin' },
  { label: 'Seguro', key: 'pv_seguro' },
  { label: 'IGTF', key: 'pv_igtf' },
  { label: 'Accesorios', key: 'pv_accesorios' },
  { label: 'Placas', key: 'pv_placas' },
]

const AUDITORIA_FIELDS = [
  { label: 'Precio Vehículo (IVA incluido)', key: 'au_precio' },
  { label: 'Gastos Administrativos', key: 'au_gastos_admin' },
  { label: 'Seguro (monto final)', key: 'au_seguro' },
  { label: 'IGTF (monto final)', key: 'au_igtf' },
  { label: 'Accesorios', key: 'au_accesorios' },
  { label: 'Comisión Flat', key: 'au_comision_flat' },
  { label: 'Placas (monto final)', key: 'au_placas' },
]

interface Deal {
  id?: string
  negocio_num: string
  cliente_nombre: string
  cliente_rif_tipo: string
  cliente_rif: string
  vendedor: string
  banco: string
  fecha_factura: string
  fecha_entrega: string
  vin: string
  inventory_vin?: string | null
  factura_compra_numero?: string | null
  factura_compra_fecha?: string | null
  factura_compra_body_neto?: number | null
  factura_compra_igtf?: number | null
  factura_compra_placa?: number | null
  factura_compra_total?: number | null
  tasa_bcv: string
  tasa_variable: string
  pv_precio: number; pv_gastos_admin: number; pv_seguro: number; pv_igtf: number; pv_accesorios: number; pv_placas: number
  pv_inicial: number; pv_monto_financiar: number; pv_comision_banco: number; pv_comision_flat_cobrado: number
  au_precio: number; au_gastos_admin: number; au_seguro: number; au_igtf: number; au_accesorios: number; au_comision_flat: number; au_placas: number
  seguro_2do_ano: boolean; seguro_2do_ano_monto: number
  seguro_real_monto?: number | null; seguro_real_at?: string | null; seguro_real_by?: string | null; seguro_real_ref?: string | null
  pagos: any[]
  status?: string
  approved_at?: string
  // Buyer detail fields
  cliente_apellidos: string
  cliente_direccion: string
  cliente_telefono: string
  cliente_email: string
  cliente_estado_civil: string
  vehiculo_marca: string
  vehiculo_modelo: string
  vehiculo_color: string
  vehiculo_placa: string
  vehiculo_año: number | null
  vehiculo_año_fabricacion: number | null
  vehiculo_clase: string
  vehiculo_uso: string
  // Inicial Diferida fields (loaded from compromisos_inicial_diferida table at openDeal)
  inicial_diferida_active?: boolean
  inicial_diferida_monto?: number
  inicial_diferida_fecha_vencimiento?: string
  inicial_diferida_custodia?: boolean
  inicial_diferida_notas?: string
  inicial_diferida_compromiso_id?: string
}

// ── BLOCKED IMAGE MODAL ───────────────────────────────────────────────────────
function BlockedImageModal({ reason, onClose }: { reason: string, onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '2px solid #BB162B', borderRadius: '16px', padding: '32px', maxWidth: '460px', width: '100%', textAlign: 'center' }}>
        <div style={{ width: '56px', height: '56px', borderRadius: '12px', background: 'rgba(187,22,43,0.15)', border: '2px solid rgba(187,22,43,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: '24px', color: '#BB162B', fontWeight: 900 }}>✕</div>
        <div style={{ fontSize: '15px', fontWeight: 700, color: '#BB162B', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>Comprobante Duplicado Bloqueado</div>
        <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginBottom: '8px', lineHeight: 1.6 }}>{reason}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '24px', padding: '10px 14px', background: 'rgba(187,22,43,0.08)', borderRadius: '8px', border: '1px solid rgba(187,22,43,0.2)' }}>
          Por seguridad, el mismo comprobante no puede ser registrado en más de un negocio. Contacte a Gerencia si cree que es un error.
        </div>
        <button onClick={onClose} style={{ ...s.btnRed, width: '100%' }}>Entendido</button>
      </div>
    </div>
  )
}


// ──────────────────────────────────────────────────────────────────────────────
// ComprobanteModal — AI receipt scanner (upgraded v2)
//
// Previously: received `metodo` prop and asked the Worker to extract amount/ref/fecha
// for a PRE-SELECTED method. This caused the USDT bug where Deisi picked "Zelle
// Roframi" in the form, uploaded a Binance screenshot, and it got stored as Zelle
// with the USDT reference because the AI was never asked what method it was.
//
// Now: AI detects the method itself, using the same v2 prompt from IngresoScanner
// (USDT-first matching, wallet/hash extraction, confidence pills). The modal
// shows all extracted fields as editable inputs — Deisi reviews and corrects
// before saving. The `metodo` prop is now only the default/hint; the AI can
// override it, and Deisi can override the AI.
// ──────────────────────────────────────────────────────────────────────────────
// SeguroRealModal — post-close registration of the REAL insurance amount.
// Deal is already APROBADO and stays locked; writes ONLY the seguro_real_*
// overlay columns via the registrar_seguro_real SECURITY DEFINER RPC. Variance
// (au_seguro charged - real paid) flows into deal_pnl_management.
function SeguroRealModal({ deal, user, onClose, onDone }: {
  deal: any,
  user: any,
  onClose: () => void,
  onDone: (vals: any) => void,
}) {
  const [monto, setMonto] = useState<string>(deal.seguro_real_monto != null ? String(deal.seguro_real_monto) : '')
  const [refNum, setRefNum] = useState<string>(deal.seguro_real_ref || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const charged = Number(deal.au_seguro) || 0
  const real = parseFloat(monto)
  const variance = !isNaN(real) ? charged - real : 0

  const submit = async () => {
    const m = parseFloat(monto)
    if (isNaN(m) || m < 0) { setErr('Ingresa un monto valido.'); return }
    setSaving(true); setErr('')
    const { error } = await supabase.rpc('registrar_seguro_real', {
      p_deal_id: deal.id,
      p_monto: m,
      p_invoice_ref: refNum || null,
    })
    if (error) { setErr(error.message); setSaving(false); return }
    if (user) {
      await supabase.from('activity_log').insert({
        user_id: user.id, user_email: user.email,
        action: 'seguro_real_registrado',
        target_type: 'deal',
        target_id: String(deal.id),
        details: { negocio_num: deal.negocio_num, au_seguro: charged, seguro_real: m, ref: refNum || null, variance: charged - m },
      })
    }
    setSaving(false)
    onDone({
      seguro_real_monto: m,
      seguro_real_ref: refNum || null,
      seguro_real_at: new Date().toISOString(),
      seguro_real_by: user?.email || null,
    })
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '2px solid rgba(46,204,138,0.5)', borderRadius: '16px', padding: '32px', maxWidth: '460px', width: '100%' }}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: '#2ecc8a', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '1px' }}>Registrar Seguro Real</div>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '20px', lineHeight: 1.6 }}>
          Negocio #{deal.negocio_num}. Ingresa el monto real de la poliza segun la factura de la aseguradora. El negocio permanece aprobado y bloqueado; solo se registra el monto real.
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
          <span>Cobrado al cliente (au_seguro)</span>
          <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{fmt(charged)}</strong>
        </div>
        <label style={s.label}>Monto real pagado a la aseguradora (USD)</label>
        <input type="number" step="0.01" style={s.input} value={monto} onChange={e => setMonto(e.target.value)} placeholder="0.00" autoFocus />
        <label style={{ ...s.label, marginTop: '12px' }}>Referencia / N de poliza (opcional)</label>
        <input type="text" style={s.input} value={refNum} onChange={e => setRefNum(e.target.value)} placeholder="Factura o poliza" />
        {!isNaN(real) && monto !== '' && (
          <div style={{ marginTop: '16px', padding: '12px 14px', borderRadius: '8px', background: variance >= 0 ? 'rgba(26,122,74,0.12)' : 'rgba(187,22,43,0.1)', border: variance >= 0 ? '1px solid rgba(46,204,138,0.35)' : '1px solid rgba(187,22,43,0.3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>{variance >= 0 ? 'Ganancia (absorbe el dealer)' : 'Perdida (absorbe el dealer)'}</span>
              <strong style={{ color: variance >= 0 ? '#2ecc8a' : '#BB162B', fontFamily: 'monospace' }}>{fmt(Math.abs(variance))}</strong>
            </div>
          </div>
        )}
        {err && <div style={{ marginTop: '14px', fontSize: '12px', color: '#BB162B' }}>{err}</div>}
        <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
          <button onClick={onClose} disabled={saving} style={{ ...s.btnGray, flex: 1 }}>Cancelar</button>
          <button onClick={submit} disabled={saving} style={{ ...s.btnGreen, flex: 1 }}>{saving ? 'Guardando...' : 'Registrar'}</button>
        </div>
      </div>
    </div>
  )
}

function ComprobanteModal({ metodo: initialMetodo, currentDealId, currentNegocioNum, onConfirm, onCancel }: {
  metodo: string,
  currentDealId?: string,
  currentNegocioNum?: string,
  onConfirm: (data: any) => void,
  onCancel: () => void
}) {
  const [image, setImage] = useState<string | null>(null)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imageHash, setImageHash] = useState<string>('')
  const [reading, setReading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState('')
  const [blockedReason, setBlockedReason] = useState('')
  // Editable fields (prefilled from AI, user can override before confirming)
  const [metodoEdit, setMetodoEdit] = useState<string>(initialMetodo || '')
  const [montoEdit, setMontoEdit] = useState<string>('')
  const [refEdit, setRefEdit] = useState<string>('')
  const [fechaEdit, setFechaEdit] = useState<string>('')
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setChecking(true)
    setError('')
    setResult(null)
    setBlockedReason('')
    setImageHash('')

    try {
      const hash = await computeFileHash(file)

      // Check against DB (other deals)
      const dupCheck = await checkImageDuplicate(hash, file.name, currentDealId)
      if (dupCheck.isDuplicate) {
        setBlockedReason(dupCheck.reason)
        if (fileRef.current) fileRef.current.value = ''
        setChecking(false)
        return
      }

      setImageHash(hash)
      setImageFile(file)
      const reader = new FileReader()
      reader.onload = (ev) => setImage(ev.target?.result as string)
      reader.readAsDataURL(file)
    } catch {
      setError('Error al verificar el archivo. Intente de nuevo.')
    }

    setChecking(false)
  }

  const readWithAI = async () => {
    if (!image) return
    setReading(true)
    setError('')
    try {
      const base64 = image.split(',')[1]
      const isPdf = imageFile?.type === 'application/pdf' || imageFile?.name?.toLowerCase().endsWith('.pdf')
      const mediaType = isPdf ? 'application/pdf' : (imageFile?.type || 'image/jpeg')

      // Timeout guard — abort if Worker hangs (common on flaky VE internet)
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 20000)

      // ★ v2: use raw passthrough mode so we control the prompt fully
      // (includes USDT-first matching + method detection, not just amount/ref)
      const res = await fetch('https://autocore-comprobante.sano-franco.workers.dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              isPdf ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
                    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              {
                type: 'text',
                text: `You are analyzing a payment receipt submitted to a Venezuelan KIA dealership. The receipt may be any of these:

A) USDT / crypto payment — Binance deposit/withdrawal, Trust Wallet, MetaMask, Coinbase, Kraken, blockchain explorer screenshot (etherscan / tronscan / bscscan / polygonscan), exchange transfer confirmation
B) Zelle payment — US-based P2P, shows "Confirmation #" or "Confirmation code"
C) Wire transfer — international or domestic US bank wire, shows "FedWire" / "Reference number" / SWIFT details
D) Venezuelan bolívar transfer — Banesco / Mercantil / BOD / Banco de Venezuela / Bicentenario, shows "Nro. de operación" / "Nro. referencia" / "Nro. Op"
E) Cash receipt ("Efectivo" / "RECIBO DE CAJA")
F) PIVCA settlement document ("Liquidación PIVCA" / bank comision docs)
G) Retention document ("Retención" / retención de impuesto)

RETURN ONLY JSON (no markdown, no commentary, no prose):
{
  "monto_usd": number | null,
  "monto_bs": number | null,
  "fecha": "YYYY-MM-DD" | null,
  "fecha_confidence": "high" | "medium" | "low",
  "referencia": "reference/confirmation/TX hash or null",
  "referencia_type": "tx_hash" | "confirmation" | "wire_ref" | "nro_operacion" | "other" | null,
  "sender_name": "name of sender, OR wallet address snippet if crypto — null if absent",
  "metodo_pago": "MUST match EXACTLY one of: 'Efectivo' | 'Zelle Roframi' | 'Zelle Motocentro' | 'Zelle Externo' | 'Wire Transfer Roframi' | 'Wire Transfer Motocentro' | 'Wire Transfer Panama' | 'USDT' | 'Transferencia en Bolívares' | 'Retención' | 'Liquidación PIVCA' | 'Saldo a Financiar' — OR null",
  "metodo_confidence": "high" | "medium" | "low",
  "cuenta_destino": "recipient account hint (e.g. 'ROFRAMI MANAGEMENT LLC', 'MOTOCENTRO II LLC', or the wallet address suffix) or null",
  "crypto_network": "TRC-20" | "ERC-20" | "BEP-20" | "Polygon" | "Solana" | "Bitcoin" | null,
  "wallet_address_to": "destination wallet address (shortened: first 6 + last 4) or null",
  "notas": "free text — any info that doesn't fit above, or null"
}

═══════════════════════════════════════════════════════════════════════
METHOD DETECTION — apply rules IN ORDER, stop at first match
═══════════════════════════════════════════════════════════════════════

★ RULE 1 — USDT / CRYPTO (CHECK THIS FIRST, even if the document also mentions "Transfer" or "Wire"):
   Trigger on ANY of these signals:
   • Words: "USDT", "Tether", "USD₮", "TetherUS"
   • Networks: "TRC-20", "TRC20", "ERC-20", "ERC20", "BEP-20", "BEP20", "TRX", "Polygon", "Solana", "Tron", "Ethereum", "Binance Smart Chain", "BSC"
   • Platforms: "Binance", "Trust Wallet", "MetaMask", "Coinbase", "Kraken", "OKX", "Bybit", "KuCoin", "Billetera Spot"
   • Spanish terms: "Criptomonedas", "Billetera", "Dirección" (wallet), "Txid", "Comisión de la red"
   • Explorers: "etherscan", "tronscan", "bscscan", "polygonscan", "blockchain.com"
   • Wallet address formats visible in the receipt:
     – Ethereum/BSC/Polygon: 0x followed by 40 hex chars (e.g., 0xAf72a1...)
     – Tron (TRC-20): starts with T + 33 alphanumeric chars (e.g., TJ2Ps5GAgQ...)
     – Solana: 32-44 base58 chars
   • TX hash visible (long hex string, typically 64 chars)
   → Set metodo_pago = "USDT"
   → Set crypto_network based on the network shown (if visible). "TRX" → "TRC-20"
   → Set referencia = TX hash / TxID (preferred) or exchange's transaction/order ID
   → Set referencia_type = "tx_hash" if it's a hash, else "other"
   → If sender name visible, use it. Else use "Wallet " + first 6 chars + "..." + last 4 chars of sender address
   → monto_usd = monto_usdt (USDT is 1:1 pegged to USD)
   → monto_bs = null unless explicitly shown

RULE 2 — Zelle (US P2P):
   Signals: "Zelle", "Zelle®", "zellepay.com", payment from a US bank app
   Recipient logic:
   • If recipient field shows "ROFRAMI" (any variant: Roframi Management, Roframi LLC, etc.) → "Zelle Roframi"
   • If recipient shows "MOTOCENTRO" (Motocentro II LLC, etc.) → "Zelle Motocentro"
   • Otherwise → "Zelle Externo"
   referencia_type = "confirmation", referencia = confirmation number

RULE 3 — Wire Transfer:
   Signals: "Wire Transfer", "Wire", "FedWire", "SWIFT", "IBAN", "International transfer", "ACH Credit"
   Recipient logic:
   • "ROFRAMI" → "Wire Transfer Roframi"
   • "PANAMA" or "PAN" or Panamanian bank → "Wire Transfer Panama"
   • "MOTOCENTRO" → "Wire Transfer Motocentro"
   referencia_type = "wire_ref", referencia = FedWire ref / reference number

RULE 4 — Transferencia en Bolívares (Venezuelan bank):
   Signals: "Banesco", "Mercantil", "BOD", "Bicentenario", "Banco de Venezuela", "BNC", "BBVA Provincial"
   Also: "Nro. de operación", "Nro. Op", "Nro. referencia", "Transferencia inmediata", amounts in Bs (bolívares)
   referencia_type = "nro_operacion"

RULE 5 — Efectivo (cash):
   Signals: "RECIBO DE CAJA", "Efectivo", "Cash", "Cobro en efectivo", no bank or electronic info
   referencia_type = "other" or null

RULE 6 — Liquidación PIVCA:
   Signals: "PIVCA", "Liquidación PIVCA", financial institution settlement document
   referencia_type = "other"

RULE 7 — Retención:
   Signals: "Retención", "retencion", "impuesto retenido", withholding tax certificate
   referencia_type = "other"

RULE 8 — None match:
   Set metodo_pago = null, metodo_confidence = "low"

═══════════════════════════════════════════════════════════════════════
REFERENCE NUMBER EXTRACTION — critical for duplicate detection
═══════════════════════════════════════════════════════════════════════

• USDT: prefer the full TxID / TX hash. Fallback: exchange order/transaction ID.
• Zelle: "Confirmation code" / "Confirmation #" — usually 8-12 alphanumeric.
• Wire: "Reference number" / "Transaction ID" / FedWire reference.
• Bolívares: "Nro. de operación" / "Número de referencia" — usually 6-12 digits.
• NEVER invent a reference. If you can't find one clearly, return null.
• Preserve case, dashes, spaces. Trim only leading/trailing whitespace.

═══════════════════════════════════════════════════════════════════════
DATE EXTRACTION
═══════════════════════════════════════════════════════════════════════

• Always return YYYY-MM-DD format.
• If document is Spanish/Venezuelan → interpret "DD/MM/YYYY" as Day/Month/Year.
• If document is English/US → interpret as MM/DD/YYYY.
• Blockchain relative times ("3 hours ago"): assume today's date, set fecha_confidence = "medium".
• If completely unclear, set fecha = null and fecha_confidence = "low".

═══════════════════════════════════════════════════════════════════════
AMOUNT EXTRACTION
═══════════════════════════════════════════════════════════════════════

• monto_usd: the USD amount shown (or USDT amount, since 1:1 peg).
• monto_bs: only if explicitly shown in Venezuelan bolívares. Don't convert.
• Binance shows amounts with European format sometimes (15.586,37 = fifteen thousand five hundred eighty-six point three seven). Parse carefully: if both "," and "." appear, "." is thousand separator and "," is decimal.

═══════════════════════════════════════════════════════════════════════
FINAL CHECKS
═══════════════════════════════════════════════════════════════════════

• metodo_pago MUST match one of the 12 exact strings or be null. Never invent.
• Prefer null + "low" confidence over wrong guesses.
• For crypto, always try to fill crypto_network and wallet_address_to if visible.`
              }
            ]
          }]
        })
      })
      clearTimeout(timeoutId)
      const data = await res.json()
      let text = ''
      if (data.content && Array.isArray(data.content)) { text = data.content.find((b: any) => b.type === 'text')?.text || '' }
      else if (typeof data === 'string') { text = data }
      else if (data.text) { text = data.text }
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)

      // Prefill editable fields with AI values (fall back to parent-provided method)
      setMetodoEdit(parsed.metodo_pago || initialMetodo || '')
      setMontoEdit(parsed.monto_usd != null ? String(parsed.monto_usd) : '')
      setRefEdit(parsed.referencia || '')
      setFechaEdit(parsed.fecha || '')

      // Attach hash and filename for later registration; also normalize keys the
      // old save flow expects (monto/referencia/fecha/notas).
      setResult({
        ...parsed,
        monto: parsed.monto_usd,
        _hash: await computeFileHash(imageFile!),
        _filename: imageFile!.name,
      })
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setError('La IA tardó demasiado. Revisa tu conexión e intenta de nuevo.')
      } else {
        setError('No se pudo leer el comprobante. Por favor ingresa los datos manualmente.')
      }
    }
    setReading(false)
  }

  const buildComentarioFromAI = (): string => {
    if (!result) return ''
    const parts: string[] = []
    if (result.sender_name) parts.push(`De: ${result.sender_name}`)
    if (result.crypto_network) parts.push(`Red: ${result.crypto_network}`)
    if (result.wallet_address_to) parts.push(`Wallet: ${result.wallet_address_to}`)
    if (result.notas) parts.push(result.notas)
    return parts.join(' · ')
  }

  // Confidence pill
  const ConfPill = ({ level }: { level: 'high' | 'medium' | 'low' | undefined }) => {
    if (!level) return null
    const colors = {
      high:   { bg: 'rgba(46,204,138,0.2)',  fg: '#2ecc8a' },
      medium: { bg: 'rgba(184,114,10,0.2)',  fg: '#b8720a' },
      low:    { bg: 'rgba(187,22,43,0.2)',   fg: '#BB162B' },
    }
    const c = colors[level]
    return (
      <span style={{ marginLeft: 8, fontSize: 9, padding: '2px 8px', borderRadius: 10, background: c.bg, color: c.fg, fontWeight: 700 }}>
        {level.toUpperCase()}
      </span>
    )
  }

  if (blockedReason) return <BlockedImageModal reason={blockedReason} onClose={() => { setBlockedReason(''); onCancel() }} />

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', overflowY: 'auto' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '28px', width: '100%', maxWidth: '560px', maxHeight: '95vh', overflowY: 'auto' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Subir Comprobante con IA</div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
          La IA detectará método, monto y referencia automáticamente. Puedes corregir antes de guardar.
        </div>

        {/* Hidden inputs */}
        <input ref={fileRef} type="file" accept="image/*,application/pdf" onChange={handleFile} style={{ display: 'none' }} />
        <input
          ref={(el) => { if (el) (el as any)._isCamera = true }}
          id="camera-input"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFile}
          style={{ display: 'none' }}
        />

        {checking ? (
          <div style={{ border: '2px dashed var(--border)', borderRadius: '12px', padding: '40px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
            <div style={{ marginBottom: '8px' }}>Verificando comprobante...</div>
            <div style={{ fontSize: '11px', color: '#4a9eff' }}>Revisando si ya fue registrado en otro negocio</div>
          </div>
        ) : !image ? (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
              <button
                onClick={() => fileRef.current?.click()}
                style={{ border: '2px dashed var(--border)', borderRadius: '12px', padding: '28px 16px', textAlign: 'center', cursor: 'pointer', background: 'transparent', color: 'var(--text-secondary)', transition: 'border-color 0.2s' }}
              >
                <div style={{ fontSize: '24px', marginBottom: '8px' }}>🖼️</div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Subir Archivo</div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Imagen o PDF</div>
              </button>
              <button
                onClick={() => document.getElementById('camera-input')?.click()}
                style={{ border: '2px dashed rgba(74,158,255,0.4)', borderRadius: '12px', padding: '28px 16px', textAlign: 'center', cursor: 'pointer', background: 'rgba(74,158,255,0.05)', color: 'var(--text-secondary)', transition: 'border-color 0.2s' }}
              >
                <div style={{ fontSize: '24px', marginBottom: '8px' }}>📷</div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#4a9eff', marginBottom: '4px' }}>Tomar Foto</div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Abrir cámara del dispositivo</div>
              </button>
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textAlign: 'center' }}>
              Se verificará automáticamente contra todos los negocios
            </div>
          </div>
        ) : (
          <div>
            {imageFile?.type === 'application/pdf' || imageFile?.name?.endsWith('.pdf') ? (
              <div style={{ width: '100%', padding: '24px', background: 'var(--bg-input)', borderRadius: '8px', border: '1px solid var(--border)', marginBottom: '12px', textAlign: 'center' }}>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>📄</div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>{imageFile?.name}</div>
                <div style={{ fontSize: '11px', color: '#2ecc8a' }}>✓ PDF listo para leer con IA</div>
              </div>
            ) : (
              <img src={image} alt="comprobante" style={{ width: '100%', maxHeight: '200px', objectFit: 'contain', borderRadius: '8px', border: '1px solid var(--border)', marginBottom: '12px' }} />
            )}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => fileRef.current?.click()} style={{ ...s.btnGray, fontSize: '11px', padding: '6px 12px' }}>📎 Cambiar</button>
              <button onClick={() => document.getElementById('camera-input')?.click()} style={{ ...s.btnGray, fontSize: '11px', padding: '6px 12px' }}>📷 Nueva foto</button>
            </div>
          </div>
        )}
        {image && !result && (
          <button onClick={readWithAI} disabled={reading} style={{ ...s.btnRed, width: '100%', marginTop: '12px' }}>
            {reading ? '⏳ Analizando con IA...' : '🤖 Leer con IA'}
          </button>
        )}
        {error && <div style={{ color: '#BB162B', fontSize: '12px', marginTop: '12px', padding: '10px', background: 'rgba(187,22,43,0.1)', borderRadius: '8px' }}>{error}</div>}

        {result && (
          <div style={{ marginTop: '16px' }}>
            {/* ──────── Editable fields (prefilled from AI) ──────── */}

            {/* Método de Pago — critical field, highlighted */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 4, display: 'block' }}>
                Método de Pago
                <ConfPill level={result.metodo_confidence} />
              </label>
              <select
                value={metodoEdit}
                onChange={e => setMetodoEdit(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  background: metodoEdit ? 'var(--bg-input)' : 'rgba(187,22,43,0.08)',
                  border: `1px solid ${metodoEdit ? 'var(--border)' : 'rgba(187,22,43,0.4)'}`,
                  borderRadius: 8,
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  outline: 'none',
                }}
              >
                <option value="">— Selecciona método —</option>
                {METODOS_PAGO.map(m => (
                  <option key={m} value={m}>{m}{result.metodo_pago === m ? ' (sugerido por IA)' : ''}</option>
                ))}
              </select>
            </div>

            {/* Grid: Monto, Fecha, Referencia */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 4, display: 'block' }}>Monto USD</label>
                <input
                  type="number" step="0.01"
                  value={montoEdit}
                  onChange={e => setMontoEdit(e.target.value)}
                  placeholder="0.00"
                  style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none' }}
                />
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 4, display: 'block' }}>
                  Fecha
                  <ConfPill level={result.fecha_confidence} />
                </label>
                <input
                  type="date"
                  value={fechaEdit}
                  onChange={e => setFechaEdit(e.target.value)}
                  style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none' }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 4, display: 'block' }}>
                Referencia
                {result.referencia_type && (
                  <span style={{ marginLeft: 8, fontSize: 9, padding: '2px 8px', borderRadius: 10, background: 'rgba(59,130,246,0.15)', color: '#3B82F6', fontWeight: 700 }}>
                    {result.referencia_type === 'tx_hash' ? 'TX HASH' :
                     result.referencia_type === 'confirmation' ? 'CONFIRMATION' :
                     result.referencia_type === 'wire_ref' ? 'WIRE REF' :
                     result.referencia_type === 'nro_operacion' ? 'NRO. OPERACIÓN' : 'REF'}
                  </span>
                )}
              </label>
              <input
                type="text"
                value={refEdit}
                onChange={e => setRefEdit(e.target.value)}
                placeholder="Número de referencia, confirmación o TX hash"
                style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none', fontFamily: result.referencia_type === 'tx_hash' ? 'monospace' : undefined }}
              />
            </div>

            {/* AI-detected context (read-only) */}
            {(result.sender_name || result.crypto_network || result.wallet_address_to || result.notas) && (
              <div style={{ background: 'var(--bg-input)', borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 11 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 }}>Detalles IA</div>
                {[
                  ['Remitente', result.sender_name],
                  ['Red cripto', result.crypto_network],
                  ['Wallet destino', result.wallet_address_to],
                  ['Notas', result.notas],
                ].filter(([, v]) => v).map(([l, v]) => (
                  <div key={l as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{l}</span>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', maxWidth: '70%', fontFamily: (l === 'Wallet destino' || l === 'Red cripto') ? 'monospace' : undefined }}>{v as string}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
              <button
                onClick={() => {
                  if (!metodoEdit) { alert('Por favor selecciona el método de pago.'); return }
                  const montoVal = parseFloat(montoEdit)
                  if (isNaN(montoVal) || montoVal <= 0) { alert('Monto USD debe ser mayor a cero.'); return }
                  onConfirm({
                    ...result,
                    // Overrides applied by the user in the review UI
                    metodo: metodoEdit,
                    monto: montoVal,
                    referencia: refEdit.trim(),
                    fecha: fechaEdit,
                    comentario: buildComentarioFromAI(),
                    imagen: image,
                    file: imageFile,  // 2026-05-07: pass File through for storage upload
                    _hash: result._hash || imageHash,
                    _filename: result._filename || imageFile?.name,
                  })
                }}
                style={{ ...s.btnGreen, flex: 2, fontSize: '12px', opacity: metodoEdit ? 1 : 0.5, cursor: metodoEdit ? 'pointer' : 'not-allowed' }}
              >
                ✓ Confirmar y Agregar
              </button>
              <button onClick={() => { setResult(null); setMetodoEdit(initialMetodo || ''); setMontoEdit(''); setRefEdit(''); setFechaEdit('') }} style={{ ...s.btnGray, fontSize: '12px' }}>Volver a leer</button>
            </div>
          </div>
        )}
        <button onClick={onCancel} style={{ ...s.btnGray, width: '100%', marginTop: '12px' }}>Cancelar</button>
      </div>
    </div>
  )
}

// ── MULTI COMPROBANTE MODAL ───────────────────────────────────────────────────
type MultiItem = {
  id: string
  file: File
  image: string
  hash: string
  status: 'pending' | 'reading' | 'done' | 'blocked' | 'error'
  result: any
  blockedReason?: string
}

function MultiComprobanteModal({ metodo, currentDealId, currentNegocioNum, existingHashes, onConfirmAll, onCancel }: {
  metodo: string
  currentDealId?: string
  currentNegocioNum?: string
  existingHashes: string[]
  onConfirmAll: (items: MultiItem[]) => void
  onCancel: () => void
}) {
  const [items, setItems] = useState<MultiItem[]>([])
  const [processing, setProcessing] = useState(false)
  const [allDone, setAllDone] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).slice(0, 20)
    if (!files.length) return
    setAllDone(false)
    setProcessing(true)

    // Build initial items with hashes
    const newItems: MultiItem[] = []
    for (const file of files) {
      const hash = await computeFileHash(file)
      const image = await new Promise<string>(res => {
        const r = new FileReader()
        r.onload = ev => res(ev.target?.result as string)
        r.readAsDataURL(file)
      })
      newItems.push({ id: hash + file.name, file, image, hash, status: 'pending', result: null })
    }

    // Merge with existing items (don't reset already processed ones)
    setItems(prev => {
      const existingIds = new Set(prev.map(i => i.id))
      return [...prev, ...newItems.filter(i => !existingIds.has(i.id))]
    })

    // Process each new item
    for (const item of newItems) {
      // Check duplicate against DB
      const dupCheck = await checkImageDuplicate(item.hash, item.file.name, currentDealId)
      if (dupCheck.isDuplicate) {
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'blocked', blockedReason: dupCheck.reason } : i))
        continue
      }
      // Check duplicate within this deal (existing pagos)
      if (existingHashes.includes(item.hash)) {
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'blocked', blockedReason: 'Este comprobante ya fue adjuntado a un pago en este negocio.' } : i))
        continue
      }
      // Read with AI
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'reading' } : i))
      try {
        const base64 = item.image.split(',')[1]
        const isPdf = item.file.type === 'application/pdf' || item.file.name.toLowerCase().endsWith('.pdf')
        const res = await fetch('https://autocore-comprobante.sano-franco.workers.dev', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base64,
            mediaType: isPdf ? 'application/pdf' : (item.file.type || 'image/jpeg'),
            isPdf,  // 2026-05-07: required so worker sends as type:document not type:image
            metodo,
          })
        })
        const data = await res.json()
        let text = ''
        if (data.content && Array.isArray(data.content)) text = data.content.find((b: any) => b.type === 'text')?.text || ''
        else if (data.text) text = data.text
        else if (typeof data === 'string') text = data
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'done', result: { ...parsed, _hash: item.hash, _filename: item.file.name } } : i))
      } catch {
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'error' } : i))
      }
    }

    setProcessing(false)
    setAllDone(true)
    if (fileRef.current) fileRef.current.value = ''
  }

  const removeItem = (id: string) => setItems(prev => prev.filter(i => i.id !== id))

  const readyItems = items.filter(i => i.status === 'done')
  const blockedItems = items.filter(i => i.status === 'blocked')
  const errorItems = items.filter(i => i.status === 'error')
  const pendingItems = items.filter(i => i.status === 'pending' || i.status === 'reading')

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', overflowY: 'auto' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '28px', width: '100%', maxWidth: '640px', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Subir Múltiples Comprobantes</div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '20px' }}>{metodo} — Hasta 20 imágenes a la vez</div>

        {/* Upload button */}
        <input ref={fileRef} type="file" accept="image/*" multiple onChange={handleFiles} style={{ display: 'none' }} />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={processing}
          style={{ width: '100%', border: '2px dashed var(--border)', borderRadius: '12px', padding: '20px', textAlign: 'center', cursor: processing ? 'not-allowed' : 'pointer', background: 'transparent', color: 'var(--text-secondary)', marginBottom: '20px', opacity: processing ? 0.5 : 1 }}
        >
          <div style={{ fontSize: '24px', marginBottom: '6px' }}>🖼️</div>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px' }}>
            {items.length > 0 ? 'Agregar más imágenes' : 'Seleccionar imágenes (hasta 20)'}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>La IA leerá cada comprobante automáticamente</div>
        </button>

        {/* Progress summary */}
        {items.length > 0 && (
          <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' as const }}>
            {readyItems.length > 0 && <span style={{ fontSize: '11px', padding: '4px 10px', background: 'rgba(46,204,138,0.15)', color: '#2ecc8a', borderRadius: '20px', fontWeight: 700 }}>✓ {readyItems.length} listos</span>}
            {pendingItems.length > 0 && <span style={{ fontSize: '11px', padding: '4px 10px', background: 'rgba(74,158,255,0.15)', color: '#4a9eff', borderRadius: '20px', fontWeight: 700 }}>⏳ {pendingItems.length} procesando</span>}
            {blockedItems.length > 0 && <span style={{ fontSize: '11px', padding: '4px 10px', background: 'rgba(187,22,43,0.15)', color: '#BB162B', borderRadius: '20px', fontWeight: 700 }}>✕ {blockedItems.length} bloqueados</span>}
            {errorItems.length > 0 && <span style={{ fontSize: '11px', padding: '4px 10px', background: 'rgba(184,114,10,0.15)', color: '#b8720a', borderRadius: '20px', fontWeight: 700 }}>⚠ {errorItems.length} con error</span>}
          </div>
        )}

        {/* Item list */}
        {items.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '10px', marginBottom: '20px' }}>
            {items.map(item => (
              <div key={item.id} style={{
                display: 'flex', gap: '12px', alignItems: 'flex-start',
                padding: '12px 14px', borderRadius: '10px',
                border: `1px solid ${item.status === 'done' ? 'rgba(46,204,138,0.3)' : item.status === 'blocked' ? 'rgba(187,22,43,0.3)' : item.status === 'error' ? 'rgba(184,114,10,0.3)' : 'var(--border)'}`,
                background: item.status === 'done' ? 'rgba(46,204,138,0.05)' : item.status === 'blocked' ? 'rgba(187,22,43,0.05)' : item.status === 'error' ? 'rgba(184,114,10,0.05)' : 'var(--bg-input)',
              }}>
                <img src={item.image} alt="" style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '6px', border: '1px solid var(--border)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{item.file.name}</div>
                  {item.status === 'reading' && <div style={{ fontSize: '12px', color: '#4a9eff' }}>⏳ Leyendo con IA...</div>}
                  {item.status === 'pending' && <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>En cola...</div>}
                  {item.status === 'blocked' && <div style={{ fontSize: '12px', color: '#BB162B' }}>✕ {item.blockedReason}</div>}
                  {item.status === 'error' && <div style={{ fontSize: '12px', color: '#b8720a' }}>⚠ No se pudo leer. Se omitirá.</div>}
                  {item.status === 'done' && item.result && (
                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' as const }}>
                      <span style={{ fontSize: '12px', color: '#2ecc8a', fontWeight: 700 }}>{item.result.monto ? fmt(item.result.monto) : '—'}</span>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Ref: {item.result.referencia || '—'}</span>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{item.result.fecha ? fmtDate(item.result.fecha) : '—'}</span>
                    </div>
                  )}
                </div>
                {(item.status === 'done' || item.status === 'error' || item.status === 'blocked') && (
                  <button onClick={() => removeItem(item.id)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '16px', padding: '0', flexShrink: 0 }}>✕</button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '10px' }}>
          {readyItems.length > 0 && (
            <button
              onClick={() => onConfirmAll(readyItems)}
              disabled={processing}
              style={{ ...s.btnGreen, flex: 1 }}
            >
              Agregar {readyItems.length} Pago{readyItems.length !== 1 ? 's' : ''}
            </button>
          )}
          <button onClick={onCancel} style={{ ...s.btnGray, flex: readyItems.length > 0 ? '0 0 auto' : 1 }}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}

function DuplicateModal({ message, onConfirm, onCancel }: { message: string, onConfirm: () => void, onCancel: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid rgba(184,114,10,0.4)', borderRadius: '16px', padding: '28px', width: '100%', maxWidth: '420px', textAlign: 'center' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: '#b8720a', marginBottom: '8px' }}>Pago Duplicado Detectado</div>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '20px', lineHeight: '1.6' }}>{message}</div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onCancel} style={{ ...s.btnGray, flex: 1 }}>Cancelar</button>
          <button onClick={onConfirm} style={{ ...s.btnRed, flex: 1 }}>Agregar de todas formas</button>
        </div>
      </div>
    </div>
  )
}

function PrintPreview({ deal, totals, onClose }: { deal: Deal, totals: any, onClose: () => void }) {
  const resultColor = totals.resultado_tipo === 'CUADRADO' ? '#1a7a4a' : totals.resultado_tipo === 'FALTANTE' ? '#BB162B' : '#b8720a'

  const handlePrint = () => {
    const printWindow = window.open('', '_blank')
    if (!printWindow) return
    printWindow.document.write(`
      <!DOCTYPE html><html><head>
      <title>Auditoría #${deal.negocio_num || '—'}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; font-size: 11px; color: #000; padding: 20px 24px; }
        @page { size: letter portrait; margin: 12mm 14mm; }
        .header { border-bottom: 3px solid #BB162B; padding-bottom: 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-end; }
        .company { font-size: 22px; font-weight: 900; letter-spacing: 3px; color: #05141F; }
        .branch { font-size: 13px; font-weight: 700; color: #BB162B; letter-spacing: 2px; }
        .banner { padding: 8px 16px; border-radius: 6px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; background: ${resultColor}; color: #fff; }
        .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
        .box { border: 1px solid #ddd; border-radius: 6px; padding: 10px; }
        .box.green { border-color: #2ecc8a; }
        .box-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #eee; color: #BB162B; }
        .box-title.green { color: #1a7a4a; border-bottom-color: #d4f5e7; }
        .box-title.dark { color: #05141F; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .info-label { font-size: 8px; color: #999; text-transform: uppercase; }
        .info-value { font-weight: 600; font-size: 11px; }
        .row { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #f5f5f5; }
        .total-row { display: flex; justify-content: space-between; padding: 6px 0 0; margin-top: 4px; border-top: 2px solid #05141F; font-weight: 700; }
        .total-row.green { border-top-color: #1a7a4a; color: #1a7a4a; }
        table { width: 100%; border-collapse: collapse; font-size: 11px; }
        th { padding: 4px 8px; text-align: left; font-size: 9px; font-weight: 700; text-transform: uppercase; color: #666; background: #f5f5f5; }
        td { padding: 4px 8px; border-bottom: 1px solid #f0f0f0; }
        .tfoot-row td { border-top: 2px solid #000; font-weight: 700; padding: 6px 8px; border-bottom: none; }
        .signatures { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; margin-top: 24px; }
        .sig { text-align: center; border-top: 1px solid #000; padding-top: 6px; font-size: 10px; color: #555; text-transform: uppercase; }
        .footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #eee; text-align: center; font-size: 9px; color: #aaa; }
      </style></head><body>
      <div class="header">
        <div><div class="company">KIA MARACAY</div><div class="branch">MOTOCENTRO II</div><div style="font-size:10px;color:#666;margin-top:2px">Auditoría de Negocio</div></div>
        <div style="text-align:right"><div style="font-size:18px;font-weight:900;color:#05141F">#${deal.negocio_num || '—'}</div><div style="font-size:10px;color:#666">Factura: ${deal.fecha_factura ? fmtDate(deal.fecha_factura) : '—'}</div><div style="font-size:10px;color:#666">Entrega: ${deal.fecha_entrega ? fmtDate(deal.fecha_entrega) : '—'}</div></div>
      </div>
      <div class="banner">
        <div style="font-size:16px;font-weight:900;letter-spacing:2px">${totals.resultado_tipo}</div>
        <div style="display:flex;gap:20px;font-size:11px">
          <span>Proyecto: <strong>${fmt(totals.pv_total)}</strong></span>
          <span>Auditoría: <strong>${fmt(totals.au_total)}</strong></span>
          <span>Ingresos: <strong>${fmt(totals.total_ingresos)}</strong></span>
          <span>Neto: <strong>${fmt(Math.abs(totals.neto))}</strong></span>
        </div>
      </div>
      <div class="grid2">
        <div class="box"><div class="box-title">Cliente</div><div class="info-grid">
          <div><div class="info-label">Nombre</div><div class="info-value">${deal.cliente_nombre || '—'}</div></div>
          <div><div class="info-label">RIF / Cédula</div><div class="info-value">${deal.cliente_rif_tipo}-${deal.cliente_rif || '—'}</div></div>
          <div><div class="info-label">Vendedor</div><div class="info-value">${deal.vendedor || '—'}</div></div>
          <div><div class="info-label">VIN</div><div class="info-value">${deal.vin || '—'}</div></div>
        </div></div>
        <div class="box"><div class="box-title">Financiamiento</div><div class="info-grid">
          <div><div class="info-label">Banco</div><div class="info-value">${deal.banco || '—'}</div></div>
          <div><div class="info-label">Tasa BCV</div><div class="info-value">${deal.tasa_bcv || '—'}</div></div>
          <div><div class="info-label">Tasa Variable</div><div class="info-value">${deal.tasa_variable || '—'}</div></div>
          <div><div class="info-label">Monto Financiar</div><div class="info-value">${deal.pv_monto_financiar ? fmt(deal.pv_monto_financiar) : '—'}</div></div>
        </div></div>
      </div>
      <div class="grid2">
        <div class="box"><div class="box-title dark">Proyecto de Venta</div>
          ${PROYECTO_FIELDS.map(f => `<div class="row"><span>${f.label}</span><span>${(deal as any)[f.key] ? fmt((deal as any)[f.key]) : '$0.00'}</span></div>`).join('')}
          <div class="total-row"><span>TOTAL</span><span>${fmt(totals.pv_total)}</span></div>
        </div>
        <div class="box green"><div class="box-title green">Auditoría — Números Reales</div>
          ${AUDITORIA_FIELDS.map(f => `<div class="row"><span>${f.label}</span><span>${(deal as any)[f.key] ? fmt((deal as any)[f.key]) : '$0.00'}</span></div>`).join('')}
          ${totals.igtf_recovered > 0 ? `<div class="row" style="color:#1a7a4a;font-weight:700"><span>IGTF Recuperado (en factura)</span><span>${fmt(totals.igtf_recovered)}</span></div>` : ''}
          <div class="total-row green"><span>TOTAL</span><span>${fmt(totals.au_total)}</span></div>
        </div>
      </div>
      ${deal.pagos.length > 0 ? `
      <div class="box" style="margin-bottom:14px">
        <div class="box-title">Ingresos Recibidos</div>
        <table><thead><tr><th>Fecha</th><th>Método</th><th>USD</th><th>Bs</th><th>Referencia</th></tr></thead>
        <tbody>${deal.pagos.map((p: any) => `<tr><td>${p.fecha ? fmtDate(p.fecha) : '—'}</td><td>${p.metodo}</td><td><strong>${fmt(parseFloat(p.monto_usd) || 0)}</strong></td><td>${fmtBs(parseFloat(p.monto_bs) || 0)}</td><td>${p.referencia || '—'}</td></tr>`).join('')}</tbody>
        <tfoot><tr class="tfoot-row"><td colspan="2">TOTAL INGRESOS</td><td>${fmt(totals.total_ingresos)}</td><td colspan="2"></td></tr></tfoot>
        </table>
      </div>` : ''}
      <div class="signatures"><div class="sig">Vendedor</div><div class="sig">Auditoría</div><div class="sig">Gerencia</div></div>
      <div class="footer">KIA Maracay — Motocentro II · Generado por AutoCore NPA · ${new Date().toLocaleDateString('es-VE')}</div>
      </body></html>
    `)
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => { printWindow.print() }, 500)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, overflowY: 'auto', padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', marginBottom: '20px' }}>
        <button onClick={handlePrint} style={{ padding: '12px 32px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>IMPRIMIR</button>
        <button onClick={onClose} style={{ padding: '12px 32px', background: 'transparent', color: '#fff', border: '1px solid #555', borderRadius: '8px', fontSize: '14px', cursor: 'pointer' }}>Cerrar</button>
      </div>
      <div style={{ background: '#fff', color: '#000', maxWidth: '800px', margin: '0 auto', padding: '28px 32px', fontFamily: 'Arial, sans-serif', fontSize: '11px', boxShadow: '0 4px 24px rgba(0,0,0,0.3)', borderRadius: '8px' }}>
        <div style={{ textAlign: 'center', padding: '40px', color: '#666', fontSize: '13px' }}>Haz clic en <strong>IMPRIMIR</strong> para ver el documento completo.</div>
      </div>
    </div>
  )
}


// ── BUYER DOC SCANNER ────────────────────────────────────────────────────────
function BuyerDocScanner({ onExtracted, onFile }: {
  onExtracted: (data: any) => void
  onFile?: (file: File, suggestedType: 'factura' | 'cdo' | 'cedula') => Promise<void> | void
}) {
  const [scanning, setScanning] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setScanning(true)
    setError('')
    setDone(false)
    try {
      const base64 = await new Promise<string>((res, rej) => {
        const r = new FileReader()
        r.onload = ev => res((ev.target?.result as string).split(',')[1])
        r.onerror = rej
        r.readAsDataURL(file)
      })
      const isPdf = file.type === 'application/pdf' || file.name.endsWith('.pdf')
      const mediaType = isPdf ? 'application/pdf' : (file.type || 'image/jpeg')
      const contentBlock = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }

      const res = await fetch('https://autocore-comprobante.sano-franco.workers.dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: [
              contentBlock,
              {
                type: 'text',
                text: `This is a Venezuelan cédula de identidad, factura de vehículo, or certificado de origen.
Extract all available information and respond ONLY with a JSON object:
{
  "cliente_nombre": "first names only",
  "cliente_apellidos": "last names only",
  "cliente_rif": "number only no dashes",
  "cliente_rif_tipo": "V|J|E|G",
  "cliente_direccion": "full address or null",
  "cliente_telefono": "phone or null",
  "cliente_email": "email or null",
  "cliente_estado_civil": "Soltero/a|Casado/a|Divorciado/a|Viudo/a or null",
  "vehiculo_marca": "brand or null",
  "vehiculo_modelo": "model or null",
  "vehiculo_color": "color or null",
  "vehiculo_placa": "plate or null",
  "vehiculo_año": "AÑO MODELO as integer — typically labeled 'Año:' or 'Año Modelo' on the FACTURA. This is the model year of the vehicle. e.g. 2026. Null if not visible.",
  "vehiculo_año_fabricacion": "AÑO DE FABRICACIÓN as integer — typically labeled 'Año Fabricación' or 'Fabricación' on the CERTIFICADO DE ORIGEN (CDO). This is the year the unit was manufactured (may differ from año modelo). e.g. 2025. Null if not visible.",
  "vehiculo_clase": "class or null",
  "vehiculo_uso": "PARTICULAR|CARGA|TRANSPORTE PÚBLICO or null",
  "vin": "VIN/serial carroceria or null"
}
IMPORTANT: vehiculo_año (Año Modelo) and vehiculo_año_fabricacion (Año Fabricación) are TWO DIFFERENT fields. The factura usually shows Año Modelo. The CDO usually shows Año Fabricación. Do not confuse them.
If a field is not visible, use null. No markdown, no extra text.`
              }
            ]
          }]
        })
      })
      const data = await res.json()
      const text = data.content?.[0]?.text || '{}'
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
      // Remove null values before passing
      const filtered = Object.fromEntries(Object.entries(parsed).filter(([_, v]) => v !== null && v !== ''))
      onExtracted(filtered)
      // 2026-05-07: also persist the source file to storage if parent provided callback.
      // Best-effort: classify by filename; default to 'factura' since this scanner is
      // most often used to attach factura/CDO/cédula on an existing deal.
      if (onFile) {
        const suggestedType = classifyDocFromFilename(file.name) || 'factura'
        try { await onFile(file, suggestedType) } catch (uplErr) { console.warn('[BuyerDocScanner] onFile failed:', uplErr) }
      }
      setDone(true)
      setTimeout(() => setDone(false), 3000)
    } catch (e: any) {
      setError('Error al leer el documento. Intente de nuevo.')
    }
    setScanning(false)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <input ref={fileRef} type="file" accept="image/*,application/pdf" onChange={handleFile} style={{ display: 'none' }} />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={scanning}
        style={{
          padding: '8px 18px', borderRadius: 8, border: '1.5px solid rgba(74,158,255,0.5)',
          background: 'rgba(74,158,255,0.08)', color: '#4a9eff',
          fontSize: 12, fontWeight: 700, cursor: scanning ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', gap: 7, opacity: scanning ? 0.7 : 1,
        }}
      >
        {scanning
          ? <><span className="spinner" style={{ borderColor: 'rgba(74,158,255,0.3)', borderTopColor: '#4a9eff' }} /> Leyendo documento...</>
          : '🪪 Escanear Cédula / Factura con IA'}
      </button>
      {done && <span style={{ fontSize: 12, color: '#2ecc8a', fontWeight: 600 }}>✓ Datos extraídos</span>}
      {error && <span style={{ fontSize: 12, color: '#BB162B' }}>{error}</span>}
    </div>
  )
}

// ── NEW DEAL SCANNER ──────────────────────────────────────────────────────────
// ★ FIX #3: AI now extracts MONTO TOTAL A PAGAR USD (authoritative price per business rules)
// ── NEW DEAL SCANNER ──────────────────────────────────────────────────────────
// ★ FIX (2026-04-29): Field component must live OUTSIDE NewDealScanner. When defined
// inside the parent's render body, every keystroke recreates the function reference,
// causing React to unmount/remount the <input>, which loses focus and captures only
// the first character. Defining it at module level keeps the component identity stable.
function ScannerField({ label, k, extracted, setExtracted }: {
  label: string
  k: string
  extracted: any
  setExtracted: React.Dispatch<React.SetStateAction<any>>
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, display: 'block', marginBottom: 4 }}>{label}</label>
      <input
        value={extracted[k] || ''}
        onChange={e => setExtracted((x: any) => ({ ...x, [k]: e.target.value }))}
        style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
      />
    </div>
  )
}

// ── NEW-DEAL SCANNER (C build, 2026-06-15) ──────────────────────────────────
// Three mandatory document slots (Factura · CDO · Cédula). Each file is dropped
// into a named slot — no filename guessing. Factura and Cédula are AI-verified
// with ONE scan:'auto' read each: the read both confirms the doc matches its slot
// AND extracts its fields. The Factura read feeds the form, the reportes columns,
// and the itemization (precio_vehiculo / gastos_admin / seguro) all at once — so
// there is no second extractVentaFields read. CDO is store-only (the worker has
// no CDO classifier); año_fabricación is a manual field in review.
function NewDealScanner({ user, onCreated, onCancel }: { user: any, onCreated: (deal: any) => void, onCancel: () => void }) {
  type SlotKey = 'factura' | 'cdo' | 'cedula'
  type SlotState = { file: File | null, status: 'empty' | 'verifying' | 'ok' | 'mismatch' | 'error', msg?: string }
  const mkEmpty = (): SlotState => ({ file: null, status: 'empty' })

  const [slots, setSlots] = useState<Record<SlotKey, SlotState>>({ factura: mkEmpty(), cdo: mkEmpty(), cedula: mkEmpty() })
  const [step, setStep] = useState<'slots' | 'review' | 'saving'>('slots')
  const [extracted, setExtracted] = useState<any>({})
  const [error, setError] = useState('')

  const facturaRef = useRef<HTMLInputElement>(null)
  const cdoRef = useRef<HTMLInputElement>(null)
  const cedulaRef = useRef<HTMLInputElement>(null)

  // One scan:'auto' read, with an abort timeout for flaky VE internet. Returns documents[].
  async function scanAuto(file: File): Promise<any[]> {
    const b64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = ev => resolve(((ev.target?.result as string) || '').split(',')[1] || '')
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 45000)
    try {
      const res = await fetch('https://autocore-comprobante.sano-franco.workers.dev', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ scan: 'auto', base64: b64, mediaType: isPdf ? 'application/pdf' : (file.type || 'image/jpeg'), isPdf }),
      })
      const json = await res.json().catch(() => null)
      return Array.isArray(json?.documents) ? json.documents : []
    } finally { clearTimeout(timer) }
  }

  // Map factura_venta.extracted → the review-form keys, and stash the raw reportes
  // columns under _venta so handleCreate writes them without a second AI read.
  function applyFactura(v: any) {
    setExtracted((x: any) => ({
      ...x,
      negocio_num:        v.factura_venta_numero ?? x.negocio_num,
      fecha_factura:      v.factura_venta_fecha ?? x.fecha_factura,
      monto_total_pagar:  v.factura_venta_total ?? x.monto_total_pagar,
      precio_vehiculo:    v.precio_vehiculo ?? x.precio_vehiculo,
      gastos_administrativos: v.gastos_administrativos ?? x.gastos_administrativos,
      seguro_monto:       v.seguro_monto ?? x.seguro_monto,
      igtf_monto:         v.factura_venta_igtf_real ?? x.igtf_monto,
      cliente_nombre:     v.cliente_nombre ?? x.cliente_nombre,
      cliente_apellidos:  v.cliente_apellidos ?? x.cliente_apellidos,
      cliente_rif:        v.cliente_rif ?? x.cliente_rif,
      cliente_rif_tipo:   v.cliente_rif_tipo ?? x.cliente_rif_tipo,
      cliente_direccion:  v.cliente_direccion ?? x.cliente_direccion,
      cliente_telefono:   v.cliente_telefono ?? x.cliente_telefono,
      cliente_email:      v.cliente_email ?? x.cliente_email,
      vehiculo_marca:     v.vehiculo_marca ?? x.vehiculo_marca,
      vehiculo_modelo:    v.vehiculo_modelo ?? x.vehiculo_modelo,
      vehiculo_año:       v.vehiculo_año ?? x.vehiculo_año,
      vehiculo_color:     v.vehiculo_color ?? x.vehiculo_color,
      vehiculo_placa:     v.vehiculo_placa ?? x.vehiculo_placa,
      vehiculo_clase:     v.vehiculo_clase ?? x.vehiculo_clase,
      vehiculo_uso:       v.vehiculo_uso ?? x.vehiculo_uso,
      vin:                v.vin ?? x.vin,
      _venta: {
        factura_venta_numero:    v.factura_venta_numero,
        factura_venta_control:   v.factura_venta_control,
        factura_venta_body_neto: v.factura_venta_body_neto,
        factura_venta_iva:       v.factura_venta_iva,
        factura_venta_igtf_real: v.factura_venta_igtf_real,
        factura_venta_tasa_bcv:  v.factura_venta_tasa_bcv,
        factura_venta_placa:     v.factura_venta_placa,
        factura_venta_total:     v.factura_venta_total,
        factura_venta_modo_igtf: v.factura_venta_modo_igtf,
      },
    }))
  }

  // Cédula fills client fields the factura doesn't carry (estado_civil) and confirms identity.
  function applyCedula(v: any) {
    setExtracted((x: any) => ({
      ...x,
      cliente_nombre:       x.cliente_nombre || v.nombre || '',
      cliente_apellidos:    x.cliente_apellidos || v.apellidos || '',
      cliente_rif:          x.cliente_rif || v.rif || '',
      cliente_rif_tipo:     x.cliente_rif_tipo || v.rif_tipo || 'V',
      cliente_estado_civil: x.cliente_estado_civil || v.estado_civil || '',
    }))
  }

  async function handleSlotFile(slot: SlotKey, file: File | undefined) {
    if (!file) return
    setError('')
    // CDO: store-only (worker can't classify a Certificado de Origen).
    if (slot === 'cdo') { setSlots(s => ({ ...s, cdo: { file, status: 'ok' } })); return }

    setSlots(s => ({ ...s, [slot]: { file, status: 'verifying' } }))
    try {
      const docs = await scanAuto(file)
      const wantType = slot === 'factura' ? 'factura_venta' : 'cedula'
      const hit = docs.find((d: any) => d?.type === wantType)?.extracted || null
      if (!hit) {
        const detected = docs.map((d: any) => d?.type).filter(Boolean)
        const human = (t: string) => t === 'factura_venta' ? 'una factura de venta' : t === 'factura_compra' ? 'una factura de compra (de KIA)' : t === 'cedula' ? 'una cédula' : 'otro documento'
        const want = slot === 'factura' ? 'una factura de venta' : 'una cédula'
        const msg = detected.length
          ? `Esto parece ${human(detected[0])}, no ${want}. Sube el documento correcto en este espacio.`
          : `No se reconoció ${want}. Verifica que la foto sea clara y completa, e intenta de nuevo.`
        setSlots(s => ({ ...s, [slot]: { file, status: 'mismatch', msg } }))
        return
      }
      if (slot === 'factura') applyFactura(hit)
      else applyCedula(hit)
      setSlots(s => ({ ...s, [slot]: { file, status: 'ok' } }))
    } catch {
      setSlots(s => ({ ...s, [slot]: { file, status: 'error', msg: 'Error al leer el documento. Revisa tu conexión e intenta de nuevo.' } }))
    }
  }

  const allReady = slots.factura.status === 'ok' && slots.cedula.status === 'ok' && slots.cdo.status === 'ok'
  const anyVerifying = slots.factura.status === 'verifying' || slots.cedula.status === 'verifying'

  async function handleCreate() {
    if (!allReady) { setError('Faltan documentos. Factura, CDO y Cédula son obligatorios, y Factura/Cédula deben quedar verificadas.'); return }
    if (!extracted.negocio_num) { setError('No se detectó el número de factura. Corrígelo en la revisión.'); return }
    setStep('saving'); setError('')

    const totalAuditado = extracted.monto_total_pagar || extracted.precio_vehiculo || 0
    const precioBase = extracted.precio_vehiculo || extracted.monto_total_pagar || 0
    const payload = {
      negocio_num:          extracted.negocio_num || null,
      fecha_factura:        extracted.fecha_factura || null,
      cliente_nombre:       extracted.cliente_nombre || null,
      cliente_apellidos:    extracted.cliente_apellidos || null,
      cliente_rif:          extracted.cliente_rif || null,
      cliente_rif_tipo:     extracted.cliente_rif_tipo || 'V',
      cliente_direccion:    extracted.cliente_direccion || null,
      cliente_telefono:     extracted.cliente_telefono || null,
      cliente_email:        extracted.cliente_email || null,
      cliente_estado_civil: extracted.cliente_estado_civil || null,
      vehiculo_marca:       extracted.vehiculo_marca || 'KIA',
      vehiculo_modelo:      extracted.vehiculo_modelo || null,
      vehiculo_color:       extracted.vehiculo_color || null,
      vehiculo_placa:       extracted.vehiculo_placa || null,
      vehiculo_año:         extracted.vehiculo_año || null,
      vehiculo_año_fabricacion: extracted.vehiculo_año_fabricacion || null,
      vehiculo_clase:       extracted.vehiculo_clase || null,
      vehiculo_uso:         extracted.vehiculo_uso || 'PARTICULAR',
      vin:                  extracted.vin || null,
      au_precio:            precioBase,
      pv_precio:            precioBase,
      au_gastos_admin:      extracted.gastos_administrativos || 0,
      pv_gastos_admin:      extracted.gastos_administrativos || 0,
      au_seguro:            extracted.seguro_monto || 0,
      pv_seguro:            extracted.seguro_monto || 0,
      au_igtf:              extracted.igtf_monto || 0,
      pv_igtf:              extracted.igtf_monto || 0,
      total_cliente:        totalAuditado,
      pagos:                [],
      status:               'BORRADOR',
      created_by:           user.id,
      tasa_bcv:             null,
      vendedor:             null,
      banco:                null,
    }
    const { data, error } = await supabase.from('deals').insert(payload).select('*').single()
    if (error) { setError('Error al crear: ' + error.message); setStep('review'); return }

    const dealId = data.id
    const negocioNum = data.negocio_num || null
    const meta: Record<string, any> = {}
    const uploadFails: string[] = []

    // Upload each file to its OWN slot — no filename guessing, no clobbering.
    const slotFiles: Array<[SlotKey, File | null]> = [
      ['factura', slots.factura.file],
      ['cdo',     slots.cdo.file],
      ['cedula',  slots.cedula.file],
    ]
    for (const [type, f] of slotFiles) {
      if (!f) continue
      const result = await uploadDealDoc({ file: f, negocioNum, dealId, type })
      if (result.error) uploadFails.push(`${type}: ${result.error}`)
      else if (result.path) {
        meta[type] = {
          path: result.path, ext: result.ext, mime: result.mime,
          uploaded_by: user?.id || null, uploaded_at: new Date().toISOString(),
          source_filename: f.name,
        }
      }
    }
    if (Object.keys(meta).length > 0) {
      const { error: metaErr } = await supabase.from('deals').update({ documentos_meta: meta }).eq('id', dealId)
      if (metaErr) uploadFails.push(`documentos_meta: ${metaErr.message}`)
    }

    // Feed reportes from the SAME factura read captured at slot time — no second AI call.
    const venta = extracted._venta || null
    if (venta) {
      const patch: Record<string, any> = {}
      const setIf = (k: string) => { const val = venta[k]; if (val !== null && val !== undefined && val !== '') patch[k] = val }
      ;['factura_venta_numero', 'factura_venta_control', 'factura_venta_body_neto', 'factura_venta_iva',
        'factura_venta_igtf_real', 'factura_venta_tasa_bcv', 'factura_venta_placa', 'factura_venta_total',
        'factura_venta_modo_igtf'].forEach(setIf)
      if (Object.keys(patch).length > 0) {
        const { error: vErr } = await supabase.from('deals').update(patch).eq('id', dealId)
        if (vErr) console.warn('[NewDealScanner] venta→reportes feed failed:', vErr.message)
      }
    }

    if (uploadFails.length > 0) {
      console.warn('[NewDealScanner] some documents failed to upload:', uploadFails)
      alert('Negocio creado, pero algunos documentos no se pudieron archivar:\n\n' + uploadFails.join('\n') + '\n\nVuelve a escanearlos desde el detalle del negocio.')
    }

    onCreated(data)
  }

  const SLOT_META: Record<SlotKey, { label: string, emoji: string, hint: string, req: boolean }> = {
    factura: { label: 'Factura de Venta', emoji: '📋', hint: 'Se verifica con IA y alimenta el negocio y los reportes', req: true },
    cdo:     { label: 'Certificado de Origen', emoji: '📜', hint: 'Se archiva en el negocio', req: true },
    cedula:  { label: 'Cédula / RIF', emoji: '🪪', hint: 'Se verifica con IA y completa los datos del cliente', req: true },
  }

  function SlotTile({ k }: { k: SlotKey }) {
    const st = slots[k]
    const meta = SLOT_META[k]
    const ref = k === 'factura' ? facturaRef : k === 'cdo' ? cdoRef : cedulaRef
    const color =
      st.status === 'ok' ? '#10B981' :
      st.status === 'mismatch' || st.status === 'error' ? '#BB162B' :
      st.status === 'verifying' ? '#3B82F6' : 'var(--border)'
    const statusTxt =
      st.status === 'ok' ? '✓ Verificado' :
      st.status === 'verifying' ? '⏳ Verificando…' :
      st.status === 'mismatch' ? '✕ Documento incorrecto' :
      st.status === 'error' ? '✕ Error' : ''
    return (
      <div style={{ border: `2px ${st.status === 'empty' ? 'dashed' : 'solid'} ${color}`, borderRadius: 12, padding: '14px 16px', marginBottom: 12, background: 'var(--bg-deep)' }}>
        <input ref={ref} type="file" accept="image/*,application/pdf" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; handleSlotFile(k, f) }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 26 }}>{meta.emoji}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' }}>
              {meta.label}<span style={{ color: '#BB162B', marginLeft: 4 }}>*</span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
              {st.file ? st.file.name : meta.hint}
            </div>
            {statusTxt && <div style={{ fontSize: 12, fontWeight: 700, color, marginTop: 4 }}>{statusTxt}</div>}
          </div>
          <button
            onClick={() => ref.current?.click()}
            disabled={st.status === 'verifying'}
            style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid var(--border)', background: st.status === 'ok' ? 'transparent' : '#BB162B', color: st.status === 'ok' ? 'var(--text-secondary)' : '#fff', fontWeight: 700, fontSize: 12.5, cursor: st.status === 'verifying' ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
            {st.status === 'ok' ? 'Cambiar' : st.file ? 'Reintentar' : 'Subir'}
          </button>
        </div>
        {(st.status === 'mismatch' || st.status === 'error') && st.msg && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#BB162B', background: 'rgba(187,22,43,0.08)', border: '1px solid rgba(187,22,43,0.3)', borderRadius: 8, padding: '8px 12px' }}>{st.msg}</div>
        )}
      </div>
    )
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, overflowY: 'auto' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 16, padding: 28, maxWidth: 600, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>Nuevo Negocio</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              {step === 'slots' ? 'Sube cada documento en su espacio. Los 3 son obligatorios.' : 'Revisa y corrige los datos antes de crear.'}
            </div>
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 22 }}>✕</button>
        </div>

        {error && <div style={{ background: 'rgba(187,22,43,0.1)', border: '1px solid rgba(187,22,43,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: '#BB162B' }}>{error}</div>}

        {step === 'slots' && (
          <>
            <SlotTile k="factura" />
            <SlotTile k="cdo" />
            <SlotTile k="cedula" />
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '4px 2px 16px' }}>
              La Factura y la Cédula se verifican con IA: si subes el documento equivocado en un espacio, el sistema lo rechaza. El CDO se archiva tal cual.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={onCancel} style={{ flex: 1, padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer' }}>Cancelar</button>
              <button onClick={() => { if (allReady) { setError(''); setStep('review') } else setError('Completa los 3 documentos (Factura y Cédula verificadas).') }}
                disabled={!allReady || anyVerifying}
                style={{ flex: 2, padding: 12, borderRadius: 8, border: 'none', background: allReady ? '#BB162B' : 'var(--border)', color: '#fff', fontWeight: 800, fontSize: 14, cursor: allReady ? 'pointer' : 'default' }}>
                {anyVerifying ? 'Verificando…' : 'Continuar a revisión →'}
              </button>
            </div>
          </>
        )}

        {step === 'review' && (
          <>
            <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 12, color: '#10B981', fontWeight: 600 }}>
              ✓ Documentos verificados — revisa y corrige si es necesario
            </div>

            {extracted.monto_total_pagar && (
              <div style={{ background: 'rgba(187,22,43,0.08)', border: '1px solid rgba(187,22,43,0.3)', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6 }}>Monto Total a Pagar (Factura)</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: '#BB162B', fontFamily: 'monospace' }}>${Number(extracted.monto_total_pagar).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <ScannerField label="N° Factura / Negocio *" k="negocio_num" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Fecha Factura" k="fecha_factura" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Monto Total a Pagar (USD)" k="monto_total_pagar" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Precio Vehículo (base)" k="precio_vehiculo" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Gastos Administrativos" k="gastos_administrativos" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Seguro" k="seguro_monto" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Nombres" k="cliente_nombre" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Apellidos" k="cliente_apellidos" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Cédula/RIF" k="cliente_rif" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Tipo" k="cliente_rif_tipo" extracted={extracted} setExtracted={setExtracted} />
              <div style={{ gridColumn: '1 / -1' }}><ScannerField label="Dirección" k="cliente_direccion" extracted={extracted} setExtracted={setExtracted} /></div>
              <ScannerField label="Teléfono" k="cliente_telefono" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Email" k="cliente_email" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Estado Civil" k="cliente_estado_civil" extracted={extracted} setExtracted={setExtracted} />
              <div />
              <ScannerField label="Marca" k="vehiculo_marca" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Modelo" k="vehiculo_modelo" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Año Modelo" k="vehiculo_año" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Año Fabricación (manual, del CDO)" k="vehiculo_año_fabricacion" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Color" k="vehiculo_color" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Placa" k="vehiculo_placa" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="VIN / Serial Carrocería" k="vin" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Clase" k="vehiculo_clase" extracted={extracted} setExtracted={setExtracted} />
              <ScannerField label="Uso" k="vehiculo_uso" extracted={extracted} setExtracted={setExtracted} />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button onClick={() => { setError(''); setStep('slots') }} style={{ flex: 1, padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer' }}>← Documentos</button>
              <button onClick={handleCreate} style={{ flex: 2, padding: 12, borderRadius: 8, border: 'none', background: '#BB162B', color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
                ✓ Crear Negocio #{extracted.negocio_num || '—'}
              </button>
            </div>
          </>
        )}

        {step === 'saving' && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-secondary)', fontSize: 14 }}>
            💾 Creando negocio y archivando documentos…
          </div>
        )}
      </div>
    </div>
  )
}


// ──────────────────────────────────────────────────────────────────────────────
// IngresoScanner — AI-powered payment receipt scanner
//
// v2 improvements:
// - USDT detection moved to FIRST position in matching rules (was #7), because
//   crypto receipts often contain words like "Wire" or "Transfer" that caused
//   false matches earlier in the pipeline
// - Expanded USDT pattern list: Binance, Trust Wallet, MetaMask, Coinbase,
//   blockchain explorers (etherscan, tronscan, bscscan), wallet addresses,
//   TX hashes, TRC-20/ERC-20/BEP-20 network mentions
// - New extracted fields: crypto_network, wallet_address_to, referencia_type,
//   fecha_confidence. Folded into the comentario field so the DB schema
//   doesn't need changes.
// - Reference extraction now specialized per method type (Zelle confirmation #,
//   Wire FedWire ref, Bolívares Nro. Operación, USDT TX hash)
// - Sender detection handles wallet addresses (renders "Wallet 0x...1234")
// - Review panel now shows crypto-specific info (network, address) when present
// - Confidence pills per field so Deisi sees what to double-check
//
// Drop-in replacement for the existing IngresoScanner function. Keeps the same
// props, same return shape, same save path. The only code outside this function
// that references extracted.* is the NewDealScanner (Factura) — untouched.
// ──────────────────────────────────────────────────────────────────────────────
function IngresoScanner({ user, deals, onDone, onCancel }: { user: any, deals: any[], onDone: () => void, onCancel: () => void }) {
  const [step, setStep] = useState<'upload' | 'confirm' | 'done'>('upload')
  const [scanning, setScanning] = useState(false)
  const [extracted, setExtracted] = useState<any>(null)
  const [imageB64, setImageB64] = useState<string>('')
  const [imageFileForUpload, setImageFileForUpload] = useState<File | null>(null)  // 2026-05-07: full File for storage upload
  const [error, setError] = useState('')
  const [selectedDealId, setSelectedDealId] = useState<string>('')
  const [facturaInput, setFacturaInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedCount, setSavedCount] = useState(0)
  const [metodoOverride, setMetodoOverride] = useState<string>('')
  // Editable fields (user can correct AI)
  const [refOverride, setRefOverride] = useState<string>('')
  const [montoUsdOverride, setMontoUsdOverride] = useState<string>('')
  const [fechaOverride, setFechaOverride] = useState<string>('')
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)

  const foundDeal = deals.find(d =>
    selectedDealId ? String(d.id) === selectedDealId :
    facturaInput ? String(d.negocio_num) === facturaInput.trim() : false
  )

  const scanIngreso = async (file: File) => {
    setScanning(true)
    setError('')
    setExtracted(null)
    setMetodoOverride('')
    setRefOverride('')
    setMontoUsdOverride('')
    setFechaOverride('')
    try {
      const base64 = await new Promise<string>((res, rej) => {
        const r = new FileReader()
        r.onload = ev => res((ev.target?.result as string).split(',')[1])
        r.onerror = rej
        r.readAsDataURL(file)
      })
      const isPdf = file.type === 'application/pdf'
      const mediaType = isPdf ? 'application/pdf' : (file.type || 'image/jpeg')
      setImageB64(base64)
      setImageFileForUpload(file)

      // Timeout wrapper — abort if the Worker hangs beyond 20s.
      // Prevents the "scanning forever" UX on flaky connections.
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 20000)

      const res = await fetch('https://autocore-comprobante.sano-franco.workers.dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [
              isPdf ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
                    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              {
                type: 'text',
                text: `You are analyzing a payment receipt submitted to a Venezuelan KIA dealership. The receipt may be any of these:

A) USDT / crypto payment — Binance deposit, Trust Wallet send, MetaMask tx, Coinbase, Kraken, blockchain explorer screenshot (etherscan / tronscan / bscscan / polygonscan), exchange transfer confirmation
B) Zelle payment — US-based P2P, shows "Confirmation #" or "Confirmation code"
C) Wire transfer — international or domestic US bank wire, shows "FedWire" / "Reference number" / SWIFT details
D) Venezuelan bolívar transfer — Banesco / Mercantil / BOD / Banco de Venezuela / Bicentenario, shows "Nro. de operación" / "Nro. referencia" / "Nro. Op"
E) Cash receipt ("Efectivo" / "RECIBO DE CAJA")
F) PIVCA settlement document ("Liquidación PIVCA" / bank comision docs)
G) Retention document ("Retención" / retención de impuesto)

RETURN ONLY JSON (no markdown, no commentary, no prose):
{
  "monto_usd": number | null,
  "monto_bs": number | null,
  "fecha": "YYYY-MM-DD" | null,
  "fecha_confidence": "high" | "medium" | "low",
  "referencia": "reference/confirmation/TX hash or null",
  "referencia_type": "tx_hash" | "confirmation" | "wire_ref" | "nro_operacion" | "other" | null,
  "sender_name": "name of sender, OR wallet address snippet if crypto — null if absent",
  "metodo_pago": "MUST match EXACTLY one of: 'Efectivo' | 'Zelle Roframi' | 'Zelle Motocentro' | 'Zelle Externo' | 'Wire Transfer Roframi' | 'Wire Transfer Motocentro' | 'Wire Transfer Panama' | 'USDT' | 'Transferencia en Bolívares' | 'Retención' | 'Liquidación PIVCA' | 'Saldo a Financiar' — OR null",
  "metodo_confidence": "high" | "medium" | "low",
  "cuenta_destino": "recipient account hint (e.g. 'ROFRAMI MANAGEMENT LLC', 'MOTOCENTRO II LLC', or the wallet address suffix) or null",
  "crypto_network": "TRC-20" | "ERC-20" | "BEP-20" | "Polygon" | "Solana" | "Bitcoin" | null,
  "wallet_address_to": "destination wallet address (shortened: first 6 + last 4) or null",
  "notas": "free text — any info that doesn't fit above, or null"
}

═══════════════════════════════════════════════════════════════════════
METHOD DETECTION — apply rules IN ORDER, stop at first match
═══════════════════════════════════════════════════════════════════════

★ RULE 1 — USDT / CRYPTO (CHECK THIS FIRST, even if the document also mentions "Transfer" or "Wire"):
   Trigger on ANY of these signals:
   • Words: "USDT", "Tether", "USD₮", "TetherUS"
   • Networks: "TRC-20", "TRC20", "ERC-20", "ERC20", "BEP-20", "BEP20", "Polygon", "Solana", "Tron", "Ethereum", "Binance Smart Chain", "BSC"
   • Platforms: "Binance", "Trust Wallet", "MetaMask", "Coinbase", "Kraken", "OKX", "Bybit", "KuCoin"
   • Explorers: "etherscan", "tronscan", "bscscan", "polygonscan", "blockchain.com"
   • Wallet address formats visible in the receipt:
     – Ethereum/BSC/Polygon: 0x followed by 40 hex chars (e.g., 0xAf72a1...)
     – Tron (TRC-20): starts with T + 33 alphanumeric chars (e.g., TJRabPr...)
     – Solana: 32-44 base58 chars
   • TX hash visible (long hex string, typically 64 chars)
   → Set metodo_pago = "USDT"
   → Set crypto_network based on the network shown (if visible)
   → Set referencia = TX hash (preferred) or exchange's transaction/order ID
   → Set referencia_type = "tx_hash" if it's a hash, else "other"
   → If sender name visible, use it. Else use "Wallet " + first 6 chars + "..." + last 4 chars of sender address
   → monto_usd = monto_usdt (USDT is 1:1 pegged to USD)
   → monto_bs = null unless explicitly shown

RULE 2 — Zelle (US P2P):
   Signals: "Zelle", "Zelle®", "zellepay.com", payment from a US bank app
   Recipient logic:
   • If recipient field shows "ROFRAMI" (any variant: Roframi Management, Roframi LLC, etc.) → "Zelle Roframi"
   • If recipient shows "MOTOCENTRO" (Motocentro II LLC, etc.) → "Zelle Motocentro"
   • Otherwise → "Zelle Externo"
   referencia_type = "confirmation", referencia = confirmation number

RULE 3 — Wire Transfer:
   Signals: "Wire Transfer", "Wire", "FedWire", "SWIFT", "IBAN", "International transfer", "ACH Credit"
   Recipient logic:
   • "ROFRAMI" → "Wire Transfer Roframi"
   • "PANAMA" or "PAN" or Panamanian bank → "Wire Transfer Panama"
   • "MOTOCENTRO" → "Wire Transfer Motocentro"
   referencia_type = "wire_ref", referencia = FedWire ref / reference number

RULE 4 — Transferencia en Bolívares (Venezuelan bank):
   Signals: "Banesco", "Mercantil", "BOD", "Bicentenario", "Banco de Venezuela", "BNC", "BBVA Provincial"
   Also: "Nro. de operación", "Nro. Op", "Nro. referencia", "Transferencia inmediata", amounts in Bs (bolívares)
   referencia_type = "nro_operacion"

RULE 5 — Efectivo (cash):
   Signals: "RECIBO DE CAJA", "Efectivo", "Cash", "Cobro en efectivo", no bank or electronic info
   referencia_type = "other" or null

RULE 6 — Liquidación PIVCA:
   Signals: "PIVCA", "Liquidación PIVCA", financial institution settlement document
   referencia_type = "other"

RULE 7 — Retención:
   Signals: "Retención", "retencion", "impuesto retenido", withholding tax certificate
   referencia_type = "other"

RULE 8 — None match:
   Set metodo_pago = null, metodo_confidence = "low"

═══════════════════════════════════════════════════════════════════════
REFERENCE NUMBER EXTRACTION — this is critical, the dealership uses it for duplicate detection
═══════════════════════════════════════════════════════════════════════

• USDT: prefer the full TX hash (even if it's long — 64 hex chars). Fallback: exchange order/transaction ID.
• Zelle: "Confirmation code" / "Confirmation #" — usually 8-12 alphanumeric.
• Wire: "Reference number" / "Transaction ID" / FedWire reference (IMAD/OMAD).
• Bolívares: "Nro. de operación" / "Número de referencia" — usually 6-12 digits.
• If multiple candidates exist, prefer the one labeled as a reference/confirmation.
• NEVER invent a reference. If you can't find one clearly, return null.
• The reference should be EXACTLY as it appears — preserve case, dashes, spaces. Trim only leading/trailing whitespace.

═══════════════════════════════════════════════════════════════════════
DATE EXTRACTION
═══════════════════════════════════════════════════════════════════════

• Always return YYYY-MM-DD format.
• If format is ambiguous (e.g., "03/04/2026" — could be March 4 or April 3):
  – If document language is Spanish or Venezuelan → interpret as DD/MM/YYYY
  – If document is English/US → interpret as MM/DD/YYYY
  – Set fecha_confidence = "medium"
• Blockchain relative times ("3 hours ago"): assume today's date, set fecha_confidence = "medium"
• If completely unclear, set fecha = null and fecha_confidence = "low".

═══════════════════════════════════════════════════════════════════════
AMOUNT EXTRACTION
═══════════════════════════════════════════════════════════════════════

• monto_usd: the USD amount shown (or USDT amount, since 1:1 peg).
• monto_bs: only if explicitly shown in Venezuelan bolívares. Don't convert.
• For PIVCA or retention docs showing percentages: extract the base dollar amount being settled, not the commission.
• For bank receipts showing dual currency (USD equivalent + Bs): capture both.

═══════════════════════════════════════════════════════════════════════
FINAL CHECKS
═══════════════════════════════════════════════════════════════════════

• metodo_pago MUST match one of the 12 exact strings or be null. Never invent.
• Prefer null + "low" confidence over wrong guesses.
• For crypto, always try to fill crypto_network and wallet_address_to if visible.`
              }
            ]
          }]
        })
      })
      clearTimeout(timeoutId)
      const data = await res.json()
      const text = data.content?.[0]?.text || '{}'
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
      setExtracted(parsed)
      // Prefill all editable fields with AI values
      setMetodoOverride(parsed.metodo_pago || '')
      setRefOverride(parsed.referencia || '')
      setMontoUsdOverride(parsed.monto_usd != null ? String(parsed.monto_usd) : '')
      setFechaOverride(parsed.fecha || '')
      setScanning(false)
      setStep('confirm')
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setError('La IA tardó demasiado. Revisa tu conexión e intenta de nuevo.')
      } else {
        setError('Error al leer el comprobante. Verifica la imagen o intenta manualmente.')
      }
      setScanning(false)
    }
  }

  const getMetodo = () => metodoOverride || 'Zelle Motocentro'

  // Build a comentario that includes AI-detected sender + crypto info.
  // This is what staff will see in the deal's pagos list.
  const buildComentario = (): string => {
    if (!extracted) return ''
    const parts: string[] = []
    if (extracted.sender_name) parts.push(`De: ${extracted.sender_name}`)
    if (extracted.crypto_network) parts.push(`Red: ${extracted.crypto_network}`)
    if (extracted.wallet_address_to) parts.push(`Wallet: ${extracted.wallet_address_to}`)
    if (extracted.notas) parts.push(extracted.notas)
    return parts.join(' · ')
  }

  const handleSave = async () => {
    if (!foundDeal || !extracted) return
    if (!metodoOverride) {
      alert('Por favor selecciona el método de pago antes de guardar.')
      return
    }
    setSaving(true)
    const tasa = parseFloat(foundDeal.tasa_bcv) || 1
    const metodo = getMetodo()
    // Use overrides for the fields the user can edit; fall back to AI extraction
    const refFinal = refOverride.trim() || extracted.referencia || ''
    const fechaFinal = fechaOverride || extracted.fecha || new Date().toISOString().slice(0, 10)
    const montoUsdInput = parseFloat(montoUsdOverride)
    const montoUsd = !isNaN(montoUsdInput) ? montoUsdInput : (extracted.monto_usd ?? (extracted.monto_bs ? extracted.monto_bs / tasa : 0))
    const montoBs = extracted.monto_bs ?? (montoUsd * tasa)

    // 2026-05-07: upload comprobante to storage; also keep legacy data URL
    // (with proper MIME prefix) so existing render paths still work.
    let comprobantePath: string | undefined
    let comprobanteMime: string | undefined
    if (imageB64 && imageFileForUpload) {
      const result = await uploadDealDoc({
        file: imageFileForUpload,
        negocioNum: foundDeal.negocio_num || null,
        dealId: foundDeal.id || null,
        type: 'pago',
      })
      if (!result.error && result.path) {
        comprobantePath = result.path
        comprobanteMime = result.mime
      } else if (result.error) {
        console.warn('[IngresoScanner] storage upload failed, falling back to data URL:', result.error)
      }
    }

    const newPago = {
      metodo,
      fecha: fechaFinal,
      monto_usd: montoUsd,
      monto_bs: montoBs,
      referencia: refFinal,
      comentario: buildComentario(),
      // Legacy data URL: proper MIME detection (was hardcoded image/jpeg pre-2026-05-07).
      // Kept for backwards compatibility with old admin render paths.
      comprobante_imagen: imageB64 ? buildDataUrl(imageB64) : undefined,
      // New storage path (preferred for rendering when present).
      comprobante_path: comprobantePath,
      comprobante_mime: comprobanteMime,
      notas_ai: extracted.notas,
    }
    // foundDeal comes from the LEAN list (no pagos column) and could also be
    // stale if another user added a payment since the page loaded. Re-read the
    // authoritative pagos by id right before writing so we never overwrite
    // existing payments with an empty/partial array.
    const { data: fresh, error: freshErr } = await supabase
      .from('deals').select('pagos').eq('id', foundDeal.id).maybeSingle()
    if (freshErr || !fresh) {
      alert('No se pudo releer el negocio antes de guardar: ' + (freshErr?.message || 'no encontrado') + '. Intenta de nuevo.')
      setSaving(false); return
    }
    const existingPagos = Array.isArray(fresh.pagos) ? fresh.pagos : []
    if (newPago.referencia && existingPagos.some((p: any) => p.referencia === newPago.referencia)) {
      alert('Ya existe un pago con esa referencia en este negocio.'); setSaving(false); return
    }
    const newPagos = [...existingPagos, newPago]
    const total_recibido = newPagos.reduce((s: number, p: any) => s + (parseFloat(p.monto_usd) || 0), 0)
    const { error } = await supabase.from('deals').update({ pagos: newPagos, total_recibido }).eq('id', foundDeal.id)
    if (error) { alert('Error: ' + error.message); setSaving(false); return }
    setSavedCount(c => c + 1)
    setSaving(false)
    setStep('done')
  }

  const fmtLocal = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  // Confidence pill renderer — reused across fields
  const ConfPill = ({ level }: { level: 'high' | 'medium' | 'low' | undefined }) => {
    if (!level) return null
    const colors = {
      high:   { bg: 'rgba(46,204,138,0.2)',  fg: '#2ecc8a' },
      medium: { bg: 'rgba(184,114,10,0.2)',  fg: '#b8720a' },
      low:    { bg: 'rgba(187,22,43,0.2)',   fg: '#BB162B' },
    }
    const c = colors[level]
    return (
      <span style={{ marginLeft: 8, fontSize: 9, padding: '2px 8px', borderRadius: 10, background: c.bg, color: c.fg, fontWeight: 700 }}>
        {level.toUpperCase()}
      </span>
    )
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 16, padding: 28, maxWidth: 520, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>Subir Ingreso</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              {savedCount > 0 ? `${savedCount} ingreso${savedCount !== 1 ? 's' : ''} guardado${savedCount !== 1 ? 's' : ''}` : 'Escanea comprobante de pago'}
            </div>
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 22 }}>✕</button>
        </div>

        {step === 'upload' && (
          <>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" onChange={e => e.target.files?.[0] && scanIngreso(e.target.files[0])} style={{ display: 'none' }} />
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={e => e.target.files?.[0] && scanIngreso(e.target.files[0])} style={{ display: 'none' }} />
            {scanning
              ? <div style={{ textAlign: 'center', padding: '40px 0', color: '#3B82F6', fontSize: 14, fontWeight: 600 }}>⏳ Analizando comprobante con IA...</div>
              : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <button onClick={() => cameraRef.current?.click()}
                    style={{ padding: '28px 16px', borderRadius: 12, border: '2px dashed var(--border)', background: 'var(--bg-deep)', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'center' }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>📷</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>Cámara</div>
                  </button>
                  <button onClick={() => fileRef.current?.click()}
                    style={{ padding: '28px 16px', borderRadius: 12, border: '2px dashed var(--border)', background: 'var(--bg-deep)', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'center' }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>🖼️</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>Galería</div>
                  </button>
                </div>
              )
            }
            {error && <div style={{ marginTop: 12, color: '#BB162B', fontSize: 12 }}>{error}</div>}
          </>
        )}

        {step === 'confirm' && extracted && (
          <>
            {/* ───────────────────── Editable fields ───────────────────── */}
            {/* Método de Pago — AI suggested, user can override */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6, display: 'block' }}>
                Método de Pago
                <ConfPill level={extracted.metodo_confidence} />
              </label>
              <select
                value={metodoOverride}
                onChange={e => setMetodoOverride(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  background: metodoOverride ? 'var(--bg-input)' : 'rgba(187,22,43,0.08)',
                  border: `1px solid ${metodoOverride ? 'var(--border)' : 'rgba(187,22,43,0.4)'}`,
                  borderRadius: 8,
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  outline: 'none',
                }}
              >
                <option value="">— Selecciona método de pago —</option>
                {METODOS_PAGO.map(m => (
                  <option key={m} value={m}>{m}{extracted.metodo_pago === m ? ' (sugerido por IA)' : ''}</option>
                ))}
              </select>
              {!extracted.metodo_pago && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#b8720a' }}>
                  ⚠ La IA no pudo determinar el método automáticamente. Por favor selecciona manualmente.
                </div>
              )}
            </div>

            {/* Monto USD */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6, display: 'block' }}>
                Monto USD
              </label>
              <input
                type="number"
                step="0.01"
                value={montoUsdOverride}
                onChange={e => setMontoUsdOverride(e.target.value)}
                placeholder="0.00"
                style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none' }}
              />
              {extracted.monto_bs && (
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
                  También detectado: Bs {Number(extracted.monto_bs).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
              )}
            </div>

            {/* Referencia */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6, display: 'block' }}>
                Referencia
                {extracted.referencia_type && (
                  <span style={{ marginLeft: 8, fontSize: 9, padding: '2px 8px', borderRadius: 10, background: 'rgba(59,130,246,0.15)', color: '#3B82F6', fontWeight: 700 }}>
                    {extracted.referencia_type === 'tx_hash' ? 'TX HASH' :
                     extracted.referencia_type === 'confirmation' ? 'CONFIRMATION' :
                     extracted.referencia_type === 'wire_ref' ? 'WIRE REF' :
                     extracted.referencia_type === 'nro_operacion' ? 'NRO. OPERACIÓN' : 'REF'}
                  </span>
                )}
              </label>
              <input
                type="text"
                value={refOverride}
                onChange={e => setRefOverride(e.target.value)}
                placeholder="Número de referencia, confirmación o TX hash"
                style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none', fontFamily: extracted.referencia_type === 'tx_hash' ? 'monospace' : undefined }}
              />
            </div>

            {/* Fecha */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 6, display: 'block' }}>
                Fecha
                <ConfPill level={extracted.fecha_confidence} />
              </label>
              <input
                type="date"
                value={fechaOverride}
                onChange={e => setFechaOverride(e.target.value)}
                style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none' }}
              />
            </div>

            {/* ───────────────────── Read-only AI-detected info ───────────────────── */}
            <div style={{ background: 'var(--bg-deep)', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 8 }}>
                Detalles detectados por IA
              </div>
              {[
                ['Remitente', extracted.sender_name],
                ['Cuenta destino', extracted.cuenta_destino],
                ['Red cripto', extracted.crypto_network],
                ['Wallet destino', extracted.wallet_address_to],
                ['Notas', extracted.notas],
              ].filter(([_, v]) => v).map(([l, v]) => (
                <div key={l as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 11 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{l}</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', maxWidth: '70%', fontFamily: (l === 'Wallet destino' || l === 'Red cripto') ? 'monospace' : undefined }}>{v as string}</span>
                </div>
              ))}
              {![extracted.sender_name, extracted.cuenta_destino, extracted.crypto_network, extracted.wallet_address_to, extracted.notas].some(Boolean) && (
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontStyle: 'italic' }}>Sin detalles adicionales</div>
              )}
            </div>

            {/* ───────────────────── Deal assignment ───────────────────── */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 10 }}>¿A qué negocio pertenece este pago?</div>

              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6, marginBottom: 12 }}>
                {deals.filter(d => d.status !== 'APROBADO').slice(0, 5).map(d => (
                  <button key={d.id} onClick={() => { setSelectedDealId(String(d.id)); setFacturaInput('') }}
                    style={{
                      padding: '10px 14px', borderRadius: 8, textAlign: 'left', cursor: 'pointer',
                      border: `1px solid ${selectedDealId === String(d.id) ? '#BB162B' : 'var(--border)'}`,
                      background: selectedDealId === String(d.id) ? 'rgba(187,22,43,0.1)' : 'var(--bg-deep)',
                      color: 'var(--text-primary)',
                    }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>#{d.negocio_num}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 8 }}>{d.cliente_nombre}</span>
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}>O ingresa #:</span>
                <input
                  value={facturaInput}
                  onChange={e => { setFacturaInput(e.target.value); setSelectedDealId('') }}
                  placeholder="Nro. de factura"
                  style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, outline: 'none' }}
                />
              </div>
              {facturaInput && !foundDeal && (
                <div style={{ fontSize: 12, color: '#BB162B', marginTop: 6 }}>Negocio #{facturaInput} no encontrado</div>
              )}
              {foundDeal && (
                <div style={{ fontSize: 12, color: '#10B981', marginTop: 6, fontWeight: 600 }}>
                  ✓ {foundDeal.cliente_nombre} — Total recibido: {fmtLocal(foundDeal.total_recibido || 0)}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setStep('upload')} style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer' }}>← Atrás</button>
              <button onClick={handleSave} disabled={!foundDeal || !metodoOverride || saving}
                style={{ flex: 2, padding: 10, borderRadius: 8, border: 'none', background: foundDeal && metodoOverride ? '#BB162B' : '#333', color: '#fff', fontWeight: 700, cursor: foundDeal && metodoOverride ? 'pointer' : 'not-allowed', opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Guardando...' : foundDeal && metodoOverride ? `✓ Agregar a #${foundDeal.negocio_num}` : !foundDeal ? 'Selecciona un negocio' : 'Selecciona método de pago'}
              </button>
            </div>
          </>
        )}

        {step === 'done' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
              Ingreso guardado en #{foundDeal?.negocio_num}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24 }}>
              {montoUsdOverride ? fmtLocal(parseFloat(montoUsdOverride)) : (extracted?.monto_usd ? fmtLocal(extracted.monto_usd) : '')} · {refOverride || extracted?.referencia || ''} · {getMetodo()}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => {
                  setStep('upload'); setExtracted(null); setSelectedDealId(''); setFacturaInput('');
                  setMetodoOverride(''); setRefOverride(''); setMontoUsdOverride(''); setFechaOverride('');
                }}
                style={{ flex: 1, padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer' }}>
                + Otro Ingreso
              </button>
              <button onClick={onDone}
                style={{ flex: 1, padding: 12, borderRadius: 8, border: 'none', background: '#BB162B', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
                Listo
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}



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

// ── DocViewer: loads signed URLs for stored documents ────────────────────────
function DocViewer({ negocioNum, dealId, refreshKey }: { negocioNum: string, dealId?: string, refreshKey?: number }) {
  const [paths, setPaths] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const docTypes = ['factura', 'cdo', 'cedula']
      const result: Record<string, string> = {}   // docType -> storage PATH (not a signed url)

      // Path 1 (primary): explicit paths recorded in documentos_meta. Collect the PATH
      // only — signing is deferred to click time, so a flaky/expired sign can never
      // blank a button whose file is already recorded.
      const { data: row } = await supabase
        .from('deals').select('documentos_meta').eq('negocio_num', negocioNum).limit(1).maybeSingle()
      if (cancelled) return
      const meta = ((row?.documentos_meta || {}) as Record<string, any>)
      for (const doc of docTypes) {
        if (meta[doc]?.path) result[doc] = meta[doc].path
      }

      // Path 2 (fallback): fill any STILL-MISSING doc type from the storage folders
      // (negocio_num AND deals/borrador_<dealId>/). Path only — no signing here either.
      const stillMissing = docTypes.filter(d => !result[d])
      if (stillMissing.length > 0) {
        const folders = [
          negocioNum ? `deals/${negocioNum}` : null,
          dealId ? `deals/borrador_${dealId}` : null,
        ].filter(Boolean) as string[]
        for (const folder of folders) {
          const { data: files } = await supabase.storage.from('comprobantes').list(folder, { limit: 50 })
          if (cancelled) return
          if (!files || files.length === 0) continue
          for (const doc of stillMissing) {
            if (result[doc]) continue
            const match = files.find(f => f.name.toLowerCase().startsWith(doc))
            if (match) result[doc] = `${folder}/${match.name}`
          }
        }
      }

      if (!cancelled) setPaths(result)
    }
    load()
    return () => { cancelled = true }
  }, [negocioNum, dealId, refreshKey])

  // Pre-sign all the doc links ONCE when paths are ready (a single token fetch, not one
  // per click) and render them as NATIVE links — no JS or signing at click time, so they
  // can't hang or be popup-blocked on repeat clicks. Watchdog avoids a perpetual spinner.
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

  // Fallback for a link not pre-signed in time: open a tab synchronously, sign with a
  // watchdog, then redirect — error message instead of a perpetual blank if it stalls.
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
  const linkStyle = { padding: '6px 12px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(74,158,255,0.4)', background: 'rgba(74,158,255,0.08)', color: '#4a9eff', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'none', display: 'inline-block' as const }
  const hasAny = Object.keys(paths).length > 0
  if (!hasAny) return null

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 8 }}>Documentos Escaneados</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
        {docTypes.map(({ key, label }) => {
          if (!paths[key]) return null
          return signed[key]
            ? <a key={key} href={signed[key]} target="_blank" rel="noopener noreferrer" style={linkStyle}>{label}</a>
            : <button key={key} onClick={() => openDoc(key)} style={linkStyle}>{label}</button>
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// ★ FIX #2: MoneyInput — isolated component to prevent whole-form re-renders
// Tracks raw input in LOCAL ref, only commits to parent on blur.
// This eliminates the "type one character at a time" lag.
// ═══════════════════════════════════════════════════════════════════════════
function MoneyInput({ value, onChange, disabled, style }: {
  value: number
  onChange: (v: number) => void
  disabled?: boolean
  style?: React.CSSProperties
}) {
  const [focused, setFocused] = useState(false)
  const [raw, setRaw] = useState<string>('')
  const inputRef = useRef<HTMLInputElement>(null)

  if (disabled) return <div style={style}>{value ? fmt(value) : '$0.00'}</div>

  const displayValue = focused ? raw : (value ? fmt(value) : '')

  return (
    <input
      ref={inputRef}
      type="text"
      style={style}
      value={displayValue}
      placeholder="$0.00"
      onFocus={() => {
        setFocused(true)
        setRaw(value ? String(value) : '')
      }}
      onBlur={() => {
        setFocused(false)
        const cleaned = raw.replace(/[$,\s]/g, '')
        const parsed = parseFloat(cleaned)
        const finalValue = isNaN(parsed) ? 0 : parsed
        if (finalValue !== value) onChange(finalValue)
      }}
      onChange={e => {
        // Store the raw typed text locally. Do NOT call parent's onChange during typing.
        // This keeps the rest of the form completely inert while the user types,
        // which eliminates the per-keystroke lag on slow connections.
        setRaw(e.target.value)
      }}
    />
  )
}
// ─── Inventory Link Card ────────────────────────────────────────────────
// Phase 3 of inventory module: auto-link a deal to an inventory_units row by
// VIN. Reads-only when the deal is locked (APROBADO). The DB unique partial
// index on deals.inventory_vin guarantees one-deal-per-VIN; collisions surface
// as a save error.
// ─────────────────────────────────────────────────────────────────────────────
// ClienteSaldoCard — pulls the client's prior deposits (pagos_recibidos saldo a
// favor, keyed by cédula) into view at deal time, and applies them to the
// inicial. Solves the entanglement gap: money the client already deposited
// (registered under his name) is now visible and applicable when Deisi creates
// the deal. Applying adds a deal pago AND draws down pagos_recibidos.monto_disponible.
// ─────────────────────────────────────────────────────────────────────────────
function ClienteSaldoCard({ deal, setDeal, isLocked }: { deal: any, setDeal: any, isLocked: boolean }) {
  const [saldos, setSaldos] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [amt, setAmt] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)

  const digits = String(deal.cliente_rif || '').replace(/\D/g, '')

  const fetchSaldos = useCallback(async () => {
    if (isLocked || digits.length < 4) { setSaldos([]); return }
    setLoading(true)
    try {
      const { data } = await (supabase.from('pagos_recibidos')
        .select('id, fecha, origen, monto, monto_disponible, monto_bs, tasa_bcv, confirmation_code, usdt_tx_hash, payer_cedula, payer_name, nota_registro, status, comprob_url, aprobado_por, bank_tx_id')
        .eq('status', 'AVAILABLE').gt('monto_disponible', 0.01)
        // CONTROL: solo dinero APROBADO por admin puede aplicarse a un negocio.
        // Un status equivocado nunca debe bastar — exigimos firma de aprobación.
        .not('aprobado_por', 'is', null)
        .ilike('payer_cedula', `%${digits}%`)
        .order('fecha', { ascending: true }) as any)
      const list = (Array.isArray(data) ? data : []).filter((r: any) => String(r.payer_cedula || '').replace(/\D/g, '').includes(digits))
      setSaldos(list)
      const seed: Record<string, string> = {}
      for (const r of list) {
        const isBs = r.monto_bs != null && r.tasa_bcv != null && Number(r.tasa_bcv) > 0
        seed[r.id] = (isBs ? (Number(r.monto_bs) * (Number(r.monto_disponible) / Number(r.monto))) : Number(r.monto_disponible)).toFixed(2)
      }
      setAmt(seed)
    } finally { setLoading(false) }
  }, [digits, isLocked])

  useEffect(() => { fetchSaldos() }, [fetchSaldos])

  const totalSaldo = saldos.reduce((su, r) => su + Number(r.monto_disponible || 0), 0)

  async function aplicar(pr: any) {
    if (isLocked) return
    if (!deal.id) { setMsg('Guarda el negocio primero para aplicar el saldo del cliente.'); return }
    if (applyingId) return   // one apply at a time — blocks rapid repeat clicks
    const isBs = pr.monto_bs != null && pr.tasa_bcv != null && Number(pr.tasa_bcv) > 0
    const inputVal = parseFloat(amt[pr.id] || '0') || 0
    const remainingBs = isBs ? Number(pr.monto_bs) * (Number(pr.monto_disponible) / Number(pr.monto)) : 0
    let usdApplied: number; let bsApplied: number | null
    if (isBs) {
      bsApplied = Math.min(inputVal, remainingBs)
      // applying essentially the whole remaining Bs → draw the exact USD remainder so it zeroes out (no rounding crumb)
      usdApplied = bsApplied >= remainingBs - 1 ? Number(pr.monto_disponible) : bsApplied / Number(pr.tasa_bcv)
    } else {
      usdApplied = Math.min(inputVal, Number(pr.monto_disponible))
      if (usdApplied >= Number(pr.monto_disponible) - 0.01) usdApplied = Number(pr.monto_disponible)
      bsApplied = null
    }
    if (usdApplied <= 0.0001) { setMsg('Indica un monto válido.'); return }
    setApplyingId(pr.id); setMsg(null)
    const bsFmt = (n: number) => n.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const pago = {
      fecha: pr.fecha || new Date().toISOString().slice(0, 10),
      metodo: isBs ? 'Bolívares' : (pr.origen || 'Saldo a favor'),
      monto_usd: usdApplied, monto_bs: bsApplied || 0,
      referencia: pr.confirmation_code || pr.usdt_tx_hash || '',
      comentario: `Saldo a favor del cliente (depósito ${String(pr.id).slice(0, 8)})` + (isBs ? ` — Bs ${bsFmt(bsApplied as number)} @ ${pr.tasa_bcv}` : ''),
      _pago_recibido_id: pr.id, _from_saldo: true,
      // Receipt + verification provenance so the INGRESOS table can show
      // reference/comprobante/estado without a lookup (older pagos without
      // these fields fall back to the prMap fetch in the table).
      comprob_url: pr.comprob_url || null,
      _pr_aprobado_por: pr.aprobado_por || null,
      _pr_bank_tx_id: pr.bank_tx_id || null,
    }
    try {
      // Atomic, RLS-proof: locks the credit, checks balance, draws down (in USD),
      // appends the deal pago — all server-side. Returns remaining USD disponible.
      const { data, error } = await (supabase.rpc('aplicar_saldo_a_negocio', {
        p_pr_id: pr.id, p_deal_id: deal.id, p_monto: usdApplied, p_pago: pago,
      }) as any)
      if (error) throw new Error(error.message)
      const restante = Number(data)
      setDeal((d: any) => ({ ...d, pagos: [...(Array.isArray(d.pagos) ? d.pagos : []), pago] }))
      setSaldos(prev => prev
        .map(x => x.id === pr.id ? { ...x, monto_disponible: restante } : x)
        .filter(x => Number(x.monto_disponible) > 0.01))
      const restanteBs = isBs ? Number(pr.monto_bs) * (restante / Number(pr.monto)) : 0
      setMsg(isBs
        ? `Aplicado Bs ${bsFmt(bsApplied as number)} (≈ ${fmt(usdApplied)}) al negocio al cambio BCV.` + (restante > 0.0001 ? ` Quedan Bs ${bsFmt(restanteBs)}.` : '')
        : `Aplicado ${fmt(usdApplied)} al negocio desde el saldo del cliente.` + (restante > 0.0001 ? ` Quedan ${fmt(restante)} disponibles.` : ''))
    } catch (e: any) {
      setMsg(e?.message || 'Error al aplicar el saldo.')
    } finally { setApplyingId(null) }
  }

  if (isLocked) return null   // deal aprobado por admin → sin saldo a favor (ya contabilizado)
  if (digits.length < 4) return null
  if (!loading && saldos.length === 0) return null

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderLeft: '3px solid #16A34A', borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>
          Saldo a favor del cliente
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginLeft: 8 }}>depósitos previos bajo esta cédula</span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 900, color: '#16A34A', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalSaldo)}</div>
      </div>

      {msg && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-primary)', background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px' }}>{msg}</div>}

      {loading ? (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-secondary)' }}>Buscando depósitos…</div>
      ) : (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {saldos.map(pr => (
            <div key={pr.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>{pr.monto_bs != null && pr.tasa_bcv ? `Bs ${(Number(pr.monto_bs) * (Number(pr.monto_disponible) / Number(pr.monto))).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : fmt(Number(pr.monto_disponible))} disponible <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>· {pr.monto_bs != null ? `Bolívares (≈ ${fmt(Number(pr.monto_disponible))})` : pr.origen} · {pr.fecha}</span></div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{pr.payer_name || '—'}{pr.nota_registro ? ` · ${pr.nota_registro}` : ''}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-primary)', fontFamily: 'monospace', marginTop: 2 }}>Ref: {pr.confirmation_code || pr.usdt_tx_hash || '—'}</div>
              </div>
              {!isLocked && (
                <>
                  <input style={{ width: 110, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)', fontSize: 13 }}
                    inputMode="decimal" value={amt[pr.id] || ''} onChange={e => setAmt(a => ({ ...a, [pr.id]: e.target.value }))} />
                  <button disabled={applyingId === pr.id} onClick={() => aplicar(pr)}
                    style={{ padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: 'none', background: '#16A34A', color: '#fff' }}>
                    {applyingId === pr.id ? 'Aplicando…' : 'Aplicar al negocio'}
                  </button>
                </>
              )}
            </div>
          ))}
          {!deal.id && (
            <div style={{ fontSize: 11.5, color: '#b8720a', marginTop: 2 }}>Guarda el negocio primero para poder aplicar el saldo.</div>
          )}
        </div>
      )}
    </div>
  )
}

function InventoryLinkCard({ deal, setDeal, isLocked }: { deal: any, setDeal: any, isLocked: boolean }) {
  const [unit, setUnit] = useState<any | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'found' | 'notfound'>('idle')

  // Look up the unit whenever the VIN changes (or component mounts with linked VIN)
  useEffect(() => {
    let cancelled = false
    const vinToCheck = deal.vin || deal.inventory_vin
    if (!vinToCheck || vinToCheck.trim().length < 11) {
      setUnit(null); setStatus('idle'); return
    }
    setStatus('loading')
    supabase.from('inventory_units')
      .select('vin, modelo, año, color, costo_unidad_usd, costo_placa_certificado_usd, costo_total_factura_usd, factura_compra_num, factura_compra_fecha, fecha_entrada, estado')
      .eq('vin', vinToCheck.trim().toUpperCase())
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        if (data) { setUnit(data); setStatus('found') }
        else      { setUnit(null); setStatus('notfound') }
      })
    return () => { cancelled = true }
  }, [deal.vin, deal.inventory_vin])

  const isLinked = !!deal.inventory_vin && unit && unit.vin === deal.inventory_vin

  // Auto-link when the typed VIN matches a real unit. On link — or when an existing
  // link is missing its compra snapshot — copy the unit's purchase cost onto the deal
  // so reportes' P&L picks up the compra side. Option A (snapshot-at-link): the cost is
  // locked at sale time. We only fill compra fields that are currently empty, so a deal
  // already priced (e.g. historical backfill) is never overwritten.
  useEffect(() => {
    if (isLocked || status !== 'found' || !unit) return
    const needsLink = !deal.inventory_vin
    const needsSnapshot = deal.factura_compra_body_neto === null || deal.factura_compra_body_neto === undefined
    if (!needsLink && !needsSnapshot) return
    setDeal((d: any) => {
      const patch: any = { ...d }
      if (needsLink) patch.inventory_vin = unit.vin
      if (needsSnapshot) {
        const body = Number(unit.costo_unidad_usd) || 0
        patch.factura_compra_numero    = unit.factura_compra_num || null
        patch.factura_compra_fecha     = unit.factura_compra_fecha || null
        patch.factura_compra_body_neto = body
        patch.factura_compra_igtf      = Number((body * 0.03).toFixed(2))   // compra IGTF = body × 3% (regla fija)
        patch.factura_compra_placa     = Number(unit.costo_placa_certificado_usd) || 0
        patch.factura_compra_total     = unit.costo_total_factura_usd != null ? Number(unit.costo_total_factura_usd) : null
      }
      return patch
    })
  }, [status, unit, deal.inventory_vin, deal.factura_compra_body_neto, isLocked, setDeal])

  const handleUnlink = () => {
    if (isLocked) return
    if (!window.confirm('¿Desvincular esta unidad del negocio? La unidad volverá al inventario disponible.')) return
    setDeal((d: any) => ({
      ...d,
      inventory_vin: null,
      factura_compra_numero: null, factura_compra_fecha: null,
      factura_compra_body_neto: null, factura_compra_igtf: null,
      factura_compra_placa: null, factura_compra_total: null,
    }))
    setUnit(null); setStatus('idle')
  }

  return (
    <div style={s.card}>
      <div style={s.sectionTitle}>📦 Inventario y Costo Base</div>
      {!deal.vin ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          Ingresa el VIN en la sección Información del Negocio. La unidad se vinculará automáticamente.
        </div>
      ) : status === 'loading' ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Buscando en inventario...</div>
      ) : status === 'found' && unit ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '20px', flexWrap: 'wrap' as const }}>
            <div style={{ flex: 1, minWidth: '300px' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#2ecc8a', marginBottom: '8px' }}>
                ✓ Unidad encontrada en inventario
              </div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
                {unit.modelo} {unit.año} · {unit.color || '—'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <div>VIN: <span style={{ fontFamily: 'monospace' }}>{unit.vin}</span></div>
                <div>Factura KIA: {unit.factura_compra_num} · {unit.factura_compra_fecha}</div>
                <div>Fecha entrada: {unit.fecha_entrada}</div>
                <div>Estado actual: <strong>{unit.estado}</strong></div>
              </div>
            </div>
            <div style={{ textAlign: 'right' as const, minWidth: '180px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '4px' }}>
                Costo Unidad (KIA)
              </div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>
                ${parseFloat(unit.costo_unidad_usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              {!isLocked && deal.inventory_vin && (
                <button onClick={handleUnlink}
                        style={{ marginTop: '10px', padding: '6px 14px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
                  Desvincular
                </button>
              )}
            </div>
          </div>
        </div>
      ) : status === 'notfound' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' as const }}>
          <div style={{ flex: 1, minWidth: '280px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#b8720a', marginBottom: '4px' }}>
              ⚠ Esta unidad no está en inventario
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              VIN <span style={{ fontFamily: 'monospace' }}>{deal.vin}</span> no se encontró. 
              {' '}Para vincular el costo base de la unidad, regístrala primero en el módulo de Inventario.
            </div>
          </div>
          <button
            onClick={() => window.open('/inventario', '_blank')}
            style={{ padding: '8px 16px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
            Abrir Inventario →
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default function AuditoriaPage() {
  return (
    <Suspense fallback={null}>
      <Auditoria />
    </Suspense>
  )
}

function Auditoria() {
  const router = useRouter()
  const { permissions, role, loading: permsLoading } = useNPAPermissions()
  const [user, setUser] = useState<any>(null)
  const [deals, setDeals] = useState<any[]>([])
  const [dealsError, setDealsError] = useState<string>('')
  const [approvedOffset, setApprovedOffset]   = useState(0)
  const [approvedHasMore, setApprovedHasMore] = useState(false)
  const [loadingMore, setLoadingMore]         = useState(false)
  const [view, setView] = useState<'list' | 'form'>('list')
  const [editingDeal, setEditingDeal] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [showPrint, setShowPrint] = useState(false)
  const [showSeguroReal, setShowSeguroReal] = useState(false)
  const [showNewDealScanner, setShowNewDealScanner] = useState(false)
  const [showIngresoScanner, setShowIngresoScanner] = useState(false)
  const [showComprobante, setShowComprobante] = useState(false)
  const [showMultiComprobante, setShowMultiComprobante] = useState(false)
  // Phase 2: QR scanner for cash comprobantes from Mirla/Angeles
  const [showQRScanner, setShowQRScanner] = useState(false)
  // ★ v2: When false, the manual method/amount/ref form is collapsed. Deisi
  //        uses the AI scanner by default; she only expands this for cash,
  //        PIVCA, retention, or other non-scannable payments.
  const [showManualForm, setShowManualForm] = useState(false)
  const [showDuplicate, setShowDuplicate] = useState(false)
  const [duplicateMsg, setDuplicateMsg] = useState('')
  const [pendingPago, setPendingPago] = useState<any>(null)
  // Devolución al cliente (deals con SOBRANTE): Auditoría solicita, Mirla
  // aprueba en /tesoreria/confirmar, Coraly paga desde /tesoreria/caja-chica.
  const [showDevolucion, setShowDevolucion] = useState(false)
  const [showNotaEntrega, setShowNotaEntrega] = useState(false)
  const [devMonto, setDevMonto] = useState('')
  const [devMotivo, setDevMotivo] = useState('')
  const [devSaving, setDevSaving] = useState(false)
  const [devError, setDevError] = useState('')
  const [devExistentes, setDevExistentes] = useState<any[]>([])

  const emptyDeal: Deal = {
    negocio_num: '', cliente_nombre: '', cliente_rif_tipo: 'V', cliente_rif: '',
    vendedor: '', banco: '', fecha_factura: '', fecha_entrega: '', vin: '', inventory_vin: null,
    tasa_bcv: '', tasa_variable: '',
    pv_precio: 0, pv_gastos_admin: 0, pv_seguro: 0, pv_igtf: 0, pv_accesorios: 0, pv_placas: 0,
    pv_inicial: 0, pv_monto_financiar: 0, pv_comision_banco: 0, pv_comision_flat_cobrado: 0,
    au_precio: 0, au_gastos_admin: 0, au_seguro: 0, au_igtf: 0,
    au_accesorios: 0, au_comision_flat: 0, au_placas: 0,
    seguro_2do_ano: false, seguro_2do_ano_monto: 0,
    pagos: [], status: 'BORRADOR',
    cliente_apellidos: '', cliente_direccion: '', cliente_telefono: '',
    cliente_email: '', cliente_estado_civil: '',
    vehiculo_marca: 'KIA', vehiculo_modelo: '', vehiculo_color: '',
    vehiculo_placa: '', vehiculo_año: null, vehiculo_año_fabricacion: null, vehiculo_clase: '', vehiculo_uso: 'PARTICULAR',
    inicial_diferida_active: false,
    inicial_diferida_monto: 0,
    inicial_diferida_fecha_vencimiento: '',
    inicial_diferida_custodia: false,
    inicial_diferida_notas: '',
    inicial_diferida_compromiso_id: undefined,
  }

  const [deal, setDeal] = useState<Deal>({ ...emptyDeal })

  // Datos de tesoreria para pagos jalados (referencia / comprobante / aprobacion)
  // que no traen esos campos embebidos (pagos aplicados antes de 2026-07-03).
  const [prMap, setPrMap] = useState<Record<string, any>>({})
  const prIdsRef = useRef<string>('')
  useEffect(() => {
    const ids = Array.from(new Set(((deal as any).pagos || [])
      .map((p: any) => p?._pago_recibido_id).filter(Boolean))) as string[]
    const key = ids.slice().sort().join(',')
    if (key === prIdsRef.current) return
    prIdsRef.current = key
    if (ids.length === 0) { setPrMap({}); return }
    ;(async () => {
      const { data } = await (supabase.from('pagos_recibidos')
        .select('id, confirmation_code, usdt_tx_hash, comprob_url, aprobado_por, bank_tx_id')
        .in('id', ids) as any)
      const m: Record<string, any> = {}
      for (const r of (Array.isArray(data) ? data : [])) m[r.id] = r
      setPrMap(m)
    })()
  }, [(deal as any).pagos])

  // CREDITO INTERNO: la fila 'Saldo a Financiar' se toma AUTOMATICAMENTE de
  // Estructura de Financiamiento (pv_monto_financiar) en lugar de digitarse.
  // Crea la fila si falta y sincroniza su monto cuando el campo cambia; si ya
  // existia una fila manual (p.ej. '12 giros') la adopta conservando su referencia.
  useEffect(() => {
    if (view !== 'form') return
    if ((deal as any).banco !== 'FINANCIAMIENTO INTERNO') return
    const monto = parseFloat(String((deal as any).pv_monto_financiar)) || 0
    if (monto <= 0) return
    setDeal((d: any) => {
      if (!d || d.banco !== 'FINANCIAMIENTO INTERNO') return d
      const pagos: any[] = Array.isArray(d.pagos) ? d.pagos : []
      const idx = pagos.findIndex((p: any) => p?.metodo === 'Saldo a Financiar')
      const tasa = parseFloat(d.tasa_bcv) || 0
      if (idx === -1) {
        return { ...d, pagos: [...pagos, {
          metodo: 'Saldo a Financiar',
          fecha: new Date().toISOString().slice(0, 10),
          monto_usd: monto, monto_bs: monto * tasa,
          referencia: 'Financiamiento interno',
          _auto_financiamiento: true,
        }] }
      }
      const cur = pagos[idx]
      if (Math.abs((parseFloat(cur.monto_usd) || 0) - monto) < 0.005) return d
      const np = pagos.slice()
      np[idx] = { ...cur, monto_usd: monto, monto_bs: monto * tasa, _auto_financiamiento: true }
      return { ...d, pagos: np }
    })
  }, [(deal as any).banco, (deal as any).pv_monto_financiar, view])
  const [docsVersion, setDocsVersion] = useState(0)  // bump to re-fetch DocViewer after a scan upload
  const [pago, setPago] = useState({ metodo: '', fecha: '', monto_usd: 0, monto_bs: 0, referencia: '', comentario: '' })

  // Approved deals are normally locked. SURGICAL EXCEPTION: when the user
  // arrived via /inicial-diferida → AI flow (window._diferidaCompromisoId set)
  // AND the deal has a pending diferida compromiso, allow the comprobante
  // modal to save a payment that matches the pending amount. All other
  // editing (fields, manual pago, totals) stays locked.
  const isLocked = deal.status === 'APROBADO'
  const hasPendingDiferida = !!deal.inicial_diferida_compromiso_id && !!deal.inicial_diferida_active
  const isDiferidaPaymentMode = isLocked && hasPendingDiferida && typeof window !== 'undefined' && !!(window as any)._diferidaCompromisoId
  const requiereComprobante = METODOS_REQUIEREN_COMPROBANTE.includes(pago.metodo)

  useEffect(() => {
    if (permsLoading) return
    if (!permissions.npa_can_audit_deals) { router.replace('/dashboard') }
  }, [permsLoading, permissions, role, router])

  const searchParams = useSearchParams()

  useEffect(() => {
    const init = async () => {
      const { data } = await supabase.auth.getUser()
      if (!data.user) { router.push('/'); return }
      setUser(data.user)
      const allDeals = await loadDeals()

      // Handle ?open_deal=ID from global search click + ?open_scanner=ingreso
      // & ?compromiso_id=... from /inicial-diferida → AI flow redirect
      // ?negocio=NUM deep-links by factura number (used by /tesoreria/confirmar
      // so Mirla can verify a devolución against the deal before approving).
      const openId = searchParams?.get('open_deal')
      const openScanner = searchParams?.get('open_scanner')
      const compromisoIdParam = searchParams?.get('compromiso_id')
      const negocioParam = searchParams?.get('negocio')
      if (negocioParam && !openId) {
        let target = allDeals.find((d: any) => String(d.negocio_num) === negocioParam.trim())
        if (!target) {
          const { data: one } = await supabase.from('deals').select('*')
            .eq('negocio_num', negocioParam.trim()).limit(1).maybeSingle()
          if (one) target = one
        }
        if (target) {
          openDeal(target)
          window.history.replaceState({}, '', '/auditoria')
        }
      }
      if (openId) {
        let target = allDeals.find((d: any) => String(d.id) === openId)
        if (!target) {
          // Approved deal beyond the loaded page — fetch it directly so the
          // global-search "open" still works after pagination.
          const { data: one } = await supabase.from('deals').select('*').eq('id', openId).maybeSingle()
          if (one) target = one
        }
        if (target) {
          openDeal(target)
          // Clean URL without reload
          window.history.replaceState({}, '', '/auditoria')
          // If redirected from /inicial-diferida, auto-launch ingreso scanner
          // and remember the compromiso so the AI flow can confirm match
          if (openScanner === 'ingreso') {
            setTimeout(() => {
              setShowComprobante(true)
              if (compromisoIdParam) {
                ;(window as any)._diferidaCompromisoId = compromisoIdParam
              }
            }, 300)
          }
        }
      }
    }
    init()
  }, [])

  // Robust deals loader: time-boxed, one retry after a forced token refresh, and
  // FAIL-LOUD. A swallowed RLS/network/timeout error used to render as a phantom
  // "No hay negocios registrados." — now it surfaces the real cause + Reintentar.
  const APPROVED_PAGE = 5
  // Lean column set for list rows — deliberately EXCLUDES heavy JSONB (pagos,
  // documentos_meta, factura blobs). Includes tasa_bcv (tiny) so the scanner's
  // bs/usd math works off the prop; pagos is re-fetched fresh before any write.
  const DEAL_LIST_COLS = 'id, negocio_num, status, cliente_nombre, cliente_apellidos, vendedor, banco, fecha_entrega, total_cliente, total_recibido, resultado_tipo, tasa_bcv'

  const loadDeals = async (): Promise<any[]> => {
    // Split the load so the page never pulls the ENTIRE approved history at once
    // (that's what hung until the auth watchdog tripped → "sesión expiró").
    // Unapproved (BORRADOR) deals are the audit queue → load them all. Approved
    // deals are reference only → load the latest 5, with "Cargar más" to page
    // the rest on demand.
    //
    // CRITICAL: list rows are LEAN. select('*') dragged the full pagos JSONB —
    // which embeds base64 comprobante_imagen data URLs — for every deal, so the
    // payload reached several MB and timed out even for 5 rows on slow wifi.
    // We pull only the columns the table + scanner read; openDeal() and the
    // IngresoScanner re-fetch the full row by id before any edit/write.
    const runPending = () => withTimeout(
      supabase.from('deals').select(DEAL_LIST_COLS).neq('status', 'APROBADO').order('created_at', { ascending: false }),
      12000, 'deals-pending',
    )
    const runApproved = () => withTimeout(
      supabase.from('deals').select(DEAL_LIST_COLS).eq('status', 'APROBADO').order('created_at', { ascending: false }).range(0, APPROVED_PAGE - 1),
      12000, 'deals-approved',
    )
    try {
      let pend: any = await runPending()
      let appr: any = await runApproved()
      if (pend?.error || appr?.error) {
        // Most common first-attempt failure is an expired JWT — force a refresh
        // and retry once before giving up.
        try { await supabase.auth.refreshSession() } catch { /* ignore */ }
        pend = await runPending()
        appr = await runApproved()
      }
      if (pend?.error || appr?.error) {
        const e = pend?.error || appr?.error
        setDealsError('No se pudieron cargar los negocios: ' + (e?.message || 'error desconocido') + '. Recarga con Ctrl+Shift+R; si persiste, cierra sesion y vuelve a entrar.')
        return deals
      }
      setDealsError('')
      const pendList = pend?.data || []
      const apprList = appr?.data || []
      const list = [...pendList, ...apprList]   // pending first, then approved
      setDeals(list)
      setApprovedOffset(apprList.length)
      setApprovedHasMore(apprList.length === APPROVED_PAGE)
      return list
    } catch (e: any) {
      const msg = String(e?.message || e)
      setDealsError(
        msg.indexOf('timeout') === 0
          ? 'La carga de negocios tardo demasiado y se cancelo (posible conexion lenta o caida de red). Pulsa Reintentar; si sigue, prueba en una ventana de incognito o con otra conexion.'
          : 'Error de red al cargar los negocios: ' + msg + '. Verifica tu conexion y pulsa Reintentar.'
      )
      return deals
    }
  }

  // Append the next page of approved deals on demand (the "Cargar más" button).
  const loadMoreApproved = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const from = approvedOffset
      const to = approvedOffset + APPROVED_PAGE - 1
      const res: any = await withTimeout(
        supabase.from('deals').select(DEAL_LIST_COLS).eq('status', 'APROBADO').order('created_at', { ascending: false }).range(from, to),
        12000, 'deals-approved-more',
      )
      if (res?.error) { setDealsError('No se pudieron cargar más aprobados: ' + (res.error.message || 'error')); return }
      const more = res?.data || []
      setDeals(prev => [...prev, ...more])
      setApprovedOffset(from + more.length)
      setApprovedHasMore(more.length === APPROVED_PAGE)
    } catch (e: any) {
      setDealsError('No se pudieron cargar más aprobados: ' + String(e?.message || e))
    } finally {
      setLoadingMore(false)
    }
  }

  // One deal row — shared by both the Pendientes and Aprobados tables.
  const renderDealRow = (d: any) => (
    <tr key={d.id} style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px' }}>{d.negocio_num}</td>
      <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px' }}>{d.cliente_nombre}{d.cliente_apellidos ? ' ' + d.cliente_apellidos : ''}</td>
      <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.vendedor}</td>
      <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.banco}</td>
      <td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{d.fecha_entrega ? fmtDate(d.fecha_entrega) : ''}</td>
      <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace' }}>{fmt(d.total_cliente || 0)}</td>
      <td style={{ padding: '12px', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace' }}>{fmt(d.total_recibido || 0)}</td>
      <td style={{ padding: '12px' }}>
        <span style={{ padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 700, background: d.resultado_tipo === 'CUADRADO' ? 'rgba(26,122,74,0.2)' : d.resultado_tipo === 'FALTANTE' ? 'rgba(187,22,43,0.2)' : 'rgba(184,114,10,0.2)', color: d.resultado_tipo === 'CUADRADO' ? '#2ecc8a' : d.resultado_tipo === 'FALTANTE' ? '#BB162B' : '#b8720a' }}>
          {d.resultado_tipo || '—'}
        </span>
      </td>
      <td style={{ padding: '12px' }}>
        <span style={{ padding: '3px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: 700, background: d.status === 'APROBADO' ? 'rgba(26,122,74,0.2)' : 'rgba(184,114,10,0.2)', color: d.status === 'APROBADO' ? '#2ecc8a' : '#b8720a' }}>
          {d.status === 'APROBADO' ? 'APROBADO' : 'BORRADOR'}
        </span>
      </td>
      <td style={{ padding: '12px' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => openDeal(d)} style={{ padding: '6px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer' }}>
            {d.status === 'APROBADO' ? 'Ver' : 'Editar'}
          </button>
          {(permissions.npa_can_admin) && d.status !== 'APROBADO' && (
            <button onClick={(e) => { e.stopPropagation(); deleteDeal(d) }}
              style={{ padding: '6px 10px', background: 'transparent', border: '1px solid rgba(187,22,43,0.4)', borderRadius: '6px', color: '#BB162B', fontSize: '12px', cursor: 'pointer' }}>
              🗑
            </button>
          )}
        </div>
      </td>
    </tr>
  )

  const dealsTableHead = (
    <thead>
      <tr style={{ borderBottom: '1px solid var(--border)' }}>
        {['Negocio #', 'Cliente', 'Vendedor', 'Banco', 'F. Entrega', 'Audit Total', 'Ingresos', 'Resultado', 'Estado', ''].map(h => (
          <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px' }}>{h}</th>
        ))}
      </tr>
    </thead>
  )

  // Safe deal deletion: ADMIN-only, requires a reason, and snapshots the FULL
  // row into activity_log BEFORE deleting — so a deleted deal is always
  // attributable AND recoverable (re-insert from details.snapshot). Replaces the
  // old one-click hard delete that vanished deal 56038 with no trace.
  const deleteDeal = async (d: any) => {
    if (!permissions.npa_can_admin) { alert('Solo un administrador puede eliminar negocios.'); return }
    if (d.status === 'APROBADO') { alert('No se puede eliminar un negocio aprobado.'); return }
    const motivo = window.prompt(`Vas a ELIMINAR el negocio #${d.negocio_num} (${d.cliente_nombre || '—'}).\n\nEscribe el motivo (queda registrado y el negocio se puede recuperar del registro):`)
    if (motivo === null) return
    if (motivo.trim().length < 4) { alert('Debes escribir un motivo (mínimo 4 caracteres).'); return }
    try {
      // Snapshot the complete current row (defensive — re-read fresh).
      const { data: snap } = await supabase.from('deals').select('*').eq('id', d.id).maybeSingle()
      if (!snap) { alert('El negocio ya no existe.'); loadDeals(); return }
      const { data: u } = await supabase.auth.getUser()
      const { error: logErr } = await supabase.from('activity_log').insert({
        user_id: u?.user?.id ?? null,
        user_email: u?.user?.email ?? null,
        action: 'deal_deleted',
        target_type: 'deal',
        target_id: String(d.id),
        details: {
          negocio_num: snap.negocio_num,
          cliente_nombre: snap.cliente_nombre,
          status: snap.status,
          motivo: motivo.trim(),
          snapshot: snap,
        },
      })
      if (logErr) { alert('No se pudo registrar la eliminación; se canceló por seguridad: ' + logErr.message); return }
      const { error: delErr } = await supabase.from('deals').delete().eq('id', d.id)
      if (delErr) { alert('No se pudo eliminar: ' + delErr.message); return }
      loadDeals()
    } catch (e: any) {
      alert('Error al eliminar: ' + (e?.message || 'desconocido'))
    }
  }

  const openDeal = async (d: any) => {
    // List rows are lean (no heavy JSONB) so they load fast on slow connections.
    // Now that the user is opening this deal for audit/edit, fetch the FULL row
    // by id so pagos / documentos_meta / factura fields are present — and so a
    // subsequent save never writes the row back with missing columns nulled.
    const { data: full } = await supabase.from('deals').select('*').eq('id', d.id).maybeSingle()
    const base = full || d
    setEditingDeal(base)
    // Load active inicial diferida compromiso (if any)
    const { data: compromiso } = await supabase
      .from('compromisos_inicial_diferida')
      .select('*')
      .eq('deal_id', base.id)
      .neq('estado', 'CANCELADA')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    setDeal({
      ...base,
      pagos: Array.isArray(base.pagos) ? base.pagos : [],
      tasa_bcv: base.tasa_bcv?.toString() || '',
      tasa_variable: base.tasa_variable?.toString() || '',
      inicial_diferida_active: !!compromiso && compromiso.estado === 'PENDIENTE',
      inicial_diferida_monto: compromiso?.monto_usd || 0,
      inicial_diferida_fecha_vencimiento: compromiso?.fecha_vencimiento || '',
      inicial_diferida_custodia: compromiso?.custodia_motocentro || false,
      inicial_diferida_notas: compromiso?.notas || '',
      inicial_diferida_compromiso_id: compromiso?.id,
    })
    setView('form')
  }

  const calcTotals = (d: Deal) => {
    const pv_total = PROYECTO_FIELDS.reduce((sum, f) => sum + (d[f.key as keyof Deal] as number || 0), 0)
    const au_total_base = AUDITORIA_FIELDS.reduce((sum, f) => sum + (d[f.key as keyof Deal] as number || 0), 0)
    // ★ IGTF surplus recovery: when IGTF was charged to the client inside the factura
    //   but Deisi (correctly) zeroed au_igtf because it doesn't get paid out separately,
    //   that money is real revenue. The difference between proyecto and auditoría IGTF
    //   represents recovered surplus revenue that must be added to the audit total.
    const igtf_recovered = Math.max(0, (d.pv_igtf || 0) - (d.au_igtf || 0))
    const au_total = au_total_base + igtf_recovered
    const total_ingresos = (d.pagos || []).reduce((sum: number, p: any) => sum + (parseFloat(p.monto_usd) || 0), 0)
    const neto = au_total - total_ingresos
    const resultado_tipo = Math.abs(neto) <= 0.05 ? 'CUADRADO' : neto > 0 ? 'FALTANTE' : 'SOBRANTE'
    const diff_pv_au = au_total - pv_total
    return { pv_total, au_total, au_total_base, igtf_recovered, total_ingresos, neto, resultado_tipo, diff_pv_au }
  }

  const calcPivca = (d: Deal) => {
    const liquidacionPivca = (d.pagos || []).filter((p: any) => p.metodo === 'Liquidación PIVCA').reduce((sum: number, p: any) => sum + (parseFloat(p.monto_usd) || 0), 0)
    // Sin liquidación registrada la comisión es desconocida (el banco aún no paga):
    // NO asumir que todo el monto a financiar es comisión. Estado pendiente = 0.
    const pendiente = liquidacionPivca <= 0
    const comisionBanco = pendiente ? 0 : d.pv_monto_financiar - liquidacionPivca
    const diferencia = pendiente ? 0 : comisionBanco - d.pv_comision_flat_cobrado
    return { liquidacionPivca, comisionBanco, diferencia, pendiente }
  }

  // ── Devolución al cliente (SOBRANTE) ──────────────────────────────────────
  // Crea un comprobante EGRESO · DEVOLUCION_CLIENTE en estado SOLICITADO con
  // revision_estado 'pendiente' (cola de aprobación de Mirla). NO toca
  // deal.pagos aquí — la línea negativa se escribe al ejecutarse el pago
  // desde Caja Chica.
  const openDevolucion = async () => {
    if (!editingDeal?.id) return
    const t = calcTotals(deal)
    setDevMonto(Math.abs(t.neto).toFixed(2))
    setDevMotivo(''); setDevError(''); setDevExistentes([])
    setShowDevolucion(true)
    // Aviso de devoluciones ya en curso para este negocio (no bloquea).
    const { data: prev } = await (supabase.from('tesoreria_comprobantes')
      .select('id, numero, monto_usd, estado, revision_estado')
      .eq('egreso_tipo', 'DEVOLUCION_CLIENTE')
      .eq('source_type', 'DEAL')
      .eq('source_id', String(editingDeal.id))
      .neq('estado', 'ANULADO') as any)
    setDevExistentes(Array.isArray(prev) ? prev : [])
  }

  const handleDevolucionSubmit = async () => {
    setDevError('')
    if (!editingDeal?.id || !user) { setDevError('Negocio no cargado.'); return }
    const monto = parseFloat(devMonto) || 0
    if (monto <= 0) { setDevError('Indica un monto válido.'); return }
    if (!devMotivo.trim()) { setDevError('El motivo de la devolución es obligatorio.'); return }
    setDevSaving(true)
    try {
      // TOPE DURO: no se puede devolver más del sobrante disponible = sobrante
      // actual − devoluciones en curso (SOLICITADO, pendientes o aprobadas sin
      // pagar). Las ya pagadas no se restan aquí: su línea negativa en pagos ya
      // redujo el sobrante. Se consulta fresco al enviar para que dos
      // solicitudes seguidas no sumen más que el sobrante.
      const t = calcTotals(deal)
      const { data: enCurso } = await (supabase.from('tesoreria_comprobantes')
        .select('id, monto_usd')
        .eq('egreso_tipo', 'DEVOLUCION_CLIENTE').eq('source_type', 'DEAL')
        .eq('source_id', String(editingDeal.id)).eq('estado', 'SOLICITADO') as any)
      const comprometido = (Array.isArray(enCurso) ? enCurso : []).reduce((s: number, c: any) => s + Number(c.monto_usd || 0), 0)
      const disponible = (t.resultado_tipo === 'SOBRANTE' ? Math.abs(t.neto) : 0) - comprometido
      if (monto > disponible + 0.005) {
        throw new Error(
          `No se puede devolver más del sobrante disponible: ${fmt(Math.max(0, disponible))}` +
          (comprometido > 0 ? ` (sobrante ${fmt(Math.abs(t.neto))} − ${fmt(comprometido)} ya en devoluciones en curso).` : '.')
        )
      }

      const { data: ubic, error: uErr } = await (supabase.from('tesoreria_ubicaciones')
        .select('id, codigo, nombre').eq('codigo', 'CAJA_CHICA').eq('activa', true).limit(1).maybeSingle() as any)
      if (uErr || !ubic) throw new Error('No se encontró la ubicación Caja Chica en tesorería.')

      const { data: numeroData, error: nErr } = await supabase.rpc('tesoreria_next_voucher_numero', { p_tipo: 'EGRESO' })
      if (nErr) throw new Error('Error generando número: ' + nErr.message)
      const numero = numeroData as string

      const clienteNombre = [deal.cliente_nombre, deal.cliente_apellidos].filter(Boolean).join(' ').trim()
      const { data: compr, error: cErr } = await (supabase.from('tesoreria_comprobantes')
        .insert({
          numero, tipo: 'EGRESO', egreso_tipo: 'DEVOLUCION_CLIENTE',
          estado: 'SOLICITADO', revision_estado: 'pendiente',
          monto_usd: monto, concepto: devMotivo.trim(),
          contraparte_nombre: clienteNombre || null,
          source_type: 'DEAL', source_id: String(editingDeal.id),
          source_label: `Neg ${deal.negocio_num} · ${clienteNombre}`.trim(),
          ubicacion_origen_id: ubic.id,
          es_urgente: false, qr_payload: '', solicitado_by: user.id,
        })
        .select('id, numero').single() as any)
      if (cErr || !compr) throw new Error('Error creando la solicitud: ' + (cErr?.message || 'sin respuesta (revisa RLS)'))

      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: compr.id, evento: 'CREADO', actor_user_id: user.id, actor_label: 'Auditoría',
        notas: `Devolución al cliente solicitada · ${fmt(monto)} · ${devMotivo.trim()}`,
      })
      await supabase.from('activity_log').insert({
        user_id: user.id, user_email: user.email,
        action: 'devolucion_cliente_solicitada',
        target_type: 'tesoreria_comprobante', target_id: String(compr.id),
        details: { negocio_num: deal.negocio_num, cliente: clienteNombre, monto_usd: monto, motivo: devMotivo.trim(), numero },
      })

      setShowDevolucion(false)
      alert(`✓ Solicitud de devolución ${numero} creada por ${fmt(monto)}.\n\nPasa a la cola de aprobación de Tesorería; al aprobarse, Caja Chica ejecuta el pago al cliente.`)
    } catch (e: any) {
      setDevError(e?.message || 'Error inesperado al crear la solicitud.')
    } finally { setDevSaving(false) }
  }

  const checkDuplicate = (newPago: any): string => {
    const existing = deal.pagos
    if (newPago.referencia && existing.some((p: any) => p.referencia && p.referencia.trim().toLowerCase() === newPago.referencia.trim().toLowerCase())) {
      return `Ya existe un pago con la referencia "${newPago.referencia}".`
    }
    if (existing.some((p: any) => p.metodo === newPago.metodo && Math.abs(parseFloat(p.monto_usd) - parseFloat(newPago.monto_usd)) < 0.01 && p.fecha === newPago.fecha)) {
      return `Ya existe un pago de ${newPago.metodo} por ${fmt(parseFloat(newPago.monto_usd))} en la misma fecha.`
    }
    return ''
  }

  const handlePagoMetodoChange = (metodo: string) => setPago(p => ({ ...p, metodo, monto_usd: 0, monto_bs: 0 }))
  // ── Bs↔USD rate for a payment line ────────────────────────────────────────
  // Banco Provincial pays the financed portion in Bs; we realize that cash in
  // USD at the Binance (street) rate — held in deal.tasa_variable — NOT BCV.
  // Every other bank keeps converting Bs at the official BCV rate as before.
  const pagoTasa = (): number => {
    if (deal.banco === 'Banco Provincial') {
      const tb = parseFloat(deal.tasa_variable) || 0
      if (tb > 0) return tb
    }
    return parseFloat(deal.tasa_bcv) || 1
  }
  const provincialNeedsBinance = (): boolean =>
    deal.banco === 'Banco Provincial' && (parseFloat(deal.tasa_variable) || 0) <= 0
  const handlePagoUsdChange = (usd: number) => { const tasa = pagoTasa(); setPago(p => ({ ...p, monto_usd: usd, monto_bs: usd * tasa })) }
  const handlePagoBsChange = (bs: number) => {
    if (provincialNeedsBinance()) {
      alert('Banco Provincial: ingresa primero la "Tasa Binance (Provincial)" para convertir los Bs a USD. (No se usa la tasa BCV en este banco.)')
      return
    }
    const tasa = pagoTasa()
    setPago(p => ({ ...p, monto_bs: bs, monto_usd: tasa > 0 ? bs / tasa : 0 }))
  }

  const tryAddPago = (pagoToAdd: any) => {
    const dupMsg = checkDuplicate(pagoToAdd)
    if (dupMsg) { setDuplicateMsg(dupMsg); setPendingPago(pagoToAdd); setShowDuplicate(true) }
    else commitPago(pagoToAdd)
  }

 const commitPago = async (pagoToAdd: any) => {
    // ── DIFERIDA PAYMENT MODE: deal is APROBADO, but we're settling a pending
    // diferida via the AI flow from /inicial-diferida. Persist directly to DB
    // (don't go through normal save). Mark compromiso PAGADA + replace
    // placeholder pago in deal.pagos. Status stays APROBADO; totals untouched
    // beyond replacing the placeholder amount.
    if (isDiferidaPaymentMode && deal.inicial_diferida_compromiso_id && editingDeal?.id) {
      const tasa = parseFloat(deal.tasa_bcv) || 0
      const newPagos = (deal.pagos || []).filter((p: any) => !(p._inicial_diferida && p._pendiente))
      newPagos.push(pagoToAdd)
      const total_recibido = newPagos.reduce((s: number, p: any) => s + (parseFloat(p.monto_usd) || 0), 0)
      const { error: dealErr } = await supabase.from('deals')
        .update({ pagos: newPagos, total_recibido }).eq('id', editingDeal.id)
      if (dealErr) { alert('Error al guardar el pago: ' + dealErr.message); return }
      const { error: cErr } = await supabase.from('compromisos_inicial_diferida')
        .update({
          estado: 'PAGADA',
          pagado_at: new Date().toISOString(),
          pagado_pago_ref: pagoToAdd.referencia || null,
          pagado_pago_metodo: pagoToAdd.metodo || null,
        }).eq('id', deal.inicial_diferida_compromiso_id)
      if (cErr) { alert('El pago se guardó pero el compromiso no se marcó como pagado: ' + cErr.message); return }
      if (pagoToAdd._imageHash && pagoToAdd._imageFilename) {
        await registerImage(String(editingDeal.id), deal.negocio_num, pagoToAdd._imageHash, pagoToAdd._imageFilename)
      }
      if (user) {
        await supabase.from('activity_log').insert({
          user_id: user.id, user_email: user.email,
          action: 'inicial_diferida_pagada_ai',
          target_type: 'compromiso_inicial_diferida',
          target_id: String(deal.inicial_diferida_compromiso_id),
          details: { negocio_num: deal.negocio_num, monto: pagoToAdd.monto_usd, metodo: pagoToAdd.metodo, referencia: pagoToAdd.referencia },
        })
      }
      // Clear and return to /inicial-diferida via soft navigation
      ;(window as any)._diferidaCompromisoId = undefined
      setShowDuplicate(false); setPendingPago(null)
      alert(`✓ Pago registrado y compromiso marcado como PAGADO.\n\n${fmt(pagoToAdd.monto_usd)} — ${pagoToAdd.metodo}`)
      router.push('/inicial-diferida')
      return
    }
    // ── NORMAL FLOW (BORRADOR deals) — unchanged
    setDeal(d => {
      const placeholderIdx = d.pagos.findIndex((p: any) => p._inicial_diferida && p._pendiente)
      let newPagos = [...d.pagos, pagoToAdd]
      if (placeholderIdx >= 0 && !pagoToAdd._inicial_diferida) {
        const placeholder = d.pagos[placeholderIdx]
        const placeholderAmount = parseFloat(placeholder.monto_usd) || 0
        const newPagoAmount = parseFloat(pagoToAdd.monto_usd) || 0
        if (Math.abs(placeholderAmount - newPagoAmount) <= 0.5) {
          const ok = window.confirm(
            `Este pago de ${fmt(newPagoAmount)} coincide con el monto de la Inicial Diferida pendiente.\n\n` +
            `¿Marcar la Inicial Diferida como PAGADA con este pago?`
          )
          if (ok) {
            newPagos = [...d.pagos.filter((_, i) => i !== placeholderIdx), pagoToAdd]
            if (d.inicial_diferida_compromiso_id) {
              supabase.from('compromisos_inicial_diferida')
                .update({
                  estado: 'PAGADA',
                  pagado_at: new Date().toISOString(),
                  pagado_pago_ref: pagoToAdd.referencia || null,
                  pagado_pago_metodo: pagoToAdd.metodo || null,
                })
                .eq('id', d.inicial_diferida_compromiso_id)
                .then(() => {})
            }
            return { ...d, pagos: newPagos, inicial_diferida_active: false }
          }
        }
      }
      return { ...d, pagos: newPagos }
    })
    setPago({ metodo: '', fecha: '', monto_usd: 0, monto_bs: 0, referencia: '', comentario: '' })
    setShowDuplicate(false)
    setPendingPago(null)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Payment entry — TWO FLOWS, equal status:
  //  A) AI flow: click "Subir Comprobante con IA" → ComprobanteModal opens
  //     immediately, AI detects method + fields, user confirms/corrects, saves.
  //  B) Manual flow: click "Agregar Manualmente" → inline form expands,
  //     user types method/amount/ref/fecha and saves. For cash, PIVCA, etc.
  // ──────────────────────────────────────────────────────────────────────────
  const handleAddPagoManual = () => {
    if (!pago.metodo) { alert('Selecciona un método de pago.'); return }
    if (!pago.monto_usd || pago.monto_usd <= 0) { alert('Monto USD debe ser mayor a cero.'); return }
    tryAddPago({ ...pago, _manual: true, _manual_by: user?.email || null, _manual_at: new Date().toISOString() })
  }
// ──────────────────────────────────────────────────────────────────────────
  // Phase 2: Handle QR scan of a tesorería comprobante (cash slip from
  // Mirla/Angeles). The scanner has already validated the QR server-side via
  // tesoreria_lookup_by_qr and confirmed it's a PENDIENTE_PICKUP INGRESO.
  //
  // We auto-fill a pago with the comprobante's data:
  //   metodo                    = 'Efectivo'
  //   monto_usd / monto_bs      = from comprobante (tasa applied)
  //   fecha                     = comprobante.created_at (date portion)
  //   referencia                = 'Tes #<numero>'
  //   comentario                = builds from contraparte + ubicacion
  //   _tesoreria_comprobante_id = back-link, used by handleSave to stamp
  //                               the comprobante's source_* fields
  //   _verified_by_cash         = visual flag (mirrors _verified_by_bank)
  // ──────────────────────────────────────────────────────────────────────────
  const handleQRScanned = (comp: ScannedComprobante) => {
    setShowQRScanner(false)

    // Guard: don't attach the same comprobante twice to this deal
    if (deal.pagos.some((p: any) => p._tesoreria_comprobante_id === comp.id)) {
      alert(`El comprobante de tesorería #${comp.numero} ya está adjunto a este negocio.`)
      return
    }

    const tasa = parseFloat(deal.tasa_bcv) || 1
    const fechaIso = comp.created_at.slice(0, 10)  // YYYY-MM-DD from timestamptz

    const parts: string[] = []
    if (comp.contraparte_nombre) parts.push(`Recibido por: ${comp.ubicacion_destino_nombre}`)
    if (comp.concepto)           parts.push(comp.concepto)

    const cashPago: any = {
      metodo:                      'Efectivo',
      fecha:                       fechaIso,
      monto_usd:                   comp.monto_usd,
      monto_bs:                    comp.monto_usd * tasa,
      referencia:                  `Tes #${comp.numero}`,
      comentario:                  parts.join(' · '),
      _tesoreria_comprobante_id:   comp.id,
      _tesoreria_comprobante_num:  comp.numero,
      _tesoreria_ubicacion_codigo: comp.ubicacion_destino_codigo,
      _verified_by_cash:           true,
    }

    // Reuse the duplicate-check + commit pipeline. Cash pagos shouldn't
    // collide on referencia (each has a unique Tes #), but reusing keeps
    // the audit log + diferida-match logic intact.
    tryAddPago(cashPago)
  }

  const handleComprobanteConfirm = async (aiData: any) => {
    // Check if this image hash is already used by another payment IN THIS SAME DEAL (in-memory)
    if (aiData._hash) {
      const alreadyUsedInDeal = deal.pagos.some((p: any) => p._imageHash === aiData._hash)
      if (alreadyUsedInDeal) {
        alert('Este comprobante ya fue adjuntado a otro pago en este negocio. No se puede usar el mismo comprobante dos veces.')
        return
      }
    }

    // ★ v2: aiData.metodo comes from the user-confirmed dropdown inside the
    //      ComprobanteModal (which itself was prefilled by AI detection). This
    //      overrides whatever method was pre-selected in the manual form.
    //      Previously the spread `...pago` would let a stale manual selection
    //      (e.g. "Zelle Roframi") win over a USDT detection.
    const tasa = parseFloat(deal.tasa_bcv) || 1
    const metodoFinal = aiData.metodo || pago.metodo
    const montoFinal = aiData.monto || pago.monto_usd || 0

    // 2026-05-07: also try to upload to storage if we have the File reference.
    // ComprobanteModal needs to pass back aiData.file for this to work; if absent,
    // fall back to legacy data URL with proper MIME detection.
    let comprobantePath: string | undefined
    let comprobanteMime: string | undefined
    if (aiData.file) {
      const negocioNum = deal.negocio_num || editingDeal?.negocio_num || null
      const dealIdLocal = editingDeal?.id || null
      const result = await uploadDealDoc({
        file: aiData.file, negocioNum, dealId: dealIdLocal, type: 'pago',
      })
      if (!result.error && result.path) {
        comprobantePath = result.path
        comprobanteMime = result.mime
      }
    }

    const enrichedPago = {
      metodo:             metodoFinal,
      fecha:              aiData.fecha || pago.fecha || '',
      monto_usd:          montoFinal,
      monto_bs:           montoFinal * tasa,
      referencia:         aiData.referencia || pago.referencia || '',
      comentario:         aiData.comentario || '',
      // Legacy data URL — normalize MIME from bytes (was hardcoded image/jpeg before)
      comprobante_imagen: aiData.imagen ? (aiData.imagen.startsWith('data:') ? buildDataUrl(aiData.imagen.split(',')[1] || '') : buildDataUrl(aiData.imagen)) : undefined,
      // New storage path (preferred for rendering)
      comprobante_path:   comprobantePath,
      comprobante_mime:   comprobanteMime,
      notas_ai:           aiData.notas,
      _imageHash:         aiData._hash,
      _imageFilename:     aiData._filename,
    }
    setShowComprobante(false)
    // Reset the manual form so it doesn't retain stale values from a previous entry
    setPago({ metodo: '', fecha: '', monto_usd: 0, monto_bs: 0, referencia: '', comentario: '' })
    tryAddPago(enrichedPago)
  }

  const removePago = (i: number) => setDeal(d => ({ ...d, pagos: d.pagos.filter((_: any, idx: number) => idx !== i) }))

  // 2026-05-07: now async — each item uploads to storage in parallel before
  // being committed to the in-memory deal.pagos state. Failed uploads still
  // commit (with legacy data URL fallback) so Deisi doesn't lose work.
  const handleMultiConfirm = async (readyItems: any[]) => {
    const tasa = parseFloat(deal.tasa_bcv) || 1
    const negocioNum = deal.negocio_num || editingDeal?.negocio_num || null
    const dealId = editingDeal?.id || null

    const newPagos = await Promise.all(readyItems.map(async (item: any) => {
      let comprobantePath: string | undefined
      let comprobanteMime: string | undefined
      if (item.file) {
        const result = await uploadDealDoc({
          file: item.file, negocioNum, dealId, type: 'pago',
        })
        if (!result.error && result.path) {
          comprobantePath = result.path
          comprobanteMime = result.mime
        }
      }
      return {
        metodo: pago.metodo || 'Zelle',
        fecha: item.result.fecha || '',
        monto_usd: item.result.monto || 0,
        monto_bs: (item.result.monto || 0) * tasa,
        referencia: item.result.referencia || '',
        comentario: item.result.notas || '',
        // Legacy data URL still kept for back-compat
        comprobante_imagen: item.image,
        // New storage path (preferred when present)
        comprobante_path: comprobantePath,
        comprobante_mime: comprobanteMime,
        notas_ai: item.result.notas,
        _imageHash: item.hash,
        _imageFilename: item.file?.name,
      }
    }))
    setDeal(d => ({ ...d, pagos: [...d.pagos, ...newPagos] }))
    setShowMultiComprobante(false)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ★ FIX #1: Save-overwrite race
  // Before: UPDATE included status='BORRADOR' from stale editingDeal snapshot,
  //         overwriting approvals landed by Gerencia while Deisi was editing.
  // After: UPDATE never touches status/approved_*/unlocked_* fields. Those are
  //        owned exclusively by admin's handleApprove/handleUnlock. Also,
  //        a fresh DB read right before saving detects if the deal was approved
  //        while open, and cancels the save with a clear warning.
  // ═══════════════════════════════════════════════════════════════════════════
  const handleSave = async () => {
    if (!user) { alert('Sesión no iniciada. Recarga la página.'); return }

    // Duplicate factura number check
    if (deal.negocio_num) {
      const { data: existing } = await supabase
        .from('deals')
        .select('id, negocio_num')
        .eq('negocio_num', deal.negocio_num)
        .single()
      if (existing && existing.id !== editingDeal?.id) {
        alert(`Ya existe un negocio con el N° de factura ${deal.negocio_num}. No se pueden duplicar negocios.`)
        return
      }
    }

    // Required-field validation: both Año Modelo (factura) and Año Fabricación (CDO) must be present
    if (!deal.vehiculo_año) {
      alert('Falta el AÑO MODELO. Verifica el campo en la sección Vehículo (debe coincidir con el "Año:" de la factura).')
      return
    }
    if (!deal.vehiculo_año_fabricacion) {
      alert('Falta el AÑO DE FABRICACIÓN. Verifica el campo en la sección Vehículo (debe coincidir con el "Año Fabricación" del Certificado de Origen).')
      return
    }

    setSaving(true)

    // ★ CRITICAL: pre-save freshness check. If Gerencia approved while Deisi was
    // editing, abort the save instead of overwriting the approval.
    if (editingDeal?.id) {
      const { data: current, error: freshErr } = await supabase
        .from('deals')
        .select('status, approved_at, approved_by')
        .eq('id', editingDeal.id)
        .single()
      if (freshErr) {
        alert('No se pudo verificar el estado actual del negocio. Intenta de nuevo.')
        setSaving(false)
        return
      }
      if (current?.status === 'APROBADO') {
        alert(
          `Este negocio fue APROBADO por Gerencia mientras lo editabas.\n\n` +
          `Tus cambios NO se guardaron para no sobrescribir la aprobación.\n\n` +
          `Si necesitas modificarlo, pide a Gerencia que lo desbloquee primero.`
        )
        setSaving(false)
        setView('list')
        setEditingDeal(null)
        setDeal({ ...emptyDeal })
        loadDeals()
        return
      }
    }

    const totals = calcTotals(deal)
    const pivcaComision = calcPivca(deal)

    // Build the payload. CRITICAL: do NOT include status, approved_at, approved_by,
    // unlocked_by, unlocked_at, unlock_reason — those belong to the approval flow only.
    const payload: any = {
      negocio_num:            deal.negocio_num || null,
      cliente_nombre:         deal.cliente_nombre || null,
      cliente_rif_tipo:       deal.cliente_rif_tipo || 'V',
      cliente_rif:            deal.cliente_rif || null,
      vendedor:               deal.vendedor || null,
      banco:                  deal.banco || null,
      fecha_factura:          deal.fecha_factura || null,
      fecha_entrega:          deal.fecha_entrega || null,
      vin:                    deal.vin || null,
      inventory_vin:          deal.inventory_vin || null,
      factura_compra_numero:    deal.factura_compra_numero || null,
      factura_compra_fecha:     deal.factura_compra_fecha || null,
      factura_compra_body_neto: n(deal.factura_compra_body_neto),
      factura_compra_igtf:      n(deal.factura_compra_igtf),
      factura_compra_placa:     n(deal.factura_compra_placa),
      factura_compra_total:     n(deal.factura_compra_total),
      tasa_bcv:               n(deal.tasa_bcv),
      tasa_variable:          n(deal.tasa_variable),
      pv_precio:              n(deal.pv_precio),
      pv_gastos_admin:        n(deal.pv_gastos_admin),
      pv_seguro:              n(deal.pv_seguro),
      pv_igtf:                n(deal.pv_igtf),
      pv_accesorios:          n(deal.pv_accesorios),
      pv_placas:              n(deal.pv_placas),
      pv_inicial:             n(deal.pv_inicial),
      pv_monto_financiar:     n(deal.pv_monto_financiar),
      pv_comision_banco:      deal.banco === 'PIVCA' ? n(pivcaComision.comisionBanco) : n(deal.pv_comision_banco),
      pv_comision_flat_cobrado: n(deal.pv_comision_flat_cobrado),
      au_precio:              n(deal.au_precio),
      au_gastos_admin:        n(deal.au_gastos_admin),
      au_seguro:              n(deal.au_seguro),
      au_igtf:                n(deal.au_igtf),
      au_accesorios:          n(deal.au_accesorios),
      au_comision_flat:       n(deal.au_comision_flat),
      au_placas:              n(deal.au_placas),
      seguro_2do_ano:         deal.seguro_2do_ano,
      seguro_2do_ano_monto:   n(deal.seguro_2do_ano_monto),
      pagos:                  deal.pagos,
      total_cliente:          totals.au_total,
      total_recibido:         totals.total_ingresos,
      resultado:              totals.neto,
      resultado_tipo:         totals.resultado_tipo,
      igtf:                   n(deal.au_igtf),
      comision_banco:         n(deal.au_comision_flat),
      monto_financiar:        n(deal.pv_monto_financiar),
      cliente_apellidos:      deal.cliente_apellidos || null,
      cliente_direccion:      deal.cliente_direccion || null,
      cliente_telefono:       deal.cliente_telefono || null,
      cliente_email:          deal.cliente_email || null,
      cliente_estado_civil:   deal.cliente_estado_civil || null,
      vehiculo_marca:         deal.vehiculo_marca || null,
      vehiculo_modelo:        deal.vehiculo_modelo || null,
      vehiculo_color:         deal.vehiculo_color || null,
      vehiculo_placa:         deal.vehiculo_placa || null,
      vehiculo_año:           deal.vehiculo_año || null,
      vehiculo_año_fabricacion: deal.vehiculo_año_fabricacion || null,
      vehiculo_clase:         deal.vehiculo_clase || null,
      vehiculo_uso:           deal.vehiculo_uso || null,
    }

    let savedDealId = editingDeal?.id

    if (editingDeal?.id) {
      // UPDATE: payload deliberately does NOT contain status/approved_*/unlocked_*.
      // Those fields keep their current values in the DB.
      const { error } = await supabase.from('deals').update(payload).eq('id', editingDeal.id)
      if (error) { alert('Error al guardar: ' + error.message); setSaving(false); return }
    } else {
      // INSERT: set initial status to BORRADOR and record created_by.
      const insertPayload = { ...payload, status: 'BORRADOR', created_by: user.id }
      const { data, error } = await supabase.from('deals').insert(insertPayload).select('id').single()
      if (error) { alert('Error al guardar: ' + error.message); setSaving(false); return }
      savedDealId = data?.id
    }

    // Register any new image hashes from payments that have them
    if (savedDealId) {
      for (const p of deal.pagos) {
        if (p._imageHash && p._imageFilename) {
          await registerImage(savedDealId, deal.negocio_num, p._imageHash, p._imageFilename)
        }
      }
      // ── Phase 2: back-stamp tesorería comprobantes ──────────────────────
      // For any pago in this deal that came from a QR scan, write the
      // deal_id + label back onto the comprobante. This lets Mirla see
      // "applied to Negocio #X" on her tesorería dashboard.
      for (const p of deal.pagos) {
        if (p._tesoreria_comprobante_id) {
          await supabase
            .from('tesoreria_comprobantes')
            .update({
              source_type:  'deal_pago',
              source_id:    String(savedDealId),
              source_label: `Negocio #${deal.negocio_num} — ${deal.cliente_nombre || ''}`.trim(),
            })
            .eq('id', p._tesoreria_comprobante_id)
        }
      }
      // Log the save action
      await supabase.from('activity_log').insert({
        user_id:     user.id,
        user_email:  user.email,
        action:      'deal_saved',
        target_type: 'deal',
        target_id:   String(savedDealId),
        details: {
          negocio_num:    deal.negocio_num,
          cliente_nombre: deal.cliente_nombre,
          banco:          deal.banco,
          is_edit:        !!editingDeal?.id,
          resultado_tipo: totals.resultado_tipo,
        },
      })

      // ── INICIAL DIFERIDA: upsert compromiso + manage placeholder pago ──
      if (deal.inicial_diferida_active && deal.inicial_diferida_monto && deal.inicial_diferida_fecha_vencimiento) {
        const compromisoPayload: any = {
          deal_id:                 savedDealId,
          negocio_num:             deal.negocio_num,
          cliente_nombre:          deal.cliente_nombre,
          cliente_apellidos:       deal.cliente_apellidos || null,
          cliente_rif_tipo:        deal.cliente_rif_tipo || 'V',
          cliente_rif:             deal.cliente_rif || null,
          cliente_direccion:       deal.cliente_direccion || null,
          cliente_telefono:        deal.cliente_telefono || null,
          vehiculo_marca:          deal.vehiculo_marca || null,
          vehiculo_modelo:         deal.vehiculo_modelo || null,
          vehiculo_color:          deal.vehiculo_color || null,
          vehiculo_placa:          deal.vehiculo_placa || null,
          vin:                     deal.vin || null,
          monto_usd:               deal.inicial_diferida_monto,
          monto_bs:                (deal.inicial_diferida_monto || 0) * (parseFloat(deal.tasa_bcv) || 0),
          tasa_bcv:                parseFloat(deal.tasa_bcv) || null,
          precio_total_vehiculo:   totals.au_total,
          inicial_total_acordada:  deal.pv_inicial || 0,
          inicial_pagada_hoy:      Math.max(0, (deal.pv_inicial || 0) - (deal.inicial_diferida_monto || 0)),
          fecha_vencimiento:       deal.inicial_diferida_fecha_vencimiento,
          custodia_motocentro:     !!deal.inicial_diferida_custodia,
          notas:                   deal.inicial_diferida_notas || null,
          estado:                  'PENDIENTE',
          created_by:              user.id,
        }
        // Add vehiculo_año only if present, using the Spanish column name (matches DB schema)
        if (deal.vehiculo_año) {
          (compromisoPayload as any)['vehiculo_año'] = deal.vehiculo_año
        }
        if (deal.inicial_diferida_compromiso_id) {
          const { error: updErr } = await supabase.from('compromisos_inicial_diferida')
            .update(compromisoPayload)
            .eq('id', deal.inicial_diferida_compromiso_id)
          if (updErr) {
            console.error('Compromiso UPDATE failed:', updErr)
            alert('Error al actualizar el compromiso de inicial diferida:\n\n' + updErr.message + '\n\nEl negocio se guardó pero el compromiso no. Revisa la consola.')
          }
        } else {
          const { data: insertedCompromiso, error: insErr } = await supabase.from('compromisos_inicial_diferida')
            .insert(compromisoPayload)
            .select('id')
            .single()
          if (insErr) {
            console.error('Compromiso INSERT failed:', insErr)
            alert('Error al crear el compromiso de inicial diferida:\n\n' + insErr.message + '\n\nEl negocio se guardó pero el compromiso no. Revisa la consola.')
          } else if (insertedCompromiso) {
            // Capture the new compromiso ID so subsequent saves UPDATE instead of INSERT
            setDeal(d => ({ ...d, inicial_diferida_compromiso_id: insertedCompromiso.id }))
          }
        }
        // Ensure placeholder pago exists in deals.pagos array (counts as ingreso for squaring)
        const hasPlaceholder = deal.pagos.some((p: any) => p._inicial_diferida && p._pendiente)
        if (!hasPlaceholder) {
          const tasa = parseFloat(deal.tasa_bcv) || 0
          const placeholder = {
            metodo: 'Inicial Diferida',
            fecha: deal.inicial_diferida_fecha_vencimiento,
            monto_usd: deal.inicial_diferida_monto,
            monto_bs: (deal.inicial_diferida_monto || 0) * tasa,
            referencia: 'PENDIENTE',
            comentario: `Compromiso de pago — vence ${fmtDate(deal.inicial_diferida_fecha_vencimiento || '')}`,
            _inicial_diferida: true,
            _pendiente: true,
          }
          const newPagos = [...deal.pagos, placeholder]
          await supabase.from('deals')
            .update({ pagos: newPagos, total_recibido: newPagos.reduce((s: number, p: any) => s + (parseFloat(p.monto_usd) || 0), 0) })
            .eq('id', savedDealId)
        }
     } else if (!deal.inicial_diferida_active) {
        // User toggled OFF (or it was off and stayed off). Find ANY active compromisos
        // for this deal, regardless of compromiso_id state, to handle orphan cases.
        const { data: activeCompromisos, error: fetchErr } = await supabase
          .from('compromisos_inicial_diferida')
          .select('id')
          .eq('deal_id', savedDealId)
          .eq('estado', 'PENDIENTE')

        if (fetchErr) {
          console.error('Failed to query active compromisos:', fetchErr)
        } else if (activeCompromisos && activeCompromisos.length > 0) {
          const { error: cancelErr } = await supabase.from('compromisos_inicial_diferida')
            .update({
              estado: 'CANCELADA',
              cancelado_at: new Date().toISOString(),
              cancelado_motivo: 'Desactivado en auditoría',
            })
            .eq('deal_id', savedDealId)
            .eq('estado', 'PENDIENTE')
          if (cancelErr) {
            console.error('Failed to cancel compromisos:', cancelErr)
            alert('Error al cancelar el compromiso de inicial diferida:\n\n' + cancelErr.message + '\n\nRevisa la consola.')
          } else {
            console.log(`Cancelled ${activeCompromisos.length} compromiso(s) for deal ${savedDealId}`)
          }
        }
        const cleanedPagos = deal.pagos.filter((p: any) => !(p._inicial_diferida && p._pendiente))
        if (cleanedPagos.length !== deal.pagos.length) {
          await supabase.from('deals')
            .update({ pagos: cleanedPagos, total_recibido: cleanedPagos.reduce((s: number, p: any) => s + (parseFloat(p.monto_usd) || 0), 0) })
            .eq('id', savedDealId)
        }
        setDeal(d => ({ ...d, inicial_diferida_compromiso_id: undefined }))
      } 
    }

    setDeal({ ...emptyDeal })
    setEditingDeal(null)
    setView('list')
    loadDeals()
    setSaving(false)
  }

  // ── PRINT COMPROMISO DE INICIAL DIFERIDA ──
  const printCompromiso = (d: Deal) => {
    if (!d.inicial_diferida_monto || !d.inicial_diferida_fecha_vencimiento) {
      alert('Completa el monto y la fecha de vencimiento antes de imprimir.')
      return
    }
    const today = new Date()
    const dayNum = today.getDate()
    const monthNames = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']
    const monthName = monthNames[today.getMonth()]
    const yearNum = today.getFullYear()
    const monto = d.inicial_diferida_monto || 0
    const montoFmt = monto.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const inicialAcordada = d.pv_inicial || 0
    const inicialPagadaHoy = Math.max(0, inicialAcordada - monto)
    const custodiaText = d.inicial_diferida_custodia
      ? `<strong>TERCERO — Custodia del vehículo:</strong> Las partes acuerdan que el vehículo objeto de esta operación permanecerá en las instalaciones de <strong>MOTOCENTRO II, C.A</strong>, en calidad de custodia, hasta que el cliente haya cancelado la totalidad del monto comprometido. Hasta tanto no se haga efectivo el pago acordado, el vehículo no podrá ser entregado al cliente, y el cliente acepta y reconoce expresamente esta condición.`
      : `<strong>TERCERO — Entrega del vehículo:</strong> El vehículo ha sido entregado al cliente en el día de hoy, en perfecto estado y a su entera satisfacción. El cliente reconoce que la entrega del vehículo no extingue ni modifica su obligación de pago del saldo pendiente identificado en este documento, el cual deberá ser cancelado en la fecha acordada, independientemente de la posesión actual del vehículo.`
    const vMarca = d.vehiculo_marca || 'KIA'
    const vModelo = d.vehiculo_modelo || ''
    const vColor = d.vehiculo_color || ''
    const vPlaca = d.vehiculo_placa || ''
    const vAnio = d.vehiculo_año || ''
    const cApellidos = d.cliente_apellidos || ''
    const cDir = d.cliente_direccion || '_______________________________________'
    const cTel = d.cliente_telefono || '______________'
    const fechaVencFmt = fmtDate(d.inicial_diferida_fecha_vencimiento || '')
    const notasBlock = d.inicial_diferida_notas
      ? `<div class="sec"><strong><u>NOTAS ADICIONALES:</u></strong> ${d.inicial_diferida_notas}</div>`
      : ''

    const printWindow = window.open('', '_blank')
    if (!printWindow) return
    printWindow.document.write(`<!DOCTYPE html>
<html><head><title>Compromiso de Inicial Diferida #${d.negocio_num || '—'}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 11.5px; color: #000; background: #fff; }
  @page { size: letter portrait; margin: 16mm 22mm; }
  .header { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 2px solid #05141F; }
  .company-block { font-size: 10.5px; line-height: 1.6; }
  .company-name { font-size: 13px; font-weight: 900; margin-bottom: 1px; }
  .doc-title { text-align: center; font-size: 14px; font-weight: 900; text-transform: uppercase; letter-spacing: 1px; text-decoration: underline; margin: 18px 0 22px; }
  .info-box { background: #f9f7f4; border: 1px solid #e0d8c8; border-radius: 6px; padding: 12px 16px; margin-bottom: 18px; }
  .info-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 11px; }
  .info-label { color: #666; font-weight: 600; }
  .info-value { color: #000; font-weight: 700; }
  .amount-banner { text-align: center; background: #fff4e0; border: 2px solid #b8720a; border-radius: 8px; padding: 14px; margin: 20px 0; }
  .amount-label { font-size: 10px; font-weight: 700; color: #b8720a; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 6px; }
  .amount-value { font-size: 24px; font-weight: 900; color: #b8720a; font-family: monospace; }
  .amount-due { font-size: 11px; color: #555; margin-top: 6px; }
  .block { font-size: 11px; line-height: 1.85; margin-bottom: 12px; text-align: justify; }
  .sec { font-size: 11px; line-height: 1.8; margin-bottom: 12px; text-align: justify; }
  .ul { border-bottom: 1px solid #333; display: inline-block; min-width: 100px; }
  .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-top: 50px; }
  .sig { text-align: center; border-top: 1px solid #000; padding-top: 6px; font-size: 10px; color: #333; font-weight: 600; }
  .sig-name { font-size: 11px; font-weight: 700; margin-top: 2px; color: #000; }
  .sig-rif { font-size: 10px; color: #555; margin-top: 1px; }
  .footer { margin-top: 20px; padding-top: 8px; border-top: 1px solid #eee; text-align: center; font-size: 9px; color: #999; }
</style>
</head><body>
  <div class="header">
    <div style="width:60px;flex-shrink:0;font-size:24px;font-weight:900;color:#BB162B;letter-spacing:2px">KIA</div>
    <div class="company-block">
      <div class="company-name">MOTOCENTRO II, C.A</div>
      <div>RIF. J-07577719-0</div>
      <div>Av. Bolívar Oeste Edif. Motocentro Piso PB. Local 292, Maracay, Edo. Aragua</div>
      <div>Telfs. (0424) 349.40.18 — E-mail: administracion@motocentro2.com</div>
    </div>
  </div>

  <div class="doc-title">Compromiso de Pago de Inicial Diferida</div>

  <div class="info-box">
    <div class="info-row"><span class="info-label">Negocio N°:</span><span class="info-value">${d.negocio_num || '—'}</span></div>
    <div class="info-row"><span class="info-label">Fecha del compromiso:</span><span class="info-value">${dayNum} de ${monthName} de ${yearNum}</span></div>
    <div class="info-row"><span class="info-label">Cliente:</span><span class="info-value">${d.cliente_nombre || ''} ${cApellidos}</span></div>
    <div class="info-row"><span class="info-label">Cédula / RIF:</span><span class="info-value">${d.cliente_rif_tipo || 'V'}-${d.cliente_rif || '____________'}</span></div>
    <div class="info-row"><span class="info-label">Teléfono:</span><span class="info-value">${cTel}</span></div>
  </div>

  <div class="block">
    Yo, <span class="ul" style="min-width:240px">${d.cliente_nombre || ''} ${cApellidos}</span>,
    venezolano(a), mayor de edad, identificado(a) con la cédula de identidad Nº <strong>${d.cliente_rif_tipo || 'V'}-${d.cliente_rif || '___'}</strong>,
    con domicilio en <span class="ul" style="min-width:280px">${cDir}</span>,
    teléfono <span class="ul" style="min-width:120px">${cTel}</span>, y civilmente hábil,
    por medio del presente documento <strong>DECLARO Y ME COMPROMETO</strong> ante la sociedad de comercio
    <strong>MOTOCENTRO II, C.A</strong>, identificada con el RIF <strong>J-07577719-0</strong>,
    inscrita en el Registro Mercantil Segundo de la Circunscripción Judicial del Estado Aragua, en los términos siguientes:
  </div>

  <div class="sec">
    <strong>PRIMERO — Identificación de la operación:</strong> He acordado con MOTOCENTRO II, C.A la compra del siguiente vehículo:
    Marca <span class="ul">${vMarca}</span>, Modelo <span class="ul">${vModelo}</span>, Año <span class="ul">${vAnio || '____'}</span>,
    Color <span class="ul">${vColor}</span>, Placa <span class="ul">${vPlaca || '____'}</span>,
    Serial de Carrocería <span class="ul" style="min-width:160px">${d.vin || '____________'}</span>,
    correspondiente al Negocio Nº <strong>${d.negocio_num || '—'}</strong>.
    Las partes han acordado un monto total de inicial de
    <strong>$${inicialAcordada.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>,
    de los cuales he cancelado en el día de hoy la cantidad de
    <strong>$${inicialPagadaHoy.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong>,
    quedando un saldo pendiente identificado en el SEGUNDO de este documento.
  </div>

  <div class="amount-banner">
    <div class="amount-label">Saldo de Inicial Pendiente de Pago</div>
    <div class="amount-value">$${montoFmt}</div>
    <div class="amount-due">A ser cancelado a más tardar el <strong>${fechaVencFmt}</strong></div>
  </div>

  <div class="sec">
    <strong>SEGUNDO — Compromiso de pago:</strong> Me comprometo de manera firme, libre y voluntaria a pagar a
    <strong>MOTOCENTRO II, C.A</strong> la cantidad de <strong>$${montoFmt} (DÓLARES DE LOS ESTADOS UNIDOS DE AMÉRICA)</strong>,
    a más tardar el día <strong>${fechaVencFmt}</strong>, en las oficinas de la empresa o mediante los métodos de pago aprobados por la misma
    (transferencia bancaria, Zelle, USDT, o cualquier otro instrumento de pago acordado entre las partes).
    Reconozco expresamente que esta cantidad forma parte integral del precio de venta acordado y constituye una obligación
    cierta, líquida y exigible a partir de la fecha indicada.
  </div>

  <div class="sec">${custodiaText}</div>

  <div class="sec">
    <strong>CUARTO — Buena fe:</strong> Declaro que el presente compromiso lo asumo de buena fe, libre de coacción y apremio,
    en pleno uso de mis facultades, en la ciudad de Maracay, Estado Aragua, a los <strong>${dayNum}</strong> días del mes de
    <strong>${monthName}</strong> del año <strong>${yearNum}</strong>.
  </div>

  ${notasBlock}

  <div class="signatures">
    <div class="sig">
      <div class="sig-name">${d.cliente_nombre || '_______________'} ${cApellidos}</div>
      <div class="sig-rif">C.I. ${d.cliente_rif_tipo || 'V'}-${d.cliente_rif || '____________'}</div>
      <div style="font-size:9px;color:#999;margin-top:4px;text-transform:uppercase;letter-spacing:1px">Cliente</div>
    </div>
    <div class="sig">
      <div class="sig-name">_______________________________</div>
      <div class="sig-rif">MOTOCENTRO II, C.A — RIF J-07577719-0</div>
      <div style="font-size:9px;color:#999;margin-top:4px;text-transform:uppercase;letter-spacing:1px">Por la Empresa</div>
    </div>
  </div>

  <div class="footer">Documento generado por AutoCore NPA · ${new Date().toLocaleDateString('es-VE')} ${new Date().toLocaleTimeString('es-VE')}</div>
</body></html>`)
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => printWindow.print(), 500)
    if (d.inicial_diferida_compromiso_id) {
      supabase.from('compromisos_inicial_diferida')
        .update({ contrato_impreso_at: new Date().toISOString() })
        .eq('id', d.inicial_diferida_compromiso_id)
        .then(() => {})
    }
  }

  const totals = calcTotals(deal)
  // Devolución: disponible = sobrante actual − devoluciones en curso (SOLICITADO).
  const devComprometido = devExistentes.filter((d: any) => d.estado === 'SOLICITADO').reduce((s: number, d: any) => s + Number(d.monto_usd || 0), 0)
  const devDisponible = Math.max(0, (totals.resultado_tipo === 'SOBRANTE' ? Math.abs(totals.neto) : 0) - devComprometido)
  const devMontoNum = parseFloat(devMonto) || 0
  const devExcede = devMontoNum > devDisponible + 0.005
  const pivcaComision = calcPivca(deal)
  const isPivca = deal.banco === 'PIVCA'
  const resultColor = totals.resultado_tipo === 'CUADRADO' ? '#1a7a4a' : totals.resultado_tipo === 'FALTANTE' ? '#BB162B' : '#b8720a'
  const isBsMetodo = pago.metodo === 'Transferencia en Bolívares' || pago.metodo === 'Retención'

  // ★ FIX #2: Use the new MoneyInput component for all amount fields.
  // This eliminates the per-keystroke re-render of the whole form.
  const fieldInput = useCallback((key: string) => {
    return (
      <MoneyInput
        value={(deal as any)[key] || 0}
        onChange={(v) => setDeal(d => ({ ...d, [key]: v }))}
        disabled={isLocked}
        style={isLocked ? s.inputDisabled : s.input}
      />
    )
  }, [deal, isLocked])

  // ── LIST VIEW ──
  if (view === 'list') return (
    <AdminShell active="auditoria">

      {/* New Deal Scanner Modal */}
      {showNewDealScanner && (
        <NewDealScanner
          user={user}
          onCreated={(newDeal) => {
            setShowNewDealScanner(false)
            loadDeals()
            openDeal(newDeal)
          }}
          onCancel={() => setShowNewDealScanner(false)}
        />
      )}

      {/* Ingreso Scanner Modal */}
      {showIngresoScanner && (
        <IngresoScanner
          user={user}
          deals={deals}
          onDone={() => { setShowIngresoScanner(false); loadDeals() }}
          onCancel={() => { setShowIngresoScanner(false); loadDeals() }}
        />
      )}
    
      <div style={s.content}>
        <CxCInicialDiferidaCard mode="vencidas-banner" />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', marginTop: '8px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '2px' }}>Módulo</div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary)' }}>Auditoría de Negocios</div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={{ ...s.btnGray, borderColor: 'rgba(16,185,129,0.5)', color: '#10B981' }} onClick={() => setShowIngresoScanner(true)}>
              📤 Subir Ingreso
            </button>
            <button style={s.btnRed} onClick={() => setShowNewDealScanner(true)}>
              📷 Nuevo Negocio
            </button>
          </div>
        </div>
        {dealsError && (
          <div style={{ background: 'rgba(187,22,43,0.1)', border: '1px solid rgba(187,22,43,0.3)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#BB162B', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <span>{dealsError}</span>
            <button style={{ ...s.btnGray, whiteSpace: 'nowrap' as const }} onClick={() => loadDeals()}>Reintentar</button>
          </div>
        )}
        {/* ── Pendientes de auditoría (BORRADOR) ─────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 10px' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase' as const, letterSpacing: 1 }}>Pendientes de auditoría</span>
          <span style={{ padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: 'rgba(184,114,10,0.2)', color: '#b8720a' }}>{deals.filter((d: any) => d.status !== 'APROBADO').length}</span>
        </div>
        <div style={{ ...s.card, marginBottom: 28 }}>
          {deals.filter((d: any) => d.status !== 'APROBADO').length === 0 ? (
            <div style={{ textAlign: 'center', padding: '28px', color: 'var(--text-secondary)' }}>{dealsError ? 'No se pudieron cargar los negocios. Pulsa Reintentar arriba.' : 'No hay negocios pendientes de auditoría.'}</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              {dealsTableHead}
              <tbody>{deals.filter((d: any) => d.status !== 'APROBADO').map(renderDealRow)}</tbody>
            </table>
          )}
        </div>

        {/* ── Aprobados recientes (últimos 5) ─────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 10px' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase' as const, letterSpacing: 1 }}>Aprobados recientes</span>
          <span style={{ padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: 'rgba(26,122,74,0.2)', color: '#2ecc8a' }}>{deals.filter((d: any) => d.status === 'APROBADO').length}</span>
        </div>
        <div style={s.card}>
          {deals.filter((d: any) => d.status === 'APROBADO').length === 0 ? (
            <div style={{ textAlign: 'center', padding: '28px', color: 'var(--text-secondary)' }}>Sin negocios aprobados todavía.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              {dealsTableHead}
              <tbody>{deals.filter((d: any) => d.status === 'APROBADO').map(renderDealRow)}</tbody>
            </table>
          )}
          {approvedHasMore && (
            <div style={{ textAlign: 'center', padding: '14px 0 4px' }}>
              <button onClick={loadMoreApproved} disabled={loadingMore} style={{ ...s.btnGray, opacity: loadingMore ? 0.6 : 1 }}>
                {loadingMore ? 'Cargando…' : 'Cargar más negocios aprobados'}
              </button>
            </div>
          )}
        </div>
      </div>
    </AdminShell>
  )

  // ── FORM VIEW ──
  return (
    <div style={s.page}>
      {showPrint && <PrintPreview deal={deal} totals={totals} onClose={() => setShowPrint(false)} />}
      {showSeguroReal && (
        <SeguroRealModal
          deal={deal}
          user={user}
          onClose={() => setShowSeguroReal(false)}
          onDone={(vals) => { setDeal(d => ({ ...d, ...vals })); setShowSeguroReal(false); loadDeals() }}
        />
      )}
        {showQRScanner && (
        <TesoreriaQRScanner
          title="Escanear comprobante de efectivo"
          expectedTipo="INGRESO"
          expectedEstado="PENDIENTE_PICKUP"
          onScanned={handleQRScanned}
          onCancel={() => setShowQRScanner(false)}
        />
      )}
      {showComprobante && (
        <ComprobanteModal
          metodo={pago.metodo}
          currentDealId={editingDeal?.id}
          currentNegocioNum={deal.negocio_num}
          onConfirm={handleComprobanteConfirm}
          onCancel={() => setShowComprobante(false)}
        />
      )}
      {showMultiComprobante && (
        <MultiComprobanteModal
          metodo={pago.metodo || 'Zelle'}
          currentDealId={editingDeal?.id}
          currentNegocioNum={deal.negocio_num}
          existingHashes={deal.pagos.filter((p: any) => p._imageHash).map((p: any) => p._imageHash)}
          onConfirmAll={handleMultiConfirm}
          onCancel={() => setShowMultiComprobante(false)}
        />
      )}
      {showDuplicate && <DuplicateModal message={duplicateMsg} onConfirm={() => { if (pendingPago) commitPago(pendingPago) }} onCancel={() => { setShowDuplicate(false); setPendingPago(null) }} />}

      {/* Documentos de Entrega — mismo modal que usa /admin (Mirla). Al imprimir
          la Nota se estampa nota_entrega_at, así el tablero de Mirla la marca emitida. */}
      {showNotaEntrega && (
        <NotaEntregaPrint
          deal={deal}
          onPrint={async () => {
            if (editingDeal?.id) {
              await supabase.from('deals').update({ nota_entrega_at: new Date().toISOString() }).eq('id', editingDeal.id)
              setDeal((d: any) => ({ ...d, nota_entrega_at: new Date().toISOString() }))
              loadDeals()
            }
            setShowNotaEntrega(false)
          }}
          onDismiss={() => setShowNotaEntrega(false)}
        />
      )}

      {/* Devolución al cliente (SOBRANTE) — solicita; Mirla aprueba; Caja Chica paga */}
      {showDevolucion && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
             onClick={() => !devSaving && setShowDevolucion(false)}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '28px', maxWidth: '460px', width: '100%' }}
               onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>↩ Devolución al cliente</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: 1.5 }}>
              Negocio #{deal.negocio_num} · {[deal.cliente_nombre, deal.cliente_apellidos].filter(Boolean).join(' ')}<br />
              Sobrante actual: <strong style={{ color: '#b8720a' }}>{fmt(Math.abs(totals.neto))}</strong>
              {devComprometido > 0 && <> · En devoluciones en curso: <strong style={{ color: '#b8720a' }}>{fmt(devComprometido)}</strong></>}
              {' '}· Disponible para devolver: <strong style={{ color: '#2ecc8a' }}>{fmt(devDisponible)}</strong>.
              La solicitud pasa a aprobación de Tesorería y se paga en efectivo desde Caja Chica.
            </div>

            {devExistentes.length > 0 && (
              <div style={{ background: 'rgba(184,114,10,0.1)', border: '1px solid rgba(184,114,10,0.35)', borderRadius: '8px', padding: '10px 12px', marginBottom: '14px', fontSize: '12px', color: '#b8720a' }}>
                <strong>⚠ Ya hay devoluciones en curso para este negocio:</strong>
                {devExistentes.map((d: any) => (
                  <div key={d.id} style={{ marginTop: 4 }}>
                    {d.numero} · {fmt(Number(d.monto_usd || 0))} · {d.estado === 'EJECUTADO' ? 'pagada' : d.revision_estado === 'aprobado' ? 'aprobada, por pagar' : 'pendiente de aprobación'}
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginBottom: '14px' }}>
              <label style={s.label}>Monto a devolver (USD) *</label>
              <input type="number" inputMode="decimal" step="0.01" min="0.01" style={s.input} value={devMonto}
                     onChange={e => setDevMonto(e.target.value)} placeholder="0.00" />
              {devExcede && (
                <div style={{ fontSize: '11px', color: '#BB162B', marginTop: 4 }}>✕ El monto supera el sobrante disponible ({fmt(devDisponible)}). No se puede devolver más de lo sobrante.</div>
              )}
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={s.label}>Motivo / Concepto *</label>
              <textarea style={{ ...s.input, minHeight: 70, resize: 'vertical' as const, fontFamily: 'inherit' }} value={devMotivo}
                        onChange={e => setDevMotivo(e.target.value)} placeholder="Ej: Seguro proyectado $900 vs real $718 — devolución del excedente cobrado" />
            </div>

            {devError && (
              <div style={{ background: 'rgba(187,22,43,0.1)', border: '1px solid rgba(187,22,43,0.35)', borderRadius: '8px', padding: '10px 12px', marginBottom: '14px', fontSize: '12.5px', color: '#BB162B' }}>{devError}</div>
            )}

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button style={s.btnGray} disabled={devSaving} onClick={() => setShowDevolucion(false)}>Cancelar</button>
              <button style={{ ...s.btnRed, opacity: devExcede ? 0.5 : 1, cursor: devExcede ? 'not-allowed' : 'pointer' }} disabled={devSaving || devExcede} onClick={handleDevolucionSubmit}>
                {devSaving ? 'Creando…' : `Solicitar devolución · ${fmt(devMontoNum)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ background: 'var(--bg-nav)', borderBottom: '1px solid var(--border)', padding: '0 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', transition: 'background 0.35s ease' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '1px' }}>
          AutoCore <span style={{ color: '#BB162B' }}>NPA</span>{' '}
          <span style={{ color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 400 }}>
            — {isLocked ? 'Negocio Aprobado (Solo Lectura)' : editingDeal ? 'Editando Negocio' : 'Nuevo Negocio'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button style={s.btnGray} onClick={() => { setView('list'); setEditingDeal(null) }}>← Volver</button>
          <button style={s.btnGreen} onClick={() => setShowPrint(true)}>Vista Previa / Imprimir</button>
          {!isLocked && <button style={s.btnRed} onClick={handleSave} disabled={saving}>{saving ? 'Guardando...' : editingDeal ? 'Guardar Cambios' : 'Guardar Negocio'}</button>}
        </div>
      </div>

      {isLocked && !isDiferidaPaymentMode && (
        <div style={{ background: 'rgba(26,122,74,0.15)', border: '1px solid rgba(46,204,138,0.3)', padding: '12px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' as const }}>
          <div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#2ecc8a' }}>NEGOCIO APROBADO</div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Este negocio fue aprobado por Gerencia y no puede ser modificado.</div>
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' as const }}>
            {permissions.npa_can_nota_entrega && (
              <button onClick={() => setShowNotaEntrega(true)} style={{ ...s.btnRed, padding: '10px 20px' }}>
                🖨 Nota de Entrega{(deal as any).nota_entrega_at ? ' ✓' : ''}
              </button>
            )}
            {permissions.npa_can_audit_deals && (
              <button onClick={() => setShowSeguroReal(true)} style={{ ...s.btnGreen, padding: '10px 20px' }}>
                {deal.seguro_real_at ? 'Editar Seguro Real' : 'Registrar Seguro Real'}
              </button>
            )}
          </div>
        </div>
      )}
      {isDiferidaPaymentMode && (
        <div style={{ background: 'rgba(46,204,138,0.12)', border: '1px solid rgba(46,204,138,0.4)', padding: '14px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' as const }}>
          <div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#2ecc8a' }}>💰 REGISTRAR PAGO DE INICIAL DIFERIDA</div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              Pendiente: <strong style={{ color: '#b8720a' }}>{fmt(deal.inicial_diferida_monto || 0)}</strong> · Sube el comprobante para que la IA lo registre
            </div>
          </div>
          <button onClick={() => setShowComprobante(true)} style={{ ...s.btnGreen, padding: '10px 20px' }}>
            🤖 Subir Comprobante con IA
          </button>
        </div>
      )}

      <div style={s.content}>
        {/* Result Banner */}
        <div style={{ background: resultColor, borderRadius: '12px', padding: '20px 28px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' as const, gap: '16px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: '2px' }}>Resultado del Negocio</div>
            <div style={{ fontSize: '36px', fontWeight: 700, color: '#fff' }}>{totals.resultado_tipo}</div>
          </div>
          <div style={{ display: 'flex', gap: '32px', alignItems: 'center' }}>
            {[{ label: 'Proyecto Total', value: totals.pv_total }, { label: 'Audit Total', value: totals.au_total }, { label: 'Total Ingresos', value: totals.total_ingresos }, { label: 'Neto', value: Math.abs(totals.neto) }].map(item => (
              <div key={item.label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '4px' }}>{item.label}</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: '#fff', fontFamily: 'monospace' }}>{fmt(item.value)}</div>
              </div>
            ))}
            {totals.resultado_tipo === 'SOBRANTE' && editingDeal?.id && permissions.npa_can_audit_deals && (
              <button
                onClick={openDevolucion}
                style={{ padding: '10px 18px', background: 'rgba(255,255,255,0.14)', color: '#fff', border: '1.5px solid rgba(255,255,255,0.55)', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px', whiteSpace: 'nowrap' as const }}
              >
                ↩ Devolución al cliente
              </button>
            )}
          </div>
        </div>

        {/* Info del Negocio */}
        <div style={s.card}>
          <div style={s.sectionTitle}>Información del Negocio</div>
          <div style={{ ...s.grid4, marginBottom: '16px' }}>
            <div><label style={s.label}>Negocio #</label><input type="text" style={isLocked ? s.inputDisabled : s.input} value={deal.negocio_num} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, negocio_num: e.target.value }))} /></div>
            <div><label style={s.label}>Fecha de Factura</label><DatePicker value={deal.fecha_factura} onChange={v => setDeal(d => ({ ...d, fecha_factura: v }))} disabled={isLocked} /></div>
            <div><label style={s.label}>Fecha de Entrega</label><DatePicker value={deal.fecha_entrega} onChange={v => setDeal(d => ({ ...d, fecha_entrega: v }))} disabled={isLocked} /></div>
            <div><label style={s.label}>VIN</label><input type="text" style={isLocked ? s.inputDisabled : s.input} value={deal.vin} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, vin: e.target.value }))} /></div>
          </div>
          <div style={s.grid3}>
            <div>
              <label style={s.label}>Vendedor</label>
              <select style={isLocked ? s.selectDisabled : s.select} value={deal.vendedor} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, vendedor: e.target.value }))}>
                <option value="">Seleccionar...</option>
                {VENDEDORES.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <label style={s.label}>Banco / Tipo</label>
              <select style={isLocked ? s.selectDisabled : s.select} value={deal.banco} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, banco: e.target.value }))}>
                <option value="">Seleccionar...</option>
                {BANCOS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div><label style={s.label}>Tasa BCV</label><input type={isLocked ? 'text' : 'number'} style={isLocked ? s.inputDisabled : s.input} value={deal.tasa_bcv} disabled={isLocked} step="0.0001" onChange={e => setDeal(d => ({ ...d, tasa_bcv: e.target.value }))} placeholder="0.0000" /></div>
          </div>
        </div>

        {/* ── INVENTARIO Y COSTO BASE (Phase 3) ─────────────────────────────
            Auto-looks up the VIN in inventory_units. If found, shows the unit
            details and saves the link via deals.inventory_vin (FK). The DB
            trigger handles state sync from there. */}
        <InventoryLinkCard deal={deal} setDeal={setDeal} isLocked={isLocked} />

        <ClienteSaldoCard deal={deal} setDeal={setDeal} isLocked={isLocked} />

        {/* Banco y Tasas — merged into Info del Negocio above, keep only PIVCA/Financiamiento section */}
        <div style={s.card}>
          <div style={s.sectionTitle}>Tasas de Cambio</div>
          <div style={s.grid3}>
            <div><label style={s.label}>{deal.banco === 'Banco Provincial' ? 'Tasa Binance (Provincial)' : 'Tasa Variable'}</label><input type={isLocked ? 'text' : 'number'} style={isLocked ? s.inputDisabled : s.input} value={deal.tasa_variable} disabled={isLocked} step="0.0001" onChange={e => setDeal(d => ({ ...d, tasa_variable: e.target.value }))} placeholder="0.0000" />{deal.banco === 'Banco Provincial' && (<div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '6px', lineHeight: 1.4 }}>El financiamiento de Banco Provincial llega en Bs y se convierte a USD a esta tasa Binance — no a la BCV.</div>)}</div>
          </div>
          {(deal.banco === 'FINANCIAMIENTO INTERNO' || deal.banco === 'PIVCA') && (
            <div style={{ marginTop: '16px', padding: '16px', background: 'rgba(187,22,43,0.08)', border: '1px solid rgba(187,22,43,0.2)', borderRadius: '8px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '12px' }}>
                {deal.banco === 'PIVCA' ? 'PIVCA' : 'Financiamiento Interno'} — Póliza de Seguro
              </div>
              <div style={s.grid2}>
                <div>
                  <label style={s.label}>¿Se cobró renovación de póliza de seguro?</label>
                  <select style={isLocked ? s.selectDisabled : s.select} value={deal.seguro_2do_ano ? 'si' : 'no'} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, seguro_2do_ano: e.target.value === 'si', seguro_2do_ano_monto: e.target.value === 'no' ? 0 : d.seguro_2do_ano_monto }))}>
                    <option value="no">No</option><option value="si">Sí</option>
                  </select>
                </div>
                {deal.seguro_2do_ano && <div><label style={s.label}>Monto cobrado (USD)</label>{fieldInput('seguro_2do_ano_monto')}</div>}
              </div>
            </div>
          )}
        </div>

        {/* ── DATOS DEL COMPRADOR ── */}
        <div style={s.card}>
          <div style={s.sectionTitle}>Cliente y Vehículo — AI Doc Scanner</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 16 }}>
            Sube la cédula o factura para que la IA extraiga los datos automáticamente
          </div>

          {/* Stored documents viewer - signed URLs */}
          {editingDeal?.negocio_num && (
            <DocViewer negocioNum={editingDeal.negocio_num} dealId={editingDeal.id} refreshKey={docsVersion} />
          )}

          {/* AI Scanner button */}
          {!isLocked && (
            <div style={{ marginBottom: 20 }}>
              <BuyerDocScanner
                onExtracted={(data) => {
                  setDeal(d => ({
                    ...d,
                    cliente_nombre:      data.cliente_nombre      || d.cliente_nombre,
                    cliente_apellidos:   data.cliente_apellidos   || d.cliente_apellidos,
                    cliente_rif:         data.cliente_rif         || d.cliente_rif,
                    cliente_rif_tipo:    data.cliente_rif_tipo    || d.cliente_rif_tipo,
                    cliente_direccion:   data.cliente_direccion   || d.cliente_direccion,
                    cliente_telefono:    data.cliente_telefono    || d.cliente_telefono,
                    cliente_email:       data.cliente_email       || d.cliente_email,
                    cliente_estado_civil: data.cliente_estado_civil || d.cliente_estado_civil,
                    vehiculo_marca:      data.vehiculo_marca      || d.vehiculo_marca,
                    vehiculo_modelo:     data.vehiculo_modelo     || d.vehiculo_modelo,
                    vehiculo_color:      data.vehiculo_color      || d.vehiculo_color,
                    vehiculo_placa:      data.vehiculo_placa      || d.vehiculo_placa,
                    vehiculo_año:        data.vehiculo_año        || d.vehiculo_año,
                    vehiculo_año_fabricacion: data.vehiculo_año_fabricacion || d.vehiculo_año_fabricacion,
                    vehiculo_clase:      data.vehiculo_clase      || d.vehiculo_clase,
                    vehiculo_uso:        data.vehiculo_uso        || d.vehiculo_uso,
                    vin:                 data.vin                 || d.vin,
                  }))
                }}
                onFile={async (file, suggestedType) => {
                  // Persist the scanned source document so it isn't discarded after
                  // the AI extracts the numbers. (Previously onFile was unset here, so
                  // attach-to-existing scans were used only for OCR, then dropped.)
                  const negocioNum = editingDeal?.negocio_num || deal.negocio_num || null
                  const dealId = editingDeal?.id || null
                  if (!negocioNum && !dealId) return
                  const result = await uploadDealDoc({ file, negocioNum, dealId, type: suggestedType })
                  if (result.error || !result.path) { console.warn('[auditoria] scan upload failed:', result.error); return }
                  // Record the exact path in documentos_meta — the source of truth that
                  // DocViewer (and admin) read. Merge so we don't drop other doc types.
                  if (dealId) {
                    const { data: u } = await supabase.auth.getUser()
                    const { data: row } = await supabase.from('deals').select('documentos_meta').eq('id', dealId).maybeSingle()
                    const meta = { ...((row?.documentos_meta || {}) as Record<string, any>) }
                    meta[suggestedType] = {
                      path: result.path, ext: result.ext, mime: result.mime,
                      uploaded_by: u?.user?.id || null, uploaded_at: new Date().toISOString(),
                      source_filename: file.name,
                    }
                    await supabase.from('deals').update({ documentos_meta: meta }).eq('id', dealId)
                  }

                  // Feed reportes P&L: when a factura de venta is scanned, pull the venta
                  // columns via the shared extractor (same one the backfill uses) and write
                  // them straight onto the deal. Targeted update — only fields that came
                  // back, never touches handleSave, so no other field can be cleared.
                  if (suggestedType === 'factura' && dealId) {
                    const ventaPatch = await extractVentaFields(file)
                    if (ventaPatch) {
                      await supabase.from('deals').update(ventaPatch).eq('id', dealId)
                      setDeal(d => ({ ...d, ...ventaPatch }))
                    }
                  }

                  setDocsVersion(v => v + 1)
                }}
              />
            </div>
          )}

          {/* Buyer fields */}
          <div style={{ ...s.grid3, marginBottom: 16 }}>
            <div><label style={s.label}>Nombres</label><input style={isLocked ? s.inputDisabled : s.input} value={deal.cliente_nombre} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, cliente_nombre: e.target.value }))} /></div>
            <div><label style={s.label}>Apellidos</label><input style={isLocked ? s.inputDisabled : s.input} value={deal.cliente_apellidos} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, cliente_apellidos: e.target.value }))} /></div>
            <div>
              <label style={s.label}>RIF / Cédula</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select style={{ ...(isLocked ? s.selectDisabled : s.select), width: 80, flexShrink: 0 }} value={deal.cliente_rif_tipo} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, cliente_rif_tipo: e.target.value }))}>
                  {RIF_TIPOS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <input style={{ ...(isLocked ? s.inputDisabled : s.input), flex: 1 }} value={deal.cliente_rif} disabled={isLocked} placeholder="Número" onChange={e => setDeal(d => ({ ...d, cliente_rif: e.target.value }))} />
              </div>
            </div>
          </div>
          <div style={{ ...s.grid3, marginBottom: 16 }}>
            <div><label style={s.label}>Estado Civil</label>
              <select style={isLocked ? s.selectDisabled : s.select} value={deal.cliente_estado_civil} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, cliente_estado_civil: e.target.value }))}>
                <option value="">Seleccionar...</option>
                {['Soltero/a','Casado/a','Divorciado/a','Viudo/a','Unión Estable'].map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div><label style={s.label}>Teléfono</label><input style={isLocked ? s.inputDisabled : s.input} value={deal.cliente_telefono} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, cliente_telefono: e.target.value }))} /></div>
            <div><label style={s.label}>Email</label><input style={isLocked ? s.inputDisabled : s.input} value={deal.cliente_email} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, cliente_email: e.target.value }))} /></div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={s.label}>Dirección Completa</label>
            <input style={isLocked ? s.inputDisabled : s.input} value={deal.cliente_direccion} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, cliente_direccion: e.target.value }))} placeholder="Av. / Calle / Conjunto / Ciudad / Estado / Zona Postal" />
          </div>
          <div style={{ ...s.grid4, marginBottom: 0 }}>
            <div><label style={s.label}>Marca</label><input style={isLocked ? s.inputDisabled : s.input} value={deal.vehiculo_marca} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, vehiculo_marca: e.target.value }))} /></div>
            <div><label style={s.label}>Modelo</label><input style={isLocked ? s.inputDisabled : s.input} value={deal.vehiculo_modelo} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, vehiculo_modelo: e.target.value }))} /></div>
            <div><label style={s.label}>Año Modelo</label><input type="number" style={isLocked ? s.inputDisabled : s.input} value={deal.vehiculo_año || ''} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, vehiculo_año: parseInt(e.target.value) || null }))} /></div>
            <div><label style={s.label}>Año Fabricación</label><input type="number" style={isLocked ? s.inputDisabled : s.input} value={deal.vehiculo_año_fabricacion || ''} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, vehiculo_año_fabricacion: parseInt(e.target.value) || null }))} /></div>
            <div><label style={s.label}>Color</label><input style={isLocked ? s.inputDisabled : s.input} value={deal.vehiculo_color} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, vehiculo_color: e.target.value }))} /></div>
            <div><label style={s.label}>Placa</label><input style={isLocked ? s.inputDisabled : s.input} value={deal.vehiculo_placa} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, vehiculo_placa: e.target.value }))} /></div>
            <div><label style={s.label}>Clase</label><input style={isLocked ? s.inputDisabled : s.input} value={deal.vehiculo_clase} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, vehiculo_clase: e.target.value }))} /></div>
            <div><label style={s.label}>Uso</label>
              <select style={isLocked ? s.selectDisabled : s.select} value={deal.vehiculo_uso} disabled={isLocked} onChange={e => setDeal(d => ({ ...d, vehiculo_uso: e.target.value }))}>
                {['PARTICULAR','CARGA','TRANSPORTE PÚBLICO','OFICIAL'].map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Proyecto vs Auditoría */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
          <div style={s.card}>
            <div style={s.sectionTitle}>Proyecto de Venta</div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '16px' }}>Lo que se planificó cobrar al cliente</div>
            {PROYECTO_FIELDS.map(f => (<div key={f.key} style={{ marginBottom: '12px' }}><label style={s.label}>{f.label}</label>{fieldInput(f.key)}</div>))}
            <div style={{ marginTop: '12px', padding: '12px 16px', background: 'var(--bg-deep)', borderRadius: '8px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '4px' }}>Total Customer Price</div>
              <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{fmt(totals.pv_total)}</div>
            </div>
            <div style={{ marginTop: '16px' }}>
              <div style={s.sectionTitle}>Estructura de Financiamiento</div>
              <div style={{ marginBottom: '12px' }}><label style={s.label}>Inicial</label>{fieldInput('pv_inicial')}</div>
              <div style={{ marginBottom: '12px' }}><label style={s.label}>Monto a Financiar</label>{fieldInput('pv_monto_financiar')}</div>
              <div style={s.sectionTitle}>Comisión Bancaria</div>
              <div style={{ marginBottom: '12px' }}>
                <label style={s.label}>Comisión Flat (Banco){isPivca && <span style={{ color: '#BB162B', marginLeft: '6px', fontSize: '9px' }}>AUTO — PIVCA</span>}</label>
                {isPivca ? <input type="text" style={s.inputLocked} value={pivcaComision.pendiente ? 'Pendiente — esperando liquidación PIVCA' : fmt(pivcaComision.comisionBanco)} readOnly /> : fieldInput('pv_comision_banco')}
              </div>
              <div style={{ marginBottom: '12px' }}><label style={s.label}>Comisión Flat (Cobrado)</label>{fieldInput('pv_comision_flat_cobrado')}</div>
              {isPivca && pivcaComision.pendiente && (
                <div style={{ marginTop: '8px', padding: '14px 16px', background: 'var(--bg-deep)', border: '1px solid rgba(240,180,41,0.45)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: '#f0b429', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '6px' }}>PIVCA — Liquidación Pendiente</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>El banco aún no ha liquidado este negocio. La comisión real se calculará automáticamente al registrar el pago con método “Liquidación PIVCA” (monto a financiar − monto liquidado).</div>
                </div>
              )}
              {isPivca && !pivcaComision.pendiente && (
                <div style={{ marginTop: '8px', padding: '14px 16px', background: 'var(--bg-deep)', border: `1px solid ${pivcaComision.diferencia >= 0 ? 'rgba(46,204,138,0.4)' : 'rgba(187,22,43,0.4)'}`, borderRadius: '8px' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '10px' }}>PIVCA — Análisis de Comisión</div>
                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Comisión Flat (Banco)</span><span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{fmt(pivcaComision.comisionBanco)}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Comisión Flat (Cobrado)</span><span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{fmt(deal.pv_comision_flat_cobrado)}</span></div>
                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase' as const }}>Diferencia</span>
                      <span style={{ fontSize: '16px', fontWeight: 900, fontFamily: 'monospace', color: pivcaComision.diferencia >= 0 ? '#2ecc8a' : '#BB162B' }}>{pivcaComision.diferencia >= 0 ? '+' : ''}{fmt(pivcaComision.diferencia)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div style={s.cardGreen}>
            <div style={s.sectionTitleGreen}>Auditoría — Números Reales</div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '16px' }}>Lo que realmente se cobró al cliente</div>
            {AUDITORIA_FIELDS.map(f => (<div key={f.key} style={{ marginBottom: '12px' }}><label style={s.label}>{f.label}</label>{fieldInput(f.key)}</div>))}
            {totals.igtf_recovered > 0 && (
              <div style={{ marginBottom: '12px', padding: '10px 14px', background: 'rgba(46,204,138,0.08)', border: '1px solid rgba(46,204,138,0.3)', borderRadius: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <label style={{ ...s.label, color: '#2ecc8a', marginBottom: 0 }}>IGTF Recuperado (cobrado en factura)</label>
                  <span style={{ fontSize: '9px', padding: '2px 8px', borderRadius: '10px', background: 'rgba(46,204,138,0.15)', color: '#2ecc8a', fontWeight: 700 }}>AUTO</span>
                </div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: '#2ecc8a', fontFamily: 'monospace' }}>{fmt(totals.igtf_recovered)}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  El IGTF está incluido en el precio de la factura (${fmt(deal.pv_igtf)}) pero no se paga por separado, por lo tanto es ingreso recuperado.
                </div>
              </div>
            )}
            <div style={{ marginTop: '12px', padding: '12px 16px', background: 'var(--bg-deep)', borderRadius: '8px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '4px' }}>Audit Total</div>
              <div style={{ fontSize: '22px', fontWeight: 700, color: '#2ecc8a', fontFamily: 'monospace' }}>{fmt(totals.au_total)}</div>
              {totals.igtf_recovered > 0 && (
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  Subtotal: {fmt(totals.au_total_base)} + IGTF recuperado: {fmt(totals.igtf_recovered)}
                </div>
              )}
            </div>
            {(totals.pv_total > 0 && totals.au_total > 0) && (
              <div style={{ marginTop: '12px', padding: '12px 16px', background: totals.diff_pv_au >= 0 ? 'rgba(26,122,74,0.15)' : 'rgba(187,22,43,0.15)', borderRadius: '8px', border: `1px solid ${totals.diff_pv_au >= 0 ? 'rgba(46,204,138,0.3)' : 'rgba(187,22,43,0.3)'}` }}>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '4px' }}>Diferencia Proyecto vs Auditoría</div>
                <div style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'monospace', color: totals.diff_pv_au >= 0 ? '#2ecc8a' : '#BB162B' }}>{totals.diff_pv_au >= 0 ? '+' : ''}{fmt(totals.diff_pv_au)}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>{totals.diff_pv_au > 0 ? 'Se cobró más de lo proyectado' : totals.diff_pv_au < 0 ? 'Se cobró menos de lo proyectado' : 'Exactamente lo proyectado'}</div>
              </div>
            )}
          </div>
        </div>

        {/* ── INICIAL DIFERIDA ── */}
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#b8720a', textTransform: 'uppercase', letterSpacing: '2px' }}>Pago de Inicial Diferida</div>
            {!isLocked && (
              <div
                onClick={() => setDeal(d => ({ ...d, inicial_diferida_active: !d.inicial_diferida_active }))}
                style={{ width: '44px', height: '24px', borderRadius: '12px', background: deal.inicial_diferida_active ? '#b8720a' : 'var(--border)', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}
              >
                <div style={{ position: 'absolute', top: '3px', left: deal.inicial_diferida_active ? '23px' : '3px', width: '18px', height: '18px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }} />
              </div>
            )}
          </div>

          {!deal.inicial_diferida_active ? (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
              Activa esta opción si el cliente acordó pagar parte del inicial en una fecha posterior.
            </div>
          ) : (
            <>
              <div style={{ background: 'rgba(184,114,10,0.08)', border: '1px solid rgba(184,114,10,0.3)', borderRadius: '8px', padding: '12px 14px', marginBottom: '14px', fontSize: '11px', color: '#b8720a', lineHeight: 1.6 }}>
                ⚠ El cliente se compromete a pagar este monto en la fecha indicada. Se generará un contrato firmable que debe imprimirse y firmarse en físico.
              </div>
              <div style={s.grid3}>
                <div>
                  <label style={s.label}>Monto Pendiente (USD)</label>
                  <MoneyInput
                    value={deal.inicial_diferida_monto || 0}
                    onChange={v => setDeal(d => ({ ...d, inicial_diferida_monto: v }))}
                    disabled={isLocked}
                    style={isLocked ? s.inputDisabled : s.input}
                  />
                </div>
                <div>
                  <label style={s.label}>Fecha de Vencimiento</label>
                  <DatePicker value={deal.inicial_diferida_fecha_vencimiento || ''} onChange={v => setDeal(d => ({ ...d, inicial_diferida_fecha_vencimiento: v }))} disabled={isLocked} />
                </div>
                <div>
                  <label style={s.label}>Custodia del Vehículo</label>
                  <select
                    style={isLocked ? s.selectDisabled : s.select}
                    value={deal.inicial_diferida_custodia ? 'si' : 'no'}
                    disabled={isLocked}
                    onChange={e => setDeal(d => ({ ...d, inicial_diferida_custodia: e.target.value === 'si' }))}
                  >
                    <option value="no">Vehículo entregado al cliente</option>
                    <option value="si">Vehículo en custodia de Motocentro</option>
                  </select>
                </div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <label style={s.label}>Notas del Compromiso (opcional)</label>
                <textarea
                  style={{ ...s.input, minHeight: '60px', resize: 'vertical' as const }}
                  value={deal.inicial_diferida_notas || ''}
                  disabled={isLocked}
                  onChange={e => setDeal(d => ({ ...d, inicial_diferida_notas: e.target.value }))}
                  placeholder="Acuerdos especiales, método de pago acordado, etc."
                />
              </div>
              {(deal.inicial_diferida_monto ?? 0) > 0 && deal.inicial_diferida_fecha_vencimiento ? (
                <div style={{ marginTop: '14px', padding: '14px 16px', background: 'rgba(184,114,10,0.12)', border: '1px solid rgba(184,114,10,0.4)', borderRadius: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' as const, gap: '12px' }}>
                  <div>
                    <div style={{ fontSize: '10px', fontWeight: 700, color: '#b8720a', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '4px' }}>Pago Pendiente</div>
                    <div style={{ fontSize: '20px', fontWeight: 900, color: '#b8720a', fontFamily: 'monospace' }}>{fmt(deal.inicial_diferida_monto || 0)}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Vence el {fmtDate(deal.inicial_diferida_fecha_vencimiento)}</div>
                  </div>
                  <button
                    onClick={() => printCompromiso(deal)}
                    style={{ padding: '10px 20px', background: '#b8720a', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px' }}
                  >
                    🖨 Imprimir Compromiso
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* Pagos */}
        <div style={s.card}>
          <div style={s.sectionTitle}>Ingresos (Pagos Recibidos)</div>
          {!isLocked && (
            <>
              {/* ★ v2: Three primary actions — AI scan (preferred), manual, bulk */}
              <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' as const }}>
                <button
                  style={{ padding: '10px 24px', background: '#2ecc8a', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 1, flex: '1 1 220px', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                  onClick={() => { setShowQRScanner(true); setShowManualForm(false) }}
                  title="Escanea el QR del comprobante impreso de tesorería para registrar un pago en efectivo"
                >
                  🏷️ Escanear QR Tesorería
                </button>

                <button
                  style={{ ...s.btnRed, flex: '1 1 220px', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                  onClick={() => { setShowComprobante(true); setShowManualForm(false) }}
                  title="La IA detecta método, monto, referencia y fecha automáticamente"
                >
                  🤖 Subir Comprobante con IA
                </button>
                <button
                  style={{ ...s.btnGray, flex: '1 1 180px', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderColor: showManualForm ? 'rgba(46,204,138,0.5)' : undefined, color: showManualForm ? '#2ecc8a' : undefined }}
                  onClick={() => setShowManualForm(v => !v)}
                  title="Para efectivo, PIVCA, retenciones u otros pagos sin comprobante digital"
                >
                  ✍️ Agregar Manualmente {showManualForm ? '▲' : '▼'}
                </button>
                <button
                  style={{ ...s.btnGray, flex: '1 1 180px', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                  onClick={() => setShowMultiComprobante(true)}
                  title="Subir hasta 20 comprobantes a la vez"
                >
                  🖼️ Múltiples Comprobantes
                </button>
              </div>

              {/* Manual form — collapsed by default; expands when Deisi toggles it */}
              {showManualForm && (
                <div style={{ background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px', marginBottom: '16px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 10 }}>
                    Entrada Manual
                    <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text-secondary)', fontWeight: 400, textTransform: 'none' as const, letterSpacing: 0 }}>
                      — para efectivo, PIVCA, retenciones, etc.
                    </span>
                  </div>
                  <div style={{ ...s.grid5, marginBottom: '12px', alignItems: 'flex-end' }}>
                    <div>
                      <label style={s.label}>Método de Pago</label>
                      <select style={s.select} value={pago.metodo} onChange={e => handlePagoMetodoChange(e.target.value)}>
                        <option value="">Seleccionar...</option>
                        {METODOS_PAGO.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                    <div><label style={s.label}>Fecha del Pago</label><DatePicker value={pago.fecha} onChange={v => setPago(p => ({ ...p, fecha: v }))} /></div>
                    {isBsMetodo ? (
                      <>
                        <div><label style={s.label}>Monto Bs <span style={{ color: '#BB162B' }}>{deal.banco === 'Banco Provincial' ? '→ Tasa Binance' : '→ Tasa BCV'}</span></label><input type="number" style={s.input} value={pago.monto_bs || ''} step="0.01" onChange={e => handlePagoBsChange(parseFloat(e.target.value) || 0)} placeholder="0.00" /></div>
                        <div><label style={s.label}>Monto USD <span style={{ color: '#2ecc8a' }}>(Auto)</span></label><input type="text" style={s.inputAuto} value={pago.monto_usd ? fmt(pago.monto_usd) : ''} readOnly placeholder="$0.00" /></div>
                      </>
                    ) : (
                      <>
                        <div><label style={s.label}>Monto USD</label><input type="number" style={s.input} value={pago.monto_usd || ''} step="0.01" onChange={e => handlePagoUsdChange(parseFloat(e.target.value) || 0)} placeholder="0.00" /></div>
                        <div><label style={s.label}>Monto Bs <span style={{ color: '#2ecc8a' }}>(Auto)</span></label><input type="text" style={s.inputAuto} value={pago.monto_bs ? fmtBs(pago.monto_bs) : ''} readOnly placeholder="Bs 0.00" /></div>
                      </>
                    )}
                    <div><label style={s.label}>Referencia</label><input style={s.input} value={pago.referencia} onChange={e => setPago(p => ({ ...p, referencia: e.target.value }))} /></div>
                  </div>
                  {requiereComprobante && (
                    <div style={{ marginBottom: '12px', padding: '10px 14px', background: 'rgba(187,22,43,0.08)', border: '1px solid rgba(187,22,43,0.2)', borderRadius: '8px', fontSize: '12px', color: '#BB162B' }}>
                      ⚠ Este método normalmente requiere comprobante. Considera usar la opción "Subir Comprobante con IA" para adjuntar y verificar el archivo.
                    </div>
                  )}
                  <button style={{ ...s.btnRed, width: '100%' }} onClick={handleAddPagoManual}>
                    + Agregar Pago Manual
                  </button>
                </div>
              )}
            </>
          )}
          {deal.pagos.length > 0 && (
            <>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Fecha', 'Método', 'USD', 'Bs', 'Referencia', 'Comprobante', 'Verificado', ''].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {deal.pagos.map((p: any, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: p._inicial_diferida && p._pendiente ? 'rgba(184,114,10,0.08)' : p._verified_by_bank ? 'rgba(16,185,129,0.04)' : 'transparent' }}>
                      <td style={{ padding: '10px 12px', color: 'var(--text-secondary)', fontSize: '13px' }}>{p.fecha ? fmtDate(p.fecha) : '—'}</td>
                      <td style={{ padding: '10px 12px', color: p._inicial_diferida && p._pendiente ? '#b8720a' : 'var(--text-primary)', fontSize: '13px', fontWeight: p._inicial_diferida && p._pendiente ? 700 : 400 }}>{p._inicial_diferida && p._pendiente ? '⏳ ' : ''}{p.metodo}{p._auto_financiamiento && <span style={{ marginLeft: 6, fontSize: '9px', fontWeight: 800, color: '#2ecc8a', letterSpacing: 0.5 }}>AUTO</span>}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace' }}>{fmt(parseFloat(p.monto_usd) || 0)}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-secondary)', fontSize: '13px', fontFamily: 'monospace' }}>{fmtBs(parseFloat(p.monto_bs) || 0)}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace' }}>{p.referencia || prMap[p._pago_recibido_id]?.confirmation_code || (prMap[p._pago_recibido_id]?.usdt_tx_hash ? String(prMap[p._pago_recibido_id].usdt_tx_hash).slice(0, 12) + '…' : '') || '—'}</td>
                      <td style={{ padding: '10px 12px' }}>
                        {p.comprobante_imagen
                          ? <span style={{ color: '#2ecc8a', fontSize: '12px', fontWeight: 600 }}>✓ Adjunto</span>
                          : (p.comprob_url || prMap[p._pago_recibido_id]?.comprob_url)
                          ? <a href={p.comprob_url || prMap[p._pago_recibido_id]?.comprob_url} target="_blank" rel="noreferrer" style={{ color: '#4a9eff', fontSize: '12px', fontWeight: 600, textDecoration: 'none' }}>Ver ↗</a>
                          : METODOS_REQUIEREN_COMPROBANTE.includes(p.metodo)
                            ? <span style={{ color: '#b8720a', fontSize: '11px' }}>Sin comprobante</span>
                            : <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>—</span>
                        }
                      </td>
                     <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                        {p._verified_by_bank
                          ? <span title="Verificado contra estado de cuenta bancario" style={{ fontSize: '18px', cursor: 'default' }}>✅</span>
                          : (p._pr_aprobado_por || prMap[p._pago_recibido_id]?.aprobado_por || p._pr_bank_tx_id || prMap[p._pago_recibido_id]?.bank_tx_id)
                          ? <span title={'Aprobado en tesorería' + ((p._pr_aprobado_por || prMap[p._pago_recibido_id]?.aprobado_por) ? ' por ' + (p._pr_aprobado_por || prMap[p._pago_recibido_id]?.aprobado_por) : '')} style={{ fontSize: '18px', cursor: 'default' }}>✅</span>
                          : p._verified_by_cash
                          ? <span title={`Recibido en tesorería — Comprobante #${p._tesoreria_comprobante_num || ''}`} style={{ fontSize: '18px', cursor: 'default' }}>🏷️</span>
                          : <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>—</span>
                        }
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {!isLocked && !p._auto_financiamiento && <button onClick={() => removePago(i)} style={{ background: 'none', border: 'none', color: '#BB162B', cursor: 'pointer', fontSize: '16px' }}>✕</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: '12px', padding: '12px 16px', background: 'var(--bg-deep)', borderRadius: '8px', display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '4px' }}>Total Ingresos</div>
                  <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{fmt(totals.total_ingresos)}</div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}