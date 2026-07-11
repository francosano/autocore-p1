// TARGET: autocore-npa/scripts/import-inventario-seed.mjs
// ═══════════════════════════════════════════════════════════════════════════
// AutoCore NPA — Inventario pipeline seed import (from 2026_Inventario_Kia.xlsx
// extract). DRY-RUN BY DEFAULT: prints a full preview and exits without
// writing. Pass --commit to actually insert.
//
// Usage:
//   node scripts/import-inventario-seed.mjs [path/to/seed_inventario_pipeline.csv]
//   node scripts/import-inventario-seed.mjs seed.csv --commit
//   node scripts/import-inventario-seed.mjs seed.csv --commit --force   (skip empty-table guard)
//   node scripts/import-inventario-seed.mjs seed.csv --sql
//       → writes supabase/seed_inventario_pipeline.sql (INSERT statements for
//         the Supabase SQL editor; alternative to --commit when no service
//         key is at hand). Run-once: the pedidos INSERTs are not idempotent.
//
// Env (only required with --commit):
//   SUPABASE_URL               (falls back to NEXT_PUBLIC_SUPABASE_URL, then project URL)
//   SUPABASE_SERVICE_ROLE_KEY  (never hardcoded — service role bypasses RLS)
//
// Normalization rules:
//   • Spanish month names → first-of-month ISO dates. Bare month names carry
//     no year: SEP–DIC are inferred as 2025, ENE–AGO as 2026 (matches the
//     proforma sequence 00-0041 SEPTIEMBRE=2025 → 00-0087 JULIO=2026).
//     Raw text is always preserved in proformas.fecha_pedido_texto.
//   • estados trimmed/uppercased, spaces → underscores ('POR RECIBIR' →
//     'POR_RECIBIR', 'NO CONFIRMADO' → 'NO_CONFIRMADO'); blank estado_unidad
//     → POR_RECIBIR; blank estado_pedido → CONFIRMADO.
//   • placa must match ^[A-Z]{2}[0-9]{3}[A-Z]{2}$; failures (and duplicates)
//     are imported with placa=NULL and the original value appended to notas —
//     never silently dropped, never inserted with a bad placa.
//   • Proformas derived from distinct non-empty proforma_nro; abono summed
//     per proforma; total_proforma = sum of its units' costo_proforma.
//   • Proforma-less rows (ECUADOR) keep their raw fecha_pedido in notas.
//   • Every insert row carries EVERY column key explicitly (supabase-js sends
//     missing keys as explicit NULL and bypasses column defaults).
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const PLACA_RE = /^[A-Z]{2}[0-9]{3}[A-Z]{2}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const MONTHS = {
  ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6,
  JULIO: 7, AGOSTO: 8, SEPTIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12,
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const COMMIT = args.includes('--commit')
const FORCE = args.includes('--force')
const SQL_OUT = args.includes('--sql')
const csvPath = args.find(a => !a.startsWith('--')) || './seed_inventario_pipeline.csv'

// ─── CSV parser (handles quoted fields with embedded commas) ────────────────
function parseCSV(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f.trim() !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(f => f.trim() !== '')) rows.push(row)
  return rows
}

// ─── Normalizers ─────────────────────────────────────────────────────────────
const clean = v => (v ?? '').trim()
const upper = v => clean(v).toUpperCase()
const num = v => {
  const c = clean(v)
  if (c === '') return null
  const n = Number(c)
  return isNaN(n) ? null : n
}

// 'Enero 2026' / 'SEPTIEMBRE' / '2025-04-21' → ISO first-of-month (or null)
function parseFechaPedido(raw) {
  const c = upper(raw)
  if (c === '') return null
  if (ISO_DATE_RE.test(c)) return c
  const m = c.match(/^([A-ZÁÉÍÓÚÑ]+)\s*(\d{4})?$/)
  if (!m) return null
  const month = MONTHS[m[1]]
  if (!month) return null
  // Bare month names: SEP–DIC belong to 2025, ENE–AGO to 2026 (sheet spans
  // Sep 2025 → Jul 2026). Explicit year wins when present.
  const year = m[2] ? Number(m[2]) : (month >= 9 ? 2025 : 2026)
  return `${year}-${String(month).padStart(2, '0')}-01`
}

