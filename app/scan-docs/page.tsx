// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/scan-docs/page.tsx
// Document scanner (factura / cédula / CDO) — desktop flow for Deisi
// v3: model upgraded Sonnet 4 → Opus 4.5, image resolution 1600→2400,
//     added OCR_RULES preamble with char disambiguation + transcribe-first
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ── Per-document type prompts ─────────────────────────────────────────────────

// ★ Shared OCR accuracy rules — appended to every prompt.
//   Addresses real Deisi pain: half of extractions need manual correction,
//   especially on VINs (long alphanumeric) and RIF digits. The key
//   techniques: explicit character disambiguation, transcribe-before-parse,
//   and re-verify critical fields.
const OCR_RULES = `

═══════════════════════════════════════════════════════════════════
OCR ACCURACY RULES — READ CAREFULLY BEFORE EXTRACTING
═══════════════════════════════════════════════════════════════════

STEP 1 — TRANSCRIBE FIRST, PARSE SECOND:
Before filling JSON, internally transcribe the critical fields verbatim
(don't output this — just do it in your reasoning). Only AFTER verbatim
transcription should you fill the JSON fields. This catches OCR mistakes
you'd otherwise confirm.

STEP 2 — CHARACTER DISAMBIGUATION (critical for serials):
When reading long alphanumeric codes like VINs, motor serials, RIFs:

  • '0' (zero) vs 'O' (letter) — VINs NEVER contain 'O' or 'I' or 'Q'
    by ISO 3779 standard. If you see something that looks like 'O', it
    is '0'. If you see something that looks like 'I', it is '1'. Same
    for 'Q' → read as '0'.
  • '1' vs 'l' vs 'I' — in a serial number context, prefer '1' unless
    the document is clearly in lowercase (unusual).
  • '5' vs 'S' — context-dependent. KIA VINs start with letters (K, L,
    or similar) then mostly digits. When in the digit portion, '5'.
  • '8' vs 'B' — look at the top/bottom closure. 'B' has flat edges;
    '8' is rounded. Hard to tell in compressed images.
  • '2' vs 'Z' — 'Z' has sharp diagonal; '2' has curved top.
  • 'G' vs '6' — 'G' has horizontal bar; '6' is a closed loop.

STEP 3 — VIN (Serial Carrocería / N.I.V.) SPECIFIC RULES:
  • EXACTLY 17 characters, always
  • Characters 1-3: World Manufacturer Identifier (letters + numbers)
    KIA codes: KNA, KND, LJD (Chinese KIA for Venezuela), MS0 (Mexico)
  • Characters 4-8: Vehicle descriptor (model/body/engine)
  • Character 9: Check digit (number or X)
  • Character 10: Model year (letter/number) — for 2025 = 'S', 2026 = 'T'
  • Characters 11-17: Sequential serial number
  • NEVER contains: I (letter i), O (letter O), Q
  • If the VIN you extract has 'I', 'O', or 'Q' → you misread. Re-read.
  • If the VIN is not exactly 17 characters → you misread. Re-read.

STEP 4 — MOTOR SERIAL RULES:
  • KIA motors typically: 6-8 alphanumeric chars (e.g., G4LCS1026670)
  • Can contain both letters and digits mixed
  • Case matters — usually UPPERCASE

STEP 5 — RIF / CÉDULA RULES:
  • Venezuelan RIF format: [V|E|J|G]-XXXXXXXX
  • The V/E/J/G prefix indicates type
  • The numeric part is 7-9 digits (no letters, ever)
  • If your extracted "rif" contains any letters, you misread. Re-read.
  • Strip all dashes, spaces, and dots from the number

STEP 6 — NAMES:
  • Venezuelan names are typically 2 first + 2 last (4 words total)
  • Preserve tildes/accents: MÁRQUEZ not MARQUEZ, PEÑA not PENA
  • If unsure about a character, TRUST the visible printed text

STEP 7 — IF A FIELD IS UNCLEAR:
  • Don't guess. Return null for that field.
  • Better to have Deisi enter a null field than to have her correct a
    wrong extraction.

NOW — extract the JSON with these rules applied:
`

const DOC_PROMPTS: Record<string, string> = {
  universal: `This is a Venezuelan vehicle document. It could be a Factura, Certificado de Origen, or Cédula de Identidad.
Identify the document type and extract ALL visible fields. Return ONLY JSON, no markdown:
{
  "doc_type": "factura" or "cdo" or "cedula",
  "negocio_num": "from FACTURA Nro. or null",
  "fecha_factura": "from Emisión: YYYY-MM-DD or null",
  "precio_vehiculo": "from Monto Total a Pagar USD: line — the FINAL USD total client pays — as number or null",
  "tasa_bcv": "exchange rate number from Tasa de cambio or null",
  "cliente_nombre": "FIRST NAMES ONLY — for 4-word Venezuelan name e.g. FIDEL JESUS RODRIGUEZ SANCHEZ → FIDEL JESUS",
  "cliente_apellidos": "LAST NAMES ONLY — for same example → RODRIGUEZ SANCHEZ",
  "cliente_rif": "CI/RIF digits only no dashes or null",
  "cliente_rif_tipo": "V or J or E or G or null",
  "cliente_direccion": "address or null",
  "cliente_telefono": "phone or null",
  "cliente_email": "email or null",
  "cliente_estado_civil": "only from cédula if visible or null",
  "vehiculo_marca": "brand or null",
  "vehiculo_modelo": "model or null",
  "vehiculo_color": "color or null",
  "vehiculo_placa": "plate or null",
  "vehiculo_año": "Año Modelo as integer or null — typically from 'Año:' on factura",
  "vehiculo_año_fabricacion": "Año de Fabricación as integer or null — typically from 'Año de Fabricación' on CDO",
  "vehiculo_clase": "class or null",
  "vehiculo_uso": "use or null",
  "vin": "Serial N.I.V. ONLY — NOT motor serial or null",
  "serial_motor": "Motor: field value or null"
}
Names rule: Venezuelan names = 2 first + 2 last. Split evenly. Use null for anything not visible.` + OCR_RULES,
  cedula: `This is a Venezuelan Cédula de Identidad (national ID card).
Extract ONLY what appears on this ID. Return ONLY JSON, no markdown:
{
  "doc_type": "cedula",
  "cliente_nombre": "FIRST NAMES ONLY — e.g. FIDEL JESUS — NOT last names",
  "cliente_apellidos": "LAST NAMES ONLY — e.g. RODRIGUEZ SANCHEZ — NOT first names",
  "cliente_rif": "CI number digits only, no dashes — e.g. 7244716",
  "cliente_rif_tipo": "V or E or J or G",
  "cliente_direccion": "full address if visible or null",
  "cliente_estado_civil": "look carefully for estado civil field — S=Soltero/a, C=Casado/a, D=Divorciado/a, V=Viudo/a, U=Union Estable. Map the letter/abbreviation to the full word. Return null only if completely absent.",
  "cliente_fecha_nacimiento": "YYYY-MM-DD or null"
}

CRITICAL: Venezuelan names have 2 first names + 2 last names. 
Example: FIDEL JESUS RODRIGUEZ SANCHEZ → nombre=FIDEL JESUS, apellidos=RODRIGUEZ SANCHEZ
Split at the midpoint — first half = nombres, second half = apellidos.
Estado civil appears on most cedulas — look for it carefully.
Use null only for anything truly not visible.` + OCR_RULES,

  factura: `This is a Venezuelan KIA vehicle Factura de Venta (sales invoice).
Extract ALL fields using the EXACT labels shown. Return ONLY JSON, no markdown:
{
  "doc_type": "factura",
  "negocio_num": "from FACTURA Nro. — e.g. 55883",
  "fecha_factura": "from Emisión: — YYYY-MM-DD",
  "precio_vehiculo": from "Monto Total a Pagar USD:" line ONLY — extract the USD number from that specific line (e.g. 22500.00) — NOT the BS amount — as number,
  "tasa_bcv": from "Tasa de cambio aplicada 1 BS/USD =" — exchange rate as number,
  "cliente_nombre": "FIRST NAMES ONLY from Nombre(s) y Apellido(s) field",
  "cliente_apellidos": "LAST NAMES ONLY from same field — split at midpoint for 4-word Venezuelan names",
  "cliente_rif": "digits only from CI: field — no dashes",
  "cliente_rif_tipo": "V or J or E or G",
  "cliente_direccion": "from Domicilio Fiscal:",
  "cliente_telefono": "from Teléfonos:",
  "cliente_email": "from Correo Electrónico:",
  "vehiculo_marca": "from Marca: — e.g. KIA",
  "vehiculo_modelo": "from Modelo: — e.g. SOLUTO MT",
  "vehiculo_color": "from Color:",
  "vehiculo_placa": "from Placa:",
  "vehiculo_año": "AÑO MODELO as integer from 'Año:' field on factura — NOT Año de Fabricación (that lives on the CDO)",
  "vehiculo_clase": "from Clase:",
  "vehiculo_uso": "from Categoría:",
  "vin": "from Serial N.I.V.: ONLY — chassis number like LJD0AA29AT0343412 — NOT the motor",
  "serial_motor": "from Motor: field — like G4LCS1026670"
}

IMPORTANT: precio_vehiculo = Monto Total a Pagar USD (NOT BS amount).
vin = Serial N.I.V. only (NOT Motor serial).
For names: FIDEL JESUS RODRIGUEZ SANCHEZ → nombre=FIDEL JESUS, apellidos=RODRIGUEZ SANCHEZ` + OCR_RULES,

  cdo: `This is a Venezuelan Certificado de Origen (INTT document).
The CDO has these EXACT field labels — use them precisely:
- "Serial Chasis:" or "Serial Carrocería:" → this is the VIN (long alphanumeric like LJD5AA1D2T0232728)
- "Serial N.I.V.:" → may be blank, ignore if blank
- "Serial Motor:" → motor serial (like Q4FLS1173722)
- "Año Modelo:" → model year (e.g. 2026) — THIS IS DIFFERENT from Año de Fabricación
- "Año de Fabricación:" → manufacturing year (e.g. 2025) — store as vehiculo_año_fabricacion
- "Modelo:" → vehicle model name
- "Marca:" → brand
- "Color Pri.:" → primary color
- "Placa:" → license plate
- "Clase:" → vehicle class (CAMIONETA, AUTOMOVIL, etc)
- "Uso:" → use (PARTICULAR, etc)
- "Nombre o Razón Social del Comprador:" → buyer full name
- "N° Cédula de Identidad o R.I.F. del Comprador:" → buyer CI
- "Código de Área:" + "Telf. Habitación:" → phone
- Address fields visible in Distribuidor-Concesionario section

Return ONLY JSON, no markdown:
{
  "doc_type": "cdo",
  "vin": "Serial Chasis or Serial Carrocería value — the long VIN code",
  "serial_motor": "Serial Motor value",
  "vehiculo_marca": "Marca value",
  "vehiculo_modelo": "Modelo value",
  "vehiculo_color": "Color Pri value",
  "vehiculo_año": "Año Modelo as integer — NOT Año de Fabricación",
  "vehiculo_año_fabricacion": "Año de Fabricación as integer",
  "vehiculo_placa": "Placa value or null",
  "vehiculo_clase": "Clase value or null",
  "vehiculo_uso": "Uso value or null",
  "cliente_nombre": "first names from buyer name or null",
  "cliente_apellidos": "last names from buyer name or null",
  "cliente_rif": "CI digits only no dashes or null",
  "cliente_telefono": "phone from area code + number or null",
  "cliente_direccion": "full address from CDO or null"
}` + OCR_RULES,
}

