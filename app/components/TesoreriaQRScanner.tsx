// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/components/TesoreriaQRScanner.tsx
// Phase 2 — QR Scanner Modal
//
// Opens the device camera, decodes AUTOCORE:TES:<uuid>:<checksum> QR codes,
// validates server-side via tesoreria_lookup_by_qr RPC, returns the
// comprobante row to the parent on success.
//
// Used by:
//   - app/auditoria/page.tsx — Deisi scans Mirla/Angeles's tesorería slip
//                              to attach a cash pago to a deal
//
// Library: html5-qrcode (lazy-loaded — does not bloat the main bundle)
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'

export interface ScannedComprobante {
  id: string
  numero: string
  tipo: string
  estado: string
  categoria: string | null
  monto_usd: number
  concepto: string | null
  contraparte_nombre: string | null
  ubicacion_destino_id: string
  ubicacion_destino_codigo: string
  ubicacion_destino_nombre: string
  source_type: string | null
  source_id: string | null
  source_label: string | null
  solicitado_by: string | null
  created_at: string
}

interface Props {
  /** Called when a valid comprobante is scanned and confirmed by the user */
  onScanned: (comprobante: ScannedComprobante) => void
  /** Called when the modal is dismissed without a result */
  onCancel: () => void
  /**
   * Optional title shown at the top. Defaults to "Escanear Comprobante de
   * Tesorería". Pass something context-specific like "Escanear comprobante
   * de cash para este negocio" if you want.
   */
  title?: string
  /**
   * Optional filter — if set, only accept comprobantes of a specific tipo
   * (e.g. 'INGRESO'). Scans of other tipos return an "incorrect type" error.
   */
  expectedTipo?: 'INGRESO' | 'SALIDA' | 'FX' | 'PICKUP' | 'REPLENISHMENT'
  /**
   * Optional filter — if set, only accept comprobantes still in this estado.
   * For Deisi's auditoría flow this should be 'PENDIENTE_PICKUP' (so she
   * can't attach a comprobante that's already been picked up by Viviana).
   */
  expectedEstado?: 'PENDIENTE_PICKUP' | 'PICKUP_CONFIRMADO' | 'COMPLETADO' | 'ANULADO'
  /**
   * Optional pre-RPC intercept. Called with the raw decoded QR payload before
   * the comprobante lookup fires. If the callback returns true, the scanner
   * treats the payload as "consumed" — it stops the camera and the caller is
   * responsible for navigation. Returning false (or omitting the prop) falls
   * through to the normal comprobante RPC lookup.
   *
   * Use case: handoff batch QRs (which are plain URLs to /tesoreria/handoff)
   * — the URL is not a comprobante payload and would fail the RPC. The scan
   * page detects the URL prefix and routes directly.
   */
  onRawScan?: (rawPayload: string) => boolean | Promise<boolean>
}

type Phase = 'asking-permission' | 'scanning' | 'looking-up' | 'review' | 'error'

