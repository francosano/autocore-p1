// app/reportes/backfill/page.tsx
'use client'

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { PDFDocument } from 'pdf-lib'
import { supabase } from '../../supabase'
import NavBar from '../../components/NavBar'
import { useNPAPermissions } from '../../components/useNPAPermissions'

// ─── Constants ───────────────────────────────────────────────────────────────
const SCANNER_URL = 'https://autocore-comprobante.sano-franco.workers.dev/'
const STORAGE_BUCKET = 'comprobantes'
const MAX_PARALLEL_SCANS = 3
const SCAN_TIMEOUT_MS = 60000

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fileToBase64 = (file: File): Promise<{ base64: string; mediaType: string; isPdf: boolean }> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1]
      resolve({
        base64,
        mediaType: file.type || 'application/octet-stream',
        isPdf: file.type === 'application/pdf',
      })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, Array.from(chunk))
  }
  return btoa(binary)
}

async function splitPdfIntoPages(file: File): Promise<{ pageNum: number; base64: string }[]> {
  const buf = await file.arrayBuffer()
  const src = await PDFDocument.load(buf, { ignoreEncryption: true })
  const totalPages = src.getPageCount()
  if (totalPages <= 1) {
    const wholeBase64 = bytesToBase64(new Uint8Array(buf))
    return [{ pageNum: 1, base64: wholeBase64 }]
  }
  const pages: { pageNum: number; base64: string }[] = []
  for (let i = 0; i < totalPages; i++) {
    const onePagePdf = await PDFDocument.create()
    const [copied] = await onePagePdf.copyPages(src, [i])
    onePagePdf.addPage(copied)
    const bytes = await onePagePdf.save()
    pages.push({ pageNum: i + 1, base64: bytesToBase64(bytes) })
  }
  return pages
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    return res
  } finally {
    clearTimeout(timeoutId)
  }
}

const isImageOrPdf = (f: File) =>
  f.type === 'application/pdf' || f.type.startsWith('image/')

const fmtDate = (iso: string | null) => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('T')[0].split('-')
  return `${d}/${m}/${y}`
}

const fmtNum = (v: any) =>
  v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ─── Helper: detect if extracted data has anything useful ─────────────────
// Prevents matching+saving docs that came back from a 502'd scan with empty
// or garbage extracted fields. Without this guard, a failed scan still gets
// counted as "Listo" and runs an UPDATE that writes nothing meaningful.
// Bounded Levenshtein distance for VIN fuzzy-matching. Returns early once the
// distance is known to exceed `max`, so it stays cheap across large pools.
function vinDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

function extractedHasUsableData(type: DocType, extracted: Record<string, any>): boolean {
  if (!extracted || typeof extracted !== 'object') return false
  if (type === 'cedula') {
    return !!(extracted.rif || extracted.nombre || extracted.apellidos)
  }
  if (type === 'factura_venta') {
    return !!(extracted.factura_venta_numero || extracted.factura_venta_body_neto || extracted.factura_venta_total)
  }
  if (type === 'factura_compra') {
    return !!(extracted.factura_compra_body_neto || extracted.factura_compra_total ||
              extracted.vin || extracted.factura_compra_numero)
  }
  return false
}

// ─── Types ───────────────────────────────────────────────────────────────────
type DocType = 'cedula' | 'factura_venta' | 'factura_compra' | 'unknown'
type ExtractedDocStatus =
  | 'matched_deal'
  | 'matched_inventory'
  | 'will_create_inventory'
  | 'no_match'
  | 'duplicate'
  | 'saved'
  | 'save_failed'      // NEW: surface failures in UI

interface ExtractedDoc {
  id: string
  page: number
  type: DocType
  extracted: Record<string, any>
  confidence?: 'high' | 'medium' | 'low'
  warnings: string[]
  status: ExtractedDocStatus
  matchedDealId: string | null
  matchedDealLabel: string | null
  matchedInventoryVin: string | null
  matchedInventoryLabel: string | null
  saveError?: string   // NEW: error message if status === 'save_failed'
  savedTo?: {
    dealLabel?: string
    inventoryAction?: string
  }
}

type FileStatus = 'pending' | 'scanning' | 'done' | 'error' | 'all_saved' | 'partial_saved'

interface FileEntry {
  id: string
  file: File
  status: FileStatus
  errorMessage?: string
  documents: ExtractedDoc[]
}

interface DealLite {
  id: string
  negocio_num: string
  cliente_nombre: string
  cliente_apellidos: string | null
  cliente_rif: string | null
  vin: string | null
  factura_venta_numero: string | null
  factura_venta_body_neto: number | null
  factura_compra_body_neto: number | null
  banco: string | null
  status: string | null
  fecha_entrega: string | null
}

interface InventoryUnitLite {
  vin: string
  modelo: string | null
  estado: string | null
}

type FilterTab = 'all' | 'sin_datos' | 'parcial' | 'completo'

