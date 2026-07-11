'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from './supabase'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleLogin = async () => {
    setLoading(true)
    setError('')
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError('Correo o contraseña incorrectos: ' + error.message)
    } else {
      // CRM-only fork: every role lands on the dashboard hub.
      router.push('/dashboard')
    }
    setLoading(false)
  }

  return (
    <main style={{
      minHeight: '100vh',
      background: 'var(--bg-page)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'sans-serif',
      transition: 'background 0.35s ease'
    }}>
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: '16px',
        padding: '48px',
        width: '100%',
        maxWidth: '420px',
        boxShadow: 'var(--shadow-card)',
        transition: 'background 0.35s ease, border-color 0.35s ease'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{
            fontSize: '11px', fontWeight: 700, color: '#BB162B',
            letterSpacing: '4px', textTransform: 'uppercase', marginBottom: '8px'
          }}>PRIME ONE</div>
          <div style={{
            fontSize: '36px', fontWeight: 700, color: 'var(--text-primary)',
            letterSpacing: '2px', textTransform: 'uppercase',
            transition: 'color 0.35s ease'
          }}>
            AutoCore <span style={{ color: '#BB162B' }}>P1</span>
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '6px' }}>
            Portal Interno — Acceso de Empleados
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{
              fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)',
              textTransform: 'uppercase', letterSpacing: '1.5px',
              display: 'block', marginBottom: '6px'
            }}>Correo Electrónico</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="tu@email.com"
              style={{
                width: '100%', padding: '12px 16px',
                background: 'var(--bg-input)', border: '1px solid var(--border)',
                borderRadius: '8px', color: 'var(--text-primary)', fontSize: '14px',
                outline: 'none', boxSizing: 'border-box' as const,
                transition: 'background 0.35s ease, border-color 0.35s ease'
              }}
            />
          </div>

          <div>
            <label style={{
              fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)',
              textTransform: 'uppercase', letterSpacing: '1.5px',
              display: 'block', marginBottom: '6px'
            }}>Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              style={{
                width: '100%', padding: '12px 16px',
                background: 'var(--bg-input)', border: '1px solid var(--border)',
                borderRadius: '8px', color: 'var(--text-primary)', fontSize: '14px',
                outline: 'none', boxSizing: 'border-box' as const,
                transition: 'background 0.35s ease, border-color 0.35s ease'
              }}
            />
          </div>

          {error && (
            <div style={{
              background: 'rgba(187,22,43,0.1)',
              border: '1px solid rgba(187,22,43,0.3)',
              borderRadius: '8px', padding: '12px',
              fontSize: '13px', color: '#BB162B'
            }}>{error}</div>
          )}

          <button
            onClick={handleLogin}
            disabled={loading}
            style={{
              background: loading ? 'var(--text-muted)' : '#BB162B',
              color: '#ffffff', border: 'none', borderRadius: '8px',
              padding: '14px', fontSize: '14px', fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '2px',
              cursor: loading ? 'not-allowed' : 'pointer', marginTop: '8px',
              transition: 'background 0.2s ease'
            }}
          >
            {loading ? 'Ingresando...' : 'Ingresar'}
          </button>
        </div>

        <div style={{ textAlign: 'center', marginTop: '24px', fontSize: '11px', color: 'var(--text-secondary)' }}>
          © 2026 AutoCore P1 · Prime One Auto Sales
        </div>
      </div>
    </main>
  )
}