const s: any = {
  overlay: {
    position: 'fixed' as const, inset: 0,
    background: 'rgba(0,0,0,0.92)',
    zIndex: 10000,
    display: 'flex', flexDirection: 'column' as const,
    alignItems: 'center', justifyContent: 'center',
    padding: '16px',
  },
  card: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 16,
    padding: 20,
    width: '100%', maxWidth: 460,
    maxHeight: '95vh',
    overflowY: 'auto' as const,
  },
  title: {
    fontSize: 16, fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 11, color: 'var(--text-secondary)',
    marginBottom: 18,
  },
  cameraBox: {
    width: '100%', aspectRatio: '1 / 1',
    background: '#000',
    borderRadius: 12,
    overflow: 'hidden' as const,
    position: 'relative' as const,
    marginBottom: 14,
  },
  scanFrame: {
    position: 'absolute' as const, inset: '14%',
    border: '2px solid #BB162B',
    borderRadius: 12,
    boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
    pointerEvents: 'none' as const,
  },
  btnRed: {
    padding: '12px 20px', background: '#BB162B',
    color: '#fff', border: 'none', borderRadius: 8,
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
    textTransform: 'uppercase' as const, letterSpacing: 1,
  },
  btnSec: {
    padding: '12px 18px', background: 'transparent',
    color: 'var(--text-primary)', border: '1px solid var(--border)',
    borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  btnRow: { display: 'flex', gap: 10, marginTop: 14 },
  err: {
    padding: '12px 14px', borderRadius: 8,
    background: 'rgba(187,22,43,0.1)',
    border: '1px solid rgba(187,22,43,0.4)',
    color: '#BB162B', fontSize: 13,
    marginBottom: 14,
  },
  detailRow: {
    display: 'flex', justifyContent: 'space-between',
    padding: '6px 0', fontSize: 13,
    borderBottom: '1px solid var(--border)',
  },
  detailLabel: { color: 'var(--text-secondary)', fontWeight: 500 },
  detailValue: { color: 'var(--text-primary)', fontWeight: 700, textAlign: 'right' as const },
  bigAmount: {
    fontSize: 32, fontWeight: 900,
    color: '#2ecc8a', fontFamily: 'monospace',
    textAlign: 'center' as const,
    padding: '14px 0',
  },
  estadoPill: (color: string) => ({
    display: 'inline-block',
    padding: '4px 12px', borderRadius: 99,
    fontSize: 11, fontWeight: 700,
    background: color + '22', color,
  }),
}

const ESTADO_COLORS: Record<string, string> = {
  PENDIENTE_PICKUP:  '#b8720a',
  PICKUP_CONFIRMADO: '#3B82F6',
  COMPLETADO:        '#2ecc8a',
  ANULADO:           '#BB162B',
}

const TIPO_LABELS: Record<string, string> = {
  INGRESO:        'Ingreso',
  SALIDA:         'Salida',
  FX:             'Cambio FX',
  PICKUP:         'Pickup',
  REPLENISHMENT:  'Reposición',
}

