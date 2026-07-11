// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/caja-chica/page.tsx
// AutoCore NPA — Caja Chica (módulo fondo fijo, una sola pantalla)
//
// 2026-06-06. Versión consolidada: la misma página de gasto que ya existía,
// ahora con el modelo de fondo fijo encima. Sin fragmentar en muchas rutas.
//
//   • Tarjeta de saldo con fondo fijo + barra de consumo + alerta de saldo bajo
//   • Registrar gasto (lo que ya existía — gasta-primero, registra-después)
//   • Reponer al fondo (modal, admin)        → transferencia Caja Principal→Chica
//   • Arqueo (modal, admin)                  → conteo físico vs sistema + ajuste
//   • Enlace a Historial + Reporte (/tesoreria/caja-chica/historial)
//
// fondo_fijo_usd / umbral_alerta_usd viven en tesoreria_ubicaciones (migración
// 2026-06-06_caja_chica_modulo.sql). Arqueo escribe en tesoreria_arqueos.
//
// Gate gasto: tesoreria_can_register_cc_gasto OR tesoreria_admin OR npa_can_admin.
// Reponer / Arqueo: solo tesoreria_admin OR npa_can_admin.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'
import { useNPAPermissions } from '../../components/useNPAPermissions'
import AdminShell from '../../components/AdminShell'
import { ArrowLeft, Receipt, Camera, Check, Wallet, Calculator, AlertTriangle, ChevronRight, X } from 'lucide-react'

const GASTO_CATEGORIAS = [
  { value: 'CC_CAFE_COMIDA',   label: 'Café / Comida',           emoji: '☕' },
  { value: 'CC_PAPELERIA',     label: 'Papelería / Oficina',     emoji: '📎' },
  { value: 'CC_MENSAJERIA',    label: 'Mensajería / Transporte', emoji: '🛵' },
  { value: 'CC_LIMPIEZA',      label: 'Limpieza / Aseo',         emoji: '🧹' },
  { value: 'CC_MANTENIMIENTO', label: 'Mantenimiento menor',     emoji: '🔧' },
  { value: 'CC_OTRO',          label: 'Otro',                    emoji: '📦' },
]

