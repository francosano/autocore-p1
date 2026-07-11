// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/handoff.ts
// AutoCore NPA — End-of-day handoff: physical cash transfer PC → Tesorería
//
// MODEL (Path B, 2026-05-21 · revised 2026-05-25):
//   A handoff batch is a PURE CASH TRANSFER from PC_MIRLA → CAJA_PPAL,
//   decoupled from comprobantes. Mirla decides how much cash she's handing
//   over (defaults to current PC_MIRLA saldo, editable).
//
//   RECEIPT SNAPSHOT (2026-06-16): createHandoffBatch now writes a read-only
//   snapshot of the deposits that make up the handoff into
//   tesoreria_handoff_batch_items, purely so the printed receipt can itemize
//   "$8k cliente A · $7k cliente B · excedente $X". This snapshot does NOT
//   drive any cash math — the batch total_usd remains the single source of
//   truth, and confirmHandoffBatch is unchanged. Snapshot writes are
//   best-effort: a failure logs a warning and never blocks the handoff.
//
//   On confirmation: 2 movimientos fire — −1 PC_MIRLA / +1 CAJA_PPAL — for
//   the batch monto. Trigger updates saldos automatically.
//
// COMPROBANTES (separate concern, REVISED 2026-05-25):
//   PENDIENTE_PICKUP → PICKUP_CONFIRMADO via individual QR scan ALSO moves
//   PC_MIRLA → CAJA_PPAL for that single comprobante. Either path (individual
//   scan or batch handoff) ends up depleting PC_MIRLA.
//
//   loadPendingComprobantes filters by "cash still in PC_MIRLA" — a
//   comprobante is excluded if its net movimientos on PC_MIRLA are ≤ 0
//   (cash already left via PICKUP_TRANSFER, HANDOFF, anular, or any other
//   debit). This prevents zombie rows from old confirmed handoffs.
// ═══════════════════════════════════════════════════════════════════════════
import { supabase } from './supabase'

export type HandoffEstado = 'PREPARADO' | 'RECIBIDO' | 'ANULADO'

export interface HandoffBatch {
  id: string
  numero: string
  estado: HandoffEstado
  from_user_id: string | null
  to_user_id: string | null
  qr_payload: string
  total_count: number   // # of deposit lines snapshotted onto the receipt
  total_usd: number     // the cash amount being handed over (source of truth)
  preparado_at: string
  recibido_at: string | null
  anulado_at: string | null
  anulado_motivo: string | null
  notas: string | null
}

// Informational: comprobantes Mirla holds in PC_MIRLA right now.
// Shown on /tesoreria/entrega for context. Also passed to createHandoffBatch
// so the receipt can snapshot which deposits make up the handoff.
export interface PendingComprobante {
  id: string
  numero: string
  estado: 'PENDIENTE_PICKUP' | 'PICKUP_CONFIRMADO'
  monto_usd: number
  concepto: string | null
  contraparte_nombre: string | null
  source_label: string | null
  solicitado_at: string | null
}

export async function nextHandoffNumero(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `ENT-`
  const { count } = await supabase
    .from('tesoreria_handoff_batches')
    .select('id', { count: 'exact', head: true })
    .like('numero', `${prefix}%-${year}`)
  const n = (count || 0) + 1
  return `${prefix}${String(n).padStart(4, '0')}-${year}`
}

export function buildHandoffQRPayload(batchId: string): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://autocore-npa.pages.dev'
  return `${origin}/tesoreria/handoff?id=${batchId}&confirm=1`
}

