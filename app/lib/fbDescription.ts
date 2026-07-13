// TARGET: autocore-p1/app/lib/fbDescription.ts
// ═══════════════════════════════════════════════════════════════════════════
// Facebook Marketplace description generator. Builds a bilingual (EN + ES,
// Miami market) listing description from REAL vehicle data only — it never
// invents specs, warranty or financing claims. CTA is a WhatsApp link when
// TENANT.whatsappVentas is set, otherwise a Messenger prompt.
// Used by: /inventario/importar ("Crear borrador FB") and the CRM Marketplace
// listing modal ("Generar descripción").
// ═══════════════════════════════════════════════════════════════════════════
import { TENANT } from '../tenant.config'

export interface FbDescInput {
  titulo: string
  precioUsd?: number | null
  millas?: number | null
  vin?: string | null
  // Optional specs (from the site importer's raw JSON-LD / fields table).
  bodyType?: string | null
  fuel?: string | null
  transmission?: string | null
  engine?: string | null
  colorExterior?: string | null
  colorInterior?: string | null
  drivetrain?: string | null
  trim?: string | null
}

const cap = (s: string) =>
  s.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (m, p, c) => p + c.toUpperCase())

const fmtMiles = (n: number) => n.toLocaleString('en-US')
const fmtUsd = (n: number) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 })

// One spec line like "Automatic · Gasoline · FWD · Silver".
function specLine(i: FbDescInput): string {
  return [i.transmission, i.fuel, i.drivetrain, i.colorExterior]
    .filter(Boolean)
    .map(s => cap(String(s)))
    .join(' · ')
}

export function buildFbDescription(i: FbDescInput): string {
  const wa = (TENANT.whatsappVentas || '').replace(/\D/g, '')
  const lines: string[] = []

  // ── English block ──────────────────────────────────────────────────────
  const hookEn = i.millas != null
    ? `${cap(i.titulo)} — only ${fmtMiles(i.millas)} miles!`
    : `${cap(i.titulo)} — ready for work or play!`
  lines.push(hookEn)
  lines.push('')
  const specs = specLine(i)
  if (specs) lines.push(`• ${specs}`)
  if (i.engine) lines.push(`• Engine: ${cap(String(i.engine))}`)
  if (i.trim) lines.push(`• Trim: ${cap(String(i.trim))}`)
  if (i.vin) lines.push(`• VIN: ${String(i.vin).toUpperCase()}`)
  if (i.precioUsd != null) {
    lines.push('')
    lines.push(`Priced to move at ${fmtUsd(i.precioUsd)}. These don't sit long — the first to see it usually takes it.`)
  } else {
    lines.push('')
    lines.push(`Sharp price — ask and it's yours to see first.`)
  }
  lines.push(
    wa
      ? `Message me here or WhatsApp for the fastest answer: https://wa.me/${wa} — schedule your test drive today.`
      : `Message me here for the fastest answer — schedule your test drive today.`
  )

  // ── Spanish block ──────────────────────────────────────────────────────
  lines.push('')
  lines.push('———')
  lines.push('')
  const hookEs = i.millas != null
    ? `${cap(i.titulo)} — ¡solo ${fmtMiles(i.millas)} millas!`
    : `${cap(i.titulo)} — ¡listo para trabajar!`
  lines.push(hookEs)
  if (i.precioUsd != null) lines.push(`Precio para vender ya: ${fmtUsd(i.precioUsd)}. El primero que lo ve, se lo lleva.`)
  lines.push(
    wa
      ? `Escríbeme por aquí o por WhatsApp para respuesta inmediata: https://wa.me/${wa} — agenda tu prueba de manejo hoy.`
      : `Escríbeme por aquí para respuesta inmediata — agenda tu prueba de manejo hoy.`
  )
  lines.push('')
  lines.push(`${TENANT.nombre} · ${TENANT.ciudad}, ${TENANT.estado}`)

  return lines.join('\n')
}
