// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/lib/prestamos.ts
// AutoCore NPA — Préstamos cortos (helper compartido)
//
// 2026-06-09. Cuando un egreso deja una caja en negativo, registramos a quién
// le debemos. Este helper inserta la fila en tesoreria_prestamos. El movimiento
// que crea el negativo se inserta en el sitio de llamada con permite_negativo:true.
// ═══════════════════════════════════════════════════════════════════════════
import { supabase } from '../supabase'

export interface PrestamoCortoInput {
  ubicacionId: string
  prestamista: string
  monto: number
  comprobanteId: string | null
  userId: string | null
}

/** Inserta un préstamo corto (ABIERTO). Devuelve { error } (null si todo bien). */
export async function registrarPrestamoCorto(
  args: PrestamoCortoInput
): Promise<{ error: string | null }> {
  if (!args.prestamista.trim()) return { error: 'Falta el nombre de a quién le debemos' }
  if (!args.monto || args.monto <= 0) return { error: 'Monto de préstamo inválido' }
  const { error } = await supabase.from('tesoreria_prestamos').insert({
    prestamista: args.prestamista.trim(),
    monto_usd: args.monto,
    ubicacion_id: args.ubicacionId,
    comprobante_id: args.comprobanteId,
    estado: 'ABIERTO',
    created_by: args.userId,
  })
  return { error: error ? error.message : null }
}

/** Quién registra el préstamo según la caja que queda en negativo. */
export function prestamistaResponsable(codigo: string | null | undefined): string {
  return codigo === 'USDT_WALLET' ? 'Mirla' : 'Viviana'
}