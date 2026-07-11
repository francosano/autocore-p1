// TARGET: autocore-npa/app/scan/page.tsx
// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/scan/page.tsx
// Bank statement PDF scanner page (mobile PWA for Deisi on the floor)
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useState, useRef, useEffect } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import { upsertBankTxBatch } from '../lib/bankUpsert'

const CUENTAS = [
  { id: 'roframi',         label: 'Roframi BofA',       flag: '🇺🇸', color: '#3B82F6' },
  { id: 'roframi_regions', label: 'Roframi Regions',    flag: '🇺🇸', color: '#60A5FA' },
  { id: 'motocentro',      label: 'Motocentro II',      flag: '🇺🇸', color: '#BB162B' },
  { id: 'panama',          label: 'Panamá',             flag: '🇵🇦', color: '#10B981' },
  { id: 'bolivares',       label: 'Bolívares',          flag: '🇻🇪', color: '#F59E0B' },
]

interface TxResult {
  fecha: string | null
  monto_usd: number | null
  monto_bs: number | null
  sender_name: string | null
  referencia: string | null              // customer-facing ref (Conf#, SNDR REF)
  referencia_alt: string | null          // bank's internal TRN (less useful for matching)
  tipo: string | null                    // zelle | wire | ach | deposit | transfer_out | card_charge | bank_fee | other
  descripcion: string | null
  payment_memo: string | null            // PMT DET line, "Pago Sportage Mirian", etc.
  flujo: 'ingreso' | 'egreso' | null     // money in vs out
  is_internal: boolean                   // transfer between own accounts (VELROD, OLMOS etc.) — never match cobranza
  is_bank_fee: boolean                   // bank's own fee/commission — exclude from matching
  categoria_gasto: string | null         // for egresos: AI-suggested category
  proveedor: string | null               // for egresos: supplier name
}

interface ScanItem {
  id: string
  file: File
  preview: string
  status: 'pending' | 'reading' | 'done' | 'error'
  transactions: TxResult[]
  error?: string
}