const completeness = (d: DealLite) => {
  const cedula = !!d.cliente_rif
  const facturaVenta = d.factura_venta_body_neto != null
  const facturaCompra = d.factura_compra_body_neto != null
  const count = [cedula, facturaVenta, facturaCompra].filter(Boolean).length
  return {
    cedula, facturaVenta, facturaCompra, count,
    status: count === 3 ? 'completo' : count === 0 ? 'sin_datos' : 'parcial',
  } as const
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  content: { padding: '32px', maxWidth: '1200px', margin: '0 auto' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '20px', marginBottom: '20px' },
  btnGreen: { padding: '10px 24px', background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px' },
  btnGray: { padding: '8px 18px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
  input: { width: '100%', padding: '8px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '12px', outline: 'none', boxSizing: 'border-box' as const },
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═════════════════════════════════════════════════════════════════════════════
export default function BackfillPage() {
  const router = useRouter()
  const { permissions, loading: permsLoading } = useNPAPermissions()
  const [user, setUser] = useState<any>(null)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [deals, setDeals] = useState<DealLite[]>([])
  const [inventoryVins, setInventoryVins] = useState<InventoryUnitLite[]>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dragOver, setDragOver] = useState(false)

  const [filterTab, setFilterTab] = useState<FilterTab>('sin_datos')
  const [search, setSearch] = useState('')
  const [showStatus, setShowStatus] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  // NEW: persistent save log shown above the file cards
  const [saveLog, setSaveLog] = useState<{
    deals_ok: number
    deals_failed: number
    deals_failed_ids: string[]
    inv_updated: number
    inv_created: number
    inv_failed: number
    storage_ok: number
    storage_failed: number
    last_errors: string[]
  } | null>(null)

  useEffect(() => {
    if (!permsLoading) {
      const allowed = permissions.npa_can_audit_deals || permissions.npa_can_view_management_pnl
      if (!allowed) router.replace('/dashboard')
    }
  }, [permsLoading, permissions, router])

  const loadInitial = useCallback(async () => {
    setLoading(true)
    const { data: authData } = await supabase.auth.getUser()
    if (!authData.user) { router.push('/'); return }
    setUser(authData.user)

    const [dealsRes, invRes] = await Promise.all([
      supabase.from('deals')
        .select('id, negocio_num, cliente_nombre, cliente_apellidos, cliente_rif, vin, factura_venta_numero, factura_venta_body_neto, factura_compra_body_neto, banco, status, fecha_entrega')
        .neq('status', 'BORRADOR')
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.from('inventory_units')
        .select('vin, modelo, estado')
        .limit(500),
    ])

    setDeals((dealsRes.data || []) as DealLite[])
    setInventoryVins((invRes.data || []) as InventoryUnitLite[])
    setLoading(false)
  }, [router])

  useEffect(() => { loadInitial() }, [loadInitial])

  const stats = useMemo(() => {
    let completo = 0, parcial = 0, sin_datos = 0
    let cedula_missing = 0, venta_missing = 0, compra_missing = 0
    for (const d of deals) {
      const c = completeness(d)
      if (c.status === 'completo') completo++
      else if (c.status === 'parcial') parcial++
      else sin_datos++
      if (!c.cedula) cedula_missing++
      if (!c.facturaVenta) venta_missing++
      if (!c.facturaCompra) compra_missing++
    }
    return { total: deals.length, completo, parcial, sin_datos, cedula_missing, venta_missing, compra_missing }
  }, [deals])

  const filteredDeals = useMemo(() => {
    return deals.filter(d => {
      const c = completeness(d)
      if (filterTab === 'sin_datos' && c.status !== 'sin_datos') return false
      if (filterTab === 'parcial' && c.status !== 'parcial') return false
      if (filterTab === 'completo' && c.status !== 'completo') return false
      if (search) {
        const q = search.toLowerCase()
        const haystack = `${d.negocio_num} ${d.cliente_nombre} ${d.cliente_apellidos || ''} ${d.cliente_rif || ''}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [deals, filterTab, search])

  const matchDoc = useCallback((type: DocType, extracted: Record<string, any>): {
    status: ExtractedDocStatus
    matchedDealId: string | null
    matchedDealLabel: string | null
    matchedInventoryVin: string | null
    matchedInventoryLabel: string | null
  } => {
    const empty = {
      status: 'no_match' as ExtractedDocStatus,
      matchedDealId: null, matchedDealLabel: null,
      matchedInventoryVin: null, matchedInventoryLabel: null,
    }

    if (type === 'cedula' && extracted.rif) {
      const matches = deals.filter(d => d.cliente_rif === extracted.rif)
      if (matches.length === 0) return empty
      const latest = matches[0]
      return {
        status: 'matched_deal',
        matchedDealId: latest.id,
        matchedDealLabel: `#${latest.negocio_num} — ${latest.cliente_nombre}${latest.cliente_apellidos ? ' ' + latest.cliente_apellidos : ''}`,
        matchedInventoryVin: null, matchedInventoryLabel: null,
      }
    }

    if (type === 'factura_venta' && extracted.factura_venta_numero) {
      const num = String(extracted.factura_venta_numero).trim()
      const match = deals.find(d => d.negocio_num === num || d.factura_venta_numero === num)
      if (!match) return empty
      return {
        status: 'matched_deal',
        matchedDealId: match.id,
        matchedDealLabel: `#${match.negocio_num} — ${match.cliente_nombre}${match.cliente_apellidos ? ' ' + match.cliente_apellidos : ''}`,
        matchedInventoryVin: null, matchedInventoryLabel: null,
      }
    }

    if (type === 'factura_compra') {
      // ═══════════════════════════════════════════════════════════════════
      // PASS 1: Handwritten "FACT# XXXXX" note (HIGHEST PRIORITY)
      //
      // The dealer writes the negocio number on every factura compra at
      // the bottom: "FACT# 55905 Stefanie Yari". This is ground truth — it
      // tells us EXACTLY which deal this factura belongs to, sidestepping
      // any VIN OCR errors (V↔4, J↔T, L↔1, etc. that even Sonnet makes).
      //
      // If we have a handwritten match, we use the deal's CANONICAL VIN
      // (already in our DB) for inventory linking, not the OCR'd factura
      // VIN. This guarantees no duplicate inventory rows.
      // ═══════════════════════════════════════════════════════════════════
      const handwritten = extracted.negocio_num_handwritten
      if (handwritten) {
        const num = String(handwritten).trim().replace(/[^0-9]/g, '')
        if (num.length >= 4) {  // negocio nums are 5+ digits; guard against junk
          const dealByHandwriting = deals.find(d => d.negocio_num === num)
          if (dealByHandwriting) {
            // Found the deal. Use its canonical VIN for inventory linking
            // (or null if the deal hasn't been linked to inventory yet).
            return {
              status: 'matched_deal',
              matchedDealId: dealByHandwriting.id,
              matchedDealLabel: `#${dealByHandwriting.negocio_num} — ${dealByHandwriting.cliente_nombre}${dealByHandwriting.cliente_apellidos ? ' ' + dealByHandwriting.cliente_apellidos : ''} (matched por escritura)`,
              matchedInventoryVin: dealByHandwriting.vin || null,
              matchedInventoryLabel: dealByHandwriting.vin
                ? `Unidad ligada al negocio · VIN …${dealByHandwriting.vin.slice(-6)}`
                : null,
            }
          }
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // PASS 2: VIN matching (fallback when no handwriting or unmatched)
      // ═══════════════════════════════════════════════════════════════════
      const rawVin = extracted.vin
      // Worker now returns vin_normalized (I→1, O→0, Q→0 stripped) and
      // vin_diagnostics ({clean, length_ok, substitutions}). Prefer the
      // normalized version for matching since legacy inventory may also
      // have been stored with OCR garbage that the same normalization fixes.
      const workerNormalizedVin = extracted.vin_normalized
      const vinDiag = extracted.vin_diagnostics || null

      if (rawVin || workerNormalizedVin) {
        // ─── Multi-pass VIN match ────────────────────────────────────────
        // Goal: NEVER create a duplicate inventory_unit for the same physical
        // car. Same VIN may appear in DB as: full+clean, full+OCR-garbage,
        // partial (last 6-8 chars), or with wrong substitutions.
        //
        // Steps:
        //   normalize() = uppercase + strip non-alphanumerics
        //   normalizeAggressive() = above + replace I→1 O→0 Q→0
        //   Then for each candidate side (deals, inventory):
        //     - exact match (best)
        //     - aggressive-normalized exact (handles OCR diffs)
        //     - suffix match (partial-VIN legacy entries)
        //     - prefix match (rare)
        //
        // We try deals first (best outcome — links to a real customer),
        // then inventory_units (still better than creating a duplicate),
        // and only create a NEW unit if no candidate matches AND the OCR
        // extraction looks credible (≥12 chars, ≤2 OCR substitutions).
        const normalize = (v: string | null | undefined) => (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
        const normalizeAggressive = (v: string | null | undefined) =>
          normalize(v).replace(/I/g, '1').replace(/O/g, '0').replace(/Q/g, '0')

        // The VIN we'll actually store/match against — prefer worker-normalized,
        // fall back to client-normalized of the raw OCR.
        const matchVin = workerNormalizedVin || normalizeAggressive(rawVin)

        // ── Try to find a matching DEAL ───────────────────────────────
        const findCandidate = <T extends { vin?: string | null }>(
          pool: T[],
        ): T | null => {
          if (!matchVin || matchVin.length < 6) return null
          // Pass 1: exact normalized
          let m = pool.find(x => normalize(x.vin) === matchVin)
          if (m) return m
          // Pass 2: aggressive normalize both sides (handles OCR garbage in DB)
          m = pool.find(x => normalizeAggressive(x.vin) === matchVin)
          if (m) return m
          // Helper: return the SINGLE matching candidate, or null if zero/ambiguous.
          // The uniqueness guard is what makes loose matching safe: if two units
          // qualify (e.g. same model/year), we refuse to guess and leave it
          // unmatched for manual review instead of attaching a factura to the
          // wrong deal (which would corrupt P&L on both).
          const onlyMatch = (pred: (dv: string) => boolean): T | undefined => {
            const hits = pool.filter(x => pred(normalizeAggressive(x.vin)))
            return hits.length === 1 ? hits[0] : undefined
          }
          // Pass 3: suffix either way — legacy partial-VIN rows and clean tail
          // reads (the serial is the unique part of a VIN). Unique-guarded.
          m = onlyMatch(dv => dv.length >= 6 && (matchVin.endsWith(dv) || dv.endsWith(matchVin)))
          if (m) return m
          // Pass 4: exact serial tail (last 7) — rescues a misread HEAD when the
          // tail is clean (OCR garbled the WMI but the serial survived).
          if (matchVin.length >= 7) {
            const tail = matchVin.slice(-7)
            m = onlyMatch(dv => dv.length >= 7 && dv.slice(-7) === tail)
            if (m) return m
          }
          // Pass 5: fuzzy — Levenshtein <= 2 over the full VIN. A clean 15-vs-17
          // drop is exactly distance 2; this also absorbs 1-2 misreads ANYWHERE
          // (incl. mid-string drops the prefix/suffix passes cannot catch).
          if (matchVin.length >= 12) {
            m = onlyMatch(dv => dv.length >= 12 && vinDistance(dv, matchVin, 2) <= 2)
            if (m) return m
          }
          // Pass 6: prefix — STRICT. The head is shared across same-model units,
          // so only accept a long (>=14) unique prefix as a last resort.
          m = onlyMatch(dv => dv.length >= 14 && matchVin.length >= 14 && (matchVin.startsWith(dv) || dv.startsWith(matchVin)))
          if (m) return m
          return null
        }

        const dealMatch = findCandidate(deals)
        if (dealMatch) {
          const isExact = normalize(dealMatch.vin) === matchVin
          const matchKind = isExact ? '' : ' (VIN parcial/normalizado)'
          return {
            status: 'matched_deal',
            matchedDealId: dealMatch.id,
            matchedDealLabel: `#${dealMatch.negocio_num} — ${dealMatch.cliente_nombre}${dealMatch.cliente_apellidos ? ' ' + dealMatch.cliente_apellidos : ''}${matchKind}`,
            matchedInventoryVin: matchVin,
            matchedInventoryLabel: null,
          }
        }

        // ── Try inventory_units with the same multi-pass logic ────────
        const invMatch = findCandidate(inventoryVins)
        if (invMatch) {
          return {
            status: 'matched_inventory',
            matchedDealId: null, matchedDealLabel: null,
            matchedInventoryVin: matchVin,
            matchedInventoryLabel: `Unidad existente ${invMatch.modelo || ''} · VIN …${matchVin.slice(-6)} (no se duplica)`,
          }
        }

        // ── No match — should we create a new unit? ───────────────────
        // Refuse if the OCR is too suspect: short (<12 chars) or had >=3 I/O/Q
        // substitutions (likely bad scan that would create a garbage row).
        const tooShort = matchVin.length < 12
        const tooGarbled = vinDiag && vinDiag.substitutions >= 3
        if (tooShort || tooGarbled) {
          return {
            status: 'no_match',
            matchedDealId: null, matchedDealLabel: null,
            matchedInventoryVin: null,
            matchedInventoryLabel: null,
          }
        }

        return {
          status: 'will_create_inventory',
          matchedDealId: null, matchedDealLabel: null,
          matchedInventoryVin: matchVin,
          matchedInventoryLabel: `Nueva unidad · VIN …${matchVin.slice(-6)}`,
        }
      }
      // No VIN at all and no handwriting — fall through to empty
      return empty
    }

    return empty
  }, [deals, inventoryVins])

  // ── Scan one file → returns array of extracted docs ─────────────────────
  const scanFile = async (entry: FileEntry): Promise<FileEntry> => {
    try {
      const isPdf = entry.file.type === 'application/pdf'
      const mediaType = entry.file.type || (isPdf ? 'application/pdf' : 'image/jpeg')

      let pages: { pageNum: number; base64: string }[]
      if (isPdf) {
        try {
          pages = await splitPdfIntoPages(entry.file)
        } catch (e: any) {
          return { ...entry, status: 'error', errorMessage: `PDF parse failed: ${e.message || e}` }
        }
      } else {
        const wholeBase64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve((r.result as string).split(',')[1])
          r.onerror = () => reject(r.error)
          r.readAsDataURL(entry.file)
        })
        pages = [{ pageNum: 1, base64: wholeBase64 }]
      }

      const scanPage = async (pg: { pageNum: number; base64: string }) => {
        try {
          const res = await fetchWithTimeout(SCANNER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              scan: 'auto',
              base64: pg.base64,
              mediaType: isPdf ? 'application/pdf' : mediaType,
              isPdf,
            }),
          }, SCAN_TIMEOUT_MS)
          if (!res.ok) {
            const errText = await res.text().catch(() => '')
            return { pageNum: pg.pageNum, ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` }
          }
          const data = await res.json()
          if (!data.ok) {
            return { pageNum: pg.pageNum, ok: false, error: data.error || 'Scan failed' }
          }
          return { pageNum: pg.pageNum, ok: true, documents: Array.isArray(data.documents) ? data.documents : [] }
        } catch (err: any) {
          if (err.name === 'AbortError') {
            return { pageNum: pg.pageNum, ok: false, error: `Página ${pg.pageNum}: timeout (>${SCAN_TIMEOUT_MS / 1000}s)` }
          }
          return { pageNum: pg.pageNum, ok: false, error: err.message || 'Network error' }
        }
      }

      const allResults: { pageNum: number; ok: boolean; documents?: any[]; error?: string }[] = []
      for (let i = 0; i < pages.length; i += MAX_PARALLEL_SCANS) {
        const chunk = pages.slice(i, i + MAX_PARALLEL_SCANS)
        const chunkResults = await Promise.all(chunk.map(scanPage))
        allResults.push(...chunkResults)
      }

      const allDocs: any[] = []
      const pageErrors: string[] = []
      for (const r of allResults) {
        if (r.ok && r.documents) {
          for (const d of r.documents) {
            allDocs.push({ ...d, page: r.pageNum })
          }
        } else if (!r.ok && r.error) {
          pageErrors.push(`Pág. ${r.pageNum}: ${r.error}`)
        }
      }

      if (allDocs.length === 0) {
        return {
          ...entry,
          status: pageErrors.length === pages.length ? 'error' : 'done',
          documents: [],
          errorMessage: pageErrors.length > 0
            ? pageErrors.slice(0, 3).join(' · ')
            : 'No se detectaron documentos válidos en este archivo',
        }
      }

      // Match each detected doc — but ONLY if it has usable extracted data.
      // Empty extracteds (from a partial scan failure) get marked no_match.
      const extractedDocs: ExtractedDoc[] = allDocs.map((d: any, idx: number) => {
        const type = (d.type || 'unknown') as DocType
        const extracted = d.extracted || {}

        // GUARD: if scan returned empty extracted, don't try to save it
        if (!extractedHasUsableData(type, extracted)) {
          return {
            id: `${entry.id}_doc${idx}`,
            page: d.page || idx + 1,
            type,
            extracted,
            confidence: d.confidence,
            warnings: [...(d.warnings || []), 'Extracción vacía o incompleta — no se guardará'],
            status: 'no_match' as ExtractedDocStatus,
            matchedDealId: null, matchedDealLabel: null,
            matchedInventoryVin: null, matchedInventoryLabel: null,
          }
        }

        const match = matchDoc(type, extracted)
        return {
          id: `${entry.id}_doc${idx}`,
          page: d.page || idx + 1,
          type,
          extracted,
          confidence: d.confidence,
          warnings: d.warnings || [],
          ...match,
        }
      })

      // ── Intra-file deal propagation ─────────────────────────────────
      // One PDF per deal (venta page + compra page). The venta matches the deal
      // reliably by factura number; the compra rides on VIN OCR and can miss.
      // If EXACTLY ONE deal was matched anywhere in this file, attach any still-
      // unmatched factura_compra in the same file to that deal, using the deal's
      // CANONICAL VIN for inventory linking (never the OCR'd factura VIN).
      // Guard: only when a single deal is matched in the file (no ambiguity).
      const fileDealIds = Array.from(
        new Set(extractedDocs.filter(d => d.matchedDealId).map(d => d.matchedDealId as string)),
      )
      if (fileDealIds.length === 1) {
        const theDeal = deals.find(d => d.id === fileDealIds[0])
        for (const d of extractedDocs) {
          if (d.type === 'factura_compra' && !d.matchedDealId) {
            d.matchedDealId = fileDealIds[0]
            d.matchedDealLabel = theDeal
              ? `#${theDeal.negocio_num} — ${theDeal.cliente_nombre}${theDeal.cliente_apellidos ? ' ' + theDeal.cliente_apellidos : ''} (ligado por archivo)`
              : d.matchedDealLabel
            d.status = 'matched_deal'
            d.matchedInventoryVin = theDeal?.vin || d.matchedInventoryVin
            d.matchedInventoryLabel = theDeal?.vin
              ? `Unidad ligada al negocio · VIN …${theDeal.vin.slice(-6)}`
              : d.matchedInventoryLabel
            d.warnings = [...(d.warnings || []), 'Compra ligada al negocio por asociación de archivo (VIN/escritura no resolvió)']
          }
        }
      }

      return {
        ...entry,
        status: 'done',
        documents: extractedDocs,
        errorMessage: pageErrors.length > 0 ? `Algunas páginas fallaron: ${pageErrors.length}` : undefined,
      }
    } catch (err: any) {
      return { ...entry, status: 'error', errorMessage: err.message || 'Unexpected error' }
    }
  }

  const processQueue = async (queue: FileEntry[]) => {
    setFiles(prev => prev.map(f => queue.some(q => q.id === f.id) ? { ...f, status: 'scanning' as FileStatus } : f))
    for (let i = 0; i < queue.length; i += MAX_PARALLEL_SCANS) {
      const chunk = queue.slice(i, i + MAX_PARALLEL_SCANS)
      const results = await Promise.all(chunk.map(scanFile))
      setFiles(prev => prev.map(f => {
        const r = results.find(x => x.id === f.id)
        return r ? r : f
      }))
    }
  }

  const addFiles = (newFilesList: File[]) => {
    const valid = newFilesList.filter(isImageOrPdf)
    const newEntries: FileEntry[] = valid.map(f => ({
      id: `${Date.now()}_${f.name}_${Math.random().toString(36).slice(2, 8)}`,
      file: f,
      status: 'pending' as FileStatus,
      documents: [],
    }))
    setFiles(prev => [...prev, ...newEntries])
    processQueue(newEntries)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const list = Array.from(e.dataTransfer.files)
    if (list.length === 0) return
    addFiles(list)
  }
  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || [])
    if (list.length === 0) return
    addFiles(list); e.target.value = ''
  }
  const removeFile = (id: string) => setFiles(prev => prev.filter(f => f.id !== id))
  const clearAll = () => { setFiles([]); setSaveLog(null) }

  // ═════════════════════════════════════════════════════════════════════════
  // SAVE — now with explicit per-doc tracking and visible UI errors
  // ═════════════════════════════════════════════════════════════════════════
  const saveAll = async () => {
    setSaving(true)
    setSaveLog(null)

    const allDocs: { fileEntry: FileEntry; doc: ExtractedDoc }[] = []
    for (const f of files) {
      for (const d of f.documents) {
        if (d.status === 'matched_deal' || d.status === 'matched_inventory' || d.status === 'will_create_inventory') {
          allDocs.push({ fileEntry: f, doc: d })
        }
      }
    }

    if (allDocs.length === 0) {
      setSaving(false)
      setSaveLog({
        deals_ok: 0, deals_failed: 0, deals_failed_ids: [],
        inv_updated: 0, inv_created: 0, inv_failed: 0,
        storage_ok: 0, storage_failed: 0,
        last_errors: ['No hay documentos listos para guardar'],
      })
      return
    }

    // Track per-doc save outcome so we can paint the UI correctly.
    const docOutcomes: Record<string, { ok: boolean; error?: string }> = {}
    const errors: string[] = []

    // Build update batches per deal/unit, tracking which docs contribute to each
    const updatesByDeal: Record<string, { cols: Record<string, any>; docIds: string[] }> = {}
    const updatesByInventoryVin: Record<string, { cols: Record<string, any>; docIds: string[] }> = {}
    const newInventoryUnits: Record<string, { payload: Record<string, any>; docIds: string[] }> = {}

    for (const { doc } of allDocs) {
      docOutcomes[doc.id] = { ok: false }  // default to not saved; set to true on success

      if (doc.matchedDealId) {
        const dealCols = mapExtractedToDealColumns(doc.type, doc.extracted)
        if (Object.keys(dealCols).length > 0) {
          if (!updatesByDeal[doc.matchedDealId]) {
            updatesByDeal[doc.matchedDealId] = { cols: {}, docIds: [] }
          }
          Object.assign(updatesByDeal[doc.matchedDealId].cols, dealCols)
          updatesByDeal[doc.matchedDealId].docIds.push(doc.id)
        }
      }

      if (doc.type === 'factura_compra' && doc.matchedInventoryVin) {
        const invCols = mapExtractedToInventoryColumns(doc.extracted)
        if (doc.status === 'will_create_inventory') {
          newInventoryUnits[doc.matchedInventoryVin] = {
            payload: {
              vin: doc.matchedInventoryVin,
              ...invCols,
              estado: 'EN_STOCK',
              created_by: user?.id,
            },
            docIds: [doc.id],
          }
        } else if (doc.status === 'matched_inventory' || doc.status === 'matched_deal') {
          if (!updatesByInventoryVin[doc.matchedInventoryVin]) {
            updatesByInventoryVin[doc.matchedInventoryVin] = { cols: {}, docIds: [] }
          }
          Object.assign(updatesByInventoryVin[doc.matchedInventoryVin].cols, invCols)
          updatesByInventoryVin[doc.matchedInventoryVin].docIds.push(doc.id)
        }
      }
    }

    // ── Step 1: storage uploads (per-deal, per-doc) ──────────────────────
    let storage_ok = 0, storage_failed = 0
    for (const { fileEntry, doc } of allDocs) {
      if (doc.matchedDealId) {
        const deal = deals.find(d => d.id === doc.matchedDealId)
        if (!deal) continue
        const ext = fileEntry.file.name.split('.').pop()?.toLowerCase()
          || (fileEntry.file.type === 'application/pdf' ? 'pdf' : 'jpg')
        const path = `deals/${deal.negocio_num}/${doc.type}_p${doc.page}.${ext}`
        try {
          const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(
            path, fileEntry.file,
            { upsert: true, contentType: fileEntry.file.type || 'application/octet-stream' },
          )
          if (error) {
            storage_failed++
            errors.push(`Storage [${path}]: ${error.message}`)
          } else {
            storage_ok++
          }
        } catch (e: any) {
          storage_failed++
          errors.push(`Storage [${path}]: ${e.message || e}`)
        }
      }
    }

    // ── Step 2: deal updates ─────────────────────────────────────────────
    let dealOk = 0, dealFail = 0
    const dealsFailedIds: string[] = []
    for (const [dealId, batch] of Object.entries(updatesByDeal)) {
      if (Object.keys(batch.cols).length === 0) continue
      const { error } = await supabase.from('deals').update(batch.cols).eq('id', dealId)
      if (error) {
        dealFail++
        dealsFailedIds.push(dealId)
        errors.push(`Deal ${deals.find(d => d.id === dealId)?.negocio_num || dealId.slice(0, 6)}: ${error.message}`)
        // Mark all docs in this batch as failed
        for (const docId of batch.docIds) {
          docOutcomes[docId] = { ok: false, error: error.message }
        }
      } else {
        dealOk++
        for (const docId of batch.docIds) {
          docOutcomes[docId] = { ok: true }
        }
      }
    }

    // ── Step 3: inventory updates ────────────────────────────────────────
    let invUpdateOk = 0, invUpdateFail = 0
    for (const [vin, batch] of Object.entries(updatesByInventoryVin)) {
      if (Object.keys(batch.cols).length === 0) continue
      const { error } = await supabase.from('inventory_units').update(batch.cols).eq('vin', vin)
      if (error) {
        invUpdateFail++
        errors.push(`Inv update [${vin.slice(-8)}]: ${error.message}`)
        for (const docId of batch.docIds) {
          // If the deal already saved this doc, keep ok=true; only override
          // if the doc had ONLY inventory destination
          if (!docOutcomes[docId]?.ok) {
            docOutcomes[docId] = { ok: false, error: error.message }
          }
        }
      } else {
        invUpdateOk++
        for (const docId of batch.docIds) {
          if (!docOutcomes[docId] || !docOutcomes[docId].ok) {
            docOutcomes[docId] = { ok: true }
          }
        }
      }
    }

    // ── Step 4: inventory inserts ────────────────────────────────────────
    let invCreateOk = 0, invCreateFail = 0
    for (const [vin, batch] of Object.entries(newInventoryUnits)) {
      const { error } = await supabase.from('inventory_units').insert(batch.payload)
      if (error) {
        invCreateFail++
        errors.push(`Inv create [${vin.slice(-8)}]: ${error.message}`)
        for (const docId of batch.docIds) {
          docOutcomes[docId] = { ok: false, error: error.message }
        }
      } else {
        invCreateOk++
        for (const docId of batch.docIds) {
          docOutcomes[docId] = { ok: true }
        }
      }
    }

    // ── Step 5: activity log ─────────────────────────────────────────────
    try {
      await supabase.from('activity_log').insert({
        user_id: user?.id,
        action: 'deal_backfill_bulk_scan',
        target_type: 'deal',
        target_id: 'bulk',
        details: {
          files_processed: files.length,
          docs_extracted: allDocs.length,
          deals_updated: dealOk,
          deals_failed: dealFail,
          deals_failed_ids: dealsFailedIds,
          inventory_updated: invUpdateOk,
          inventory_failed: invUpdateFail,
          inventory_created: invCreateOk,
          inventory_create_failed: invCreateFail,
          storage_uploaded: storage_ok,
          storage_failed: storage_failed,
          errors_sample: errors.slice(0, 10),
        },
      })
    } catch (e) { /* silent — log isn't critical */ }

    // ── Update file/doc UI state with the actual outcomes ────────────────
    setFiles(prev => prev.map(f => {
      const updatedDocs = f.documents.map(d => {
        if (d.status !== 'matched_deal' && d.status !== 'matched_inventory' && d.status !== 'will_create_inventory') {
          return d
        }
        const outcome = docOutcomes[d.id]
        if (!outcome) return d
        if (outcome.ok) {
          const savedTo: ExtractedDoc['savedTo'] = {}
          if (d.matchedDealLabel) savedTo.dealLabel = d.matchedDealLabel
          if (d.type === 'factura_compra' && d.matchedInventoryVin) {
            const vinShort = d.matchedInventoryVin.slice(-6)
            if (d.status === 'will_create_inventory') {
              savedTo.inventoryAction = `Nueva unidad creada · VIN …${vinShort}`
            } else if (d.status === 'matched_inventory') {
              savedTo.inventoryAction = `Unidad inventario actualizada · VIN …${vinShort}`
            } else if (d.status === 'matched_deal') {
              savedTo.inventoryAction = `Unidad ligada actualizada · VIN …${vinShort}`
            }
          }
          return { ...d, status: 'saved' as ExtractedDocStatus, savedTo }
        } else {
          return {
            ...d,
            status: 'save_failed' as ExtractedDocStatus,
            saveError: outcome.error || 'Error desconocido al guardar',
          }
        }
      })

      const anySaved = updatedDocs.some(d => d.status === 'saved')
      const anyFailed = updatedDocs.some(d => d.status === 'save_failed')
      let newStatus: FileStatus = f.status
      if (anySaved && !anyFailed) newStatus = 'all_saved'
      else if (anySaved && anyFailed) newStatus = 'partial_saved'
      else if (anyFailed && !anySaved) newStatus = 'error'

      return { ...f, status: newStatus, documents: updatedDocs }
    }))

    setSaveLog({
      deals_ok: dealOk,
      deals_failed: dealFail,
      deals_failed_ids: dealsFailedIds,
      inv_updated: invUpdateOk,
      inv_created: invCreateOk,
      inv_failed: invUpdateFail + invCreateFail,
      storage_ok,
      storage_failed,
      last_errors: errors.slice(0, 10),
    })

    setSaving(false)
    await loadInitial()  // refresh stats
  }

  const docStats = useMemo(() => {
    let total = 0, matched = 0, scanning = 0, no_match = 0, error = 0, saved = 0, failed = 0
    let willCreateInv = 0
    for (const f of files) {
      if (f.status === 'scanning' || f.status === 'pending') scanning++
      if (f.status === 'error') error++
      for (const d of f.documents) {
        total++
        if (d.status === 'matched_deal' || d.status === 'matched_inventory') matched++
        if (d.status === 'will_create_inventory') { matched++; willCreateInv++ }
        if (d.status === 'no_match') no_match++
        if (d.status === 'saved') saved++
        if (d.status === 'save_failed') failed++
      }
    }
    return { totalFiles: files.length, totalDocs: total, matched, scanning, no_match, error, saved, willCreateInv, failed }
  }, [files])

  if (loading || permsLoading) {
    return (
      <div style={s.page}>
        <NavBar />
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>Cargando...</div>
      </div>
    )
  }

  return (
    <div style={s.page}>
      <NavBar />

      <div style={s.content}>
        <div style={{ marginBottom: '20px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '2px' }}>
            Reportes — Backfill
          </div>
          <div style={{ fontSize: '26px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>
            Subir Documentos
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '6px', maxWidth: '700px', lineHeight: 1.5 }}>
            Arrastra cualquier cantidad de cédulas, facturas de venta y facturas de compra (incluso PDFs con varias facturas).
            La IA detecta y separa cada documento, los asocia al negocio o crea unidades nuevas en inventario.
          </div>
        </div>

        {/* ── PERSISTENT SAVE LOG ─────────────────────────────────────────── */}
        {saveLog && (
          <div style={{
            ...s.card,
            background: saveLog.deals_failed > 0 || saveLog.inv_failed > 0 || saveLog.storage_failed > 0
              ? 'rgba(187,22,43,0.08)' : 'rgba(46,204,138,0.08)',
            borderColor: saveLog.deals_failed > 0 || saveLog.inv_failed > 0 || saveLog.storage_failed > 0
              ? 'rgba(187,22,43,0.3)' : 'rgba(46,204,138,0.3)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{
                fontSize: '11px', fontWeight: 700,
                color: saveLog.deals_failed > 0 ? '#BB162B' : '#1a7a4a',
                textTransform: 'uppercase' as const, letterSpacing: '2px',
              }}>
                {saveLog.deals_failed > 0 || saveLog.inv_failed > 0 ? '⚠ Resultado del Guardado' : '✓ Guardado Completo'}
              </div>
              <button onClick={() => setSaveLog(null)} style={{ ...s.btnGray, padding: '4px 10px' }}>✕</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 12 }}>
              <SaveLogStat label="Negocios actualizados" value={saveLog.deals_ok} color="#2ecc8a" />
              <SaveLogStat label="Negocios fallidos" value={saveLog.deals_failed} color={saveLog.deals_failed > 0 ? '#BB162B' : 'var(--text-secondary)'} />
              <SaveLogStat label="Inventario creado/actualizado" value={saveLog.inv_created + saveLog.inv_updated} color="#4a9eff" />
              <SaveLogStat label="Archivos subidos" value={`${saveLog.storage_ok}/${saveLog.storage_ok + saveLog.storage_failed}`} color="var(--text-primary)" />
            </div>
            {saveLog.last_errors.length > 0 && (
              <div style={{ marginTop: 8, padding: '10px 14px', background: 'rgba(0,0,0,0.15)', borderRadius: 6, fontSize: '11px', color: '#BB162B', fontFamily: 'monospace' as const, maxHeight: '160px', overflowY: 'auto' as const }}>
                <div style={{ fontWeight: 700, marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '1px' }}>Errores ({saveLog.last_errors.length}):</div>
                {saveLog.last_errors.map((e, i) => <div key={i} style={{ marginBottom: 3 }}>• {e}</div>)}
              </div>
            )}
          </div>
        )}

        {/* ── STATUS PANEL ───────────────────────────────────────────────── */}
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase' as const, letterSpacing: '2px' }}>
              Estado de Backfill
            </div>
            <button onClick={() => setShowStatus(!showStatus)} style={{ ...s.btnGray, padding: '6px 12px' }}>
              {showStatus ? 'Ocultar' : 'Mostrar'} lista
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: showStatus ? '16px' : 0 }}>
            <StatCard label="Total Negocios" value={stats.total} color="var(--text-primary)" />
            <StatCard label="Completos" value={stats.completo} color="#2ecc8a" />
            <StatCard label="Parciales" value={stats.parcial} color="#b8720a" />
            <StatCard label="Sin Datos" value={stats.sin_datos} color="#BB162B" />
          </div>

          {showStatus && (
            <>
              <div style={{ display: 'flex', gap: '20px', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '14px', flexWrap: 'wrap' as const }}>
                <span>Cédulas faltantes: <strong style={{ color: '#b8720a' }}>{stats.cedula_missing}</strong></span>
                <span>Facturas venta faltantes: <strong style={{ color: '#b8720a' }}>{stats.venta_missing}</strong></span>
                <span>Facturas compra faltantes: <strong style={{ color: '#b8720a' }}>{stats.compra_missing}</strong></span>
              </div>

              <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
                {([
                  { key: 'sin_datos', label: 'Sin Datos', count: stats.sin_datos },
                  { key: 'parcial',   label: 'Parciales', count: stats.parcial },
                  { key: 'completo',  label: 'Completos', count: stats.completo },
                  { key: 'all',       label: 'Todos',     count: stats.total },
                ] as { key: FilterTab; label: string; count: number }[]).map(t => (
                  <button key={t.key} onClick={() => setFilterTab(t.key)} style={{
                    flex: 1, padding: '8px 10px', fontSize: '11px', fontWeight: 600,
                    background: filterTab === t.key ? '#BB162B' : 'transparent',
                    color: filterTab === t.key ? '#fff' : 'var(--text-secondary)',
                    border: filterTab === t.key ? '1px solid #BB162B' : '1px solid var(--border)',
                    borderRadius: '6px', cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px',
                  }}>
                    {t.label} ({t.count})
                  </button>
                ))}
              </div>

              <input
                type="text"
                placeholder="Buscar por negocio #, cliente o cédula..."
                value={search} onChange={e => setSearch(e.target.value)}
                style={{ ...s.input, marginBottom: '12px' }}
              />

              <div style={{ maxHeight: '420px', overflowY: 'auto' as const, border: '1px solid var(--border)', borderRadius: '8px' }}>
                {filteredDeals.length === 0 ? (
                  <div style={{ padding: '30px', textAlign: 'center' as const, color: 'var(--text-secondary)', fontSize: '12px' }}>
                    {filterTab === 'completo' ? 'Aún no hay negocios completos.' : 'Sin resultados en este filtro.'}
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: '12px' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-deep)', borderBottom: '1px solid var(--border)' }}>
                        <th style={thStyle}>#</th>
                        <th style={{ ...thStyle, textAlign: 'left' as const }}>Cliente</th>
                        <th style={thStyle}>Banco</th>
                        <th style={thStyle}>Entrega</th>
                        <th style={thStyle}>🪪 Céd</th>
                        <th style={thStyle}>📋 F.V.</th>
                        <th style={thStyle}>🧾 F.C.</th>
                        <th style={thStyle}>Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredDeals.map(d => {
                        const c = completeness(d)
                        return (
                          <tr key={d.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ ...tdStyle, fontWeight: 700, color: 'var(--text-primary)' }}>{d.negocio_num}</td>
                            <td style={{ ...tdStyle, textAlign: 'left' as const, color: 'var(--text-primary)' }}>
                              {d.cliente_nombre} {d.cliente_apellidos || ''}
                              {d.cliente_rif && (
                                <span style={{ fontSize: '10px', color: 'var(--text-secondary)', marginLeft: '6px' }}>
                                  ({d.cliente_rif})
                                </span>
                              )}
                            </td>
                            <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontSize: '11px' }}>{d.banco || '—'}</td>
                            <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontSize: '11px' }}>{fmtDate(d.fecha_entrega)}</td>
                            <td style={tdStyle}><Dot ok={c.cedula} /></td>
                            <td style={tdStyle}><Dot ok={c.facturaVenta} /></td>
                            <td style={tdStyle}><Dot ok={c.facturaCompra} /></td>
                            <td style={tdStyle}>
                              <span style={{
                                fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px',
                                background: c.status === 'completo' ? 'rgba(46,204,138,0.15)' : c.status === 'parcial' ? 'rgba(184,114,10,0.15)' : 'rgba(187,22,43,0.15)',
                                color: c.status === 'completo' ? '#2ecc8a' : c.status === 'parcial' ? '#b8720a' : '#BB162B',
                              }}>
                                {c.count}/3
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── DROP ZONE ──────────────────────────────────────────────────── */}
        <div
          onDrop={onDrop}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => inputRef.current?.click()}
          style={{
            padding: '50px 30px', textAlign: 'center' as const, cursor: 'pointer',
            border: `2px ${dragOver ? 'solid' : 'dashed'} ${dragOver ? '#BB162B' : 'var(--border)'}`,
            background: dragOver ? 'rgba(187,22,43,0.05)' : 'var(--bg-card)',
            borderRadius: '12px', marginBottom: '20px', transition: 'all 0.2s ease',
          }}
        >
          <input
            ref={inputRef} type="file" accept="image/*,application/pdf" multiple
            style={{ display: 'none' }} onChange={onFilePick}
          />
          <div style={{ fontSize: '48px', marginBottom: '14px' }}>📤</div>
          <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
            Arrastra documentos aquí
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            Cédulas · Facturas de venta · Facturas de compra (incluso PDFs con varias facturas en páginas separadas)
          </div>
        </div>

        {files.length > 0 && (
          <div style={{ ...s.card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' as const, gap: '12px' }}>
            <div style={{ display: 'flex', gap: '20px', fontSize: '12px', flexWrap: 'wrap' as const }}>
              <span style={{ color: 'var(--text-secondary)' }}>Archivos: <strong style={{ color: 'var(--text-primary)' }}>{docStats.totalFiles}</strong></span>
              {docStats.totalDocs > 0 && <span style={{ color: 'var(--text-secondary)' }}>Documentos detectados: <strong style={{ color: 'var(--text-primary)' }}>{docStats.totalDocs}</strong></span>}
              {docStats.scanning > 0 && <span style={{ color: '#4a9eff' }}>Procesando: <strong>{docStats.scanning}</strong></span>}
              {docStats.matched > 0 && <span style={{ color: '#2ecc8a' }}>Listos: <strong>{docStats.matched}</strong></span>}
              {docStats.willCreateInv > 0 && <span style={{ color: '#4a9eff' }}>Nuevas unidades: <strong>{docStats.willCreateInv}</strong></span>}
              {docStats.saved > 0 && <span style={{ color: '#2ecc8a' }}>Guardados: <strong>{docStats.saved}</strong></span>}
              {docStats.failed > 0 && <span style={{ color: '#BB162B' }}>Fallaron: <strong>{docStats.failed}</strong></span>}
              {docStats.no_match > 0 && <span style={{ color: '#b8720a' }}>Sin asociación: <strong>{docStats.no_match}</strong></span>}
              {docStats.error > 0 && <span style={{ color: '#BB162B' }}>Error: <strong>{docStats.error}</strong></span>}
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={clearAll} style={s.btnGray} disabled={saving}>Limpiar</button>
              {docStats.matched > 0 && (
                <button onClick={saveAll} style={{ ...s.btnGreen, opacity: saving ? 0.6 : 1, cursor: saving ? 'wait' : 'pointer' }} disabled={saving}>
                  {saving ? 'Guardando...' : `Guardar ${docStats.matched} ${docStats.matched === 1 ? 'documento' : 'documentos'}`}
                </button>
              )}
            </div>
          </div>
        )}

        <div>
          {files.map(f => (
            <FileCard key={f.id} file={f} onRemove={() => removeFile(f.id)} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Helper components ───────────────────────────────────────────────────────
const thStyle: any = { padding: '10px 12px', textAlign: 'center' as const, fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1px' }
const tdStyle: any = { padding: '10px 12px', textAlign: 'center' as const }

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px 14px' }}>
      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1px' }}>{label}</div>
      <div style={{ fontSize: '24px', fontWeight: 800, color, marginTop: '4px' }}>{value}</div>
    </div>
  )
}

function SaveLogStat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div style={{ background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 12px' }}>
      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1px' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 800, color, marginTop: '4px', fontFamily: 'monospace' as const }}>{value}</div>
    </div>
  )
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: '14px', height: '14px', borderRadius: '50%',
      background: ok ? '#2ecc8a' : 'rgba(125,125,125,0.2)',
      border: ok ? '1px solid #2ecc8a' : '1px solid var(--border)',
    }} />
  )
}

function FileCard({ file, onRemove }: { file: FileEntry; onRemove: () => void }) {
  const fileStatus: Record<FileStatus, { label: string; color: string; bg: string; icon: string }> = {
    pending:        { label: 'En cola', color: 'var(--text-secondary)', bg: 'transparent', icon: '⏳' },
    scanning:       { label: 'Procesando IA...', color: '#4a9eff', bg: 'rgba(74,158,255,0.05)', icon: '⚙' },
    done:           { label: '', color: 'var(--text-primary)', bg: 'transparent', icon: '' },
    error:          { label: 'Error', color: '#BB162B', bg: 'rgba(187,22,43,0.08)', icon: '✕' },
    all_saved:      { label: 'Todo guardado', color: '#2ecc8a', bg: 'rgba(46,204,138,0.08)', icon: '✓' },
    partial_saved:  { label: 'Guardado parcial', color: '#b8720a', bg: 'rgba(184,114,10,0.08)', icon: '⚠' },
  }
  const info = fileStatus[file.status]
  const cardStyle = {
    ...s.card,
    background: info.bg !== 'transparent' ? info.bg : 'var(--bg-card)',
    borderColor: file.status === 'all_saved' ? 'rgba(46,204,138,0.3)' :
                 file.status === 'partial_saved' ? 'rgba(184,114,10,0.3)' :
                 file.status === 'error' ? 'rgba(187,22,43,0.3)' : 'var(--border)',
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', marginBottom: file.documents.length > 0 ? '14px' : 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' as const }}>
            <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>📎 {file.file.name}</span>
            {info.label && (
              <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 9px', borderRadius: '4px', background: info.color + '22', color: info.color }}>
                {info.icon} {info.label}
              </span>
            )}
            {file.documents.length > 0 && (
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                {file.documents.length} {file.documents.length === 1 ? 'documento' : 'documentos'} detectado{file.documents.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {file.errorMessage && (
            <div style={{ fontSize: '11px', color: file.status === 'error' ? '#BB162B' : '#b8720a', marginTop: '4px' }}>
              {file.errorMessage}
            </div>
          )}
        </div>
        {file.status !== 'all_saved' && (
          <button onClick={onRemove} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '14px', padding: '4px 8px', flexShrink: 0 }}>
            ✕
          </button>
        )}
      </div>

      {file.documents.map(d => <DocRow key={d.id} doc={d} />)}
    </div>
  )
}

