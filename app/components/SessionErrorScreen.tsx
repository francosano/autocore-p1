// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/components/SessionErrorScreen.tsx
// v2 (2026-06-03) — Reintentar now actually REFRESHES the token.
//
// v1 did window.location.reload(), which re-read the SAME expired token from
// storage and looped straight back to this screen. v2 calls
// supabase.auth.refreshSession() first: on success it reloads with a fresh
// token (recovers); on failure it sends the user to log in cleanly. Combined
// with the proactive refresh in useNPAPermissions.ts, this is the token-expiry
// half of the multi-tab/idle session fix.
// ═══════════════════════════════════════════════════════════════════════════
'use client'

import { useState } from 'react'
import { supabase } from '../supabase'

interface Props {
  /** Optional override for the headline. */
  message?: string
  /** Where to send the user if the refresh fails. Default: '/'. */
  homeHref?: string
}

export default function SessionErrorScreen({ message, homeHref = '/' }: Props) {
  const [retrying, setRetrying] = useState(false)

  async function handleRetry() {
    setRetrying(true)
    try {
      // Try to mint a fresh token from the stored refresh token. A plain reload
      // would just re-read the expired one and loop — this is the difference.
      const { data, error } = await supabase.auth.refreshSession()
      if (error || !data?.session) {
        // Refresh token is genuinely dead — a reload can't help; log in fresh.
        window.location.href = homeHref
        return
      }
      // Fresh token persisted to storage — reload re-bootstraps cleanly.
      window.location.reload()
    } catch {
      // Network/timeout — fall back to a hard reload as a last resort.
      window.location.reload()
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg-page, #0A0F1E)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 380,
          width: '100%',
          background: 'var(--bg-card, #121829)',
          border: '1px solid var(--border, #2A3350)',
          borderRadius: 14,
          padding: '28px 24px',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 38, marginBottom: 10 }}>⚠️</div>
        <div
          style={{
            fontSize: 17,
            fontWeight: 700,
            color: 'var(--text-primary, #fff)',
            marginBottom: 8,
          }}
        >
          {message || 'Tu sesión expiró'}
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-secondary, #8A93AB)',
            lineHeight: 1.6,
            marginBottom: 22,
          }}
        >
          No pudimos verificar tu sesión. Esto suele pasar tras un período de
          inactividad o una conexión inestable. Vuelve a cargar para continuar.
        </div>
        <button
          onClick={handleRetry}
          disabled={retrying}
          style={{
            width: '100%',
            padding: '12px',
            background: '#BB162B',
            color: '#fff',
            border: 'none',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            cursor: retrying ? 'default' : 'pointer',
            opacity: retrying ? 0.6 : 1,
            marginBottom: 10,
          }}
        >
          {retrying ? 'Reconectando…' : '↻ Reintentar'}
        </button>
        <button
          onClick={() => { window.location.href = homeHref }}
          style={{
            width: '100%',
            padding: '11px',
            background: 'transparent',
            color: 'var(--text-secondary, #8A93AB)',
            border: '1px solid var(--border, #2A3350)',
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Volver al inicio
        </button>
      </div>
    </div>
  )
}