// Load comprobantes whose cash is STILL physically in PC_MIRLA.
// Filter: state must be PENDIENTE_PICKUP or PICKUP_CONFIRMADO AND the net
// movimientos for the comprobante on the punto must sum > 0 (cash hasn't
// left yet via PICKUP_TRANSFER, HANDOFF, anular, etc.).
export async function loadPendingComprobantes(
  puntoCobroUbicacionId: string,
): Promise<PendingComprobante[]> {
  // Step 1: fetch candidates by state + destino.
  const { data: candidates, error } = await supabase
    .from('tesoreria_comprobantes')
    .select('id, numero, estado, monto_usd, concepto, contraparte_nombre, source_label, solicitado_at')
    .eq('tipo', 'INGRESO')
    .in('estado', ['PENDIENTE_PICKUP', 'PICKUP_CONFIRMADO'])
    .eq('ubicacion_destino_id', puntoCobroUbicacionId)
    .order('solicitado_at', { ascending: true })
  if (error) throw error
  if (!candidates || candidates.length === 0) return []

  // Step 2: for each candidate, query its net movimiento on PC. Keep only
  // those with net > 0 (cash still parked at the punto).
  const ids = candidates.map((c: any) => c.id)
  const { data: movs, error: mErr } = await supabase
    .from('tesoreria_movimientos')
    .select('comprobante_id, monto_usd, signo, ubicacion_id')
    .in('comprobante_id', ids)
    .eq('ubicacion_id', puntoCobroUbicacionId)
  if (mErr) throw mErr

  // Build net-per-comprobante map.
  const netByComp: Record<string, number> = {}
  ;(movs || []).forEach((m: any) => {
    const key = m.comprobante_id as string
    netByComp[key] = (netByComp[key] || 0) + (Number(m.monto_usd) * Number(m.signo))
  })

  // Keep candidates whose net is still positive at the punto.
  // Tolerance of 0.005 to absorb floating-point noise.
  return (candidates as any[]).filter(c => (netByComp[c.id] || 0) > 0.005) as PendingComprobante[]
}

// Get current PC_MIRLA saldo — what Mirla CAN hand over.
export async function getPuntoCobroSaldo(puntoCobroUbicacionId: string): Promise<number> {
  const { data, error } = await supabase
    .from('tesoreria_ubicaciones')
    .select('saldo_actual_usd')
    .eq('id', puntoCobroUbicacionId)
    .single()
  if (error) throw error
  return Number(data?.saldo_actual_usd || 0)
}

export interface CreateBatchInput {
  numero: string
  fromUserId: string
  montoUsd: number
  notas?: string | null
  // Context deposits held in PC_MIRLA at prepare time. Used ONLY to snapshot
  // the receipt breakdown (which deposits make up the handoff). Optional —
  // if omitted, the batch is created exactly as before with no line items.
  pending?: PendingComprobante[]
}

export async function createHandoffBatch(input: CreateBatchInput): Promise<HandoffBatch> {
  if (!input.montoUsd || input.montoUsd <= 0) {
    throw new Error('El monto de la entrega debe ser mayor a 0.')
  }
  const { data: batchRow, error: e1 } = await supabase
    .from('tesoreria_handoff_batches')
    .insert({
      numero: input.numero,
      estado: 'PREPARADO',
      from_user_id: input.fromUserId,
      qr_payload: 'pending',
      total_count: 0,
      total_usd: input.montoUsd,
      notas: input.notas || null,
    })
    .select('*')
    .single()
  if (e1) throw new Error('Error creando batch: ' + e1.message)

  const qrPayload = buildHandoffQRPayload(batchRow.id)
  const { error: e2 } = await supabase
    .from('tesoreria_handoff_batches')
    .update({ qr_payload: qrPayload })
    .eq('id', batchRow.id)
  if (e2) throw new Error('Error actualizando QR: ' + e2.message)

  // ── Receipt snapshot (best-effort; does NOT affect cash accounting) ────────
  // Record WHICH deposits make up this handoff so the printed receipt can
  // itemize them. Allocate the handed-over monto across the pending deposits
  // oldest-first (same rule confirmHandoffBatch uses); any cash beyond the
  // covered deposits is logged as a single RESIDUAL ("excedente") line.
  // Any failure here only logs a warning — the handoff is never blocked, and
  // the batch total_usd remains the source of truth.
  try {
    const pend = (input.pending || []).slice()
    let budget = input.montoUsd
    const pickupItems: any[] = []
    for (const c of pend) {
      const cm = Number(c.monto_usd)
      if (cm > budget + 0.005) continue   // not enough monto left — leave it out
      budget -= cm
      pickupItems.push({
        batch_id: batchRow.id,
        comprobante_id: c.id,
        monto_usd: cm,
        kind: 'PICKUP',
        recibido: false,
      })
    }

    if (pickupItems.length > 0) {
      const { error: iErr } = await supabase
        .from('tesoreria_handoff_batch_items')
        .insert(pickupItems)
      if (iErr) {
        console.warn('[handoff] snapshot items warning', iErr.message)
      } else {
        await supabase
          .from('tesoreria_handoff_batches')
          .update({ total_count: pickupItems.length })
          .eq('id', batchRow.id)
      }
    }

    // Excedente: cash handed over beyond the covered deposits. Separate insert
    // so a NOT NULL on comprobante_id (if any) can't void the deposit lines.
    const residual = Math.round(budget * 100) / 100
    if (residual > 0.005) {
      const { error: rErr } = await supabase
        .from('tesoreria_handoff_batch_items')
        .insert({
          batch_id: batchRow.id,
          comprobante_id: null,
          monto_usd: residual,
          kind: 'RESIDUAL',
          recibido: false,
        })
      if (rErr) console.warn('[handoff] residual snapshot warning', rErr.message)
    }
  } catch (e: any) {
    console.warn('[handoff] receipt snapshot skipped', e?.message)
  }

  return { ...(batchRow as HandoffBatch), qr_payload: qrPayload }
}