function normEstadoUnidad(raw) {
  const c = upper(raw).replace(/\s+/g, '_')
  if (c === '') return 'POR_RECIBIR'
  return c
}
function normEstadoPedido(raw) {
  const c = upper(raw).replace(/\s+/g, '_')
  if (c === '') return 'CONFIRMADO'
  return c
}
function normEstadoVenta(raw) {
  const c = upper(raw).replace(/\s+/g, '_')
  if (c === '') return 'PIPELINE'
  return c
}

const ESTADOS_UNIDAD = new Set(['POR_RECIBIR', 'EN_TRANSITO', 'RECIBIDO'])
const ESTADOS_VENTA = new Set(['PIPELINE', 'DISPONIBLE', 'RESERVADO', 'VENDIDO'])

// ─── Load + parse ────────────────────────────────────────────────────────────
let text
try { text = readFileSync(csvPath, 'utf8') } catch (e) {
  console.error(`ERROR: cannot read CSV at ${csvPath}: ${e.message}`)
  process.exit(1)
}
if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1) // strip BOM

const rows = parseCSV(text)
const header = rows.shift().map(h => clean(h))
const col = name => {
  const i = header.indexOf(name)
  if (i === -1) { console.error(`ERROR: CSV missing column '${name}'`); process.exit(1) }
  return i
}
const IDX = {
  canal: col('canal'), proforma_nro: col('proforma_nro'), fecha_pedido: col('fecha_pedido'),
  mes_estimado: col('mes_estimado_recepcion'), modelo: col('modelo'), color: col('color'),
  placa: col('placa'), costo_proforma: col('costo_proforma'), costo_factura: col('costo_factura'),
  abono: col('abono'), saldo_restante: col('saldo_restante'), estado_pedido: col('estado_pedido'),
  estado_unidad: col('estado_unidad'), estado_venta: col('estado_venta'), vendedor: col('vendedor'),
  cliente_reserva: col('cliente_reserva'), fecha_reserva: col('fecha_reserva'), fila_hoja: col('fila_hoja'),
}

// ─── Transform ───────────────────────────────────────────────────────────────
const problems = { badPlaca: [], dupPlaca: [], missingModelo: [], badEstado: [], anomalies: [] }
const proformaMap = new Map() // nro → { nro, canal, fecha_pedido, fecha_pedido_texto, abono, total, count }
const pedidos = []
const seenPlacas = new Set()