const fmt = (n: number) =>
  `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const s: any = {
  page: { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif', paddingBottom: 40 },
  topBar: { background: '#BB162B', color: '#fff', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10, position: 'sticky', top: 0, zIndex: 50, boxShadow: '0 2px 6px rgba(0,0,0,0.15)' },
  backBtn: { background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: 4, display: 'flex' },
  title: { fontSize: 15, fontWeight: 700, letterSpacing: 0.3 },
  content: { padding: '16px 14px 24px', maxWidth: 520, margin: '0 auto' },

  saldoCard: { background: 'linear-gradient(135deg, #0A0F1E 0%, #0D2257 100%)', border: '1px solid rgba(59,130,246,0.35)', borderRadius: 14, padding: '16px 18px', marginBottom: 12, color: '#fff' },
  saldoTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  saldoLabel: { fontSize: 10, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: 2 },
  saldoAmount: { fontSize: 30, fontWeight: 800, fontFamily: 'monospace', letterSpacing: -1, marginTop: 2 },
  fondoLabel: { fontSize: 10, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: 1, textAlign: 'right' },
  fondoAmount: { fontSize: 17, fontWeight: 600, color: 'rgba(255,255,255,0.85)', fontFamily: 'monospace', marginTop: 3, textAlign: 'right' },
  barWrap: { marginTop: 14 },
  barTrack: { height: 7, background: '#0a1838', borderRadius: 4, overflow: 'hidden', display: 'flex' },
  barFill: (pct: number, low: boolean) => ({ width: `${Math.max(2, Math.min(100, pct))}%`, background: low ? '#e0894a' : '#3A7AD4' }),
  barMeta: { display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'rgba(255,255,255,0.55)' },

  alert: { background: 'rgba(187,22,43,0.12)', border: '1px solid #BB162B', borderRadius: 10, padding: '10px 13px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 9 },
  alertTxt: { fontSize: 12.5, color: '#e88' },

  actionRow: { display: 'flex', gap: 8, marginBottom: 14 },
  actBtn: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 6px', cursor: 'pointer' },
  actLabel: { fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)' },
  histLink: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 12.5, color: '#3A7AD4', cursor: 'pointer', background: 'none', border: 'none', width: '100%', marginBottom: 16 },

  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, marginBottom: 14 },
  cardTitle: { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 7 },
  field: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 },
  label: { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1 },
  required: { color: '#BB162B', marginLeft: 4 },
  input: { padding: '12px 14px', background: 'var(--bg-input, var(--bg-deep))', border: '1px solid var(--border)', borderRadius: 8, fontSize: 16, color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' },
  textarea: { padding: '10px 14px', background: 'var(--bg-input, var(--bg-deep))', border: '1px solid var(--border)', borderRadius: 8, fontSize: 14, color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box', minHeight: 60, resize: 'vertical', fontFamily: 'inherit' },
  hint: { fontSize: 11, color: 'var(--text-secondary)' },

  catGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  catTile: (active: boolean) => ({ display: 'flex', alignItems: 'center', gap: 9, border: active ? '2px solid #BB162B' : '1px solid var(--border)', background: active ? 'rgba(187,22,43,0.07)' : 'var(--bg-card)', borderRadius: 10, padding: '12px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: active ? '#BB162B' : 'var(--text-primary)' }),
  catEmoji: { fontSize: 18, lineHeight: 1 },

  fileBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', borderRadius: 8, cursor: 'pointer', border: '1px dashed var(--border)', background: 'var(--bg-deep)', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', width: '100%' },
  filePicked: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8, background: 'rgba(46,204,138,0.1)', border: '1px solid #2ecc8a55', fontSize: 12, color: '#2ecc8a', fontWeight: 600 },

  btnRed: { padding: '14px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%' },
  btnSec: { padding: '12px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', width: '100%', marginTop: 8 },
  err: { padding: '10px 14px', borderRadius: 8, background: 'rgba(187,22,43,0.1)', border: '1px solid #BB162B44', color: '#BB162B', fontSize: 13, marginBottom: 14 },
  warn: { padding: '10px 14px', borderRadius: 8, background: 'rgba(230,126,34,0.1)', border: '1px solid #e67e2255', color: '#b8720a', fontSize: 12, marginBottom: 14 },
  ok: { padding: '10px 14px', borderRadius: 8, background: 'rgba(46,204,138,0.1)', border: '1px solid #2ecc8a55', color: '#2ecc8a', fontSize: 13, marginBottom: 14 },
  loading: { padding: 40, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 },

  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 18, width: '100%', maxWidth: 420, maxHeight: '90vh', overflowY: 'auto' },
  modalHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 },
  modalTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' },
  modalClose: { marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex' },
  rows: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 14 },
  rowLabel: { color: 'var(--text-secondary)' },
  rowVal: { fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-primary)' },
  diffBox: (kind: 'ok' | 'sobrante' | 'faltante') => ({ marginTop: 8, marginBottom: 12, padding: '11px 14px', borderRadius: 10, fontSize: 14, fontWeight: 700, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: kind === 'ok' ? 'rgba(46,204,138,0.12)' : kind === 'sobrante' ? 'rgba(58,122,212,0.12)' : 'rgba(187,22,43,0.12)', border: `1px solid ${kind === 'ok' ? '#2ecc8a' : kind === 'sobrante' ? '#3A7AD4' : '#BB162B'}`, color: kind === 'ok' ? '#2ecc8a' : kind === 'sobrante' ? '#7db0ee' : '#e88' }),
}

interface Caja {
  id: string; codigo: string; nombre: string; saldo_actual_usd: number
  fondo_fijo_usd: number | null; umbral_alerta_usd: number | null
}

export default function CajaChicaPage() {
  const router = useRouter()
  const { permissions, loading: permsLoading, userId } = useNPAPermissions()

  const [cajaChica, setCajaChica] = useState<Caja | null>(null)
  const [cajaPpal, setCajaPpal]   = useState<Caja | null>(null)
  const [loadingCaja, setLoadingCaja] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  const [montoUsd, setMontoUsd]   = useState('')
  const [categoria, setCategoria] = useState('CC_CAFE_COMIDA')
  const [concepto, setConcepto]   = useState('')
  const [notas, setNotas]         = useState('')
  const [receiptFile, setReceiptFile] = useState<File | null>(null)

  const [showReponer, setShowReponer] = useState(false)
  const [reponerMonto, setReponerMonto] = useState('')
  const [showArqueo, setShowArqueo]   = useState(false)
  const [arqueoConteo, setArqueoConteo] = useState('')
  const [arqueoNotas, setArqueoNotas]   = useState('')
  const [showRepoReq, setShowRepoReq] = useState(false)
  const [repoReqMonto, setRepoReqMonto] = useState('')
  const [repoReqNota, setRepoReqNota]   = useState('')
  // Devoluciones a clientes aprobadas por Tesorería, pendientes de pago en
  // efectivo desde esta caja (EGRESO · DEVOLUCION_CLIENTE, aprobado+SOLICITADO).
  const [devsPagar, setDevsPagar] = useState<any[]>([])
  const [payingDev, setPayingDev] = useState<string | null>(null)

  const canGasto = !permsLoading && (
    permissions.tesoreria_can_register_cc_gasto || permissions.tesoreria_admin || permissions.npa_can_admin
  )
  const canManage = permissions.tesoreria_admin || permissions.npa_can_admin
  // Arqueo is allowed for admins OR holders of the granular arqueo capability
  // (e.g. an auditor counting Caja Chica) — without granting full treasury admin.
  const canArqueo = permissions.tesoreria_admin || permissions.npa_can_admin || permissions.tesoreria_can_arqueo
  // Petty-cash-only replenishment REQUEST (creates a SOLICITADO; an admin executes it).
  const canRepoRequest = (permissions as any).tesoreria_can_request_cc_repo === true

  useEffect(() => {
    if (permsLoading) return
    if (!canGasto && !canArqueo) { router.replace('/tesoreria/home'); return }
    loadCajas()
    loadDevoluciones()
  // eslint-disable-next-line
  }, [permsLoading, canGasto, canArqueo])

  async function loadDevoluciones() {
    const { data } = await (supabase.from('tesoreria_comprobantes')
      .select('id, numero, monto_usd, concepto, contraparte_nombre, source_id, source_label, solicitado_at, aprobado_at')
      .eq('tipo', 'EGRESO').eq('egreso_tipo', 'DEVOLUCION_CLIENTE')
      .eq('revision_estado', 'aprobado').eq('estado', 'SOLICITADO')
      .order('aprobado_at', { ascending: true }) as any)
    setDevsPagar(Array.isArray(data) ? data : [])
  }

  async function loadCajas() {
    setLoadingCaja(true)
    const { data, error } = await supabase
      .from('tesoreria_ubicaciones')
      .select('id, codigo, nombre, saldo_actual_usd, fondo_fijo_usd, umbral_alerta_usd')
      .in('codigo', ['CAJA_CHICA', 'CAJA_PPAL']).eq('activa', true)
    if (error || !data) { setErr('No se encontró Caja Chica. Verifica la migración SQL.'); setLoadingCaja(false); return }
    const cc = data.find((u: any) => u.codigo === 'CAJA_CHICA')
    const pp = data.find((u: any) => u.codigo === 'CAJA_PPAL')
    if (!cc) { setErr('No se encontró Caja Chica.'); setLoadingCaja(false); return }
    setCajaChica(cc as Caja)
    setCajaPpal((pp as Caja) || null)
    setLoadingCaja(false)
  }

  const montoNum = useMemo(() => parseFloat(montoUsd) || 0, [montoUsd])
  const saldo  = Number(cajaChica?.saldo_actual_usd || 0)
  const fondo  = Number(cajaChica?.fondo_fijo_usd || 0)
  const umbral = Number(cajaChica?.umbral_alerta_usd || 0)
  const consumido = Math.max(0, fondo - saldo)
  const pctDisponible = fondo > 0 ? Math.round((saldo / fondo) * 100) : 0
  const low = umbral > 0 && saldo < umbral
  const overSaldo = montoNum > 0 && montoNum > saldo

  const catMeta = useMemo(() => GASTO_CATEGORIAS.find(c => c.value === categoria) || GASTO_CATEGORIAS[0], [categoria])

  async function handleSubmit() {
    setErr(null); setOkMsg(null)
    if (!cajaChica) { setErr('Caja Chica no cargada'); return }
    if (!montoNum || montoNum <= 0) { setErr('Indica un monto válido'); return }
    if (!concepto.trim()) { setErr('Falta el concepto del gasto'); return }
    if (overSaldo) {
      const proceed = confirm(`El gasto (${fmt(montoNum)}) supera el saldo de Caja Chica (${fmt(saldo)}). ¿Registrar de todos modos?`)
      if (!proceed) return
    }
    setSaving(true)
    try {
      const { data: numeroData, error: numeroErr } = await supabase.rpc('tesoreria_next_voucher_numero', { p_tipo: 'EGRESO' })
      if (numeroErr) throw new Error('Error generando número: ' + numeroErr.message)
      const numero = numeroData as string

      const { data: compr, error: comprErr } = await supabase
        .from('tesoreria_comprobantes')
        .insert({
          numero, tipo: 'EGRESO', estado: 'EJECUTADO', monto_usd: montoNum,
          ubicacion_origen_id: cajaChica.id, concepto: concepto.trim(), categoria,
          egreso_tipo: 'CAJA_CHICA_GASTO', source_type: 'MANUAL', source_label: catMeta.label,
          es_urgente: false, qr_payload: '', solicitado_by: userId,
          cerrado_at: new Date().toISOString(), notas: notas.trim() || null,
        })
        .select('*').single()
      if (comprErr) throw new Error('Error creando comprobante: ' + comprErr.message)

      if (receiptFile) {
        try {
          const ext = (receiptFile.name.split('.').pop() || 'jpg').toLowerCase()
          const path = `tesoreria/${compr.id}/recibo.${ext}`
          const { error: upErr } = await supabase.storage.from('comprobantes').upload(path, receiptFile, { upsert: true })
          if (!upErr) {
            const { data: pub } = supabase.storage.from('comprobantes').getPublicUrl(path)
            if (pub?.publicUrl) await supabase.from('tesoreria_comprobantes').update({ egreso_documento_url: pub.publicUrl }).eq('id', compr.id)
          }
        } catch { /* recibo best-effort */ }
      }

      const { error: movErr } = await supabase.from('tesoreria_movimientos').insert({
        ubicacion_id: cajaChica.id, tipo: 'CAJA_CHICA_GASTO', monto_usd: montoNum, signo: -1,
        source_type: 'MANUAL', source_label: catMeta.label, comprobante_id: compr.id,
        descripcion: concepto.trim(), categoria, registered_by: userId,
      })
      if (movErr) throw new Error('Error registrando movimiento: ' + movErr.message)

      try { await supabase.rpc('tesoreria_recompute_saldos') } catch (e) { console.warn('[caja-chica] recompute', e) }

      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: compr.id, evento: 'EJECUTADO', actor_user_id: userId, actor_label: 'Caja Chica',
        notas: `Gasto ${catMeta.label}` + (notas.trim() ? ` · ${notas.trim()}` : ''),
      })

      router.push(`/tesoreria/comprobante?id=${compr.id}&created=1`)
    } catch (e: any) { setErr(e.message || 'Error inesperado al registrar el gasto'); setSaving(false) }
  }

  // ── Pagar devolución al cliente (aprobada por Tesorería) ─────────────────
  // Cadena contable: movimiento −1 en Caja Chica → gasto de caja chica →
  // comprobante EJECUTADO (guard anti-doble-pago) → recompute saldos →
  // línea NEGATIVA en deal.pagos (el sobrante deja de contar como utilidad)
  // → evento EJECUTADO. Sin permite_negativo: si el saldo no alcanza, no se paga.
  async function handlePagarDevolucion(dev: any) {
    setErr(null); setOkMsg(null)
    if (!cajaChica) { setErr('Caja Chica no cargada'); return }
    const monto = Number(dev.monto_usd || 0)
    const cliente = dev.contraparte_nombre || 'cliente'
    if (monto <= 0) { setErr('Monto inválido en la devolución.'); return }
    if (monto > saldo) {
      setErr(`Saldo de Caja Chica insuficiente para pagar esta devolución (${fmt(monto)} > ${fmt(saldo)}). Repón el fondo antes de pagar.`)
      return
    }
    const ok = confirm(`¿Pagar ${fmt(monto)} en efectivo a ${cliente}?\n\nDevolución ${dev.numero} · ${dev.source_label || ''}\n\nEl monto sale de Caja Chica y se descuenta del negocio de origen.`)
    if (!ok) return
    setPayingDev(dev.id)
    try {
      // Re-chequeo fresco anti-doble-ejecución (otro custodio pudo pagarla ya).
      const { data: fresh } = await (supabase.from('tesoreria_comprobantes')
        .select('estado, revision_estado').eq('id', dev.id).single() as any)
      if (!fresh || fresh.estado !== 'SOLICITADO' || fresh.revision_estado !== 'aprobado') {
        throw new Error('Esta devolución ya fue pagada o anulada. Actualizando la lista…')
      }

      // 1. Movimiento −1 en Caja Chica (monto_usd siempre > 0; el signo va aparte).
      const { data: mov, error: movErr } = await (supabase.from('tesoreria_movimientos').insert({
        ubicacion_id: cajaChica.id, tipo: 'DEVOLUCION_CLIENTE', monto_usd: monto, signo: -1,
        source_type: 'EGRESO', source_label: dev.source_label || null, comprobante_id: dev.id,
        descripcion: `Devolución a ${cliente} · ${dev.numero}`, categoria: 'DEVOLUCION_CLIENTE',
        registered_by: userId,
      }).select('id').single() as any)
      if (movErr) throw new Error('Error registrando el movimiento: ' + movErr.message)

      // 2. Registro en gastos de caja chica (detalle para el reporte del fondo).
      //    Si falla NO se aborta: el dinero ya salió en el paso 1 y abortar aquí
      //    dejaría la cadena a medias (reintentar duplicaría el movimiento).
      let gastoWarn = ''
      const { error: gastoErr } = await (supabase.from('tesoreria_caja_chica_gastos').insert({
        ubicacion_id: cajaChica.id, monto_usd: monto, categoria: 'DEVOLUCION_CLIENTE',
        descripcion: dev.concepto || `Devolución ${dev.numero}`, beneficiario: cliente,
        movimiento_id: mov?.id || null, registered_by: userId,
      }) as any)
      if (gastoErr) {
        console.warn('[devolucion] gasto caja chica no registrado:', gastoErr)
        gastoWarn = ' (Aviso: no se pudo escribir el detalle en gastos de caja chica — avisa a Franco.)'
      }

      // 3. Comprobante → EJECUTADO. Guard sobre estado para no ejecutar dos veces.
      const now = new Date().toISOString()
      const { data: upd, error: updErr } = await (supabase.from('tesoreria_comprobantes')
        .update({ estado: 'EJECUTADO', confirmado_by: userId, confirmado_at: now, cerrado_at: now })
        .eq('id', dev.id).eq('estado', 'SOLICITADO').select('id') as any)
      if (updErr) throw new Error('Error cerrando el comprobante: ' + updErr.message)
      if (!Array.isArray(upd) || upd.length === 0) throw new Error('El comprobante ya no estaba SOLICITADO — verifica en el historial antes de reintentar.')

      // 4. Recompute autoritativo (el trigger incremental se pierde por el pooler).
      try { await supabase.rpc('tesoreria_recompute_saldos') } catch (e) { console.warn('[devolucion] recompute', e) }

      // 5. SYNC AL DEAL: línea negativa en deals.pagos + total_recibido = suma
      //    + resultado_tipo recalculado (la columna guardada solo se recalcula
      //    al guardar en /auditoria; sin esto el listado/P&L seguiría diciendo
      //    SOBRANTE después de devolver). Misma fórmula que calcTotals:
      //    au_total = Σ au_* + max(0, pv_igtf − au_igtf); neto = au_total − ingresos.
      let dealWarn = ''
      if (dev.source_id) {
        const { data: dl, error: dlErr } = await (supabase.from('deals')
          .select('id, pagos, negocio_num, pv_igtf, au_precio, au_gastos_admin, au_seguro, au_igtf, au_accesorios, au_comision_flat, au_placas')
          .eq('id', dev.source_id).maybeSingle() as any)
        if (dlErr || !dl) {
          dealWarn = ' (Aviso: no se encontró el negocio de origen — la devolución NO quedó descontada en el deal; avisa a Franco.)'
        } else {
          const pagos = Array.isArray(dl.pagos) ? [...dl.pagos] : []
          pagos.push({
            fecha: new Date().toISOString().slice(0, 10), metodo: 'Devolución',
            monto_usd: -monto, monto_bs: 0, referencia: dev.numero,
            comentario: `Devolución al cliente · ${dev.concepto || ''}`.trim(),
            _comprobante_id: dev.id,
          })
          const total_recibido = pagos.reduce((s: number, p: any) => s + (parseFloat(p.monto_usd) || 0), 0)
          const au_total = ['au_precio', 'au_gastos_admin', 'au_seguro', 'au_igtf', 'au_accesorios', 'au_comision_flat', 'au_placas']
            .reduce((s: number, k: string) => s + (Number(dl[k]) || 0), 0)
            + Math.max(0, (Number(dl.pv_igtf) || 0) - (Number(dl.au_igtf) || 0))
          const neto = au_total - total_recibido
          const resultado_tipo = Math.abs(neto) <= 0.05 ? 'CUADRADO' : neto > 0 ? 'FALTANTE' : 'SOBRANTE'
          const { error: syncErr } = await (supabase.from('deals')
            .update({ pagos, total_recibido, resultado_tipo }).eq('id', dl.id) as any)
          if (syncErr) {
            console.warn('[devolucion] deal sync', syncErr)
            dealWarn = ' (Aviso: el pago salió de caja pero no se pudo descontar en el negocio — avisa a Franco.)'
          }
        }
      }

      // 6. Evento EJECUTADO.
      await supabase.from('tesoreria_comprobante_eventos').insert({
        comprobante_id: dev.id, evento: 'EJECUTADO', actor_user_id: userId, actor_label: 'Caja Chica',
        notas: `Pagado al cliente en efectivo · ${fmt(monto)} · ${cliente}`,
      })

      setOkMsg(`Devolución ${dev.numero} pagada: ${fmt(monto)} a ${cliente}.` + gastoWarn + dealWarn)
      await Promise.all([loadCajas(), loadDevoluciones()])
    } catch (e: any) {
      setErr(e?.message || 'Error inesperado al pagar la devolución')
      await loadDevoluciones()
    } finally { setPayingDev(null) }
  }

  function openReponer() {
    const topUp = Math.max(0, fondo - saldo)
    setReponerMonto(topUp > 0 ? topUp.toFixed(2) : '')
    setErr(null); setOkMsg(null); setShowReponer(true)
  }
  async function handleReponer() {
    setErr(null)
    if (!cajaChica || !cajaPpal) { setErr('Cajas no cargadas'); return }
    const m = parseFloat(reponerMonto) || 0
    if (!m || m <= 0) { setErr('Indica un monto válido'); return }
    if (m > Number(cajaPpal.saldo_actual_usd)) { setErr(`Caja Principal solo tiene ${fmt(Number(cajaPpal.saldo_actual_usd))}.`); return }
    setSaving(true)
    try {
      const { data: numeroData, error: nErr } = await supabase.rpc('tesoreria_next_voucher_numero', { p_tipo: 'EGRESO' })
      if (nErr) throw new Error('Error generando número: ' + nErr.message)
      const numero = numeroData as string
      const concepto = `Reposición de Caja Chica al fondo (${fmt(fondo)})`
      const { data: compr, error: cErr } = await supabase.from('tesoreria_comprobantes').insert({
        numero, tipo: 'EGRESO', estado: 'EJECUTADO', monto_usd: m,
        ubicacion_origen_id: cajaPpal.id, ubicacion_destino_id: cajaChica.id,
        concepto, categoria: 'CAJA_CHICA_REPO', egreso_tipo: 'CAJA_CHICA_REPO',
        source_type: 'MANUAL', source_label: 'Reposición Caja Chica', es_urgente: false,
        qr_payload: '', solicitado_by: userId, cerrado_at: new Date().toISOString(),
      }).select('*').single()
      if (cErr) throw new Error('Error creando comprobante: ' + cErr.message)
      const { error: mErr } = await supabase.from('tesoreria_movimientos').insert([
        { ubicacion_id: cajaPpal.id,  tipo: 'EGRESO_CAJA_CHICA', monto_usd: m, signo: -1, source_type: 'EGRESO', source_label: 'Reposición Caja Chica', comprobante_id: compr.id, descripcion: `Reposición caja chica · ${numero}`, categoria: 'CAJA_CHICA_REPO', registered_by: userId },
        { ubicacion_id: cajaChica.id, tipo: 'EGRESO_CAJA_CHICA', monto_usd: m, signo:  1, source_type: 'EGRESO', source_label: 'Reposición Caja Chica', comprobante_id: compr.id, descripcion: `Reposición caja chica · ${numero}`, categoria: 'CAJA_CHICA_REPO', registered_by: userId },
      ])
      if (mErr) throw new Error('Error registrando movimientos: ' + mErr.message)
      try { await supabase.rpc('tesoreria_recompute_saldos') } catch (e) { console.warn('[reponer] recompute', e) }
      setShowReponer(false); setOkMsg(`Caja Chica repuesta con ${fmt(m)}.`)
      await loadCajas()
    } catch (e: any) { setErr(e.message || 'Error al reponer') } finally { setSaving(false) }
  }

  function openRepoReq() {
    const topUp = Math.max(0, fondo - saldo)
    setRepoReqMonto(topUp > 0 ? topUp.toFixed(2) : '')
    setRepoReqNota(''); setErr(null); setOkMsg(null); setShowRepoReq(true)
  }
  async function handleRepoRequest() {
    setErr(null)
    if (!cajaChica || !cajaPpal) { setErr('Cajas no cargadas'); return }
    const m = parseFloat(repoReqMonto) || 0
    if (!m || m <= 0) { setErr('Indica un monto válido'); return }
    setSaving(true)
    try {
      const { data: numeroData, error: nErr } = await supabase.rpc('tesoreria_next_voucher_numero', { p_tipo: 'EGRESO' })
      if (nErr) throw new Error('Error generando número: ' + nErr.message)
      const numero = numeroData as string
      const concepto = `Solicitud de reposición de Caja Chica` + (repoReqNota.trim() ? ` · ${repoReqNota.trim()}` : '')
      // SOLICITADO only — no movimientos here; money moves when an admin executes it.
      const { error: cErr } = await supabase.from('tesoreria_comprobantes').insert({
        numero, tipo: 'EGRESO', estado: 'SOLICITADO', monto_usd: m,
        ubicacion_origen_id: cajaPpal.id, ubicacion_destino_id: cajaChica.id,
        concepto, categoria: 'CAJA_CHICA_REPO', egreso_tipo: 'CAJA_CHICA_REPO',
        source_type: 'MANUAL', source_label: 'Solicitud reposición Caja Chica', es_urgente: false,
        qr_payload: '', solicitado_by: userId, notas: repoReqNota.trim() || null,
      })
      if (cErr) throw new Error('Error creando solicitud: ' + cErr.message)
      setShowRepoReq(false); setOkMsg(`Solicitud de reposición enviada (${fmt(m)}). Un administrador la aprobará.`)
    } catch (e: any) { setErr(e.message || 'Error al solicitar') } finally { setSaving(false) }
  }
  const arqueoConteoNum = arqueoConteo === '' ? null : parseFloat(arqueoConteo)
  const arqueoDif = arqueoConteoNum === null || isNaN(arqueoConteoNum) ? null : Number((arqueoConteoNum - saldo).toFixed(2))
  const arqueoKind: 'ok' | 'sobrante' | 'faltante' = arqueoDif === null || arqueoDif === 0 ? 'ok' : arqueoDif > 0 ? 'sobrante' : 'faltante'
  const arqueoNeedsNote = arqueoDif !== null && arqueoDif !== 0

  function openArqueo() { setArqueoConteo(''); setArqueoNotas(''); setErr(null); setOkMsg(null); setShowArqueo(true) }
  async function handleArqueo() {
    setErr(null)
    if (!cajaChica) { setErr('Caja Chica no cargada'); return }
    if (arqueoConteoNum === null || isNaN(arqueoConteoNum) || arqueoConteoNum < 0) { setErr('Indica el conteo físico'); return }
    if (arqueoNeedsNote && !arqueoNotas.trim()) { setErr('La diferencia requiere una nota'); return }
    setSaving(true)
    try {
      const dif = Number((arqueoConteoNum - saldo).toFixed(2))
      const { error: aErr } = await supabase.from('tesoreria_arqueos').insert({
        ubicacion_id: cajaChica.id, saldo_sistema: saldo, conteo_fisico: arqueoConteoNum,
        diferencia: dif, contado_por: userId, notas: arqueoNotas.trim() || null,
      })
      if (aErr) throw new Error('Error registrando arqueo: ' + aErr.message)
      if (dif !== 0) {
        const etiqueta = dif > 0 ? 'sobrante' : 'faltante'
        const { error: mErr } = await supabase.from('tesoreria_movimientos').insert({
          ubicacion_id: cajaChica.id, tipo: 'ARQUEO_AJUSTE', monto_usd: Math.abs(dif), signo: dif > 0 ? 1 : -1,
          source_type: 'ARQUEO', source_label: `Arqueo ${etiqueta}`, comprobante_id: null,
          descripcion: `Arqueo: ${etiqueta} de ${fmt(Math.abs(dif))} · ${arqueoNotas.trim()}`, categoria: 'ARQUEO', registered_by: userId,
        })
        if (mErr) throw new Error('Error registrando ajuste de arqueo: ' + mErr.message)
        try { await supabase.rpc('tesoreria_recompute_saldos') } catch (e) { console.warn('[arqueo] recompute', e) }
      }
      setShowArqueo(false)
      setOkMsg(dif === 0 ? 'Arqueo registrado: cuadra.' : `Arqueo registrado. Ajustado al conteo físico (${dif > 0 ? '+' : '−'}${fmt(Math.abs(dif))}).`)
      await loadCajas()
    } catch (e: any) { setErr(e.message || 'Error en el arqueo') } finally { setSaving(false) }
  }

  if (permsLoading || loadingCaja) {
    return (<AdminShell active="caja-chica"><div style={s.topBar}><div style={s.title}>Caja Chica</div></div><div style={s.loading}>Cargando…</div></AdminShell>)
  }
  if (!canGasto) return null

  return (
    <AdminShell active="caja-chica">
      <div style={s.topBar}>
        <button style={s.backBtn} onClick={() => router.push('/tesoreria/home')} aria-label="Volver"><ArrowLeft size={20} strokeWidth={2.4} /></button>
        <div style={s.title}>Caja Chica</div>
      </div>

      <div style={s.content}>
        {cajaChica && (
          <div style={s.saldoCard}>
            <div style={s.saldoTop}>
              <div><div style={s.saldoLabel}>Saldo actual</div><div style={s.saldoAmount}>{fmt(saldo)}</div></div>
              {fondo > 0 && <div><div style={s.fondoLabel}>Fondo fijo</div><div style={s.fondoAmount}>{fmt(fondo)}</div></div>}
            </div>
            {fondo > 0 && (
              <div style={s.barWrap}>
                <div style={s.barTrack}><div style={s.barFill(pctDisponible, low)} /></div>
                <div style={s.barMeta}><span>Disponible {pctDisponible}%</span><span>Consumido {fmt(consumido)}</span></div>
              </div>
            )}
          </div>
        )}

        {low && (
          <div style={s.alert}>
            <AlertTriangle size={18} strokeWidth={2.2} color="#e88" />
            <span style={s.alertTxt}>Saldo bajo (bajo el umbral de {fmt(umbral)}).{canManage ? ' Conviene reponer al fondo.' : ' Avisa para reponer.'}</span>
          </div>
        )}

        {err && <div style={s.err}>{err}</div>}
        {okMsg && !err && <div style={s.ok}>{okMsg}</div>}

        {(canManage || canArqueo || canRepoRequest) && (
          <div style={s.actionRow}>
            {canManage && <button style={s.actBtn} onClick={openReponer}><Wallet size={20} color="#2ecc8a" strokeWidth={2.2} /><span style={s.actLabel}>Reponer fondo</span></button>}
            {canRepoRequest && !canManage && <button style={s.actBtn} onClick={openRepoReq}><Wallet size={20} color="#2ecc8a" strokeWidth={2.2} /><span style={s.actLabel}>Solicitar reposición</span></button>}
            {canArqueo && <button style={s.actBtn} onClick={openArqueo}><Calculator size={20} color="#e0b463" strokeWidth={2.2} /><span style={s.actLabel}>Arqueo</span></button>}
          </div>
        )}
        <button style={s.histLink} onClick={() => router.push('/tesoreria/caja-chica/historial')}>Ver historial y reporte <ChevronRight size={14} /></button>

        {/* ── Devoluciones a clientes aprobadas, pendientes de pago ── */}
        {devsPagar.length > 0 && (
          <div style={{ ...s.card, border: '1px solid rgba(187,22,43,0.45)' }}>
            <div style={{ ...s.cardTitle, color: '#BB162B' }}>↩ Devoluciones aprobadas por pagar ({devsPagar.length})</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 12 }}>
              Aprobadas por Tesorería. Se pagan en efectivo desde esta caja cuando decidas; el monto se descuenta del negocio de origen.
            </div>
            {devsPagar.map((dev: any) => {
              const monto = Number(dev.monto_usd || 0)
              const alcanza = monto <= saldo
              return (
                <div key={dev.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>{dev.contraparte_nombre || '—'}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{dev.source_label || ''}</div>
                    </div>
                    <div style={{ fontSize: 17, fontWeight: 800, fontFamily: 'monospace', color: '#BB162B', whiteSpace: 'nowrap' }}>−{fmt(monto)}</div>
                  </div>
                  {dev.concepto && <div style={{ fontSize: 12, color: 'var(--text-primary)', margin: '8px 0 0', lineHeight: 1.4 }}>{dev.concepto}</div>}
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '6px 0 10px' }}>
                    {dev.numero}
                    {dev.aprobado_at ? ` · aprobada ${String(dev.aprobado_at).slice(0, 10)}` : ''}
                    {' · '}
                    <a href={`/tesoreria/comprobante?id=${dev.id}`} style={{ color: '#3A7AD4' }}>ver comprobante</a>
                  </div>
                  {!alcanza && (
                    <div style={{ ...s.warn, marginBottom: 10 }}>⚠ El saldo de Caja Chica ({fmt(saldo)}) no alcanza para esta devolución. Repón el fondo antes de pagar.</div>
                  )}
                  <button
                    style={{ ...s.btnRed, opacity: alcanza && payingDev !== dev.id ? 1 : 0.5, cursor: alcanza ? 'pointer' : 'not-allowed' }}
                    disabled={!alcanza || payingDev !== null}
                    onClick={() => handlePagarDevolucion(dev)}
                  >
                    {payingDev === dev.id ? 'Pagando…' : `✓ Pagar al cliente · ${fmt(monto)}`}
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <div style={s.card}>
          <div style={s.cardTitle}><Receipt size={15} strokeWidth={2.4} /> Registrar gasto</div>

          {overSaldo && <div style={s.warn}>⚠ Este gasto supera el saldo disponible de Caja Chica.</div>}

          <div style={s.field}>
            <label style={s.label}>Monto USD<span style={s.required}>*</span></label>
            <input style={s.input} type="number" inputMode="decimal" step="0.01" min="0.01" value={montoUsd} onChange={e => setMontoUsd(e.target.value)} placeholder="0.00" />
          </div>

          <div style={s.field}>
            <label style={s.label}>Categoría<span style={s.required}>*</span></label>
            <div style={s.catGrid}>
              {GASTO_CATEGORIAS.map(c => (
                <div key={c.value} style={s.catTile(categoria === c.value)} onClick={() => setCategoria(c.value)}>
                  <span style={s.catEmoji}>{c.emoji}</span>{c.label}
                </div>
              ))}
            </div>
          </div>

          <div style={s.field}>
            <label style={s.label}>Concepto<span style={s.required}>*</span></label>
            <input style={s.input} type="text" value={concepto} onChange={e => setConcepto(e.target.value)} placeholder="Ej: Almuerzo equipo taller" />
            <span style={s.hint}>Qué se compró. Aparece impreso en el comprobante.</span>
          </div>

          <div style={s.field}>
            <label style={s.label}>Recibo / Foto (opcional)</label>
            {receiptFile ? (
              <div style={s.filePicked}>
                <Check size={14} strokeWidth={2.6} />{receiptFile.name}
                <span style={{ marginLeft: 'auto', cursor: 'pointer', color: 'var(--text-secondary)' }} onClick={() => setReceiptFile(null)}>✕</span>
              </div>
            ) : (
              <label style={s.fileBtn}>
                <Camera size={16} strokeWidth={2.2} />Adjuntar foto del recibo
                <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) setReceiptFile(f) }} />
              </label>
            )}
            <span style={s.hint}>No es obligatorio — puedes registrar el gasto sin recibo.</span>
          </div>

          <div style={s.field}>
            <label style={s.label}>Notas internas (opcional)</label>
            <textarea style={s.textarea} value={notas} onChange={e => setNotas(e.target.value)} placeholder="Cualquier observación adicional…" />
          </div>

          <button style={s.btnRed} onClick={handleSubmit} disabled={saving}>
            {saving ? 'Registrando…' : (<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Receipt size={16} strokeWidth={2.4} />Registrar Gasto · {fmt(montoNum)}</span>)}
          </button>
          <button style={s.btnSec} onClick={() => router.push('/tesoreria/home')} disabled={saving}>Cancelar</button>
        </div>
      </div>

      {showReponer && (
        <div style={s.overlay} onClick={() => !saving && setShowReponer(false)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHead}>
              <Wallet size={18} color="#2ecc8a" strokeWidth={2.4} />
              <span style={s.modalTitle}>Reponer al fondo</span>
              <button style={s.modalClose} onClick={() => setShowReponer(false)} aria-label="Cerrar"><X size={18} /></button>
            </div>
            <div style={s.rows}>
              <div style={s.row}><span style={s.rowLabel}>Saldo Caja Chica</span><span style={s.rowVal}>{fmt(saldo)}</span></div>
              <div style={s.row}><span style={s.rowLabel}>Fondo fijo</span><span style={s.rowVal}>{fmt(fondo)}</span></div>
              {cajaPpal && <div style={s.row}><span style={s.rowLabel}>Disponible en Caja Principal</span><span style={s.rowVal}>{fmt(Number(cajaPpal.saldo_actual_usd))}</span></div>}
            </div>
            <div style={s.field}>
              <label style={s.label}>Monto a reponer (USD)</label>
              <input style={s.input} type="number" inputMode="decimal" step="0.01" min="0.01" value={reponerMonto} onChange={e => setReponerMonto(e.target.value)} placeholder="0.00" />
              <span style={s.hint}>Sugerido para llegar al fondo: {fmt(Math.max(0, fondo - saldo))}. Sale de Caja Principal.</span>
            </div>
            <button style={s.btnRed} onClick={handleReponer} disabled={saving}>{saving ? 'Reponiendo…' : `Reponer ${fmt(parseFloat(reponerMonto) || 0)}`}</button>
          </div>
        </div>
      )}

      {showRepoReq && (
        <div style={s.overlay} onClick={() => !saving && setShowRepoReq(false)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHead}>
              <Wallet size={18} color="#2ecc8a" strokeWidth={2.4} />
              <span style={s.modalTitle}>Solicitar reposición</span>
              <button style={s.modalClose} onClick={() => setShowRepoReq(false)} aria-label="Cerrar"><X size={18} /></button>
            </div>
            <div style={s.rows}>
              <div style={s.row}><span style={s.rowLabel}>Saldo Caja Chica</span><span style={s.rowVal}>{fmt(saldo)}</span></div>
              <div style={s.row}><span style={s.rowLabel}>Fondo fijo</span><span style={s.rowVal}>{fmt(fondo)}</span></div>
            </div>
            <div style={s.field}>
              <label style={s.label}>Monto a solicitar (USD)</label>
              <input style={s.input} type="number" inputMode="decimal" step="0.01" min="0.01" value={repoReqMonto} onChange={e => setRepoReqMonto(e.target.value)} placeholder="0.00" />
              <span style={s.hint}>Sugerido para llegar al fondo: {fmt(Math.max(0, fondo - saldo))}. Un administrador aprueba la reposición; no mueve dinero todavía.</span>
            </div>
            <div style={s.field}>
              <label style={s.label}>Nota (opcional)</label>
              <textarea style={s.textarea} value={repoReqNota} onChange={e => setRepoReqNota(e.target.value)} placeholder="Motivo o detalle de la solicitud…" />
            </div>
            <button style={s.btnRed} onClick={handleRepoRequest} disabled={saving}>{saving ? 'Enviando…' : 'Enviar solicitud'}</button>
          </div>
        </div>
      )}

      {showArqueo && (
        <div style={s.overlay} onClick={() => !saving && setShowArqueo(false)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHead}>
              <Calculator size={18} color="#e0b463" strokeWidth={2.4} />
              <span style={s.modalTitle}>Arqueo de Caja Chica</span>
              <button style={s.modalClose} onClick={() => setShowArqueo(false)} aria-label="Cerrar"><X size={18} /></button>
            </div>
            <div style={s.rows}><div style={s.row}><span style={s.rowLabel}>Saldo de sistema</span><span style={s.rowVal}>{fmt(saldo)}</span></div></div>
            <div style={s.field}>
              <label style={s.label}>Conteo físico (USD)<span style={s.required}>*</span></label>
              <input style={s.input} type="number" inputMode="decimal" step="0.01" min="0" value={arqueoConteo} onChange={e => setArqueoConteo(e.target.value)} placeholder="0.00" />
              <span style={s.hint}>Cuenta el efectivo real en la caja.</span>
            </div>
            {arqueoDif !== null && (
              <div style={s.diffBox(arqueoKind)}>
                <span>{arqueoKind === 'ok' ? 'Cuadra ✓' : arqueoKind === 'sobrante' ? 'Sobrante' : 'Faltante'}</span>
                <span style={{ fontFamily: 'monospace' }}>{arqueoDif === 0 ? fmt(0) : `${arqueoDif > 0 ? '+' : '−'}${fmt(Math.abs(arqueoDif))}`}</span>
              </div>
            )}
            {arqueoNeedsNote && (
              <div style={s.field}>
                <label style={s.label}>Nota (obligatoria)<span style={s.required}>*</span></label>
                <textarea style={s.textarea} value={arqueoNotas} onChange={e => setArqueoNotas(e.target.value)} placeholder="¿Por qué no cuadra?" />
                <span style={s.hint}>El ajuste lleva el sistema al conteo físico.</span>
              </div>
            )}
            <button style={s.btnRed} onClick={handleArqueo} disabled={saving}>{saving ? 'Registrando…' : 'Registrar arqueo'}</button>
          </div>
        </div>
      )}
    </AdminShell>
  )
}