function DocRow({ doc }: { doc: ExtractedDoc }) {
  const typeLabels: Record<DocType, string> = {
    cedula: '🪪 Cédula',
    factura_venta: '📋 Factura de Venta',
    factura_compra: '🧾 Factura de Compra (KIA)',
    unknown: '❓ Tipo desconocido',
  }

  const statusInfo: Record<ExtractedDocStatus, { label: string; color: string }> = {
    matched_deal:           { label: 'Asociado a negocio', color: '#2ecc8a' },
    matched_inventory:      { label: 'Asociado a inventario', color: '#2ecc8a' },
    will_create_inventory:  { label: 'Creará nueva unidad', color: '#4a9eff' },
    no_match:               { label: 'Sin asociación', color: '#b8720a' },
    duplicate:              { label: 'Duplicado', color: 'var(--text-secondary)' },
    saved:                  { label: 'Guardado ✓', color: '#2ecc8a' },
    save_failed:            { label: 'Falló al guardar', color: '#BB162B' },
  }
  const sinfo = statusInfo[doc.status]

  return (
    <div style={{
      padding: '12px 14px', marginBottom: '8px',
      background: 'var(--bg-deep)', borderRadius: '8px',
      borderLeft: `3px solid ${sinfo.color}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px', flexWrap: 'wrap' as const }}>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Pág. {doc.page}</span>
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{typeLabels[doc.type]}</span>
        <span style={{ fontSize: '10px', fontWeight: 700, padding: '1px 7px', borderRadius: '3px', background: sinfo.color + '22', color: sinfo.color }}>
          {sinfo.label}
        </span>
        {doc.confidence && (
          <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
            confianza {doc.confidence === 'high' ? 'alta' : doc.confidence === 'medium' ? 'media' : 'baja'}
          </span>
        )}
      </div>

      {/* Save failure surfaced inline */}
      {doc.status === 'save_failed' && doc.saveError && (
        <div style={{
          marginBottom: 6, fontSize: 11, color: '#BB162B',
          padding: '6px 10px', background: 'rgba(187,22,43,0.1)',
          borderRadius: 4, fontFamily: 'monospace' as const,
        }}>
          ⚠ {doc.saveError}
        </div>
      )}

      {doc.status === 'saved' && doc.savedTo && (doc.savedTo.dealLabel || doc.savedTo.inventoryAction) && (
        <div style={{ marginBottom: '6px', fontSize: '12px' }}>
          {doc.savedTo.dealLabel && (
            <div style={{ color: '#2ecc8a', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>📋</span>
              <span>Negocio actualizado: <strong>{doc.savedTo.dealLabel}</strong></span>
            </div>
          )}
          {doc.savedTo.inventoryAction && (
            <div style={{ color: '#4a9eff', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
              <span>📦</span>
              <span>{doc.savedTo.inventoryAction}</span>
            </div>
          )}
        </div>
      )}

      {doc.status !== 'saved' && doc.status !== 'save_failed' && (doc.matchedDealLabel || doc.matchedInventoryLabel) && (
        <div style={{ fontSize: '12px', color: sinfo.color, fontWeight: 600, marginBottom: '4px' }}>
          → {doc.matchedDealLabel || doc.matchedInventoryLabel}
        </div>
      )}
      <ExtractionSummary type={doc.type} extracted={doc.extracted} />
      {doc.warnings.length > 0 && (
        <div style={{ fontSize: '10px', color: '#b8720a', marginTop: '6px' }}>
          {doc.warnings.slice(0, 2).map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}
    </div>
  )
}

function ExtractionSummary({ type, extracted }: { type: DocType; extracted: Record<string, any> }) {
  if (type === 'cedula') {
    return (
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', gap: '14px', flexWrap: 'wrap' as const }}>
        <span><strong style={{ color: 'var(--text-primary)' }}>{extracted.nombre} {extracted.apellidos}</strong></span>
        <span>RIF: {extracted.rif_tipo}-{extracted.rif}</span>
        {extracted.estado_civil && <span>{extracted.estado_civil}</span>}
      </div>
    )
  }
  if (type === 'factura_venta') {
    return (
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', gap: '12px', flexWrap: 'wrap' as const }}>
        <span>F#{extracted.factura_venta_numero}</span>
        <span>Body: <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' as const }}>{fmtNum(extracted.factura_venta_body_neto)}</strong></span>
        <span>IVA: <strong style={{ fontFamily: 'monospace' as const }}>{fmtNum(extracted.factura_venta_iva)}</strong></span>
        <span>IGTF: <strong style={{ fontFamily: 'monospace' as const }}>{fmtNum(extracted.factura_venta_igtf_real)}</strong></span>
        <span>Total: <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' as const }}>{fmtNum(extracted.factura_venta_total)}</strong></span>
        {extracted.vin && <span>VIN: {extracted.vin.slice(-8)}</span>}
      </div>
    )
  }
  if (type === 'factura_compra') {
    return (
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', gap: '12px', flexWrap: 'wrap' as const }}>
        <span>F#{extracted.factura_compra_numero}</span>
        <span>Body: <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' as const }}>{fmtNum(extracted.factura_compra_body_neto)}</strong></span>
        <span>IGTF: <strong style={{ fontFamily: 'monospace' as const }}>{fmtNum(extracted.factura_compra_igtf)}</strong></span>
        <span>Total: <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' as const }}>{fmtNum(extracted.factura_compra_total)}</strong></span>
        {extracted.vin && <span>VIN: {extracted.vin.slice(-8)}</span>}
        {extracted.vehiculo_modelo && <span>{extracted.vehiculo_modelo}</span>}
      </div>
    )
  }
  return null
}

// ═════════════════════════════════════════════════════════════════════════════
// FIELD MAPPERS
// ═════════════════════════════════════════════════════════════════════════════
//
// IMPORTANT: only write columns that ACTUALLY exist on the deals table.
// Confirmed schema (2026-05-02):
//   factura_compra_body_neto, factura_compra_fecha, factura_compra_igtf,
//   factura_compra_iva, factura_compra_placa, factura_compra_tasa_bcv,
//   factura_compra_total
//
// Columns that DO NOT exist on deals (do NOT write here):
//   factura_compra_numero, factura_compra_control
// These live only on inventory_units (factura_compra_num, factura_compra_control_num)
// and are written via mapExtractedToInventoryColumns instead.
// ═════════════════════════════════════════════════════════════════════════════
function mapExtractedToDealColumns(type: DocType, extracted: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  const setIfPresent = (key: string, fromKey?: string) => {
    const sk = fromKey || key
    if (extracted[sk] !== undefined && extracted[sk] !== null && extracted[sk] !== '') {
      out[key] = extracted[sk]
    }
  }
  if (type === 'cedula') {
    setIfPresent('cliente_nombre', 'nombre')
    setIfPresent('cliente_apellidos', 'apellidos')
    setIfPresent('cliente_rif', 'rif')
    setIfPresent('cliente_rif_tipo', 'rif_tipo')
    setIfPresent('cliente_estado_civil', 'estado_civil')
  } else if (type === 'factura_venta') {
    setIfPresent('cliente_nombre'); setIfPresent('cliente_apellidos')
    setIfPresent('cliente_rif'); setIfPresent('cliente_rif_tipo')
    setIfPresent('cliente_telefono'); setIfPresent('cliente_email')
    setIfPresent('cliente_direccion')
    setIfPresent('vehiculo_marca'); setIfPresent('vehiculo_modelo')
    setIfPresent('vehiculo_año'); setIfPresent('vehiculo_color')
    setIfPresent('vehiculo_placa'); setIfPresent('vehiculo_clase')
    setIfPresent('vehiculo_uso'); setIfPresent('vin')
    setIfPresent('factura_venta_numero'); setIfPresent('factura_venta_control')
    setIfPresent('factura_venta_fecha')
    setIfPresent('factura_venta_tasa_bcv')
    // ^ BCV rate from the factura de venta — denominator for forex arbitrage in deal_pnl_management.
    setIfPresent('factura_venta_body_neto'); setIfPresent('factura_venta_iva')
    setIfPresent('factura_venta_igtf_real'); setIfPresent('factura_venta_placa')
    setIfPresent('factura_venta_total'); setIfPresent('factura_venta_modo_igtf')
    if (extracted.factura_venta_fecha) out.fecha_factura = extracted.factura_venta_fecha
  } else if (type === 'factura_compra') {
    // ONLY columns that exist on deals — see header comment.
    // factura_compra_numero and factura_compra_control intentionally omitted;
    // they live on inventory_units, NOT deals. Writing them here causes
    // a 400 Bad Request that fails the entire UPDATE.
    setIfPresent('factura_compra_fecha')
    setIfPresent('factura_compra_tasa_bcv')
    setIfPresent('factura_compra_body_neto')
    setIfPresent('factura_compra_iva')
    setIfPresent('factura_compra_igtf')
    setIfPresent('factura_compra_placa')
    setIfPresent('factura_compra_total')
    setIfPresent('vehiculo_marca')
    setIfPresent('vehiculo_modelo')
    setIfPresent('vehiculo_año')
    setIfPresent('vehiculo_color')
    setIfPresent('vin')
  }
  return out
}

function mapExtractedToInventoryColumns(extracted: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  if (extracted.factura_compra_body_neto != null) out.costo_unidad_usd = extracted.factura_compra_body_neto
  if (extracted.factura_compra_placa != null) out.costo_placa_certificado_usd = extracted.factura_compra_placa
  if (extracted.factura_compra_total != null) out.costo_total_factura_usd = extracted.factura_compra_total
  if (extracted.factura_compra_numero) out.factura_compra_num = extracted.factura_compra_numero
  if (extracted.factura_compra_control) out.factura_compra_control_num = extracted.factura_compra_control
  if (extracted.factura_compra_fecha) out.factura_compra_fecha = extracted.factura_compra_fecha
  if (extracted.motor_serial) out.motor_serial = extracted.motor_serial
  if (extracted.vehiculo_color) out.color = extracted.vehiculo_color
  if (extracted.vehiculo_modelo) out.modelo = extracted.vehiculo_modelo
  if (extracted.vehiculo_año) out.año = extracted.vehiculo_año
  if (extracted.vehiculo_placa) out.placa = extracted.vehiculo_placa
  return out
}