export interface ConfirmHandoffInput {
  batchId: string
  byUserId: string
  puntoCobroUbicacionId: string
  cajaPpalUbicacionId: string
}

export async function confirmHandoffBatch(input: ConfirmHandoffInput): Promise<HandoffBatch> {
  const { batchId, byUserId, puntoCobroUbicacionId, cajaPpalUbicacionId } = input

  if (!batchId)               throw new Error('confirmHandoffBatch: batchId requerido')
  if (!byUserId)              throw new Error('confirmHandoffBatch: byUserId requerido (sesión no inicializada)')
  if (!puntoCobroUbicacionId) throw new Error('confirmHandoffBatch: PC_MIRLA no resuelto')
  if (!cajaPpalUbicacionId)   throw new Error('confirmHandoffBatch: CAJA_PPAL no resuelto')

  const { data: batchRow, error: bE } = await supabase
    .from('tesoreria_handoff_batches')
    .select('*')
    .eq('id', batchId)
    .single()
  if (bE) throw new Error('Error cargando batch: ' + bE.message)
  if (!batchRow) throw new Error('Batch no encontrado: ' + batchId)
  const batch = batchRow as HandoffBatch
  if (batch.estado !== 'PREPARADO') {
    throw new Error('Este batch ya fue procesado (' + batch.estado + ').')
  }

  const monto = Number(batch.total_usd)
  if (!monto || monto <= 0) {
    throw new Error('Batch sin monto válido: ' + monto)
  }

  // Pre-insert recompute so the negative-saldo guard reads current truth.
  try { await supabase.rpc('tesoreria_recompute_saldos') }
  catch (e) { console.warn('[handoff] pre-insert recompute warning', e) }

  // ── Pick up the open ingresos individually instead of moving an anonymous
  //    lump. A batch IS "Tesorería collects everything Mirla holds", so we
  //    replay an individual-scan pickup per comprobante: flip its estado and
  //    write a linked PICKUP_TRANSFER pair. That's what makes each ingreso
  //    leave the "Ingresos por recoger" list (which filters PENDIENTE_PICKUP).
  const { data: pend, error: pErr } = await supabase
    .from('tesoreria_comprobantes')
    .select('id, numero, monto_usd, estado')
    .eq('tipo', 'INGRESO')
    .eq('estado', 'PENDIENTE_PICKUP')
    .eq('ubicacion_destino_id', puntoCobroUbicacionId)
    .order('solicitado_at', { ascending: true })
  if (pErr) throw new Error('Error cargando comprobantes pendientes: ' + pErr.message)
  const pendientes = (pend || []) as Array<{ id: string; numero: string; monto_usd: number }>

  // Idempotency: any comprobante that already has a PICKUP_TRANSFER (prior
  // individual scan, or a half-finished retry of this confirm) must not get a
  // second cash movement. We still flip its estado below.
  const candidateIds = pendientes.map(c => c.id)
  let alreadyMoved = new Set<string>()
  if (candidateIds.length > 0) {
    const { data: existingMovs, error: emErr } = await supabase
      .from('tesoreria_movimientos')
      .select('comprobante_id')
      .in('comprobante_id', candidateIds)
      .eq('tipo', 'PICKUP_TRANSFER')
    if (emErr) throw new Error('Error verificando movimientos previos: ' + emErr.message)
    alreadyMoved = new Set((existingMovs || []).map((m: any) => m.comprobante_id as string))
  }

  // Allocate the batch monto across pending comprobantes, oldest-first. Only
  // fully-covered comprobantes are picked up; anything the monto can't cover
  // stays PENDIENTE_PICKUP (its cash is still physically with Mirla).
  let budget = monto
  const movRows: any[] = []
  const toConfirm: string[] = []
  const eventoRows: any[] = []

  for (const c of pendientes) {
    const cm = Number(c.monto_usd)
    if (cm > budget + 0.005) continue   // not enough left in this batch — leave pending
    budget -= cm
    toConfirm.push(c.id)
    eventoRows.push({
      comprobante_id: c.id,
      evento: 'PICKUP_CONFIRMADO',
      actor_user_id: byUserId,
      actor_label: 'Tesorería',
      notas: 'Recogida en lote ' + batch.numero + ' · PC_MIRLA → CAJA_PPAL',
    })
    if (alreadyMoved.has(c.id)) continue   // cash already moved — flip state only
    movRows.push(
      {
        ubicacion_id: puntoCobroUbicacionId,
        tipo: 'PICKUP_TRANSFER',
        monto_usd: cm,
        signo: -1,
        source_type: 'INGRESO',
        source_label: 'Recogida · ' + c.numero,
        descripcion: 'Recogida por Tesorería (entrega ' + batch.numero + ') · ' + c.numero,
        categoria: 'PICKUP',
        comprobante_id: c.id,
        registered_by: byUserId,
      },
      {
        ubicacion_id: cajaPpalUbicacionId,
        tipo: 'PICKUP_TRANSFER',
        monto_usd: cm,
        signo: 1,
        source_type: 'INGRESO',
        source_label: 'Recepción · ' + c.numero,
        descripcion: 'Recepción desde Punto de Cobro (entrega ' + batch.numero + ') · ' + c.numero,
        categoria: 'PICKUP',
        comprobante_id: c.id,
        registered_by: byUserId,
      },
    )
  }

  // Residual: cash in the batch beyond the open ingresos (Mirla handed over
  // more than the pending total). Move it as an anonymous handoff so the saldo
  // math stays exact. Idempotent on the batch numero.
  const residual = Math.round(budget * 100) / 100
  if (residual > 0.005) {
    const { data: existingResidual, error: erErr } = await supabase
      .from('tesoreria_movimientos')
      .select('id')
      .eq('tipo', 'HANDOFF_TESORERIA')
      .ilike('source_label', '%' + batch.numero + '%')
      .limit(1)
    if (erErr) throw new Error('Error verificando excedente previo: ' + erErr.message)
    if (!existingResidual || existingResidual.length === 0) {
      movRows.push(
        {
          ubicacion_id: puntoCobroUbicacionId,
          tipo: 'HANDOFF_TESORERIA',
          monto_usd: residual,
          signo: -1,
          source_type: 'HANDOFF',
          source_label: 'Entrega a tesorería · ' + batch.numero,
          descripcion: 'Entrega a Tesorería (excedente) · batch ' + batch.numero,
          categoria: 'HANDOFF',
          registered_by: byUserId,
        },
        {
          ubicacion_id: cajaPpalUbicacionId,
          tipo: 'HANDOFF_TESORERIA',
          monto_usd: residual,
          signo: 1,
          source_type: 'HANDOFF',
          source_label: 'Recepción de tesorería · ' + batch.numero,
          descripcion: 'Recepción del Punto de Cobro (excedente) · batch ' + batch.numero,
          categoria: 'HANDOFF',
          registered_by: byUserId,
        },
      )
    }
  }

  // 1. Move the cash (single atomic insert). If this throws, the batch stays
  //    PREPARADO and the whole confirm is safely retryable.
  if (movRows.length > 0) {
    const { error: mErr } = await supabase.from('tesoreria_movimientos').insert(movRows)
    if (mErr) throw new Error('Error escribiendo movimientos del handoff: ' + mErr.message)
  }

  // 2. Recompute saldos from truth (defensive; trigger is now SECURITY DEFINER).
  try { await supabase.rpc('tesoreria_recompute_saldos') }
  catch (e) { console.warn('[handoff] post-insert recompute warning', e) }

  // 3. Flip the picked-up comprobantes out of PENDIENTE_PICKUP so they leave
  //    the "Ingresos por recoger" list. Atomic guard keeps it idempotent.
  if (toConfirm.length > 0) {
    const { error: cErr } = await supabase
      .from('tesoreria_comprobantes')
      .update({
        estado: 'PICKUP_CONFIRMADO',
        confirmado_by: byUserId,
        confirmado_at: new Date().toISOString(),
      })
      .in('id', toConfirm)
      .eq('estado', 'PENDIENTE_PICKUP')
    if (cErr) throw new Error('Error actualizando comprobantes: ' + cErr.message)

    // Audit events — best-effort, non-blocking.
    try { await supabase.from('tesoreria_comprobante_eventos').insert(eventoRows) }
    catch (e) { console.warn('[handoff] evento log warning', e) }
  }

  // 4. Flip the batch to RECIBIDO last (atomic guard).
  const { data: updated, error: uErr } = await supabase
    .from('tesoreria_handoff_batches')
    .update({
      estado: 'RECIBIDO',
      to_user_id: byUserId,
      recibido_at: new Date().toISOString(),
    })
    .eq('id', batchId)
    .eq('estado', 'PREPARADO')
    .select('*')
    .single()
  if (uErr) throw new Error('Error actualizando batch: ' + uErr.message)
  if (!updated) throw new Error('Batch UPDATE no devolvió fila (¿RLS UPDATE bloqueado?).')

  return updated as HandoffBatch
}