for (const r of rows) {
  const fila = clean(r[IDX.fila_hoja]) || '?'
  const canal = upper(r[IDX.canal]) || 'NA'
  const nro = clean(r[IDX.proforma_nro])
  const fechaPedidoRaw = clean(r[IDX.fecha_pedido])
  const modelo = upper(r[IDX.modelo])
  const notas = [`[hoja fila ${fila}]`]

  if (!modelo) {
    problems.missingModelo.push({ fila, raw: r.join(',').slice(0, 120) })
    continue
  }

  // placa validation — never silently dropped, never inserted invalid
  let placa = upper(r[IDX.placa]) || null
  if (placa) {
    if (!PLACA_RE.test(placa)) {
      problems.badPlaca.push({ fila, modelo, placa })
      notas.push(`PLACA ORIGINAL (formato invalido): ${placa}`)
      placa = null
    } else if (seenPlacas.has(placa)) {
      problems.dupPlaca.push({ fila, modelo, placa })
      notas.push(`PLACA ORIGINAL (duplicada en hoja): ${placa}`)
      placa = null
    } else {
      seenPlacas.add(placa)
    }
  }

  const estado_pedido = normEstadoPedido(r[IDX.estado_pedido])
  const estado_unidad = normEstadoUnidad(r[IDX.estado_unidad])
  const estado_venta = normEstadoVenta(r[IDX.estado_venta])
  if (!ESTADOS_UNIDAD.has(estado_unidad) || !ESTADOS_VENTA.has(estado_venta)) {
    problems.badEstado.push({ fila, modelo, estado_unidad, estado_venta })
    continue
  }

  const vendedor = upper(r[IDX.vendedor]) || null
  const cliente = upper(r[IDX.cliente_reserva]) || null
  let fecha_reserva = clean(r[IDX.fecha_reserva]) || null
  if (fecha_reserva && !ISO_DATE_RE.test(fecha_reserva)) {
    notas.push(`FECHA RESERVA ORIGINAL: ${fecha_reserva}`)
    fecha_reserva = null
  }
  if ((vendedor || cliente) && estado_venta !== 'RESERVADO') {
    problems.anomalies.push({ fila, modelo, detalle: `vendedor/cliente presente con estado_venta=${estado_venta} (vendedor=${vendedor || '-'}, cliente=${cliente || '-'})` })
  }

  // Proforma derivation (only when nro present)
  const abono = num(r[IDX.abono])
  const costo_proforma = num(r[IDX.costo_proforma])
  if (nro) {
    if (!proformaMap.has(nro)) {
      proformaMap.set(nro, {
        nro, canal,
        fecha_pedido: parseFechaPedido(fechaPedidoRaw),
        fecha_pedido_texto: fechaPedidoRaw || null,
        abonado: 0, total_proforma: 0, unidades: 0,
      })
    }
    const pf = proformaMap.get(nro)
    if (pf.canal !== canal) problems.anomalies.push({ fila, modelo, detalle: `proforma ${nro}: canal ${canal} difiere del primero (${pf.canal})` })
    if (abono != null) pf.abonado += abono
    if (costo_proforma != null) pf.total_proforma += costo_proforma
    pf.unidades += 1
  } else {
    // proforma-less (ECUADOR): keep the raw order date, otherwise it is lost
    if (fechaPedidoRaw) notas.push(`FECHA PEDIDO: ${fechaPedidoRaw}`)
    if (abono != null) problems.anomalies.push({ fila, modelo, detalle: `abono ${abono} en fila sin proforma — NO importado` })
  }

  pedidos.push({
    _fila: fila,
    _proforma_nro: nro || null,
    canal,
    modelo,
    color: upper(r[IDX.color]) || null,
    placa,
    costo_proforma,
    costo_factura: num(r[IDX.costo_factura]),
    mes_estimado_recepcion: upper(r[IDX.mes_estimado]) || null,
    fecha_recepcion: null, // unknown for historic rows; set by the UI going forward
    estado_pedido,
    estado_unidad,
    estado_venta,
    vendedor,
    cliente_reserva: cliente,
    fecha_reserva,
    deal_id: null, // linked later by 008_sync_vendidos_from_deals.sql
    notas: notas.join(' | '),
  })
}

// ─── Preview ─────────────────────────────────────────────────────────────────
const countBy = (list, fn) => {
  const m = {}
  for (const x of list) { const k = fn(x); m[k] = (m[k] || 0) + 1 }
  return m
}
const pad = (v, n) => String(v ?? '').padEnd(n)

console.log('═'.repeat(76))
console.log(`SEED IMPORT PREVIEW — ${csvPath}`)
console.log('═'.repeat(76))
console.log(`Filas CSV leidas:      ${rows.length}`)
console.log(`Pedidos a importar:    ${pedidos.length}`)
console.log(`Proformas derivadas:   ${proformaMap.size}`)
console.log('')
console.log('Por canal:        ', JSON.stringify(countBy(pedidos, p => p.canal)))
console.log('Por estado_venta: ', JSON.stringify(countBy(pedidos, p => p.estado_venta)))
console.log('Por estado_unidad:', JSON.stringify(countBy(pedidos, p => p.estado_unidad)))
console.log('Por estado_pedido:', JSON.stringify(countBy(pedidos, p => p.estado_pedido)))
console.log('')
console.log('PROFORMAS:')
console.log(`  ${pad('nro', 10)}${pad('canal', 9)}${pad('fecha', 12)}${pad('texto', 16)}${pad('unids', 7)}${pad('total', 12)}abonado`)
for (const pf of proformaMap.values()) {
  console.log(`  ${pad(pf.nro, 10)}${pad(pf.canal, 9)}${pad(pf.fecha_pedido, 12)}${pad(pf.fecha_pedido_texto, 16)}${pad(pf.unidades, 7)}${pad(pf.total_proforma.toFixed(2), 12)}${pf.abonado.toFixed(2)}`)
}
const sinProforma = pedidos.filter(p => !p._proforma_nro).length
console.log(`  (sin proforma: ${sinProforma} pedidos)`)

