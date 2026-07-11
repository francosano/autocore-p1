// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/egresos/nuevo/page.tsx
// AutoCore NPA — Egreso (Outflow) Registration
//
// Creates a tesoreria_comprobante (tipo='EGRESO') with an egreso_tipo and the
// matching estado for that type's lifecycle. Money always leaves CAJA_PPAL.
//
// Four egreso types:
//   BANCARIZACION    SOLICITADO → [EN_PODER_MIRLA] → ENTREGADO_BANCARIZADOR → DEPOSITADO
//                    ruta 'via_mirla' (4 states) or 'directa' (3 states)
//   CAJA_CHICA_REPO  SOLICITADO → EJECUTADO   (internal transfer CAJA_PPAL→CAJA_CHICA)
//   VENDOR_PAGO      SOLICITADO → EJECUTADO   (factura-backed)
//   PAGO_FIJO        EJECUTADO  (created directly by Viviana, no order step)
//
// This page only CREATES the egreso at its first state. The chain transitions
// (QR scan, handoff, deposit upload, AI review) live in the comprobante detail
// page. Movimientos for SOLICITADO-lifecycle egresos are written when the
// egreso is EJECUTED/DEPOSITED, NOT at creation — money hasn't moved yet.
// Exception: PAGO_FIJO is born EJECUTADO, so its movimiento is written here.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../../supabase'
import AdminShell from '../../../components/AdminShell'
import { useAuthGate } from '../../../components/useAuthGate'
import SessionErrorScreen from '../../../components/SessionErrorScreen'
import { useIsMobile } from '../../../components/useIsMobile'
import { registrarPrestamoCorto, prestamistaResponsable } from '../../../lib/prestamos'
import { VENBANKS } from '../../../lib/venbanks'
import PrestamoNegativoModal, { PrestamoPrompt } from '../../../components/PrestamoNegativoModal'

// ── WhatsApp notifications (Tesorería) ──────────────────────────────────────
// Fire-and-forget POST to autocore-whatsapp /notify-tesoreria after a
// successful DB transition. Non-blocking, non-fatal.
const WHATSAPP_WORKER = 'https://autocore-whatsapp.sano-franco.workers.dev'

function notifyTesoreria(payload: Record<string, any>) {
  try {
    fetch(WHATSAPP_WORKER + '/notify-tesoreria', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => { /* silent */ })
  } catch { /* silent */ }
}

// ── Egreso type catalog ─────────────────────────────────────────────────────
const EGRESO_TIPOS = [
  {
    value: 'BANCARIZACION',
    label: 'Bancarización — depósito de efectivo en banco',
    desc: 'El efectivo de Caja Principal se deposita en una cuenta bancaria.',
    hasOrder: true,
  },
  {
    value: 'CAJA_CHICA_REPO',
    label: 'Reposición de Caja Chica',
    desc: 'Transferencia interna de Caja Principal a Caja Chica. El dinero no sale del sistema.',
    hasOrder: true,
  },
  {
    value: 'VENDOR_PAGO',
    label: 'Pago directo a proveedor',
    desc: 'Pago a un proveedor. Requiere subir la factura para revisión.',
    hasOrder: true,
  },
  {
    value: 'PAGO_FIJO',
    label: 'Pago fijo mensual',
    desc: 'Pago recurrente (alquiler, bono, META). Se registra directamente, sin orden previa.',
    hasOrder: false,
  },
  {
    value: 'CAMBIO_USDT',
    label: 'Cambio Cash ⇄ USDT',
    desc: 'Intercambio entre efectivo de una caja y la billetera USDT, en cualquier dirección. El monto recibido se confirma al ejecutar.',
    hasOrder: true,
  },
  {
    value: 'CAMBIO_BS',
    label: 'Cambio Cash → Bolívares',
    desc: 'Vende efectivo USD por bolívares a una tasa que tú indicas. Viviana entrega el efectivo al bancarizador (se descuenta la caja) y luego Mirla o Viviana cierran subiendo el comprobante del depósito en Bs.',
    hasOrder: true,
  },
]

