'use client'

import { useEffect } from 'react'

/**
 * global-error.tsx catches errors that occur in the root layout itself
 * (before app/error.tsx can handle them). Must include its own <html> and <body>
 * because it replaces the root layout when it activates.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('NPA global error:', error)
  }, [error])

  return (
    <html lang="es">
      <body style={{ margin: 0, fontFamily: 'sans-serif', background: '#0a0a0a', color: '#fff' }}>
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
        }}>
          <div style={{
            background: '#1a1a1a',
            border: '1px solid #2a2a2a',
            borderRadius: '14px',
            padding: '32px',
            maxWidth: '480px',
            width: '100%',
            textAlign: 'center',
          }}>
            <div style={{
              width: '56px',
              height: '56px',
              borderRadius: '14px',
              background: 'rgba(187,22,43,0.15)',
              border: '2px solid rgba(187,22,43,0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 20px',
              fontSize: '26px',
              color: '#BB162B',
              fontWeight: 900,
            }}>!</div>

            <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px' }}>
              Error crítico de la aplicación
            </div>

            <div style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '24px', lineHeight: 1.6 }}>
              Por favor recarga la página. Si el problema persiste, contacta a soporte.
            </div>

            {error.digest && (
              <div style={{
                fontSize: '10px',
                color: '#6b7280',
                fontFamily: 'monospace',
                marginBottom: '20px',
                padding: '6px 10px',
                background: '#0a0a0a',
                borderRadius: '6px',
              }}>
                Código: {error.digest}
              </div>
            )}

            <button
              onClick={() => reset()}
              style={{
                padding: '10px 24px',
                background: '#BB162B',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontSize: '13px',
                fontWeight: 700,
                cursor: 'pointer',
                textTransform: 'uppercase',
                letterSpacing: '1px',
              }}
            >
              Recargar
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}