'use client'

import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Log for developer visibility. Replace with real error tracking (Sentry, etc.) later.
    console.error('NPA route error:', error)
  }, [error])

  const isAuthError =
    error.message?.toLowerCase().includes('jwt') ||
    error.message?.toLowerCase().includes('auth') ||
    error.message?.toLowerCase().includes('not authenticated')

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-page, #0a0a0a)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      fontFamily: 'sans-serif',
    }}>
      <div style={{
        background: 'var(--bg-card, #1a1a1a)',
        border: '1px solid var(--border, #2a2a2a)',
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

        <div style={{
          fontSize: '16px',
          fontWeight: 700,
          color: 'var(--text-primary, #fff)',
          marginBottom: '8px',
        }}>
          {isAuthError ? 'Sesión expirada' : 'Ocurrió un error'}
        </div>

        <div style={{
          fontSize: '13px',
          color: 'var(--text-secondary, #9ca3af)',
          marginBottom: '24px',
          lineHeight: 1.6,
        }}>
          {isAuthError
            ? 'Tu sesión expiró mientras trabajabas. Por favor vuelve a iniciar sesión — tus cambios guardados no se perdieron.'
            : 'Algo salió mal en esta pantalla. Tus datos guardados están seguros. Intenta recargar la página.'
          }
        </div>

        {error.digest && (
          <div style={{
            fontSize: '10px',
            color: 'var(--text-muted, #6b7280)',
            fontFamily: 'monospace',
            marginBottom: '20px',
            padding: '6px 10px',
            background: 'var(--bg-deep, #0a0a0a)',
            borderRadius: '6px',
          }}>
            Código: {error.digest}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
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
            Reintentar
          </button>
          <button
            onClick={() => { window.location.href = isAuthError ? '/' : '/dashboard' }}
            style={{
              padding: '10px 24px',
              background: 'transparent',
              color: 'var(--text-secondary, #9ca3af)',
              border: '1px solid var(--border, #2a2a2a)',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {isAuthError ? 'Ir al login' : 'Ir al dashboard'}
          </button>
        </div>
      </div>
    </div>
  )
}