const PAGO_FIJO_CONCEPTOS = [
  { value: 'PAGO_ROBERTO', label: 'Pago Roberto (bono)' },
  { value: 'ALQUILER',     label: 'Alquiler del local' },
  { value: 'META',         label: 'META — facturas' },
  { value: 'COMISIONES',   label: 'Comisiones del mes' },
  { value: 'OTROS',        label: 'Otros' },
]

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  content: { padding: '32px', maxWidth: '760px', margin: '0 auto' },
  header: { marginBottom: 24 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' },
  subtitle: { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 2, marginBottom: 4 },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, marginBottom: 16 },
  field: { display: 'flex', flexDirection: 'column' as const, gap: 6, marginBottom: 14 },
  label: { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: 1 },
  required: { color: '#BB162B', marginLeft: 4 },
  input: { padding: '10px 14px', background: 'var(--bg-input, var(--bg-card))', border: '1px solid var(--border)', borderRadius: 8, fontSize: 14, color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' as const },
  textarea: { padding: '10px 14px', background: 'var(--bg-input, var(--bg-card))', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' as const, minHeight: 64, resize: 'vertical' as const, fontFamily: 'inherit' },
  select: { padding: '10px 14px', background: 'var(--bg-input, var(--bg-card))', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' as const },
  hint: { fontSize: 11, color: 'var(--text-secondary)' },
  row: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },
  buttonRow: { display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 20 },
  btnRed: { padding: '11px 26px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnSec: { padding: '11px 20px', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  err: { padding: '10px 14px', borderRadius: 8, background: 'rgba(187,22,43,0.1)', border: '1px solid #BB162B44', color: '#BB162B', fontSize: 13, marginBottom: 14 },
  preview: { padding: 14, background: 'var(--bg-deep)', borderRadius: 8, fontFamily: 'monospace', fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'pre-line' as const, lineHeight: 1.6, marginTop: 8 },
  // Type picker tiles
  tipoGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 4 },
  tipoTile: (active: boolean) => ({
    border: active ? '2px solid #BB162B' : '1px solid var(--border)',
    background: active ? 'rgba(187,22,43,0.06)' : 'var(--bg-card)',
    borderRadius: 10, padding: '14px 16px', cursor: 'pointer',
  }),
  tipoTitle: { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 },
  tipoDesc: { fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 },
  // Route radio (bancarización)
  routeBox: {
    background: 'rgba(74,158,255,0.05)',
    border: '1px solid rgba(74,158,255,0.25)',
    borderRadius: 8, padding: '12px 14px', marginBottom: 14,
  },
  routeTitle: { fontSize: 10, fontWeight: 700, color: '#4a9eff', textTransform: 'uppercase' as const, letterSpacing: 1.5, marginBottom: 10 },
  routeOpt: (active: boolean) => ({
    display: 'flex', gap: 10, alignItems: 'flex-start',
    padding: '10px 12px', borderRadius: 8, cursor: 'pointer', marginBottom: 8,
    border: active ? '1px solid #4a9eff' : '1px solid var(--border)',
    background: active ? 'rgba(74,158,255,0.08)' : 'transparent',
  }),
  // Urgent toggle
  urgentRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '12px 14px', borderRadius: 8, marginBottom: 14,
    border: '1px solid var(--border)', background: 'var(--bg-deep)',
  },
}