const section = (title, list, fmt) => {
  console.log('')
  console.log(`${title}: ${list.length}`)
  for (const x of list) console.log('  - ' + fmt(x))
}
section('PLACAS INVALIDAS (importadas con placa=NULL + nota)', problems.badPlaca, x => `fila ${x.fila} · ${x.modelo} · "${x.placa}"`)
section('PLACAS DUPLICADAS (segunda ocurrencia → NULL + nota)', problems.dupPlaca, x => `fila ${x.fila} · ${x.modelo} · "${x.placa}"`)
section('FILAS SIN MODELO (EXCLUIDAS)', problems.missingModelo, x => `fila ${x.fila} · ${x.raw}`)
section('ESTADOS INVALIDOS (EXCLUIDAS)', problems.badEstado, x => `fila ${x.fila} · ${x.modelo} · unidad=${x.estado_unidad} venta=${x.estado_venta}`)
section('ANOMALIAS (importadas tal cual, revisar)', problems.anomalies, x => `fila ${x.fila} · ${x.modelo} · ${x.detalle}`)
console.log('')

// ─── SQL output mode (paste into the Supabase SQL editor) ───────────────────
if (SQL_OUT) {
  const q = v => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`
  const n = v => v == null ? 'NULL' : String(v)

  const lines = []
  lines.push('-- TARGET: autocore-npa/supabase/seed_inventario_pipeline.sql')
  lines.push('-- GENERATED by scripts/import-inventario-seed.mjs --sql — do not edit by hand.')
  lines.push('-- RUN ONCE. Before running, confirm the tables are empty:')
  lines.push('--   select (select count(*) from proformas) as proformas,')
  lines.push('--          (select count(*) from inventory_pedidos) as pedidos;')
  lines.push('-- The proformas INSERT is idempotent (on conflict do nothing);')
  lines.push('-- the pedidos INSERTs are NOT — a second run duplicates pipeline rows.')
  lines.push('')
  lines.push('-- ── 1/2: proformas ──')
  lines.push('insert into public.proformas (nro, canal, fecha_pedido, fecha_pedido_texto, total_proforma, abonado, notas) values')
  lines.push([...proformaMap.values()].map(pf =>
    `  (${q(pf.nro)}, ${q(pf.canal)}, ${q(pf.fecha_pedido)}, ${q(pf.fecha_pedido_texto)}, ${pf.total_proforma.toFixed(2)}, ${pf.abonado.toFixed(2)}, NULL)`
  ).join(',\n') + '\non conflict (nro) do nothing;')
  lines.push('')
  lines.push('-- ── 2/2: pedidos ──')
  lines.push('insert into public.inventory_pedidos')
  lines.push('  (proforma_id, canal, modelo, color, placa, costo_proforma, costo_factura,')
  lines.push('   mes_estimado_recepcion, fecha_recepcion, estado_pedido, estado_unidad,')
  lines.push('   estado_venta, vendedor, cliente_reserva, fecha_reserva, deal_id, notas) values')
  lines.push(pedidos.map(p => {
    const pfId = p._proforma_nro
      ? `(select id from public.proformas where nro = ${q(p._proforma_nro)})`
      : 'NULL'
    return `  (${pfId}, ${q(p.canal)}, ${q(p.modelo)}, ${q(p.color)}, ${q(p.placa)}, ${n(p.costo_proforma)}, ${n(p.costo_factura)}, ${q(p.mes_estimado_recepcion)}, ${q(p.fecha_recepcion)}, ${q(p.estado_pedido)}, ${q(p.estado_unidad)}, ${q(p.estado_venta)}, ${q(p.vendedor)}, ${q(p.cliente_reserva)}, ${q(p.fecha_reserva)}, ${n(p.deal_id)}, ${q(p.notas)})`
  }).join(',\n') + ';')
  lines.push('')

  const outPath = 'supabase/seed_inventario_pipeline.sql'
  writeFileSync(outPath, lines.join('\n'), 'utf8')
  console.log(`SQL escrito en ${outPath} (${proformaMap.size} proformas, ${pedidos.length} pedidos).`)
  process.exit(0)
}

if (!COMMIT) {
  console.log('DRY RUN — no se escribio nada. Ejecuta con --commit para insertar.')
  process.exit(0)
}

// ─── Commit ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL
  || process.env.NEXT_PUBLIC_SUPABASE_URL
  || 'https://xwyiatmeyonodgncobps.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY no definida en el entorno.')
  process.exit(1)
}
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const fail = (msg, error) => {
  console.error(`ERROR: ${msg}${error ? ' — ' + error.message : ''}`)
  process.exit(1)
}

// Guard: refuse to seed into non-empty tables (re-run safety) unless --force.
{
  const { count: cP, error: eP } = await db.from('proformas').select('*', { count: 'exact', head: true })
  if (eP) fail('no se pudo contar proformas', eP)
  const { count: cU, error: eU } = await db.from('inventory_pedidos').select('*', { count: 'exact', head: true })
  if (eU) fail('no se pudo contar inventory_pedidos', eU)
  if ((cP || 0) > 0 || (cU || 0) > 0) {
    if (!FORCE) fail(`las tablas no estan vacias (proformas=${cP}, inventory_pedidos=${cU}). Usa --force para insertar de todos modos.`)
    console.log(`AVISO: tablas no vacias (proformas=${cP}, inventory_pedidos=${cU}) — continuando por --force.`)
  }
}

// 1. Insert proformas — identical keys on every row.
const proformaRows = [...proformaMap.values()].map(pf => ({
  nro: pf.nro,
  canal: pf.canal,
  fecha_pedido: pf.fecha_pedido,
  fecha_pedido_texto: pf.fecha_pedido_texto,
  total_proforma: Number(pf.total_proforma.toFixed(2)),
  abonado: Number(pf.abonado.toFixed(2)),
  notas: null,
}))
if (proformaRows.length > 0) {
  const { error } = await db.from('proformas').insert(proformaRows)
  if (error) fail('insert proformas', error)
}
console.log(`OK: ${proformaRows.length} proformas insertadas.`)

// 2. Map nro → id
const { data: pfData, error: pfErr } = await db.from('proformas').select('id, nro')
if (pfErr) fail('select proformas', pfErr)
const idByNro = new Map(pfData.map(p => [p.nro, p.id]))

// 3. Insert pedidos in batches — identical keys on every row.
const pedidoRows = pedidos.map(p => ({
  proforma_id: p._proforma_nro ? (idByNro.get(p._proforma_nro) ?? null) : null,
  canal: p.canal,
  modelo: p.modelo,
  color: p.color,
  placa: p.placa,
  costo_proforma: p.costo_proforma,
  costo_factura: p.costo_factura,
  mes_estimado_recepcion: p.mes_estimado_recepcion,
  fecha_recepcion: p.fecha_recepcion,
  estado_pedido: p.estado_pedido,
  estado_unidad: p.estado_unidad,
  estado_venta: p.estado_venta,
  vendedor: p.vendedor,
  cliente_reserva: p.cliente_reserva,
  fecha_reserva: p.fecha_reserva,
  deal_id: p.deal_id,
  notas: p.notas,
}))
const BATCH = 100
for (let i = 0; i < pedidoRows.length; i += BATCH) {
  const chunk = pedidoRows.slice(i, i + BATCH)
  const { error } = await db.from('inventory_pedidos').insert(chunk)
  if (error) fail(`insert inventory_pedidos (batch ${i / BATCH + 1}, filas ${i + 1}-${i + chunk.length})`, error)
  console.log(`OK: pedidos ${i + 1}-${i + chunk.length} insertados.`)
}

console.log('')
console.log(`LISTO: ${proformaRows.length} proformas + ${pedidoRows.length} pedidos importados.`)
console.log('Siguiente paso: correr 008_sync_vendidos_from_deals.sql en el SQL editor.')