// ── Compress + read a single document ────────────────────────────────────────
async function compressImage(file: File): Promise<{ base64: string; mediaType: string }> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const base64 = await new Promise<string>((res, rej) => {
      const r = new FileReader()
      r.onload = ev => res((ev.target?.result as string).split(',')[1])
      r.onerror = rej
      r.readAsDataURL(file)
    })
    return { base64, mediaType: 'application/pdf' }
  }
  return new Promise((res, rej) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const MAX = 2400  // ★ Higher res (was 1600) — tiny text on cédulas and
                        //   VIN stampings on CDO benefit from more pixels.
                        //   Doubles input tokens (~2x image cost) but
                        //   eliminates blur-induced OCR errors.
      let { width, height } = img
      if (width > MAX || height > MAX) {
        if (width > height) { height = Math.round(height * MAX / width); width = MAX }
        else { width = Math.round(width * MAX / height); height = MAX }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, width, height)
      URL.revokeObjectURL(url)
      // Use higher quality for dark/screenshot images, higher max for receipts
      res({ base64: canvas.toDataURL('image/jpeg', 0.95).split(',')[1], mediaType: 'image/jpeg' })
    }
    img.onerror = rej
    img.src = url
  })
}

async function readDocWithAI(file: File, docType: string): Promise<any> {
  const { base64, mediaType } = await compressImage(file)
  const isPdf = mediaType === 'application/pdf'
  const prompt = DOC_PROMPTS[docType] || DOC_PROMPTS.factura

  const callAI = async (promptText: string) => {
    const payload = {
      // ★ Upgraded from Sonnet 4 to Opus 4.5 for better OCR accuracy on
      //   tricky character disambiguation (VINs, RIF digits, etc.). Same
      //   input+output pricing, adds ~$6/month at scan-docs volume.
      model: 'claude-opus-4-5-20251101',
      max_tokens: 2000,
      messages: [{ role: 'user', content: [
        isPdf
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
          : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: promptText }
      ]}]
    }
    const response = await fetch('https://autocore-comprobante.sano-franco.workers.dev', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text().then(t => t.slice(0,100))}`)
    const data = await response.json()
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
    return (data.content?.[0]?.text || '{}')
  }

  // First attempt
  let text = await callAI(prompt)
  text = text.replace(/```json|```/g, '').trim()

  // If not valid JSON, retry with ultra-strict instruction
  try {
    return JSON.parse(text)
  } catch {
    const retryPrompt = `${prompt}

IMPORTANT: Your previous response was not valid JSON. You MUST return ONLY a JSON object starting with { and ending with }. No explanations, no text before or after, no markdown. Just the raw JSON object.`
    const retryText = await callAI(retryPrompt)
    const cleaned = retryText.replace(/```json|```/g, '').trim()
    // Extract JSON from response even if there's surrounding text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) return JSON.parse(jsonMatch[0])
    throw new Error('AI no pudo leer el documento — intenta con mejor iluminación')
  }
}

// ── Cross-verify extracted data from multiple docs ────────────────────────────
interface Verification {
  field: string
  label: string
  status: 'ok' | 'warning' | 'missing'
  message: string
}

function crossVerify(byDoc: Record<string, any>): Verification[] {
  const f = byDoc.factura || {}
  const c = byDoc.cedula || {}
  const cdo = byDoc.cdo || {}
  const checks: Verification[] = []

  // Name match: cedula vs factura
  if (c.cliente_nombre && f.cliente_nombre) {
    const cn = (c.cliente_nombre + ' ' + (c.cliente_apellidos || '')).toLowerCase().trim()
    const fn = (f.cliente_nombre + ' ' + (f.cliente_apellidos || '')).toLowerCase().trim()
    const match = cn.split(' ').filter(w => w.length > 2).some(w => fn.includes(w))
    checks.push({ field: 'nombre', label: 'Nombre cliente', status: match ? 'ok' : 'warning', message: match ? 'Coincide en Cédula y Factura' : `Cédula: "${c.cliente_nombre} ${c.cliente_apellidos || ''}" / Factura: "${f.cliente_nombre} ${f.cliente_apellidos || ''}"` })
  }

  // Cédula number match
  if (c.cliente_rif && f.cliente_rif) {
    const match = c.cliente_rif.replace(/\D/g,'') === f.cliente_rif.replace(/\D/g,'')
    checks.push({ field: 'cedula', label: 'Número de Cédula', status: match ? 'ok' : 'warning', message: match ? 'Coincide en Cédula y Factura' : `Cédula: ${c.cliente_rif} / Factura: ${f.cliente_rif}` })
  }

  // VIN match: factura vs CDO
  if (f.vin && cdo.vin) {
    const match = f.vin.trim().toUpperCase() === cdo.vin.trim().toUpperCase()
    checks.push({ field: 'vin', label: 'Serial N.I.V. (VIN)', status: match ? 'ok' : 'warning', message: match ? 'Coincide en Factura y CDO' : `Factura: ${f.vin} / CDO: ${cdo.vin}` })
  }

  // Modelo match
  if (f.vehiculo_modelo && cdo.vehiculo_modelo) {
    const match = f.vehiculo_modelo.toLowerCase().includes(cdo.vehiculo_modelo.toLowerCase().split(' ')[0])
    checks.push({ field: 'modelo', label: 'Modelo vehículo', status: match ? 'ok' : 'warning', message: match ? 'Coincide en Factura y CDO' : `Factura: ${f.vehiculo_modelo} / CDO: ${cdo.vehiculo_modelo}` })
  }

  // Missing critical fields
  const merged = { ...f, ...c, ...cdo }
  if (!merged.negocio_num) checks.push({ field: 'negocio_num', label: 'N° Factura', status: 'missing', message: 'No detectado — ingresa manualmente' })
  if (!merged.vin) checks.push({ field: 'vin', label: 'Serial N.I.V.', status: 'missing', message: 'No detectado en ningún documento' })
  if (!merged.cliente_rif) checks.push({ field: 'cliente_rif', label: 'Cédula cliente', status: 'missing', message: 'No detectado' })
  if (!merged.precio_vehiculo) checks.push({ field: 'precio_vehiculo', label: 'Monto Total USD', status: 'missing', message: 'No detectado — ingresa manualmente' })

  return checks
}

// ── NEW DEAL SCANNER ──────────────────────────────────────────────────────────
const DOC_SLOTS = [
  { key: 'factura', label: 'Factura de Venta',     emoji: '📋', color: '#BB162B' },
  { key: 'cdo',     label: 'Certificado de Origen', emoji: '📜', color: '#3B82F6' },
  { key: 'cedula',  label: 'Cédula / RIF',          emoji: '🪪', color: '#10B981' },
]

function NewDealScanner({ user, onCreated, onBack }: { user: any, onCreated: (deal: any) => void, onBack: () => void }) {
  const [step, setStep]         = useState<'upload' | 'review' | 'saving'>('upload')
  const [slots, setSlots]       = useState<Record<string, File | null>>({ factura: null, cdo: null, cedula: null })
  const [previews, setPreviews] = useState<Record<string, string>>({ factura: '', cdo: '', cedula: '' })
  const [scanning, setScanning] = useState(false)
  const [scanStatus, setScanStatus] = useState<Record<string, 'idle' | 'reading' | 'done' | 'error'>>({ factura: 'idle', cdo: 'idle', cedula: 'idle' })
  const [scanErrors, setScanErrors] = useState<Record<string, string>>({})
  const [byDoc, setByDoc]       = useState<Record<string, any>>({})
  const [extracted, setExtracted] = useState<any>({})
  const [verifications, setVerifications] = useState<Verification[]>([])
  const [error, setError]       = useState('')
  const fileRefs   = useRef<Record<string, HTMLInputElement | null>>({ factura: null, cdo: null, cedula: null })
  const cameraRefs = useRef<Record<string, HTMLInputElement | null>>({ factura: null, cdo: null, cedula: null })

  const handleFile = (slotKey: string, file: File) => {
    setSlots(s => ({ ...s, [slotKey]: file }))
    setPreviews(p => ({ ...p, [slotKey]: file.type.startsWith('image/') || !file.type ? URL.createObjectURL(file) : '' }))
    setScanStatus(s => ({ ...s, [slotKey]: 'idle' }))
  }

  const readyToScan = Object.values(slots).some(f => f !== null)

  const runScan = async () => {
    setScanning(true)
    setError('')
    setScanErrors({})
    const newByDoc: Record<string, any> = { ...byDoc }

    for (const slot of DOC_SLOTS) {
      const file = slots[slot.key]
      if (!file) continue
      setScanStatus(s => ({ ...s, [slot.key]: 'reading' }))
      try {
        const result = await readDocWithAI(file, slot.key)
        newByDoc[slot.key] = result
        setScanStatus(s => ({ ...s, [slot.key]: 'done' }))
      } catch (e: any) {
        setScanErrors(prev => ({ ...prev, [slot.key]: e.message || 'Error' }))
        setScanStatus(s => ({ ...s, [slot.key]: 'error' }))
      }
    }

    // Merge: cedula fields first, then factura overrides client fields, cdo overrides vehicle fields
    const c = newByDoc.cedula || {}
    const f = newByDoc.factura || {}
    const cdo = newByDoc.cdo || {}
    const merged: any = {}

    // From cedula — identity only
    const cFields = ['cliente_nombre','cliente_apellidos','cliente_rif','cliente_rif_tipo','cliente_direccion','cliente_estado_civil','cliente_fecha_nacimiento']
    cFields.forEach(k => { if (c[k]) merged[k] = c[k] })

    // From factura — overrides client fields + all vehicle + financial
    const fFields = ['negocio_num','fecha_factura','precio_vehiculo','tasa_bcv','cliente_nombre','cliente_apellidos','cliente_rif','cliente_rif_tipo','cliente_direccion','cliente_telefono','cliente_email','vehiculo_marca','vehiculo_modelo','vehiculo_color','vehiculo_placa','vehiculo_año','vehiculo_clase','vehiculo_uso','vin','serial_motor']
    fFields.forEach(k => { if (f[k] !== null && f[k] !== undefined && f[k] !== '') merged[k] = f[k] })

    // From CDO — overrides VIN/serial (Serial Chasis = VIN on CDO) and contributes Año de Fabricación.
    // Año Modelo (vehiculo_año) stays from Factura since CDO and Factura should match.
    const cdoFields = ['vin','serial_motor','vehiculo_marca','vehiculo_modelo','vehiculo_color','vehiculo_placa','vehiculo_clase','vehiculo_uso','vehiculo_año_fabricacion']
    cdoFields.forEach(k => { if (cdo[k] !== null && cdo[k] !== undefined && cdo[k] !== '') merged[k] = cdo[k] })

    // Fill in any remaining from cedula if still missing
    cFields.forEach(k => { if (!merged[k] && c[k]) merged[k] = c[k] })

    setByDoc(newByDoc)
    setExtracted(merged)
    setVerifications(crossVerify(newByDoc))
    setScanning(false)
    setStep('review')
  }

  const handleCreate = async () => {
    if (!extracted.negocio_num) { setError('No se detectó el N° de factura. Escríbelo manualmente.'); return }
    // Check for duplicate factura number
    const { data: existing } = await supabase.from('deals').select('id').eq('negocio_num', extracted.negocio_num).single()
    if (existing) { setError(`Ya existe el negocio #${extracted.negocio_num}. No se pueden duplicar facturas.`); return }
    if (!extracted.vehiculo_año) { setError('Falta el AÑO MODELO. Verifica el campo (debe coincidir con el "Año:" de la factura).'); return }
    if (!extracted.vehiculo_año_fabricacion) { setError('Falta el AÑO DE FABRICACIÓN. Verifica el campo (debe coincidir con el CDO).'); return }
    setStep('saving')
    const payload = {
      negocio_num:          extracted.negocio_num,
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
      au_precio:            parseFloat(extracted.precio_vehiculo) || 0,
      pv_precio:            parseFloat(extracted.precio_vehiculo) || 0,
      tasa_bcv:             parseFloat(extracted.tasa_bcv) || null,
      vendedor: extracted.vendedor || null,
      pagos: [], status: 'BORRADOR', created_by: user.id,
    }
    const { data, error: err } = await supabase.from('deals').insert(payload).select('*').single()
    if (err) { setError('Error: ' + err.message); setStep('review'); return }

    // Store scanned document images to Supabase Storage
    const docMap: Record<string, File | null> = slots
    for (const [slotKey, file] of Object.entries(docMap)) {
      if (!file || !data?.id) continue
      try {
        const { base64, mediaType } = await compressImage(file as File)
        const ext = mediaType === 'application/pdf' ? 'pdf' : 'jpg'
        const path = `deals/${data.negocio_num}/${slotKey}.${ext}`
        const blob = await fetch(`data:${mediaType};base64,${base64}`).then(r => r.blob())
        await supabase.storage.from('comprobantes').upload(path, blob, { contentType: mediaType, upsert: true })
      } catch (e) { console.error('Error storing doc', slotKey, e) }
    }

    onCreated(data)
  }

  const Field = ({ label, k, required, type = 'text' }: { label: string, k: string, required?: boolean, type?: string }) => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: required && !extracted[k] ? '#BB162B' : '#888', textTransform: 'uppercase' as const, letterSpacing: 1, display: 'block', marginBottom: 4 }}>
        {label}{required ? ' *' : ''}
      </label>
      <input
        type={type}
        value={extracted[k] || ''}
        onChange={e => setExtracted((x: any) => ({ ...x, [k]: e.target.value }))}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        style={{ width: '100%', padding: '14px 16px', background: '#1a1a1a', border: `1px solid ${required && !extracted[k] ? '#BB162B44' : '#2a2a2a'}`, borderRadius: 10, color: '#fff', fontSize: 16, outline: 'none', boxSizing: 'border-box' as const, WebkitAppearance: 'none' as const }}
      />
    </div>
  )

  // UPLOAD STEP
  if (step === 'upload') return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif', paddingBottom: 120 }}>
      <div style={{ background: '#BB162B', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 20, cursor: 'pointer', padding: 0 }}>←</button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 1 }}>NUEVO NEGOCIO</div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>Fotografía los 3 documentos</div>
        </div>
      </div>

      <div style={{ padding: '20px' }}>
        {scanning ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#3B82F6', marginBottom: 20 }}>Leyendo documentos con IA...</div>
            {DOC_SLOTS.map(slot => slots[slot.key] && (
              <div key={slot.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', marginBottom: 8, background: '#111', borderRadius: 10, textAlign: 'left' as const }}>
                <span style={{ fontSize: 20 }}>
                  {scanStatus[slot.key] === 'idle' ? '⏳' : scanStatus[slot.key] === 'reading' ? '🔄' : scanStatus[slot.key] === 'done' ? '✅' : '❌'}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: scanStatus[slot.key] === 'done' ? '#10B981' : scanStatus[slot.key] === 'error' ? '#BB162B' : '#888' }}>
                    {slot.emoji} {slot.label}
                    {scanErrors[slot.key + '_type'] && <span style={{ marginLeft: 6, fontSize: 11, color: '#3B82F6' }}>→ {scanErrors[slot.key + '_type']}</span>}
                  </div>
                  {scanErrors[slot.key] && <div style={{ fontSize: 11, color: '#BB162B', marginTop: 2 }}>{scanErrors[slot.key]}</div>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 20, lineHeight: 1.7 }}>
              Toma una foto de cada documento. Luego toca <strong style={{ color: '#fff' }}>Leer con IA</strong>.
            </div>

            {DOC_SLOTS.map(slot => {
              const hasFile = slots[slot.key] !== null
              const preview = previews[slot.key]
              return (
                <div key={slot.key} style={{ marginBottom: 16 }}>
                  {/* Hidden inputs */}
                  <input
                    ref={el => { fileRefs.current[slot.key] = el }}
                    type="file" accept="image/*,application/pdf"
                    onChange={e => e.target.files?.[0] && handleFile(slot.key, e.target.files[0])}
                    style={{ display: 'none' }}
                  />
                  <input
                    ref={el => { cameraRefs.current[slot.key] = el }}
                    type="file" accept="image/*" capture="environment"
                    onChange={e => e.target.files?.[0] && handleFile(slot.key, e.target.files[0])}
                    style={{ display: 'none' }}
                  />

                  <div style={{
                    borderRadius: 14, overflow: 'hidden',
                    border: `2px solid ${hasFile ? slot.color : '#222'}`,
                    background: '#111',
                  }}>
                    {/* Header */}
                    <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: hasFile ? `1px solid ${slot.color}33` : 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 22 }}>{slot.emoji}</span>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: hasFile ? '#fff' : '#555' }}>{slot.label}</div>
                          {hasFile && <div style={{ fontSize: 11, color: slot.color, marginTop: 1 }}>✓ Listo</div>}
                        </div>
                      </div>
                      {hasFile && (
                        <button onClick={() => { setSlots(s => ({ ...s, [slot.key]: null })); setPreviews(p => ({ ...p, [slot.key]: '' })) }}
                          style={{ background: 'none', border: 'none', color: '#444', cursor: 'pointer', fontSize: 18 }}>✕</button>
                      )}
                    </div>

                    {/* Preview or buttons */}
                    {hasFile && preview ? (
                      <div style={{ position: 'relative' }}>
                        <img src={preview} alt="" style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block' }} />
                        <button onClick={() => cameraRefs.current[slot.key]?.click()}
                          style={{ position: 'absolute', bottom: 8, right: 8, padding: '6px 12px', borderRadius: 8, background: 'rgba(0,0,0,0.7)', border: `1px solid ${slot.color}`, color: '#fff', fontSize: 11, cursor: 'pointer' }}>
                          📷 Retomar
                        </button>
                      </div>
                    ) : hasFile ? (
                      <div style={{ padding: '12px 16px', fontSize: 12, color: '#10B981' }}>📄 Archivo cargado</div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: '#0a0a0a' }}>
                        <button onClick={() => cameraRefs.current[slot.key]?.click()}
                          style={{ padding: '18px', background: '#111', border: 'none', color: '#fff', cursor: 'pointer', textAlign: 'center' as const }}>
                          <div style={{ fontSize: 24, marginBottom: 4 }}>📷</div>
                          <div style={{ fontSize: 12, color: '#666' }}>Cámara</div>
                        </button>
                        <button onClick={() => fileRefs.current[slot.key]?.click()}
                          style={{ padding: '18px', background: '#111', border: 'none', color: '#fff', cursor: 'pointer', textAlign: 'center' as const }}>
                          <div style={{ fontSize: 24, marginBottom: 4 }}>🖼️</div>
                          <div style={{ fontSize: 12, color: '#666' }}>Galería</div>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* Bottom CTA */}
      {!scanning && (
        <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, padding: '16px 20px', background: '#0A0A0A', borderTop: '1px solid #1a1a1a' }}>
          <button onClick={runScan} disabled={!readyToScan}
            style={{ width: '100%', padding: '16px', borderRadius: 12, border: 'none', background: readyToScan ? '#BB162B' : '#222', color: '#fff', fontSize: 16, fontWeight: 800, cursor: readyToScan ? 'pointer' : 'not-allowed', letterSpacing: 0.5 }}>
            {readyToScan
              ? `🔍 Leer con IA (${Object.values(slots).filter(Boolean).length} doc${Object.values(slots).filter(Boolean).length !== 1 ? 's' : ''})`
              : 'Fotografía al menos un documento'}
          </button>
        </div>
      )}
    </div>
  )

  // REVIEW STEP
  if (step === 'review') return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif', paddingBottom: 100 }}>
      <div style={{ background: '#BB162B', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', top: 0, zIndex: 10 }}>
        <button onClick={() => setStep('upload')} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 20, cursor: 'pointer', padding: 0 }}>←</button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 1 }}>REVISAR DATOS</div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>Corrige si es necesario</div>
        </div>
      </div>

      <div style={{ padding: '20px' }}>
        {error && <div style={{ background: 'rgba(187,22,43,0.15)', border: '1px solid #BB162B44', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#BB162B' }}>{error}</div>}

        {/* Scan errors */}
        {Object.entries(scanErrors).length > 0 && (
          <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#F59E0B', marginBottom: 4 }}>⚠ Errores al leer:</div>
            {Object.entries(scanErrors).map(([k, v]) => (
              <div key={k} style={{ fontSize: 11, color: '#F59E0B' }}>{k}: {v as string}</div>
            ))}
          </div>
        )}

        {/* Verification panel */}
        {verifications.length > 0 && (
          <div style={{ background: '#111', borderRadius: 12, padding: '16px', marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#F59E0B', textTransform: 'uppercase' as const, letterSpacing: 2, marginBottom: 12 }}>🔍 Verificación Cruzada</div>
            {verifications.map((v, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', borderBottom: i < verifications.length - 1 ? '1px solid #1a1a1a' : 'none' }}>
                <span style={{ fontSize: 14, flexShrink: 0 }}>{v.status === 'ok' ? '✅' : v.status === 'warning' ? '⚠️' : '❌'}</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: v.status === 'ok' ? '#10B981' : v.status === 'warning' ? '#F59E0B' : '#BB162B' }}>{v.label}</div>
                  <div style={{ fontSize: 11, color: '#555', marginTop: 1 }}>{v.message}</div>
                </div>
              </div>
            ))}
          </div>
        )}


        {/* Vendedor selector */}
        <div style={{ background: '#111', borderRadius: 12, padding: '16px', marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#BB162B', textTransform: 'uppercase' as const, letterSpacing: 2, marginBottom: 12 }}>👤 Vendedor</div>
          <div style={{ marginBottom: 0 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase' as const, letterSpacing: 1, display: 'block', marginBottom: 4 }}>Vendedor *</label>
            <select
              value={extracted.vendedor || ''}
              onChange={e => setExtracted((x: any) => ({ ...x, vendedor: e.target.value }))}
              style={{ width: '100%', padding: '14px 16px', background: '#1a1a1a', border: `1px solid ${!extracted.vendedor ? '#BB162B44' : '#2a2a2a'}`, borderRadius: 10, color: extracted.vendedor ? '#fff' : '#666', fontSize: 16, outline: 'none', boxSizing: 'border-box' as const, WebkitAppearance: 'none' as const }}
            >
              <option value="">Seleccionar vendedor...</option>
              {['Roberto Hernandez','Mariangel Acosta','Maurice Rodriguez','Vendedor Externo','Gerencia'].map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ background: '#111', borderRadius: 12, padding: '16px', marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#BB162B', textTransform: 'uppercase' as const, letterSpacing: 2, marginBottom: 12 }}>📋 Factura</div>
          <Field label="N° Factura / Negocio" k="negocio_num" required />
          <Field label="Fecha Factura" k="fecha_factura" />
          <Field label="Monto Total a Pagar USD" k="precio_vehiculo" required />
          <Field label="Tasa BCV (Bs/USD)" k="tasa_bcv" />
        </div>

        <div style={{ background: '#111', borderRadius: 12, padding: '16px', marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#BB162B', textTransform: 'uppercase' as const, letterSpacing: 2, marginBottom: 12 }}>🪪 Cliente</div>
          <Field label="Nombres" k="cliente_nombre" />
          <Field label="Apellidos" k="cliente_apellidos" />
          <Field label="Cédula/RIF" k="cliente_rif" />
          <Field label="Tipo (V/J/E/G)" k="cliente_rif_tipo" />
          <Field label="Estado Civil" k="cliente_estado_civil" />
          <Field label="Teléfono" k="cliente_telefono" />
          <Field label="Email" k="cliente_email" />
          <Field label="Dirección" k="cliente_direccion" />
        </div>

        <div style={{ background: '#111', borderRadius: 12, padding: '16px', marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#BB162B', textTransform: 'uppercase' as const, letterSpacing: 2, marginBottom: 12 }}>🚗 Vehículo</div>
          <Field label="Marca" k="vehiculo_marca" />
          <Field label="Modelo" k="vehiculo_modelo" />
          <Field label="Año Modelo" k="vehiculo_año" />
          <Field label="Año Fabricación" k="vehiculo_año_fabricacion" />
          <Field label="Color" k="vehiculo_color" />
          <Field label="Placa" k="vehiculo_placa" />
          <Field label="VIN / Serial Carrocería" k="vin" />
          <Field label="Serial Motor" k="serial_motor" />
          <Field label="Clase" k="vehiculo_clase" />
          <Field label="Uso" k="vehiculo_uso" />
        </div>
      </div>

      {/* Sticky bottom button */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, padding: '16px 20px', background: '#0A0A0A', borderTop: '1px solid #1a1a1a' }}>
        <button onClick={handleCreate}
          style={{ width: '100%', padding: '16px', borderRadius: 12, border: 'none', background: extracted.negocio_num ? '#BB162B' : '#333', color: '#fff', fontSize: 16, fontWeight: 800, cursor: 'pointer', letterSpacing: 1 }}>
          ✓ Crear Negocio {extracted.negocio_num ? `#${extracted.negocio_num}` : '— Ingresa el N° de factura'}
        </button>
      </div>
    </div>
  )

  // SAVING
  return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16 }}>
      💾 Creando negocio...
    </div>
  )
}

// ── INGRESO SCANNER ───────────────────────────────────────────────────────────
function IngresoScanner({ user, deals: initialDeals, onBack, preSelectedDeal }: { user: any, deals: any[], onBack: () => void, preSelectedDeal?: any }) {
  const [step, setStep] = useState<'upload' | 'confirm' | 'done'>('upload')
  const [scanning, setScanning] = useState(false)
  const [extracted, setExtracted] = useState<any>(null)
  const [imageB64, setImageB64] = useState('')
  const [selectedDealId, setSelectedDealId] = useState('')
  const [facturaInput, setFacturaInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedList, setSavedList] = useState<any[]>([])
  const [lastSavedDealId, setLastSavedDealId] = useState<string>('')
  const [error, setError] = useState('')
  const [localDeals, setLocalDeals] = useState<any[]>(initialDeals)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)

  // Pre-select deal if passed from new deal creation
  useEffect(() => {
    if (preSelectedDeal) {
      setSelectedDealId(String(preSelectedDeal.id))
      setLocalDeals(prev => {
        const exists = prev.some(d => String(d.id) === String(preSelectedDeal.id))
        return exists ? prev : [preSelectedDeal, ...prev]
      })
    }
  }, [preSelectedDeal?.id])

  const refreshLocalDeals = async () => {
    const { data } = await supabase.from('deals')
      .select('id, negocio_num, cliente_nombre, pagos, total_recibido, tasa_bcv, status')
      .order('created_at', { ascending: false })
    if (data) setLocalDeals(data)
  }

  const openDeals = localDeals.filter(d => d.status !== 'APROBADO')

  const foundDeal = openDeals.find(d =>
    selectedDealId ? String(d.id) === selectedDealId :
    facturaInput ? String(d.negocio_num) === facturaInput.trim() : false
  )

  const scan = async (file: File) => {
    setScanning(true)
    setError('')
    try {
      const base64 = await new Promise<string>((res, rej) => {
        const r = new FileReader()
        r.onload = ev => res((ev.target?.result as string).split(',')[1])
        r.onerror = rej
        r.readAsDataURL(file)
      })
      setImageB64(base64)
      const isPdf = file.type === 'application/pdf'
      const mediaType = isPdf ? 'application/pdf' : (file.type || 'image/jpeg')

      const res = await fetch('https://autocore-comprobante.sano-franco.workers.dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 800,
          messages: [{
            role: 'user',
            content: [
              isPdf
                ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
                : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              {
                type: 'text',
                text: `This is a payment receipt screenshot. It may be:
- Binance Pay / USDT: shows "X USDT", "Alias: User-XXXXX", "ID de orden: XXXXXXXXX", "Pagado con X USDT", "Cuenta de Fondos"
- Zelle: shows sender name, confirmation number, bank name
- Wire Transfer: shows SWIFT/wire details
- Bank transfer

Return ONLY JSON, no markdown:
{
  "monto_usd": the payment amount as number — for USDT/crypto 1 USDT = 1 USD or null,
  "fecha": "YYYY-MM-DD or null",
  "referencia": "for USDT use ID de orden value; for Zelle use confirmation number; any transaction ID or null",
  "sender_name": "for USDT use the Alias value (e.g. User-6b7d8); for Zelle use sender name or null",
  "tipo": "usdt if you see USDT or Binance or Cuenta de Fondos; otherwise zelle|wire|ach|transfer",
  "cuenta_destino": "recipient account or null",
  "usdt_alias": "the Alias: User-XXXXX value if visible or null",
  "usdt_id_number": "the number below the alias (e.g. 18862783) if visible or null"
}
USDT DETECTION: if screenshot shows 'USDT', 'Pago exitoso' with USDT amount, 'Alias:', 'ID de orden', 'Cuenta de Fondos' — tipo MUST be 'usdt'.
NOTE: The screenshot may have a dark (black) background with white text or a light (white) background — read carefully regardless of background color.`
              }
            ]
          }]
        })
      })
      const data = await res.json()
      const text = data.content?.[0]?.text || '{}'
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
      setExtracted(parsed)
      setScanning(false)
      setStep('confirm')
    } catch {
      setError('No se pudo leer. Intenta de nuevo.')
      setScanning(false)
    }
  }

  const getMetodo = () => {
    if (!extracted) return 'Zelle Motocentro'
    const cuenta = (extracted.cuenta_destino || '').toLowerCase()
    const tipo = (extracted.tipo || '').toLowerCase()
    // USDT detection — check tipo first, then keywords
    if (tipo === 'usdt' || extracted.usdt_alias || cuenta.includes('usdt')) return 'USDT'
    if (tipo === 'zelle') return cuenta.includes('roframi') ? 'Zelle Roframi' : 'Zelle Motocentro'
    if (tipo === 'wire') {
      if (cuenta.includes('roframi')) return 'Wire Transfer Roframi'
      if (cuenta.includes('panama')) return 'Wire Transfer Panama'
      return 'Wire Transfer Motocentro'
    }
    return 'Zelle Motocentro'
  }

  const handleSave = async () => {
    if (!foundDeal || !extracted || saving) return
    setSaving(true)
    const tasa = parseFloat(foundDeal.tasa_bcv) || 1
    const newPago = {
      metodo: getMetodo(),
      fecha: extracted.fecha || new Date().toISOString().slice(0, 10),
      monto_usd: extracted.monto_usd || 0,
      monto_bs: (extracted.monto_usd || 0) * tasa,
      referencia: extracted.referencia || '',
      comentario: [
        extracted.sender_name ? `De: ${extracted.sender_name}` : '',
        extracted.usdt_alias ? `USDT Alias: ${extracted.usdt_alias}` : '',
        extracted.usdt_id_number ? `ID: ${extracted.usdt_id_number}` : '',
      ].filter(Boolean).join(' · '),
      comprobante_imagen: imageB64 ? `data:image/jpeg;base64,${imageB64}` : undefined,
    }
    const existingPagos = Array.isArray(foundDeal.pagos) ? foundDeal.pagos : []
    if (newPago.referencia && existingPagos.some((p: any) => p.referencia === newPago.referencia)) {
      alert('Ya existe un pago con esa referencia.'); setSaving(false); return
    }
    const newPagos = [...existingPagos, newPago]
    const { error: err } = await supabase.from('deals').update({
      pagos: newPagos,
      total_recibido: newPagos.reduce((s: number, p: any) => s + (parseFloat(p.monto_usd) || 0), 0)
    }).eq('id', foundDeal.id)
    if (err) { alert('Error: ' + err.message); setSaving(false); return }
    // Refresh deal data from DB so next pago sees updated pagos list
    const { data: refreshedDeal } = await supabase.from('deals')
      .select('id, negocio_num, cliente_nombre, pagos, total_recibido, tasa_bcv, status')
      .eq('id', foundDeal.id).single()
    if (refreshedDeal) {
      const dealId = String(foundDeal.id)
      setLastSavedDealId(dealId)
    }
    await refreshLocalDeals()
    setSavedList(l => [...l, { deal: foundDeal, pago: newPago }])
    setSaving(false)
    setStep('done')
  }

  // UPLOAD
  if (step === 'upload') return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ background: '#18181B', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #222' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 20, cursor: 'pointer', padding: 0 }}>←</button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 1 }}>SUBIR INGRESO</div>
          <div style={{ fontSize: 11, color: '#666' }}>{savedList.length > 0 ? `${savedList.length} guardado${savedList.length !== 1 ? 's' : ''}` : 'Escanea comprobante'}</div>
        </div>
      </div>

      <div style={{ padding: '24px 20px' }}>
        <input ref={fileRef} type="file" accept="image/*,application/pdf" onChange={e => e.target.files?.[0] && scan(e.target.files[0])} style={{ display: 'none' }} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={e => e.target.files?.[0] && scan(e.target.files[0])} style={{ display: 'none' }} />

        {scanning ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#3B82F6' }}>Leyendo comprobante...</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
            <button onClick={() => cameraRef.current?.click()}
              style={{ padding: '24px', borderRadius: 14, border: '2px solid #222', background: '#111', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 16 }}>
              <span style={{ fontSize: 36 }}>📷</span>
              <div style={{ textAlign: 'left' as const }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>Tomar Foto</div>
                <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>Zelle, Wire, comprobante</div>
              </div>
            </button>
            <button onClick={() => fileRef.current?.click()}
              style={{ padding: '24px', borderRadius: 14, border: '2px solid #222', background: '#111', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 16 }}>
              <span style={{ fontSize: 36 }}>🖼️</span>
              <div style={{ textAlign: 'left' as const }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>Desde Galería</div>
                <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>Foto o PDF</div>
              </div>
            </button>
          </div>
        )}
        {error && <div style={{ marginTop: 16, color: '#BB162B', fontSize: 13 }}>{error}</div>}

        {/* Recent saved */}
        {savedList.length > 0 && (
          <div style={{ marginTop: 28 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#555', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 10 }}>Guardados esta sesión</div>
            {savedList.map((s, i) => (
              <div key={i} style={{ padding: '10px 14px', background: '#111', borderRadius: 8, marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, color: '#888' }}>#{s.deal.negocio_num} — {s.deal.cliente_nombre?.split(' ')[0]}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#10B981', fontFamily: 'monospace' }}>{fmt(s.pago.monto_usd)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )

  // CONFIRM
  if (step === 'confirm') return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif', paddingBottom: 100 }}>
      <div style={{ background: '#18181B', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #222', position: 'sticky', top: 0, zIndex: 10 }}>
        <button onClick={() => setStep('upload')} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 20, cursor: 'pointer', padding: 0 }}>←</button>
        <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 1 }}>CONFIRMAR INGRESO</div>
      </div>

      <div style={{ padding: '20px' }}>
        {/* Payment info */}
        <div style={{ background: '#111', borderRadius: 12, padding: '16px', marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#10B981', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 12 }}>Pago Detectado</div>
          <div style={{ fontSize: 32, fontWeight: 900, color: '#10B981', fontFamily: 'monospace', marginBottom: 8 }}>
            {extracted?.monto_usd ? fmt(extracted.monto_usd) : '—'}
          </div>
          {[
            ['Remitente', extracted?.sender_name],
            ['Referencia', extracted?.referencia],
            ['Fecha', extracted?.fecha],
            ['Tipo', extracted?.tipo?.toUpperCase()],
            ['Método', getMetodo()],
          ].filter(([, v]) => v).map(([l, v]) => (
            <div key={l as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #1a1a1a' }}>
              <span style={{ fontSize: 12, color: '#666' }}>{l}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>{v}</span>
            </div>
          ))}
        </div>

        {/* Deal selection */}
        <div style={{ background: '#111', borderRadius: 12, padding: '16px', marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#3B82F6', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 14 }}>¿A qué negocio?</div>

          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8, marginBottom: 14 }}>
            {openDeals.slice(0, 6).map(d => (
              <button key={d.id} onClick={() => { setSelectedDealId(String(d.id)); setFacturaInput('') }}
                style={{
                  padding: '12px 14px', borderRadius: 10, textAlign: 'left' as const, cursor: 'pointer',
                  border: `2px solid ${selectedDealId === String(d.id) ? '#BB162B' : '#1a1a1a'}`,
                  background: selectedDealId === String(d.id) ? 'rgba(187,22,43,0.15)' : '#0d0d0d',
                  color: '#fff',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>#{d.negocio_num}</span>
                  <span style={{ fontSize: 12, color: '#10B981', fontFamily: 'monospace' }}>{fmt(d.total_recibido || 0)}</span>
                </div>
                <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{d.cliente_nombre}</div>
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#555', flexShrink: 0 }}>O busca por #:</span>
            <input
              value={facturaInput}
              onChange={e => { setFacturaInput(e.target.value); setSelectedDealId('') }}
              placeholder="Nro. factura"
              style={{ flex: 1, padding: '10px 12px', background: '#0d0d0d', border: '1px solid #2a2a2a', borderRadius: 8, color: '#fff', fontSize: 14, outline: 'none' }}
            />
          </div>
          {facturaInput && !foundDeal && (
            <div style={{ fontSize: 12, color: '#BB162B', marginTop: 8 }}>Negocio #{facturaInput} no encontrado</div>
          )}
          {foundDeal && (
            <div style={{ fontSize: 13, color: '#10B981', marginTop: 8, fontWeight: 600 }}>
              ✓ {foundDeal.cliente_nombre}
            </div>
          )}
        </div>
      </div>

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, padding: '16px 20px', background: '#0A0A0A', borderTop: '1px solid #1a1a1a' }}>
        <button onClick={handleSave} disabled={!foundDeal || saving}
          style={{ width: '100%', padding: '16px', borderRadius: 12, border: 'none', background: foundDeal ? '#BB162B' : '#222', color: '#fff', fontSize: 15, fontWeight: 800, cursor: foundDeal ? 'pointer' : 'not-allowed', opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Guardando...' : foundDeal ? `✓ Agregar a #${foundDeal.negocio_num}` : 'Selecciona un negocio'}
        </button>
      </div>
    </div>
  )

  // DONE
  return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ fontSize: 72, marginBottom: 16 }}>✅</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Ingreso Guardado</div>
      <div style={{ fontSize: 14, color: '#10B981', fontFamily: 'monospace', marginBottom: 4 }}>
        {extracted?.monto_usd ? fmt(extracted.monto_usd) : ''}
      </div>
      <div style={{ fontSize: 13, color: '#555', marginBottom: 32 }}>Negocio #{foundDeal?.negocio_num}</div>
      <div style={{ display: 'flex', gap: 12, width: '100%', maxWidth: 360 }}>
        <button onClick={async () => {
          // Refresh deals so pagos list is up to date
          const { data: refreshedDeals } = await supabase.from('deals')
            .select('id, negocio_num, cliente_nombre, pagos, total_recibido, tasa_bcv, status')
            .order('created_at', { ascending: false })
          if (refreshedDeals) {
            // Update openDeals — we need to pass up but for now just keep same deal selected
          }
          setStep('upload')
          setExtracted(null)
          setImageB64('')
          // Keep selectedDealId so the same deal is pre-selected
          if (lastSavedDealId) setSelectedDealId(lastSavedDealId)
        }}
          style={{ flex: 1, padding: 14, borderRadius: 10, border: '1px solid #222', background: '#111', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>
          + Otro Pago
        </button>
        <button onClick={onBack}
          style={{ flex: 1, padding: 14, borderRadius: 10, border: 'none', background: '#BB162B', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>
          Inicio
        </button>
      </div>
    </div>
  )
}

// ── UPDATE EXISTING DEAL SCANNER ─────────────────────────────────────────────
function UpdateDealScanner({ user, deals, onBack }: { user: any, deals: any[], onBack: () => void }) {
  const [step, setStep] = useState<'select' | 'upload' | 'review' | 'saving' | 'done'>('select')
  const [facturaInput, setFacturaInput] = useState('')
  const [selectedDeal, setSelectedDeal] = useState<any>(null)
  const [scanning, setScanning] = useState(false)
  const [scannedCount, setScannedCount] = useState(0)
  const [extracted, setExtracted] = useState<any>({})
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)

  const foundDeal = deals.find(d =>
    facturaInput ? String(d.negocio_num) === facturaInput.trim() : false
  )

  const [scanErrors, setScanErrors] = useState<string[]>([])

  const scanDocs = async (files: FileList) => {
    if (!files.length) return
    setScanning(true)
    setError('')
    setScanErrors([])
    setScannedCount(files.length)
    let combined: any = { ...extracted } // override existing

    for (const file of Array.from(files)) {
      try {
        const result = await readDocWithAI(file, 'universal')
        Object.entries(result).forEach(([k, v]) => {
          if (k === 'doc_type') return
          if (v !== null && v !== '' && v !== undefined) combined[k] = v
        })
      } catch (e: any) {
        setScanErrors(prev => [...prev, `${file.name}: ${e.message}`])
      }
    }

    // Pre-fill with existing deal data, then overlay AI results
    const merged = {
      cliente_nombre:       selectedDeal.cliente_nombre || '',
      cliente_apellidos:    selectedDeal.cliente_apellidos || '',
      cliente_rif:          selectedDeal.cliente_rif || '',
      cliente_rif_tipo:     selectedDeal.cliente_rif_tipo || 'V',
      cliente_direccion:    selectedDeal.cliente_direccion || '',
      cliente_telefono:     selectedDeal.cliente_telefono || '',
      cliente_email:        selectedDeal.cliente_email || '',
      cliente_estado_civil: selectedDeal.cliente_estado_civil || '',
      vehiculo_marca:       selectedDeal.vehiculo_marca || '',
      vehiculo_modelo:      selectedDeal.vehiculo_modelo || '',
      vehiculo_color:       selectedDeal.vehiculo_color || '',
      vehiculo_placa:       selectedDeal.vehiculo_placa || '',
      vehiculo_año:         selectedDeal.vehiculo_año || '',
      vehiculo_año_fabricacion: selectedDeal.vehiculo_año_fabricacion || '',
      vehiculo_clase:       selectedDeal.vehiculo_clase || '',
      vehiculo_uso:         selectedDeal.vehiculo_uso || 'PARTICULAR',
      vin:                  selectedDeal.vin || '',
      serial_motor:         selectedDeal.serial_motor || '',
      fecha_factura:        selectedDeal.fecha_factura || '',
      precio_vehiculo:      selectedDeal.au_precio || '',
      ...combined, // AI results override blanks
    }
    // Never overwrite negocio_num from AI — keep the existing one
    delete merged.negocio_num

    setExtracted(merged)
    setScanning(false)
    setStep('review')
  }

  const handleUpdate = async () => {
    if (!selectedDeal) return
    if (!extracted.vehiculo_año) { setError('Falta el AÑO MODELO. Verifica el campo (debe coincidir con el "Año:" de la factura).'); return }
    if (!extracted.vehiculo_año_fabricacion) { setError('Falta el AÑO DE FABRICACIÓN. Verifica el campo (debe coincidir con el CDO).'); return }
    setStep('saving')
    const payload: any = {
      cliente_nombre:       extracted.cliente_nombre || null,
      cliente_apellidos:    extracted.cliente_apellidos || null,
      cliente_rif:          extracted.cliente_rif || null,
      cliente_rif_tipo:     extracted.cliente_rif_tipo || 'V',
      cliente_direccion:    extracted.cliente_direccion || null,
      cliente_telefono:     extracted.cliente_telefono || null,
      cliente_email:        extracted.cliente_email || null,
      cliente_estado_civil: extracted.cliente_estado_civil || null,
      vehiculo_marca:       extracted.vehiculo_marca || null,
      vehiculo_modelo:      extracted.vehiculo_modelo || null,
      vehiculo_color:       extracted.vehiculo_color || null,
      vehiculo_placa:       extracted.vehiculo_placa || null,
      vehiculo_año:         extracted.vehiculo_año || null,
      vehiculo_año_fabricacion: extracted.vehiculo_año_fabricacion || null,
      vehiculo_clase:       extracted.vehiculo_clase || null,
      vehiculo_uso:         extracted.vehiculo_uso || null,
      vin:                  extracted.vin || null,
      fecha_factura:        extracted.fecha_factura || null,
    }
    if (extracted.precio_vehiculo) {
      payload.au_precio = parseFloat(extracted.precio_vehiculo) || null
      payload.pv_precio = parseFloat(extracted.precio_vehiculo) || null
    }
    const { error: err } = await supabase.from('deals').update(payload).eq('id', selectedDeal.id)
    if (err) { setError('Error: ' + err.message); setStep('review'); return }
    setStep('done')
  }

  const Field = ({ label, k }: { label: string, k: string }) => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase' as const, letterSpacing: 1, display: 'block', marginBottom: 4 }}>{label}</label>
      <input
        value={extracted[k] || ''}
        onChange={e => setExtracted((x: any) => ({ ...x, [k]: e.target.value }))}
        style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 8, color: '#fff', fontSize: 14, outline: 'none', boxSizing: 'border-box' as const }}
      />
    </div>
  )

  // STEP: SELECT DEAL
  if (step === 'select') return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif', paddingBottom: 100 }}>
      <div style={{ background: '#18181B', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #222' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 20, cursor: 'pointer', padding: 0 }}>←</button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 1 }}>ACTUALIZAR NEGOCIO</div>
          <div style={{ fontSize: 11, color: '#666' }}>Selecciona el negocio a actualizar</div>
        </div>
      </div>
      <div style={{ padding: '20px' }}>
        {/* Search by factura number */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: '#666', textTransform: 'uppercase' as const, letterSpacing: 1.5, display: 'block', marginBottom: 8 }}>Buscar por N° Factura</label>
          <input
            value={facturaInput}
            onChange={e => setFacturaInput(e.target.value)}
            placeholder="Ej: 55883"
            style={{ width: '100%', padding: '12px 16px', background: '#111', border: '1px solid #2a2a2a', borderRadius: 10, color: '#fff', fontSize: 16, outline: 'none', boxSizing: 'border-box' as const }}
            autoFocus
          />
          {facturaInput && !foundDeal && (
            <div style={{ fontSize: 12, color: '#BB162B', marginTop: 6 }}>Negocio #{facturaInput} no encontrado</div>
          )}
          {foundDeal && (
            <div style={{ marginTop: 10, padding: '12px 14px', background: 'rgba(187,22,43,0.1)', border: '1px solid rgba(187,22,43,0.3)', borderRadius: 10 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>#{foundDeal.negocio_num} — {foundDeal.cliente_nombre || 'Sin nombre'}</div>
              <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{foundDeal.vehiculo_modelo || 'Sin vehículo'} · {foundDeal.status}</div>
            </div>
          )}
        </div>

        {/* All deals list */}
        <div style={{ fontSize: 11, fontWeight: 700, color: '#444', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 12 }}>Todos los Negocios</div>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
          {deals.map(d => (
            <button key={d.id} onClick={() => setSelectedDeal(d)}
              style={{
                padding: '12px 14px', borderRadius: 10, textAlign: 'left' as const, cursor: 'pointer',
                border: `1px solid ${selectedDeal?.id === d.id ? '#BB162B' : '#1a1a1a'}`,
                background: selectedDeal?.id === d.id ? 'rgba(187,22,43,0.12)' : '#111',
                color: '#fff',
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>#{d.negocio_num}</span>
                <span style={{ fontSize: 11, color: d.status === 'APROBADO' ? '#10B981' : '#b8720a', fontWeight: 600 }}>{d.status}</span>
              </div>
              <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{d.cliente_nombre || 'Sin datos de cliente'}</div>
              {/* Show which fields are missing */}
              {(!d.cliente_apellidos || !d.vehiculo_modelo || !d.vin) && (
                <div style={{ fontSize: 10, color: '#BB162B', marginTop: 4 }}>
                  ⚠ Faltan: {[!d.cliente_apellidos && 'apellidos', !d.vehiculo_modelo && 'modelo', !d.vin && 'VIN'].filter(Boolean).join(', ')}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Bottom confirm button */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, padding: '16px 20px', background: '#0A0A0A', borderTop: '1px solid #1a1a1a' }}>
        <button
          onClick={() => { if (foundDeal) setSelectedDeal(foundDeal); if (selectedDeal || foundDeal) setStep('upload') }}
          disabled={!selectedDeal && !foundDeal}
          style={{ width: '100%', padding: '16px', borderRadius: 12, border: 'none', background: (selectedDeal || foundDeal) ? '#BB162B' : '#222', color: '#fff', fontSize: 15, fontWeight: 800, cursor: (selectedDeal || foundDeal) ? 'pointer' : 'not-allowed' }}>
          {(selectedDeal || foundDeal) ? `Actualizar #${(selectedDeal || foundDeal)?.negocio_num} →` : 'Selecciona un negocio'}
        </button>
      </div>
    </div>
  )

  // STEP: UPLOAD DOCS
  if (step === 'upload') return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ background: '#18181B', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #222' }}>
        <button onClick={() => setStep('select')} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 20, cursor: 'pointer', padding: 0 }}>←</button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 1 }}>NEGOCIO #{selectedDeal?.negocio_num}</div>
          <div style={{ fontSize: 11, color: '#666' }}>Sube los documentos</div>
        </div>
      </div>
      <div style={{ padding: '24px 20px' }}>
        <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple onChange={e => e.target.files && scanDocs(e.target.files)} style={{ display: 'none' }} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" multiple onChange={e => e.target.files && scanDocs(e.target.files)} style={{ display: 'none' }} />

        {scanning ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#3B82F6' }}>Leyendo {scannedCount} documento{scannedCount !== 1 ? 's' : ''}...</div>
            <div style={{ fontSize: 13, color: '#555', marginTop: 8 }}>Extrayendo datos con IA</div>
          </div>
        ) : (
          <>
            <div style={{ padding: '14px 16px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: 10, marginBottom: 24, fontSize: 13, color: '#3B82F6' }}>
              Actualizando negocio <strong>#{selectedDeal?.negocio_num}</strong> — {selectedDeal?.cliente_nombre || 'Sin nombre'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
              <button onClick={() => cameraRef.current?.click()}
                style={{ padding: '24px', borderRadius: 14, border: '2px solid #222', background: '#111', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 16 }}>
                <span style={{ fontSize: 36 }}>📷</span>
                <div style={{ textAlign: 'left' as const }}>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>Tomar Foto</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>Usa la cámara</div>
                </div>
              </button>
              <button onClick={() => fileRef.current?.click()}
                style={{ padding: '24px', borderRadius: 14, border: '2px solid #222', background: '#111', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 16 }}>
                <span style={{ fontSize: 36 }}>🖼️</span>
                <div style={{ textAlign: 'left' as const }}>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>Desde Galería / PDF</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>Múltiples archivos</div>
                </div>
              </button>
            </div>
            <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
              {['📋 Factura de Venta', '📜 Certificado de Origen', '🪪 Cédula / RIF'].map(d => (
                <div key={d} style={{ padding: '10px 14px', background: '#111', borderRadius: 8, fontSize: 13, color: '#555' }}>{d}</div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )

  // STEP: REVIEW
  if (step === 'review') return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif', paddingBottom: 100 }}>
      <div style={{ background: '#18181B', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #222', position: 'sticky', top: 0, zIndex: 10 }}>
        <button onClick={() => setStep('upload')} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 20, cursor: 'pointer', padding: 0 }}>←</button>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900 }}>REVISAR DATOS — #{selectedDeal?.negocio_num}</div>
          <div style={{ fontSize: 11, color: '#666' }}>Corrige si es necesario</div>
        </div>
      </div>
      <div style={{ padding: '20px' }}>
        {error && <div style={{ background: 'rgba(187,22,43,0.15)', border: '1px solid #BB162B44', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#BB162B' }}>{error}</div>}

        {scanErrors.length > 0 && (
          <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#F59E0B', marginBottom: 4 }}>⚠ Errores al leer:</div>
            {scanErrors.map((e: string, i: number) => <div key={i} style={{ fontSize: 11, color: '#F59E0B' }}>{e}</div>)}
          </div>
        )}
        <div style={{ background: '#111', borderRadius: 12, padding: '16px', marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#BB162B', textTransform: 'uppercase' as const, letterSpacing: 2, marginBottom: 12 }}>🪪 Cliente</div>
          <Field label="Nombres" k="cliente_nombre" />
          <Field label="Apellidos" k="cliente_apellidos" />
          <Field label="Cédula/RIF" k="cliente_rif" />
          <Field label="Tipo (V/J/E/G)" k="cliente_rif_tipo" />
          <Field label="Estado Civil" k="cliente_estado_civil" />
          <Field label="Teléfono" k="cliente_telefono" />
          <Field label="Email" k="cliente_email" />
          <Field label="Dirección" k="cliente_direccion" />
        </div>

        <div style={{ background: '#111', borderRadius: 12, padding: '16px', marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#BB162B', textTransform: 'uppercase' as const, letterSpacing: 2, marginBottom: 12 }}>🚗 Vehículo</div>
          <Field label="Marca" k="vehiculo_marca" />
          <Field label="Modelo" k="vehiculo_modelo" />
          <Field label="Año Modelo" k="vehiculo_año" />
          <Field label="Año Fabricación" k="vehiculo_año_fabricacion" />
          <Field label="Color" k="vehiculo_color" />
          <Field label="Placa" k="vehiculo_placa" />
          <Field label="VIN / Serial Carrocería" k="vin" />
          <Field label="Serial Motor" k="serial_motor" />
          <Field label="Clase" k="vehiculo_clase" />
          <Field label="Uso" k="vehiculo_uso" />
          <Field label="Fecha Factura" k="fecha_factura" />
          <Field label="Precio Vehículo (USD)" k="precio_vehiculo" />
        </div>
      </div>
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, padding: '16px 20px', background: '#0A0A0A', borderTop: '1px solid #1a1a1a' }}>
        <button onClick={handleUpdate}
          style={{ width: '100%', padding: '16px', borderRadius: 12, border: 'none', background: '#3B82F6', color: '#fff', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>
          💾 Guardar Cambios en #{selectedDeal?.negocio_num}
        </button>
      </div>
    </div>
  )

  // SAVING
  if (step === 'saving') return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16 }}>
      💾 Guardando...
    </div>
  )

  // DONE
  return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ fontSize: 72, marginBottom: 16 }}>✅</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Negocio Actualizado</div>
      <div style={{ fontSize: 28, fontWeight: 900, color: '#3B82F6', marginBottom: 4 }}>#{selectedDeal?.negocio_num}</div>
      <div style={{ fontSize: 13, color: '#555', marginBottom: 32 }}>{extracted.cliente_nombre} {extracted.cliente_apellidos}</div>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12, width: '100%', maxWidth: 360 }}>
        <button onClick={() => { setStep('select'); setSelectedDeal(null); setFacturaInput(''); setExtracted({}) }}
          style={{ padding: '14px', borderRadius: 10, border: '1px solid #222', background: '#111', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>
          Actualizar otro negocio
        </button>
        <button onClick={onBack}
          style={{ padding: '14px', borderRadius: 10, border: 'none', background: '#BB162B', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>
          Inicio
        </button>
      </div>
    </div>
  )
}
export default function DeisiApp() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [deals, setDeals] = useState<any[]>([])
  const [screen, setScreen] = useState<'home' | 'nuevo' | 'ingreso' | 'actualizar' | 'success'>('home')
  const [lastCreated, setLastCreated] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    document.title = 'AutoCore Scan Docs'
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) { router.push('/'); return }
      setUser(data.user)
      const { data: ds } = await supabase.from('deals').select('id, negocio_num, cliente_nombre, pagos, total_recibido, tasa_bcv, status').order('created_at', { ascending: false })
      setDeals(ds || [])
      setLoading(false)
    })
  }, [])

  const refreshDeals = async () => {
    const { data: ds } = await supabase.from('deals').select('id, negocio_num, cliente_nombre, pagos, total_recibido, tasa_bcv, status').order('created_at', { ascending: false })
    setDeals(ds || [])
  }

  if (loading) return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#BB162B', fontSize: 28, fontWeight: 900, letterSpacing: 3 }}>KIA</div>
    </div>
  )

  if (screen === 'nuevo') return (
    <NewDealScanner
      user={user}
      onCreated={(deal) => { setLastCreated(deal); refreshDeals(); setScreen('success') }}
      onBack={() => setScreen('home')}
    />
  )

  if (screen === 'ingreso') return (
    <IngresoScanner
      user={user}
      deals={deals}
      preSelectedDeal={lastCreated || undefined}
      onBack={() => { setLastCreated(null); refreshDeals(); setScreen('home') }}
    />
  )

  if (screen === 'actualizar') return (
    <UpdateDealScanner
      user={user}
      deals={deals}
      onBack={() => { refreshDeals(); setScreen('home') }}
    />
  )

  if (screen === 'success') return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ fontSize: 72, marginBottom: 16 }}>🎉</div>
      <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 4 }}>Negocio Creado</div>
      <div style={{ fontSize: 28, fontWeight: 900, color: '#BB162B', marginBottom: 4 }}>#{lastCreated?.negocio_num}</div>
      <div style={{ fontSize: 14, color: '#555', marginBottom: 40 }}>{lastCreated?.cliente_nombre}</div>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12, width: '100%', maxWidth: 360 }}>
        <button onClick={async () => { await refreshDeals(); setScreen('ingreso') }}
          style={{ padding: '18px', borderRadius: 12, border: 'none', background: '#10B981', color: '#fff', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>
          📤 Subir Ingresos para este negocio
        </button>
        <button onClick={() => setScreen('home')}
          style={{ padding: '16px', borderRadius: 12, border: '1px solid #222', background: '#111', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          Volver al inicio
        </button>
      </div>
    </div>
  )

  // HOME
  return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{ background: '#18181B', padding: '20px 24px', borderBottom: '1px solid #1a1a1a' }}>
        <div style={{ fontSize: 11, color: '#555', letterSpacing: 2, textTransform: 'uppercase' as const, marginBottom: 4 }}>AutoCore</div>
        <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: 1 }}>
          KIA <span style={{ color: '#BB162B' }}>MARACAY</span>
        </div>
        <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>
          {user?.email}
        </div>
      </div>

      {/* Main buttons */}
      <div style={{ padding: '32px 24px' }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <button onClick={() => setScreen('nuevo')}
            style={{
              padding: '32px 24px', borderRadius: 16, border: 'none',
              background: 'linear-gradient(135deg, #BB162B, #8B0D1F)',
              color: '#fff', cursor: 'pointer', textAlign: 'left' as const,
              boxShadow: '0 8px 32px rgba(187,22,43,0.3)',
            }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: 0.5, marginBottom: 4 }}>Nuevo Negocio</div>
            <div style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.5 }}>
              Escanea Factura, Certificado de Origen y Cédula para crear el negocio automáticamente
            </div>
          </button>

          <button onClick={() => setScreen('ingreso')}
            style={{
              padding: '32px 24px', borderRadius: 16,
              border: '1px solid rgba(16,185,129,0.3)',
              background: 'linear-gradient(135deg, #1a3a2a, #0d2a1a)',
              color: '#fff', cursor: 'pointer', textAlign: 'left' as const,
            }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>💸</div>
            <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: 0.5, marginBottom: 4 }}>Subir Ingreso</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>
              Escanea comprobante de Zelle o Wire y asígnalo al negocio correspondiente
            </div>
          </button>
          <button onClick={() => setScreen('actualizar')}
            style={{
              padding: '24px', borderRadius: 16,
              border: '1px solid rgba(59,130,246,0.3)',
              background: 'linear-gradient(135deg, #1a2a3a, #0d1a2a)',
              color: '#fff', cursor: 'pointer', textAlign: 'left' as const,
              display: 'flex', alignItems: 'center', gap: 16,
            }}>
            <span style={{ fontSize: 32 }}>📁</span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 2 }}>Actualizar Negocio</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
                Agrega documentos a un negocio existente
              </div>
            </div>
          </button>
        </div>

        {deals.filter(d => d.status !== 'APROBADO').length > 0 && (
          <div style={{ marginTop: 32 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#444', textTransform: 'uppercase' as const, letterSpacing: 2, marginBottom: 12 }}>
              Negocios Abiertos
            </div>
            {deals.filter(d => d.status !== 'APROBADO').slice(0, 5).map(d => (
              <div key={d.id} style={{ padding: '12px 14px', background: '#111', borderRadius: 10, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>#{d.negocio_num}</span>
                  <span style={{ fontSize: 13, color: '#666', marginLeft: 8 }}>{d.cliente_nombre?.split(' ').slice(0, 2).join(' ')}</span>
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#10B981', fontFamily: 'monospace' }}>{fmt(d.total_recibido || 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '0 24px 32px', textAlign: 'center' as const }}>
        <button onClick={() => router.push('/auditoria')}
          style={{ background: 'none', border: 'none', color: '#333', fontSize: 12, cursor: 'pointer' }}>
          Ir a Auditoría completa →
        </button>
      </div>
    </div>
  )
}