export default function NuevoEgresoPage() {
  const router = useRouter()
  const isMobile = useIsMobile()
  // Layer 2: auth gate.
  const gate = useAuthGate(p =>
    p.npa_can_audit_deals ||
    p.tesoreria_admin ||
    p.npa_can_admin ||
    (p as any).tesoreria_can_request_salida === true
  )
  const { userId } = gate

  const [cajaPpal, setCajaPpal]       = useState<{ id: string; nombre: string; saldo: number } | null>(null)
  const [cajaPC, setCajaPC]           = useState<{ id: string; nombre: string; saldo: number } | null>(null)
  const [cajaChica, setCajaChica]     = useState<{ id: string; nombre: string } | null>(null)
  const [cajaUSDT, setCajaUSDT]       = useState<{ id: string; nombre: string; saldo: number } | null>(null)
  const [loadingCajas, setLoadingCajas] = useState(true)

  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Préstamo por saldo negativo (solo PAGO_FIJO se ejecuta aquí; los demás
  // capturan el préstamo al ejecutarse en el detalle del comprobante).
  const [prestModal, setPrestModal] = useState<{ prompt: PrestamoPrompt; resume: (p: string, m: number) => void } | null>(null)

  // Form state
  const [egresoTipo, setEgresoTipo]   = useState('')
  const [montoUsd, setMontoUsd]       = useState('')
  const [concepto, setConcepto]       = useState('')
  const [dirigidoA, setDirigidoA]     = useState('')
  const [bancRuta, setBancRuta]       = useState('via_mirla')
  const [pagoFijoConcepto, setPagoFijoConcepto] = useState('PAGO_ROBERTO')
  const [sourceLabel, setSourceLabel] = useState('')
  const [notas, setNotas]             = useState('')
  const [esUrgente, setEsUrgente]     = useState(false)
  // Optional supporting document (receipt / relación) attached at creation.
  // Available for EVERY egreso tipo. Uploaded to the 'comprobantes' bucket
  // BEFORE the comprobante insert (path keyed by voucher numero) so the URL
  // can be written in the same insert — no orphan risk.
  const [docFile, setDocFile]         = useState<File | null>(null)
  const [docKey, setDocKey]           = useState(0)   // bump to visually reset the file input
  // Source caja — 'CAJA_PPAL' (default), 'PC_MIRLA', or 'USDT_WALLET'.
  // PC_MIRLA = Beto/Mirla spending cash sitting at the collection point
  // before pickup. USDT_WALLET = digital USDT bancarización, gated by
  // can_manage_usdt permission.
  const [sourceCaja, setSourceCaja]   = useState<'CAJA_PPAL' | 'PC_MIRLA' | 'USDT_WALLET'>('CAJA_PPAL')
  // CAMBIO_USDT direction. sourceCaja is always the CASH side of the swap:
  //   CASH_TO_USDT: cash caja → USDT_WALLET
  //   USDT_TO_CASH: USDT_WALLET → cash caja
  const [fxDireccion, setFxDireccion] = useState<'CASH_TO_USDT' | 'USDT_TO_CASH'>('CASH_TO_USDT')

  // CAMBIO_BS — operator types the exchange rate (Bs/USD; normally Binance) and
  // picks the Venezuelan bank where the bancarizador will deposit the bolívares.
  const [tasaCambio, setTasaCambio]   = useState('')
  const [bancoBs, setBancoBs]         = useState('')

  // The currently selected source caja object (resolved from sourceCaja).
  const cajaOrigen =
    sourceCaja === 'PC_MIRLA'    ? cajaPC :
    sourceCaja === 'USDT_WALLET' ? cajaUSDT :
                                   cajaPpal

  // can_manage_usdt — gates the USDT option in the source picker. Granted
  // only to Gerencia/Admin/manager per the migration. Read from the auth
  // gate's permissions object (cast since this perm is new and not yet in
  // the NPAPermissions TS interface).
  const canManageUSDT = ((gate.permissions as any)?.can_manage_usdt) === true

  const tipoMeta = useMemo(
    () => EGRESO_TIPOS.find(t => t.value === egresoTipo) || null,
    [egresoTipo]
  )

  useEffect(() => {
    if (gate.status === 'denied') { router.replace('/tesoreria'); return }
    if (gate.status === 'ok') { loadCajas() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.status])

  async function loadCajas() {
    setLoadingCajas(true)
    const { data, error } = await supabase
      .from('tesoreria_ubicaciones')
      .select('id, codigo, nombre, saldo_actual_usd')
      .in('codigo', ['CAJA_PPAL', 'CAJA_CHICA', 'PC_MIRLA', 'USDT_WALLET'])
    if (error || !data) {
      setErr('No se pudieron cargar las cajas. Verifica la migración SQL.')
      setLoadingCajas(false)
      return
    }
    const pp   = data.find((u: any) => u.codigo === 'CAJA_PPAL')
    const cc   = data.find((u: any) => u.codigo === 'CAJA_CHICA')
    const pc   = data.find((u: any) => u.codigo === 'PC_MIRLA')
    const usdt = data.find((u: any) => u.codigo === 'USDT_WALLET')
    if (pp)   setCajaPpal({ id: pp.id, nombre: pp.nombre, saldo: Number(pp.saldo_actual_usd) || 0 })
    if (cc)   setCajaChica({ id: cc.id, nombre: cc.nombre })
    if (pc)   setCajaPC({ id: pc.id, nombre: pc.nombre, saldo: Number(pc.saldo_actual_usd) || 0 })
    if (usdt) setCajaUSDT({ id: usdt.id, nombre: usdt.nombre, saldo: Number(usdt.saldo_actual_usd) || 0 })
    setLoadingCajas(false)
  }

  // Initial estado depends on the egreso type's lifecycle.
  function initialEstado(): string {
    if (egresoTipo === 'PAGO_FIJO') return 'EJECUTADO'   // born executed
    return 'SOLICITADO'                                  // everything else is ordered first
  }

  async function handleSubmit(loan?: { prestamista: string; monto: number }) {
    setErr(null)

    if (!egresoTipo)            { setErr('Selecciona el tipo de egreso'); return }
    const monto = parseFloat(montoUsd)
    if (!monto || monto <= 0)  { setErr('Monto inválido'); return }
    if (!concepto.trim())      { setErr('Falta el concepto'); return }
    if (!cajaOrigen)           { setErr('Caja de origen no encontrada'); return }
    if (egresoTipo === 'BANCARIZACION' && !dirigidoA.trim()) {
      setErr('Indica a quién va dirigida la bancarización'); return
    }
    if (egresoTipo === 'CAJA_CHICA_REPO' && !cajaChica) {
      setErr('Caja Chica no encontrada'); return
    }
    if (egresoTipo === 'CAMBIO_USDT') {
      if (!cajaUSDT)           { setErr('USDT Wallet no encontrada en ubicaciones'); return }
      if (!dirigidoA.trim())   { setErr('Indica con quién se hace el cambio'); return }
      if (sourceCaja === 'USDT_WALLET') { setErr('Selecciona la caja de efectivo del cambio'); return }
    }
    if (egresoTipo === 'CAMBIO_BS') {
      if (sourceCaja === 'USDT_WALLET') { setErr('El cambio a Bolívares sale de una caja de efectivo (Caja Principal o Punto de Cobro).'); return }
      const t = parseFloat(tasaCambio)
      if (!t || t <= 0)        { setErr('Indica la tasa de cambio (Bs por USD).'); return }
      if (!bancoBs)            { setErr('Selecciona el banco destino donde llegarán los bolívares.'); return }
    }

    // Saldo check. El movimiento −1 solo se ejecuta AHORA para PAGO_FIJO
    // (nace EJECUTADO). Los demás tipos debitan al ejecutarse en el detalle del
    // comprobante, así que un SOLICITADO que excede el saldo se permite — el
    // préstamo se captura en ese momento. Para PAGO_FIJO, si excede el saldo,
    // pedimos a quién le debemos en vez de bloquear.
    if (egresoTipo === 'PAGO_FIJO' && monto > cajaOrigen.saldo) {
      if (!loan) {
        setPrestModal({
          prompt: { cajaNombre: cajaOrigen.nombre, who: prestamistaResponsable(sourceCaja), montoEgreso: monto, saldoDisponible: cajaOrigen.saldo },
          resume: (p, m) => { setPrestModal(null); handleSubmit({ prestamista: p, monto: m }) },
        })
        return
      }
      // loan provista → seguimos; el movimiento se inserta con permite_negativo.
    }

    setSaving(true)
    try {
      // 1. Voucher number
      const { data: numeroData, error: numeroErr } =
        await supabase.rpc('tesoreria_next_voucher_numero', { p_tipo: 'EGRESO' })
      if (numeroErr) throw new Error('Error generando número de comprobante: ' + numeroErr.message)
      const numero = numeroData as string

      const estado = initialEstado()

      // 1b. Optional supporting document — upload first (nothing committed
      // yet, so a failed upload aborts cleanly with no orphan comprobante).
      let documentoUrl: string | null = null
      if (docFile) {
        const ext = (docFile.name.split('.').pop() || 'jpg').toLowerCase()
        const path = `tesoreria/egresos/${numero}/soporte.${ext}`
        const { error: upErr } = await supabase.storage
          .from('comprobantes')
          .upload(path, docFile, { upsert: true })
        if (upErr) throw new Error('Error subiendo el documento de soporte: ' + upErr.message)
        const { data: pub } = supabase.storage.from('comprobantes').getPublicUrl(path)
        documentoUrl = pub?.publicUrl || null
      }

      // 2. Create the egreso comprobante
      const { data: compr, error: comprErr } = await supabase
        .from('tesoreria_comprobantes')
        .insert({
          numero,
          tipo: 'EGRESO',
          estado,
          monto_usd: monto,
          // Money leaves the chosen source caja (CAJA_PPAL or PC_MIRLA).
          // CAMBIO_USDT: origen/destino encode the swap direction —
          // CASH_TO_USDT debits the cash caja and credits USDT_WALLET;
          // USDT_TO_CASH is the mirror image.
          ubicacion_origen_id: egresoTipo === 'CAMBIO_USDT'
            ? (fxDireccion === 'CASH_TO_USDT' ? cajaOrigen.id : cajaUSDT!.id)
            : cajaOrigen.id,
          // Caja Chica reposición also has a destination (internal transfer).
          ubicacion_destino_id: egresoTipo === 'CAJA_CHICA_REPO' && cajaChica ? cajaChica.id
            : egresoTipo === 'CAMBIO_USDT'
              ? (fxDireccion === 'CASH_TO_USDT' ? cajaUSDT!.id : cajaOrigen.id)
              : null,
          concepto: concepto.trim(),
          categoria: egresoTipo,
          egreso_tipo: egresoTipo,
          // For BANCARIZACION, the route depends on source:
          //   USDT_WALLET → always 'directa' (no Mirla in the chain; the
          //                 USDT moves digitally to the bancarizador)
          //   anything else → user's bancRuta choice ('via_mirla' or 'directa')
          bancarizacion_ruta: egresoTipo === 'BANCARIZACION'
            ? (sourceCaja === 'USDT_WALLET' ? 'directa' : bancRuta)
            : null,
          egreso_dirigido_a: dirigidoA.trim() || null,
          pago_fijo_concepto: egresoTipo === 'PAGO_FIJO' ? pagoFijoConcepto : null,
          // CAMBIO_BS — store the operator's exchange rate and the destination
          // Venezuelan bank. monto_usd already holds the USD cash being sold;
          // expected Bs = monto_usd × tasa_aplicada. The Bs bank rows are
          // created later at close (deposit upload by Mirla/Viviana).
          tasa_aplicada:   egresoTipo === 'CAMBIO_BS' ? (parseFloat(tasaCambio) || null) : null,
          banco_bs_codigo: egresoTipo === 'CAMBIO_BS' ? bancoBs : null,
          banco_bs_nombre: egresoTipo === 'CAMBIO_BS' ? (VENBANKS.find(b => b.codigo === bancoBs)?.nombre || null) : null,
          es_urgente: esUrgente,
          // Optional supporting document (receipt / relación). The comprobante
          // detail page already renders this field as a link.
          egreso_documento_url: documentoUrl,
          source_type: 'MANUAL',
          source_label: sourceLabel.trim() || null,
          qr_payload: '',           // trigger fills this
          solicitado_by: userId,
          notas: notas.trim() || null,
        })
        .select('*')
        .single()
      if (comprErr) throw new Error('Error creando egreso: ' + comprErr.message)

      // 3. Movimientos — ONLY for PAGO_FIJO, which is born EJECUTADO.
      //    All other egreso types write their movimientos at the moment of
      //    execution/deposit (in the comprobante detail page), because the
      //    money has not physically moved yet at SOLICITADO.
      if (estado === 'EJECUTADO') {
        // Si este pago deja la caja en negativo, registramos primero el préstamo
        // (a quién le debemos) y luego permitimos el movimiento negativo.
        if (loan) {
          const { error: pErr } = await registrarPrestamoCorto({
            ubicacionId: cajaOrigen.id, prestamista: loan.prestamista, monto: loan.monto,
            comprobanteId: compr.id, userId,
          })
          if (pErr) throw new Error('Error registrando préstamo: ' + pErr)
        }
        const { error: movErr } = await supabase
          .from('tesoreria_movimientos')
          .insert({
            ubicacion_id: cajaOrigen.id,
            tipo: egresoTipo,
            monto_usd: monto,
            signo: -1,
            permite_negativo: !!loan,
            source_type: 'MANUAL',
            source_label: sourceLabel.trim() || null,
            comprobante_id: compr.id,
            descripcion: concepto.trim(),
            categoria: egresoTipo,
            registered_by: userId,
          })
        if (movErr) throw new Error('Error registrando movimiento: ' + movErr.message)

        // Authoritative saldo recompute — the incremental balance trigger
        // misses under the REST/pooler path, leaving caja saldos stale.
        try { await supabase.rpc('tesoreria_recompute_saldos') }
        catch (e) { console.warn('[egreso] recompute warning', e) }
      }

      // 4. Log evento
      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: compr.id,
        evento: estado === 'EJECUTADO' ? 'EJECUTADO' : 'SOLICITADO',
        actor_user_id: userId,
        actor_label: 'Egreso',
        notas: notas.trim() || null,
      })

      // 4b. WhatsApp notification(s).
      //   - The main event (SOLICITADO for everything except PAGO_FIJO which is
      //     born EJECUTADO).
      //   - If the egreso is BANCARIZACION sourced from PC_MIRLA, also fire
      //     punto_cobro_afectado so subscribers see the drawer balance changed.
      // All non-blocking.
      const notifyPayload: Record<string, any> = {
        evento: estado === 'EJECUTADO' ? 'EJECUTADO' : 'SOLICITADO',
        tipo: 'EGRESO',
        egreso_tipo: egresoTipo,
        bancarizacion_ruta: egresoTipo === 'BANCARIZACION'
          ? (sourceCaja === 'USDT_WALLET' ? 'directa' : bancRuta)
          : undefined,
        es_urgente: esUrgente,
        numero: compr.numero,
        monto_usd: monto,
        concepto: concepto.trim(),
        solicitante: 'Tesorería',                        // who placed the egreso
        egreso_dirigido_a: dirigidoA.trim() || null,
        bancarizador: dirigidoA.trim() || null,          // same field, different label per template
        ubicacion_origen: cajaOrigen.nombre,
        ubicacion_origen_codigo: sourceCaja,             // 'PC_MIRLA' or 'CAJA_PPAL' → Worker uses for action line
        enviado_por: userId,
      }
      notifyTesoreria(notifyPayload)

      // Co-fire punto_cobro_afectado when a BANCARIZACION is sourced from
      // the collection point. The "saldo restante" is the PC_MIRLA balance
      // AFTER this egreso commits the cash. (At this moment no movimiento
      // has been written yet, so we compute it: current saldo − monto.)
      // Uses force_template since this is a co-fire — the routing logic
      // already chose banc_solicitada for the primary event above.
      if (egresoTipo === 'BANCARIZACION' && sourceCaja === 'PC_MIRLA' && cajaPC) {
        notifyTesoreria({
          force_template: 'punto_cobro_afectado',
          tipo: 'EGRESO',
          es_urgente: esUrgente,
          numero: compr.numero,
          monto_usd: monto,
          motivo: `Bancarización solicitada · ${concepto.trim()}`,
          pc_saldo_restante: Math.max(0, (cajaPC.saldo || 0) - monto),
          enviado_por: userId,
        })
      }

      // 5. Go to the comprobante detail (chain tracker / execution actions)
      router.push(`/tesoreria/comprobante?id=${compr.id}&created=1`)
    } catch (e: any) {
      setErr(e.message || 'Error inesperado')
      setSaving(false)
    }
  }

  if (gate.status === 'error') {
    return <SessionErrorScreen homeHref="/tesoreria" />
  }
  if (gate.status === 'loading' || gate.status === 'denied' || loadingCajas) {
    return (
      <AdminShell active="tesoreria">
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-secondary)' }}>Cargando…</div>
      </AdminShell>
    )
  }

  const lifecyclePreview = (() => {
    if (egresoTipo === 'BANCARIZACION') {
      return bancRuta === 'via_mirla'
        ? 'SOLICITADO → EN PODER DE MIRLA → ENTREGADO AL BANCARIZADOR → DEPOSITADO'
        : 'SOLICITADO → ENTREGADO AL BANCARIZADOR → DEPOSITADO'
    }
    if (egresoTipo === 'CAJA_CHICA_REPO') return 'SOLICITADO → EJECUTADO'
    if (egresoTipo === 'CAMBIO_USDT')     return 'SOLICITADO → EJECUTADO (cambio confirmado)'
    if (egresoTipo === 'CAMBIO_BS')       return 'SOLICITADO → ENTREGADO (Viviana entrega efectivo) → DEPOSITADO (Bs confirmados)'
    if (egresoTipo === 'VENDOR_PAGO')     return 'SOLICITADO → EJECUTADO'
    if (egresoTipo === 'PAGO_FIJO')       return 'EJECUTADO (directo)'
    return '—'
  })()

  return (
    <AdminShell active="tesoreria">
      <div style={{ ...s.content, padding: isMobile ? '16px 14px 32px' : '32px', maxWidth: isMobile ? '100%' : 760 }}>

        <div style={s.header}>
          <div style={s.subtitle}>TESORERÍA</div>
          <h1 style={s.title}>Registrar Egreso</h1>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            Salida de efectivo desde Caja Principal. El tipo de egreso define el flujo.
          </div>
        </div>

        {err && <div style={s.err}>{err}</div>}

        {/* ── Step 1: pick the egreso type ── */}
        <div style={s.card}>
          <div style={{ ...s.label, marginBottom: 10 }}>Tipo de egreso<span style={s.required}>*</span></div>
          <div style={{ ...s.tipoGrid, gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
            {EGRESO_TIPOS.filter(t => t.value !== 'CAMBIO_USDT' || canManageUSDT).map(t => (
              <div
                key={t.value}
                style={s.tipoTile(egresoTipo === t.value)}
                onClick={() => {
                  setEgresoTipo(t.value)
                  // USDT source only makes sense for BANCARIZACION. If the
                  // user switches to a different egreso tipo while USDT is
                  // selected, fall back to CAJA_PPAL.
                  if (t.value !== 'BANCARIZACION' && sourceCaja === 'USDT_WALLET') {
                    setSourceCaja('CAJA_PPAL')
                  }
                  // CAMBIO_USDT: sourceCaja is the cash side, never USDT.
                  if (t.value === 'CAMBIO_USDT' && sourceCaja === 'USDT_WALLET') {
                    setSourceCaja('CAJA_PPAL')
                  }
                }}
              >
                <div style={s.tipoTitle}>{t.label}</div>
                <div style={s.tipoDesc}>{t.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Step 2: the branching form ── */}
        {egresoTipo && (
          <div style={s.card}>

            {/* Bancarización route picker — hidden for USDT.
                USDT bancarizaciones are always digital direct transfers; the
                via_mirla / directa choice doesn't apply because no physical
                cash exists. Shows a small explainer instead. */}
            {egresoTipo === 'BANCARIZACION' && sourceCaja === 'USDT_WALLET' && (
              <div style={{ ...s.routeBox, background: 'rgba(0,150,200,0.06)' }}>
                <div style={s.routeTitle}>🪙 Bancarización en USDT</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  Los USDT se transfieren digitalmente al bancarizador. No hay paso
                  por Admon — el bancarizador deposita directamente en la cuenta
                  bancaria.
                </div>
              </div>
            )}
            {egresoTipo === 'CAMBIO_USDT' && (
              <div style={{ ...s.routeBox, background: 'rgba(0,150,200,0.06)' }}>
                <div style={s.routeTitle}>⇄ Dirección del cambio</div>
                <div
                  style={s.routeOpt(fxDireccion === 'CASH_TO_USDT')}
                  onClick={() => setFxDireccion('CASH_TO_USDT')}
                >
                  <input type="radio" checked={fxDireccion === 'CASH_TO_USDT'} readOnly />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Efectivo → USDT</div>
                    <div style={s.hint}>Sale efectivo de la caja seleccionada y entran USDT a la billetera.</div>
                  </div>
                </div>
                <div
                  style={s.routeOpt(fxDireccion === 'USDT_TO_CASH')}
                  onClick={() => setFxDireccion('USDT_TO_CASH')}
                >
                  <input type="radio" checked={fxDireccion === 'USDT_TO_CASH'} readOnly />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>USDT → Efectivo</div>
                    <div style={s.hint}>Salen USDT de la billetera y entra efectivo a la caja seleccionada.</div>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Saldo USDT Wallet: ${(cajaUSDT?.saldo || 0).toFixed(2)}. El monto recibido se confirma al ejecutar — la diferencia queda registrada como costo del cambio.
                </div>
              </div>
            )}
            {egresoTipo === 'CAMBIO_BS' && (
              <div style={{ ...s.routeBox, background: 'rgba(0,150,200,0.06)' }}>
                <div style={s.routeTitle}>⇄ Cambio de efectivo a Bolívares</div>
                <div style={{ ...s.row, gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
                  <div style={s.field}>
                    <label style={s.label}>Tasa (Bs por USD)<span style={s.required}>*</span></label>
                    <input style={s.input} type="number" step="0.01" min="0.01"
                      value={tasaCambio}
                      onChange={e => setTasaCambio(e.target.value)}
                      placeholder="Ej: 753.00" />
                    <span style={s.hint}>Tasa a la que se transó (normalmente Binance). Escríbela manualmente.</span>
                  </div>
                  <div style={s.field}>
                    <label style={s.label}>Banco destino (Bs)<span style={s.required}>*</span></label>
                    <select style={s.select} value={bancoBs} onChange={e => setBancoBs(e.target.value)}>
                      <option value="">Selecciona el banco…</option>
                      {VENBANKS.map(b => <option key={b.codigo} value={b.codigo}>{b.codigo} · {b.nombre}</option>)}
                    </select>
                    <span style={s.hint}>Cuenta venezolana donde el bancarizador depositará los bolívares.</span>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Viviana entrega el efectivo al bancarizador (el USD se descuenta de la caja en ese momento). Luego Mirla o Viviana cierran subiendo el comprobante del depósito en Bs — admite varios recibos.
                </div>
              </div>
            )}
            {egresoTipo === 'BANCARIZACION' && sourceCaja !== 'USDT_WALLET' && (
              <div style={s.routeBox}>
                <div style={s.routeTitle}>🏦 Ruta de la bancarización</div>
                <div
                  style={s.routeOpt(bancRuta === 'via_mirla')}
                  onClick={() => setBancRuta('via_mirla')}
                >
                  <input type="radio" checked={bancRuta === 'via_mirla'} readOnly />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Vía Mirla</div>
                    <div style={s.hint}>El efectivo pasa por la oficina de Mirla. Ella escanea el QR al recibirlo y lo entrega al bancarizador.</div>
                  </div>
                </div>
                <div
                  style={s.routeOpt(bancRuta === 'directa')}
                  onClick={() => setBancRuta('directa')}
                >
                  <input type="radio" checked={bancRuta === 'directa'} readOnly />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Entrega directa</div>
                    <div style={s.hint}>Viviana entrega el efectivo directamente al bancarizador. Se omite el paso por Mirla.</div>
                  </div>
                </div>
              </div>
            )}

            {/* Fixed-payment concept */}
            {egresoTipo === 'PAGO_FIJO' && (
              <div style={s.field}>
                <label style={s.label}>Concepto del pago fijo<span style={s.required}>*</span></label>
                <select style={s.select} value={pagoFijoConcepto} onChange={e => setPagoFijoConcepto(e.target.value)}>
                  {PAGO_FIJO_CONCEPTOS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
            )}

            {/* Source caja selector — where the money comes from.
                Beto can spend from Punto de Cobro (PC_MIRLA) before pickup.
                USDT_WALLET is visible only to users with can_manage_usdt. */}
            <div style={s.field}>
              <label style={s.label}>Origen del dinero<span style={s.required}>*</span></label>
              <div style={{ display: 'flex', gap: 10, flexDirection: isMobile ? 'column' : 'row' }}>
                <div
                  style={{
                    flex: 1, padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                    border: sourceCaja === 'CAJA_PPAL' ? '2px solid #BB162B' : '1px solid var(--border)',
                    background: sourceCaja === 'CAJA_PPAL' ? 'rgba(187,22,43,0.06)' : 'var(--bg-card)',
                  }}
                  onClick={() => setSourceCaja('CAJA_PPAL')}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {cajaPpal?.nombre || 'Caja Principal'}
                  </div>
                  <div style={s.hint}>Saldo: ${(cajaPpal?.saldo || 0).toFixed(2)}</div>
                </div>
                <div
                  style={{
                    flex: 1, padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                    border: sourceCaja === 'PC_MIRLA' ? '2px solid #BB162B' : '1px solid var(--border)',
                    background: sourceCaja === 'PC_MIRLA' ? 'rgba(187,22,43,0.06)' : 'var(--bg-card)',
                  }}
                  onClick={() => setSourceCaja('PC_MIRLA')}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {cajaPC?.nombre || 'Punto de Cobro (Mirla)'}
                  </div>
                  <div style={s.hint}>Saldo: ${(cajaPC?.saldo || 0).toFixed(2)}</div>
                </div>
                {/* USDT — only shown to users with can_manage_usdt, AND only
                    for BANCARIZACION (USDT egresos are always bancarizaciones
                    to a bancarizador who deposits in fiat). */}
                {canManageUSDT && egresoTipo === 'BANCARIZACION' && (
                  <div
                    style={{
                      flex: 1, padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                      border: sourceCaja === 'USDT_WALLET' ? '2px solid #BB162B' : '1px solid var(--border)',
                      background: sourceCaja === 'USDT_WALLET' ? 'rgba(187,22,43,0.06)' : 'var(--bg-card)',
                    }}
                    onClick={() => setSourceCaja('USDT_WALLET')}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {cajaUSDT?.nombre || 'USDT'}
                    </div>
                    <div style={s.hint}>Saldo: ${(cajaUSDT?.saldo || 0).toFixed(2)}</div>
                  </div>
                )}
              </div>
              <span style={s.hint}>
                {egresoTipo === 'CAMBIO_USDT'
                  ? 'Caja de EFECTIVO del cambio — el otro lado es siempre la billetera USDT.'
                  : sourceCaja === 'USDT_WALLET'
                  ? 'Bancarización en USDT — los fondos se transfieren digitalmente al bancarizador.'
                  : 'Punto de Cobro: efectivo recibido aún sin recoger. Caja Principal: bóveda principal.'}
              </span>
            </div>

            <div style={{ ...s.row, gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
              <div style={s.field}>
                <label style={s.label}>Monto USD<span style={s.required}>*</span></label>
                <input style={s.input} type="number" step="0.01" min="0.01"
                  value={montoUsd}
                  onChange={e => setMontoUsd(e.target.value)}
                  placeholder="0.00" />
                {cajaOrigen && (
                  <span style={s.hint}>Saldo {cajaOrigen.nombre}: ${cajaOrigen.saldo.toFixed(2)}</span>
                )}
                {egresoTipo === 'CAMBIO_BS' && (() => {
                  const bs = (parseFloat(montoUsd) || 0) * (parseFloat(tasaCambio) || 0)
                  return bs > 0
                    ? <span style={{ ...s.hint, color: '#1a7a4a', fontWeight: 700 }}>≈ {bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs esperados</span>
                    : <span style={s.hint}>Indica la tasa para ver los Bs esperados.</span>
                })()}
              </div>

              {/* "Directed to" — required for bancarización, optional otherwise */}
              <div style={s.field}>
                <label style={s.label}>
                  Dirigido a
                  {(egresoTipo === 'BANCARIZACION' || egresoTipo === 'CAMBIO_USDT') && <span style={s.required}>*</span>}
                </label>
                <input style={s.input} type="text"
                  value={dirigidoA}
                  onChange={e => setDirigidoA(e.target.value)}
                  placeholder={egresoTipo === 'BANCARIZACION' ? 'Ej: Enzo Carbonara' : egresoTipo === 'CAMBIO_USDT' ? 'Con quién se hace el cambio' : 'Proveedor / destinatario'} />
                <span style={s.hint}>
                  {egresoTipo === 'BANCARIZACION'
                    ? 'Persona encargada de depositar el efectivo en el banco.'
                    : 'Opcional — a quién va dirigido el pago.'}
                </span>
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>Concepto (corto)<span style={s.required}>*</span></label>
              <input style={s.input} type="text"
                value={concepto}
                onChange={e => setConcepto(e.target.value)}
                placeholder="Ej: Bancarización semanal" />
              <span style={s.hint}>Aparecerá impreso en el comprobante.</span>
            </div>

            <div style={s.field}>
              <label style={s.label}>Referencia (opcional)</label>
              <input style={s.input} type="text"
                value={sourceLabel}
                onChange={e => setSourceLabel(e.target.value)}
                placeholder="Ej: Cuenta Mercantil 0105…" />
              <span style={s.hint}>Cuenta destino, número de factura del proveedor, etc.</span>
            </div>

            <div style={s.field}>
              <label style={s.label}>Notas internas (opcional)</label>
              <textarea style={s.textarea}
                value={notas}
                onChange={e => setNotas(e.target.value)}
                placeholder="Cualquier observación adicional…" />
            </div>

            {/* Optional supporting document — receipt or relación of what is
                being paid. Available for every egreso tipo, never mandatory. */}
            <div style={s.field}>
              <label style={s.label}>Documento de soporte (opcional)</label>
              <input
                key={'doc-' + docKey}
                type="file"
                accept="image/*,.pdf"
                style={{ ...s.input, padding: '8px 10px' }}
                onChange={e => setDocFile(e.target.files?.[0] || null)}
              />
              {docFile ? (
                <span style={{ ...s.hint, color: '#1a7a4a', fontWeight: 700 }}>
                  📎 {docFile.name} — se adjuntará al comprobante.
                  {' '}<span style={{ color: '#BB162B', cursor: 'pointer', fontWeight: 700 }} onClick={() => { setDocFile(null); setDocKey(k => k + 1) }}>Quitar</span>
                </span>
              ) : (
                <span style={s.hint}>Recibo, relación o soporte del pago. Foto o PDF. No es obligatorio.</span>
              )}
            </div>

            {/* Urgent toggle */}
            <div style={s.urgentRow}>
              <input type="checkbox" checked={esUrgente} onChange={e => setEsUrgente(e.target.checked)} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: esUrgente ? '#BB162B' : 'var(--text-primary)' }}>
                  {esUrgente ? '🔴 Marcado como URGENTE' : 'Marcar como urgente'}
                </div>
                <div style={s.hint}>Los egresos urgentes aparecen primero en la lista y se resaltan en las notificaciones.</div>
              </div>
            </div>

            {/* Preview */}
            <div style={{ marginTop: 8 }}>
              <div style={s.label}>Previsualización</div>
              <div style={s.preview}>
                {`COMPROBANTE DE EGRESO${esUrgente ? '   🔴 URGENTE' : ''}
─────────────────────────────
Tipo:     ${tipoMeta?.label || egresoTipo}
Monto:    $${montoUsd || '0.00'}
Concepto: ${concepto || '—'}
Dirigido: ${dirigidoA || '—'}${egresoTipo === 'PAGO_FIJO' ? `
Pago fijo:${PAGO_FIJO_CONCEPTOS.find(c => c.value === pagoFijoConcepto)?.label || ''}` : ''}${egresoTipo === 'BANCARIZACION' ? `
Ruta:     ${bancRuta === 'via_mirla' ? 'Vía Mirla' : 'Entrega directa'}` : ''}
Origen:   ${egresoTipo === 'CAMBIO_USDT' && fxDireccion === 'USDT_TO_CASH' ? (cajaUSDT?.nombre || 'USDT Wallet') : (cajaOrigen?.nombre || 'Caja Principal')}${egresoTipo === 'CAMBIO_USDT' ? `
Destino:  ${fxDireccion === 'CASH_TO_USDT' ? (cajaUSDT?.nombre || 'USDT Wallet') : (cajaOrigen?.nombre || 'Caja Principal')}` : ''}${egresoTipo === 'CAJA_CHICA_REPO' ? `
Destino:  ${cajaChica?.nombre || 'Caja Chica'}` : ''}${egresoTipo === 'CAMBIO_BS' ? `
Tasa:     ${tasaCambio || '—'} Bs/USD
Bs esper: ${((parseFloat(montoUsd)||0)*(parseFloat(tasaCambio)||0)).toLocaleString('es-VE',{minimumFractionDigits:2,maximumFractionDigits:2})}
Banco:    ${VENBANKS.find(b=>b.codigo===bancoBs)?.nombre || '—'}` : ''}
Flujo:    ${lifecyclePreview}`}
              </div>
            </div>

            <div style={s.buttonRow}>
              <button style={s.btnSec} onClick={() => router.back()} disabled={saving}>← Cancelar</button>
              <button style={s.btnRed} onClick={() => handleSubmit()} disabled={saving}>
                {saving ? 'Guardando…'
                  : egresoTipo === 'PAGO_FIJO' ? 'Registrar Pago →'
                  : 'Crear Egreso →'}
              </button>
            </div>
          </div>
        )}

      </div>

      {prestModal && (
        <PrestamoNegativoModal
          prompt={prestModal.prompt}
          saving={saving}
          onConfirm={prestModal.resume}
          onCancel={() => setPrestModal(null)}
        />
      )}
    </AdminShell>
  )
}