export default function TesoreriaQRScanner({
  onScanned,
  onCancel,
  title = 'Escanear Comprobante de Tesorería',
  expectedTipo,
  expectedEstado,
  onRawScan,
}: Props) {
  const [phase, setPhase] = useState<Phase>('asking-permission')
  const [error, setError] = useState<string>('')
  const [scanned, setScanned] = useState<ScannedComprobante | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Cleanup ref — must outlive renders so the unmount effect can call stop()
  const scannerRef = useRef<any | null>(null)
  // Lock to prevent multiple lookups from the same camera frame burst
  const lookupInFlightRef = useRef<boolean>(false)

  // ── Initialize camera + scanner ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    const start = async () => {
      try {
        // Lazy-load html5-qrcode so it doesn't bloat the main bundle
        const mod = await import('html5-qrcode')
        const { Html5Qrcode } = mod

        if (cancelled) return
        if (!containerRef.current) return

        // The container needs a stable id for html5-qrcode internals
        const containerId = 'tes-qr-scanner-region'
        containerRef.current.id = containerId

        const scanner = new Html5Qrcode(containerId, /* verbose */ false)
        scannerRef.current = scanner

        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: (vw: number, vh: number) => {
              // 72% of the smaller dimension, centered
              const minEdge = Math.min(vw, vh)
              const size = Math.floor(minEdge * 0.72)
              return { width: size, height: size }
            },
            aspectRatio: 1.0,
          },
          (decodedText: string) => {
            if (lookupInFlightRef.current) return
            lookupInFlightRef.current = true
            void handleDecoded(decodedText)
          },
          () => {
            // per-frame "not found" callback — silent, very noisy
          }
        )

        setPhase('scanning')
      } catch (e: any) {
        if (cancelled) return
        const msg = e?.message || String(e)
        if (/permission|denied|notallowed/i.test(msg)) {
          setError(
            'No se pudo acceder a la cámara. Por favor permite el acceso ' +
            'en la configuración de tu navegador y vuelve a intentar.'
          )
        } else if (/notfound|no.*camera/i.test(msg)) {
          setError('No se encontró ninguna cámara en este dispositivo.')
        } else {
          setError('Error al iniciar la cámara: ' + msg)
        }
        setPhase('error')
      }
    }

    start()

    return () => {
      cancelled = true
      // Best-effort camera shutdown
      const sc = scannerRef.current
      if (sc) {
        try {
          // .stop() returns a promise; ignore errors on unmount
          sc.stop().catch(() => {}).finally(() => {
            try { sc.clear() } catch { /* noop */ }
          })
        } catch { /* noop */ }
        scannerRef.current = null
      }
    }
  }, [])

  // ── Handle a successful decode ──────────────────────────────────────────
  const handleDecoded = async (qrPayload: string) => {
    setPhase('looking-up')

    // Stop the camera immediately — we don't want re-decodes
    const sc = scannerRef.current
    if (sc) {
      try { await sc.stop() } catch { /* noop */ }
    }

    // Pre-RPC intercept (e.g. handoff batch URLs). If the parent consumes
    // the payload, we stop here — the parent handles navigation.
    if (onRawScan) {
      try {
        const consumed = await onRawScan(qrPayload)
        if (consumed) return
      } catch (e) {
        console.warn('[scanner] onRawScan threw:', e)
      }
    }

    // Server-side validation + lookup
    const { data, error: rpcErr } = await supabase
      .rpc('tesoreria_lookup_by_qr', { p_qr_payload: qrPayload })

    if (rpcErr) {
      setError('Error consultando el comprobante: ' + rpcErr.message)
      setPhase('error')
      return
    }

    // RPC returns a table (array of rows). Should be exactly 1 row.
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null
    if (!row) {
      setError('La consulta no devolvió resultados.')
      setPhase('error')
      return
    }

    if (!row.is_valid) {
      setError(row.error_message || 'Comprobante inválido')
      setPhase('error')
      return
    }

    // Tipo filter
    if (expectedTipo && row.tipo !== expectedTipo) {
      setError(
        `Este comprobante es de tipo "${TIPO_LABELS[row.tipo] || row.tipo}", ` +
        `pero aquí se necesita un "${TIPO_LABELS[expectedTipo] || expectedTipo}".`
      )
      setPhase('error')
      return
    }

    // Estado filter
    if (expectedEstado && row.estado !== expectedEstado) {
      let humanEstado: string = row.estado
      if (row.estado === 'PICKUP_CONFIRMADO') humanEstado = 'ya fue recogido por la tesorera'
      else if (row.estado === 'COMPLETADO')   humanEstado = 'ya fue completado'
      else if (row.estado === 'ANULADO')       humanEstado = 'fue anulado'
      setError(`No se puede usar este comprobante: ${humanEstado}.`)
      setPhase('error')
      return
    }

    setScanned(row as ScannedComprobante)
    setPhase('review')
  }

  // ── User retries after error ────────────────────────────────────────────
  const retryScan = () => {
    setError('')
    setScanned(null)
    lookupInFlightRef.current = false
    // Re-mount by toggling phase; the useEffect doesn't re-run, so we
    // manually restart the scanner.
    setPhase('asking-permission')
    // Simplest path: ask the parent to remount us. But since we can't,
    // re-init the scanner manually:
    setTimeout(async () => {
      try {
        const mod = await import('html5-qrcode')
        const { Html5Qrcode } = mod
        if (!containerRef.current) return
        const containerId = containerRef.current.id || 'tes-qr-scanner-region'
        const scanner = new Html5Qrcode(containerId, false)
        scannerRef.current = scanner
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 240, height: 240 }, aspectRatio: 1.0 },
          (txt) => {
            if (lookupInFlightRef.current) return
            lookupInFlightRef.current = true
            void handleDecoded(txt)
          },
          () => {}
        )
        setPhase('scanning')
      } catch (e: any) {
        setError('No se pudo reiniciar la cámara: ' + (e?.message || ''))
        setPhase('error')
      }
    }, 100)
  }

  // ── User confirms the scanned comprobante ───────────────────────────────
  const confirm = () => {
    if (!scanned) return
    onScanned(scanned)
  }

  return (
    <div style={s.overlay} role="dialog" aria-modal="true">
      <div style={s.card}>

        <div style={s.title}>{title}</div>
        <div style={s.subtitle}>
          {phase === 'asking-permission' && 'Iniciando cámara…'}
          {phase === 'scanning'          && 'Apunta la cámara al QR del comprobante impreso'}
          {phase === 'looking-up'        && 'Validando comprobante…'}
          {phase === 'review'            && 'Confirma que es el comprobante correcto'}
          {phase === 'error'             && 'Ocurrió un problema'}
        </div>

        {/* Camera box — visible while scanning, hidden during review/error */}
        {(phase === 'asking-permission' || phase === 'scanning' || phase === 'looking-up') && (
          <div style={s.cameraBox}>
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
            {phase === 'scanning' && <div style={s.scanFrame} />}
            {phase === 'looking-up' && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 700 }}>
                Validando…
              </div>
            )}
          </div>
        )}

        {/* Error state */}
        {phase === 'error' && (
          <>
            <div style={s.err}>{error}</div>
            <div style={s.btnRow}>
              <button style={s.btnSec} onClick={onCancel}>Cancelar</button>
              <button style={{ ...s.btnRed, flex: 1 }} onClick={retryScan}>Volver a escanear</button>
            </div>
          </>
        )}

        {/* Review — user confirms */}
        {phase === 'review' && scanned && (
          <>
            <div style={s.bigAmount}>
              ${scanned.monto_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>

            <div style={s.detailRow}>
              <span style={s.detailLabel}>Comprobante</span>
              <span style={s.detailValue}>#{scanned.numero}</span>
            </div>
            <div style={s.detailRow}>
              <span style={s.detailLabel}>Tipo</span>
              <span style={s.detailValue}>{TIPO_LABELS[scanned.tipo] || scanned.tipo}</span>
            </div>
            <div style={s.detailRow}>
              <span style={s.detailLabel}>Estado</span>
              <span style={s.detailValue}>
                <span style={s.estadoPill(ESTADO_COLORS[scanned.estado] || '#888')}>
                  {scanned.estado.replace('_', ' ')}
                </span>
              </span>
            </div>
            <div style={s.detailRow}>
              <span style={s.detailLabel}>Concepto</span>
              <span style={s.detailValue}>{scanned.concepto || '—'}</span>
            </div>
            {scanned.contraparte_nombre && (
              <div style={s.detailRow}>
                <span style={s.detailLabel}>Contraparte</span>
                <span style={s.detailValue}>{scanned.contraparte_nombre}</span>
              </div>
            )}
            <div style={s.detailRow}>
              <span style={s.detailLabel}>Ubicación</span>
              <span style={s.detailValue}>{scanned.ubicacion_destino_nombre}</span>
            </div>
            {scanned.source_label && (
              <div style={s.detailRow}>
                <span style={s.detailLabel}>Referencia</span>
                <span style={s.detailValue}>{scanned.source_label}</span>
              </div>
            )}
            <div style={{ ...s.detailRow, border: 'none' }}>
              <span style={s.detailLabel}>Fecha</span>
              <span style={s.detailValue}>
                {new Date(scanned.created_at).toLocaleString('es-VE', {
                  day: '2-digit', month: '2-digit', year: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
              </span>
            </div>

            <div style={s.btnRow}>
              <button style={s.btnSec} onClick={onCancel}>Cancelar</button>
              <button style={{ ...s.btnRed, flex: 1 }} onClick={confirm}>
                ✓ Usar este comprobante
              </button>
            </div>
          </>
        )}

        {/* Cancel button always visible during scanning */}
        {(phase === 'asking-permission' || phase === 'scanning') && (
          <button style={{ ...s.btnSec, width: '100%' }} onClick={onCancel}>
            Cancelar
          </button>
        )}

      </div>
    </div>
  )
}