export async function anularHandoffBatch(
  batchId: string,
  motivo: string,
): Promise<void> {
  if (!motivo || motivo.trim().length < 5) {
    throw new Error('Motivo obligatorio (mín. 5 caracteres).')
  }
  const { data: batch, error: e1 } = await supabase
    .from('tesoreria_handoff_batches')
    .select('estado')
    .eq('id', batchId)
    .single()
  if (e1) throw e1
  if (batch.estado !== 'PREPARADO') {
    throw new Error('Sólo se puede anular un batch en estado PREPARADO. Estado actual: ' + batch.estado)
  }
  const { error: e2 } = await supabase
    .from('tesoreria_handoff_batches')
    .update({
      estado: 'ANULADO',
      anulado_at: new Date().toISOString(),
      anulado_motivo: motivo.trim(),
    })
    .eq('id', batchId)
    .eq('estado', 'PREPARADO')
  if (e2) throw e2
}

export interface BatchListRow {
  id: string
  numero: string
  estado: HandoffEstado
  total_count: number
  total_usd: number
  preparado_at: string
  recibido_at: string | null
  anulado_at: string | null
  notas: string | null
}

export async function listHandoffBatches(limit = 50): Promise<BatchListRow[]> {
  const { data, error } = await supabase
    .from('tesoreria_handoff_batches')
    .select('id, numero, estado, total_count, total_usd, preparado_at, recibido_at, anulado_at, notas')
    .order('preparado_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data || []) as BatchListRow[]
}