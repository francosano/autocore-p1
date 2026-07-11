// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/scan/page.tsx
// AutoCore NPA — Tesorería QR Scan
//
// Phase 3 (2026-05-13): pickup entry point for ingresos.
// Phase 4 (2026-05-16): now also handles EGRESO comprobantes. The scanner
// runs WITHOUT a tipo/estado filter so it accepts any valid QR, then this
// page routes by tipo:
//   - INGRESO → /tesoreria/comprobante?id=...        (pickup-confirm lives there)
//   - EGRESO  → /tesoreria/comprobante?id=...&scan=1 (the &scan=1 flag tells the
//               detail page to auto-open the confirmation prompt for the
//               current egreso state — flow 2b)
//
// Gate: tesoreria_can_pickup OR tesoreria_admin OR npa_can_admin.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthGate } from '../../components/useAuthGate'
import SessionErrorScreen from '../../components/SessionErrorScreen'
import TesoreriaQRScanner, { type ScannedComprobante } from '../../components/TesoreriaQRScanner'

export default function TesoreriaScanPage() {
  const router = useRouter()
  // Layer 2: gate via useAuthGate — redirect ONLY on a settled 'denied'.
  const gate = useAuthGate(p =>
    p.tesoreria_can_pickup || p.tesoreria_admin || p.npa_can_admin
  )

  useEffect(() => {
    if (gate.status === 'denied') {
      router.replace('/tesoreria/home')
    }
  }, [gate.status, router])

  if (gate.status === 'loading' || gate.status === 'denied') {
    return (
      <div style={{
        minHeight: '100vh', background: '#000', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'sans-serif', fontSize: 13,
      }}>
        Cargando…
      </div>
    )
  }
  if (gate.status === 'error') {
    return <SessionErrorScreen homeHref="/tesoreria/home" />
  }

  function handleScanned(comp: ScannedComprobante) {
    // Route by tipo. Egresos get &scan=1 so the detail page knows the user
    // arrived via a scan and should auto-open the state-confirmation prompt.
    if (comp.tipo === 'EGRESO') {
      router.replace('/tesoreria/comprobante?id=' + comp.id + '&scan=1')
    } else {
      router.replace('/tesoreria/comprobante?id=' + comp.id)
    }
  }

  // Pre-RPC intercept — handoff batch QRs are plain URLs (not comprobante
  // payloads), so the comprobante lookup RPC would reject them. We detect the
  // /tesoreria/handoff path here and route directly. Returns true to tell the
  // scanner the payload was consumed (no further lookup needed).
  function handleRawScan(raw: string): boolean {
    // Accept absolute URL or relative path; tolerate trailing whitespace.
    const trimmed = (raw || '').trim()
    if (!trimmed) return false

    // Look for the handoff route segment with an id param. The QR payload is
    // always a full URL produced by buildHandoffQRPayload(), but we keep this
    // matcher permissive so it survives domain changes.
    const match = trimmed.match(/\/tesoreria\/handoff\?[^ ]*\bid=([0-9a-fA-F-]{36})/)
    if (!match) return false

    const batchId = match[1]
    // Always append confirm=1 — if Tesorería is scanning, she's confirming.
    router.replace('/tesoreria/handoff?id=' + batchId + '&confirm=1')
    return true
  }

  function handleCancel() {
    router.replace('/tesoreria/home')
  }

  // No expectedTipo / expectedEstado filter — accept any valid comprobante QR.
  // The detail page enforces what action is valid for the current state.
  return (
    <TesoreriaQRScanner
      title="Escanear comprobante"
      onScanned={handleScanned}
      onCancel={handleCancel}
      onRawScan={handleRawScan}
    />
  )
}