export default function ScanPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [cuenta, setCuenta] = useState<string | null>(null)
  const [items, setItems] = useState<ScanItem[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [processing, setProcessing] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.push('/')
      else setUser(data.user)
      // PWA: never redirect away — stay on scan page
    })
  }, [])

  const readWithAI = async (item: ScanItem): Promise<TxResult[]> => {
    const base64 = await new Promise<string>((res, rej) => {
      const r = new FileReader()
      r.onload = ev => res((ev.target?.result as string).split(',')[1])
      r.onerror = rej
      r.readAsDataURL(item.file)
    })
    const isPdf = item.file.type === 'application/pdf' || item.file.name.endsWith('.pdf')
    const mediaType = isPdf ? 'application/pdf' : (item.file.type || 'image/jpeg')

    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }

    const res = await fetch('https://autocore-comprobante.sano-franco.workers.dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        // 32k output: a full monthly statement (100s of tx) fits in one reply.
        // 8000 truncated ~45+ tx statements -> stop_reason max_tokens error.
        max_tokens: 32000,
        messages: [{
          role: 'user',
          content: [
            contentBlock,
            {
              type: 'text',
              text: `You are parsing a bank statement (Motocentro / Roframi / Velrod / Yari / Olmos group of companies).
Extract EVERY transaction line. Respond with a JSON array. Each item:
{
  "fecha": "YYYY-MM-DD or null",
  "monto_usd": number or null,        // USD amount, always positive
  "monto_bs": number or null,         // bolivar amount, always positive
  "sender_name": "name of sender/payer/payee or null",
  "referencia": "CUSTOMER-FACING reference (Conf#, SNDR REF, No. de Referencia) or null",
  "referencia_alt": "bank's internal TRN/transaction number or null",
  "tipo": "zelle|wire|ach|deposit|transfer_out|card_charge|bank_fee|other",   // transfer_out ONLY when flujo=egreso; an incoming transfer is "wire" or "deposit"
  "descripcion": "short clean description (clean up bank noise)",
  "payment_memo": "PMT DET line, payment notes, or null  (e.g. 'PAGO Sportage Mirian')",
  "flujo": "ingreso (money IN) or egreso (money OUT) — REQUIRED",
  "is_internal": true|false,
  "is_bank_fee": true|false,
  "categoria_gasto": "for egresos only: KIA Distribuciones|Software|Servicios Públicos|Nómina|Comisión Bancaria|Tarjeta de Crédito|Otros or null",
  "proveedor": "for egresos only: supplier/payee name or null"
}

CRITICAL RULES:

1) is_internal = TRUE for any transfer between the company's own accounts. Signals:
   - "Mobile transfer from CHK XXXX" (BofA internal)
   - sender_name in: VELROD CORP, VELROD COMMERCE CORP, VELASQUEZ RODRIGUEZ RAFAEL, YARI CROES STEFANIE, YARI ENDER, OLMOS DOUGLAS, ZAMBRANO PAREDES BREINEL, SOLARTE ACEVEDO YOVANNY, MATERIALES SORRENTO, ROFRAMI, MOTOCENTRO
   ⚠️ MEDROD CORP / JAVIER MEDINA is a BANCARIZADOR (external money handler), NOT internal — deposits from MEDROD are is_internal=FALSE, flujo=ingreso, and will be matched to bancarización egresos.
   - "Transfer LACE INVESTIMENTS CORPORATION" (internal holding)
   These should NEVER match against customer cobranza payments.

   ⚠️ IMPORTANT: is_internal=TRUE does NOT mean flujo=egreso. Direction is independent:
   - "Mobile transfer FROM CHK XXXX"           → flujo=INGRESO (money IN from that account)
   - "Mobile transfer TO CHK XXXX"             → flujo=EGRESO  (money OUT to that account)
   - "Online Banking transfer from CHK XXXX"   → flujo=INGRESO
   - "Online Banking transfer to CHK XXXX"     → flujo=EGRESO
   ALWAYS check the amount sign and the from/to keyword. A positive amount or no minus sign on a "transfer from" line = ingreso. Statements like Bank of America list internal transfers in the same column as customer payments; the only signal for direction is the from/to wording and the +/- sign on the amount.

2) is_bank_fee = TRUE for:
   - "Wire Transfer Fee", "Service fees"
   - Mercantil Panamá's "INT Comision Trnsf-XXXX" and "INT ITBMS P/COMISIONES/TRANSFEREN" lines
   - Any "COMI." or "COMISION" small fixed-amount line
   - "Prfd Rwds for Bus-Book Credit Fee Waiver" (these are $0 but mark as fees)
   These won't match cobranza.

3) For Bank of America wire-ins:
   - referencia = SNDR REF (the customer/sender's reference)
   - referencia_alt = TRN (BofA's internal)
   Example: "WIRE TYPE:BOOK IN ... TRN:2026041300404397 SNDR REF:607147364 ORIG:1/JALEO FOOD SERVICES COR"
   → referencia: "607147364", referencia_alt: "2026041300404397", sender_name: "JALEO FOOD SERVICES COR", flujo: "ingreso"

4) For Zelle payments:
   - referencia = the Conf# (after "Conf#")
   - sender_name = the name after "Zelle payment from"
   - tipo = "zelle"
   Example: "Zelle payment from CARMEN HERNANDEZ DE DE STEFANO Conf# fmhgc69dt"
   → referencia: "fmhgc69dt", sender_name: "CARMEN HERNANDEZ DE DE STEFANO", flujo: "ingreso"
   - If the note has a "for" clause, extract it: 'Zelle payment from MARIA DELGADO for "Pago"; Conf# Xx8dVzwwt'
   → payment_memo: "Pago"

5) For Mercantil Panama:
   - "INT MEDROD CORP MEDROD CORP" + Crédito = ingreso from MEDROD (internal)
   - "ACH--VENEKIA DISTRIBUCIONES CA BANESCO" + Débito = egreso to KIA distributor
     → categoria_gasto: "KIA Distribuciones", proveedor: "VENEKIA DISTRIBUCIONES CA"

6) For card purchases (CHECKCARD ... ):
   - tipo = "card_charge", flujo = "egreso"
   - sender_name = the merchant (e.g. "SUPABASE SINGAPORE")
   - categoria_gasto: best guess. SUPABASE → "Software". NIC SUNBIZ → "Servicios Públicos" (state filing).

7) For wire outs to KIA / VENEKIA:
   - flujo: "egreso", tipo: "wire", categoria_gasto: "KIA Distribuciones", proveedor: BNF name
   Example: "WIRE TYPE:INTL OUT ... BNF:VENEKIA DISTRIBUCIONES CA"

8) Amount: always POSITIVE in monto_usd/monto_bs. Sign is encoded in 'flujo'.
   - Statements show débito column for outflows, crédito column for inflows
   - BofA shows withdrawals as "-247,394.73" → store as 247394.73 with flujo='egreso'

9) Always set flujo. Never null. Direction signals (in priority order):
   a) Amount sign on the statement line:  "-$7,350.00" → egreso · "$7,350.00" / "+$7,350.00" → ingreso
   b) Column the amount appears in:  débito/withdrawal column → egreso · crédito/deposit column → ingreso
   c) Available-balance delta:  if running balance went UP after this row → ingreso · DOWN → egreso
   d) Keyword in description: "from / payment from / deposit / credit / received" → ingreso · "to / payment to / withdrawal / debit / sent / wire out" → egreso
   Apply (a)-(d) even for internal transfers, card charges, and fee lines. NEVER assume direction from tipo alone — a "transfer" or "wire" can be either ingreso or egreso.

Respond ONLY with the JSON array, no markdown, no other text.
If no transactions visible (it's a summary page, cover page, or instructions): return [].`
            }
          ]
        }]
      })
    })
    const data = await res.json()

    // ★ Detect truncation FIRST — Claude cuts JSON mid-stream if it hits
    //   max_tokens. Parsing that incomplete string fails silently and shows
    //   a useless "Error al leer" to Deisi. Now we tell her the real reason.
    if (data.stop_reason === 'max_tokens') {
      throw new Error('Demasiadas transacciones en este PDF. Divide el estado de cuenta en archivos más pequeños (ej: por quincena) y súbelos por separado.')
    }
    // Claude can also return an error object from the Anthropic API
    if (data.type === 'error' || data.error) {
      throw new Error('La IA no pudo leer el archivo: ' + (data.error?.message || data.error || 'error desconocido'))
    }

    const text = data.content?.[0]?.text || '[]'
    const clean = text.replace(/```json|```/g, '').trim()
    try {
      return JSON.parse(clean)
    } catch (parseErr) {
      // If parse fails, it's because the AI returned prose instead of JSON
      // (e.g., "I'm unable to extract transactions from this document"). Give
      // Deisi a hint about what the AI actually said so she can decide what
      // to do (try a different PDF, reshoot the photo, etc.)
      const snippet = clean.slice(0, 150).replace(/\n/g, ' ')
      throw new Error('La IA no respondió en formato JSON. Respuesta: "' + snippet + (clean.length > 150 ? '..."' : '"'))
    }
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || !cuenta) return
    const newItems: ScanItem[] = Array.from(files).slice(0, 20).map(file => ({
      id: `${file.name}-${Date.now()}-${Math.random()}`,
      file,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
      status: 'pending' as const,
      transactions: [],
    }))
    setItems(prev => [...prev, ...newItems])
    setProcessing(true)

    for (const item of newItems) {
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'reading' } : i))
      try {
        const txs = await readWithAI(item)
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'done', transactions: txs } : i))
      } catch (e: any) {
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'error', error: e.message } : i))
      }
    }
    setProcessing(false)
  }

  const removeItem = (id: string) => setItems(prev => prev.filter(i => i.id !== id))

  // Carry each parent file's type onto its transactions so handleSave can
  // classify the ingest source (PDF statement vs image screenshot).
  const isPdfItem = (it: ScanItem) =>
    it.file.type === 'application/pdf' || it.file.name.toLowerCase().endsWith('.pdf')
  const allTransactions = items
    .filter(i => i.status === 'done')
    .flatMap(i => i.transactions.map(t => ({ ...t, _isPdf: isPdfItem(i) })))
  const totalUSD = allTransactions.reduce((s, t) => s + (t.monto_usd || 0), 0)
  // Subset that will be available for cobranza matching (excludes internal + bank fees + outflows)
  const matchableTxs = allTransactions.filter(t => !t.is_internal && !t.is_bank_fee && t.flujo === 'ingreso')
  const matchableTotal = matchableTxs.reduce((s, t) => s + (t.monto_usd || 0), 0)

  const handleSave = async () => {
    if (!cuenta) { alert('Error: selecciona una cuenta primero.'); return }
    if (allTransactions.length === 0) { alert('Error: no hay transacciones extraídas para guardar.'); return }
    if (!user) {
      alert('Error: sesión no iniciada. Recarga la página.');
      // Try once to recover
      const { data } = await supabase.auth.getUser()
      if (data?.user) {
        setUser(data.user)
        alert('Sesión recuperada. Intenta guardar de nuevo.')
      }
      return
    }
    setSaving(true)

    // Build BankTxInput rows. Each transaction carries _isPdf from its parent
    // file → PDF = bank statement, image = Zelle receipt screenshot.
    const inputs = allTransactions.map(tx => ({
      cuenta: cuenta!,
      fecha: tx.fecha || null,
      monto_usd: tx.monto_usd || null,
      monto_bs: tx.monto_bs || null,
      sender_name: tx.sender_name || null,
      referencia: tx.referencia || null,
      referencia_alt: tx.referencia_alt || null,
      tipo: tx.tipo || 'other',
      descripcion: tx.descripcion || null,
      payment_memo: tx.payment_memo || null,
      raw_text: JSON.stringify(tx),
      flujo: tx.flujo || null,
      is_third_party: false,
      is_internal: tx.is_internal === true,
      is_bank_fee: tx.is_bank_fee === true,
      categoria_gasto: tx.flujo === 'egreso' ? (tx.categoria_gasto || null) : null,
      proveedor: tx.flujo === 'egreso' ? (tx.proveedor || null) : null,
      es_compra_unidades: tx.flujo === 'egreso' && /venekia/i.test(tx.proveedor || tx.sender_name || ''),
      compra_proveedor: tx.flujo === 'egreso' && /venekia/i.test(tx.proveedor || tx.sender_name || '') ? (tx.proveedor || 'VENEKIA DISTRIBUCIONES CA') : null,
      // Origin source string. Keep 'screenshot' literal for image receipts to
      // match historical data; statements get 'pdf_statement'.
      source: tx._isPdf ? 'pdf_statement' : 'screenshot',
      uploaded_by: user.id,
      _isPdf: tx._isPdf,
    }))

    // Split by ingest source so each batch sets the correct seen_in_* flag.
    const statementInputs = inputs.filter(r => r._isPdf).map(({ _isPdf, ...r }) => r)
    const screenshotInputs = inputs.filter(r => !r._isPdf).map(({ _isPdf, ...r }) => r)

    try {
      const s1 = statementInputs.length
        ? await upsertBankTxBatch(statementInputs, 'statement')
        : { inserted: 0, merged: 0, errors: 0, results: [], errorDetails: [] }
      const s2 = screenshotInputs.length
        ? await upsertBankTxBatch(screenshotInputs, 'screenshot')
        : { inserted: 0, merged: 0, errors: 0, results: [], errorDetails: [] }

      const inserted = s1.inserted + s2.inserted
      const merged = s1.merged + s2.merged
      const errors = s1.errors + s2.errors
      const errDetails = [...s1.errorDetails, ...s2.errorDetails]

      if (errors > 0) {
        console.error('[scan] upsert errors:', errDetails)
        alert(`Se guardaron ${inserted + merged} transacciones (${inserted} nuevas, ${merged} fusionadas). ${errors} con error:\n` + errDetails.slice(0, 3).join('\n'))
      }

      setSaving(false)
      setSaved(true)
      if (merged > 0) {
        setTimeout(() => alert(`${inserted} transacciones nuevas guardadas. ${merged} fusionadas con registros existentes (ya vistas por otra fuente).`), 100)
      }
      setTimeout(() => { setItems([]); setCuenta(null); setSaved(false) }, 2500)
    } catch (e: any) {
      console.error('[scan] save failed:', e)
      alert('Error al guardar: ' + (e?.message || String(e)))
      setSaving(false)
    }
  }

  // ── PWA meta ──
  useEffect(() => {
    document.title = 'AutoCore Scan'
    const meta = document.createElement('meta')
    meta.name = 'apple-mobile-web-app-capable'
    meta.content = 'yes'
    document.head.appendChild(meta)
    const meta2 = document.createElement('meta')
    meta2.name = 'apple-mobile-web-app-status-bar-style'
    meta2.content = 'black-translucent'
    document.head.appendChild(meta2)
  }, [])

  const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  if (saved) return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 64 }}>✅</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: '#fff' }}>{allTransactions.length} transacciones guardadas</div>
      <div style={{ fontSize: 14, color: '#10B981' }}>{fmt(matchableTotal)} disponible para conciliar</div>
      <div style={{ fontSize: 12, color: '#666', marginTop: 8 }}>Conciliando con ingresos pendientes en /banco...</div>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: '#0A0A0A', color: '#fff', fontFamily: 'system-ui, sans-serif', paddingBottom: 100 }}>

      {/* Header */}
      <div style={{ background: '#BB162B', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 100 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 2 }}>AUTOCORE</div>
          <div style={{ fontSize: 11, opacity: 0.8, letterSpacing: 1 }}>BANK SCAN</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => router.push('/banco')} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>
            📊 Banco
          </button>
          <button onClick={() => router.push('/dashboard')} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>
            NPA →
          </button>
        </div>
      </div>

      <div style={{ padding: '20px 16px' }}>

        {/* Account selector */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 12 }}>Seleccionar Cuenta</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {CUENTAS.map(c => (
              <button key={c.id} onClick={() => { setCuenta(c.id); setItems([]) }}
                style={{
                  padding: '16px 12px', borderRadius: 12, border: `2px solid ${cuenta === c.id ? c.color : '#222'}`,
                  background: cuenta === c.id ? c.color + '22' : '#111',
                  color: cuenta === c.id ? c.color : '#888', cursor: 'pointer',
                  textAlign: 'left', transition: 'all 0.15s',
                }}>
                <div style={{ fontSize: 22, marginBottom: 6 }}>{c.flag}</div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{c.label}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Upload area */}
        {cuenta && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 12 }}>
              {CUENTAS.find(c => c.id === cuenta)?.label}
            </div>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple onChange={e => handleFiles(e.target.files)} style={{ display: 'none' }} />
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={e => handleFiles(e.target.files)} style={{ display: 'none' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
              <button onClick={() => cameraRef.current?.click()} disabled={processing}
                style={{ padding: '22px 16px', borderRadius: 14, border: '2px dashed #333', background: '#111', color: '#fff', cursor: 'pointer', textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📷</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>Cámara</div>
                <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>Tomar foto</div>
              </button>
              <button onClick={() => fileRef.current?.click()} disabled={processing}
                style={{ padding: '22px 16px', borderRadius: 14, border: '2px dashed #333', background: '#111', color: '#fff', cursor: 'pointer', textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🖼️</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>Galería / PDF</div>
                <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>Múltiples archivos</div>
              </button>
            </div>
          </div>
        )}

        {/* Items list */}
        {items.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 12 }}>
              {items.length} archivo{items.length !== 1 ? 's' : ''} — {allTransactions.length} transacciones
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {items.map(item => (
                <div key={item.id} style={{
                  background: '#111', borderRadius: 12,
                  border: `1px solid ${item.status === 'done' ? '#10B98133' : item.status === 'error' ? '#BB162B33' : '#222'}`,
                  overflow: 'hidden',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                    {item.preview
                      ? <img src={item.preview} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} />
                      : <div style={{ width: 48, height: 48, background: '#222', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>📄</div>
                    }
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 4 }}>{item.file.name}</div>
                      {item.status === 'reading' && <div style={{ fontSize: 13, color: '#3B82F6' }}>⏳ Leyendo con IA...</div>}
                      {item.status === 'error' && (
                        <div style={{ fontSize: 12, color: '#BB162B', lineHeight: 1.4 }}>
                          ✕ {item.error || 'Error al leer'}
                        </div>
                      )}
                      {item.status === 'done' && (
                        <div style={{ fontSize: 13, color: '#10B981', fontWeight: 700 }}>
                          ✓ {item.transactions.length} transacción{item.transactions.length !== 1 ? 'es' : ''}
                          {item.transactions[0]?.monto_usd ? ` · ${fmt(item.transactions.reduce((s, t) => s + (t.monto_usd || 0), 0))}` : ''}
                        </div>
                      )}
                    </div>
                    <button onClick={() => removeItem(item.id)} style={{ background: 'none', border: 'none', color: '#444', cursor: 'pointer', fontSize: 18, padding: 4 }}>✕</button>
                  </div>
                  {/* Transaction details */}
                  {item.status === 'done' && item.transactions.length > 0 && (
                    <div style={{ borderTop: '1px solid #222', padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {item.transactions.map((tx, i) => {
                        const isOut = tx.flujo === 'egreso'
                        const skipMatch = tx.is_internal || tx.is_bank_fee
                        return (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 0', borderBottom: i < item.transactions.length - 1 ? '1px solid #1a1a1a' : 'none', opacity: skipMatch ? 0.5 : 1 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: isOut ? '#BB162B33' : '#10B98133', color: isOut ? '#FCA5A5' : '#86EFAC', fontWeight: 700 }}>
                                  {isOut ? 'OUT' : 'IN'}
                                </span>
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tx.sender_name || tx.proveedor || 'Sin nombre'}</span>
                                {tx.is_internal && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: '#33333355', color: '#888' }}>Interno</span>}
                                {tx.is_bank_fee && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: '#33333355', color: '#888' }}>Comisión</span>}
                                {tx.categoria_gasto && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: '#F59E0B33', color: '#FBBF24' }}>{tx.categoria_gasto}</span>}
                              </div>
                              <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
                                {tx.tipo?.toUpperCase()} {tx.fecha ? `· ${tx.fecha}` : ''} {tx.referencia ? `· Ref: ${tx.referencia}` : ''}
                              </div>
                              {tx.payment_memo && (
                                <div style={{ fontSize: 11, color: '#888', marginTop: 2, fontStyle: 'italic' }}>📝 {tx.payment_memo}</div>
                              )}
                            </div>
                            <div style={{ fontSize: 14, fontWeight: 900, color: isOut ? '#FCA5A5' : '#10B981', fontFamily: 'monospace', flexShrink: 0, marginLeft: 8 }}>
                              {isOut ? '-' : ''}{tx.monto_usd ? fmt(tx.monto_usd) : tx.monto_bs ? `Bs ${tx.monto_bs}` : '—'}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Summary + Save */}
        {allTransactions.length > 0 && (
          <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, padding: '16px', background: '#0A0A0A', borderTop: '1px solid #222' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 1 }}>Para conciliar</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: '#10B981', fontFamily: 'monospace' }}>{fmt(matchableTotal)}</div>
                <div style={{ fontSize: 11, color: '#555' }}>
                  {matchableTxs.length} ingreso{matchableTxs.length !== 1 ? 's' : ''} de {allTransactions.length} totales
                  {allTransactions.length !== matchableTxs.length && ` · ${fmt(totalUSD)} bruto`}
                </div>
              </div>
              <button onClick={handleSave} disabled={saving || processing}
                style={{
                  padding: '14px 28px', borderRadius: 12, border: 'none',
                  background: saving || processing ? '#333' : '#BB162B',
                  color: '#fff', fontSize: 15, fontWeight: 800, cursor: 'pointer',
                  letterSpacing: 1,
                }}>
                {saving ? 'Guardando...' : processing ? 'Procesando...' : '💾 Guardar'}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}