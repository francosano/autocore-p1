// app/settings/ReportesTab.tsx
// ═══════════════════════════════════════════════════════════════════════════
// REPORTES TAB — manage who receives the daily 6pm digest emails.
//
// 2026-05-20
//
// Only visible to the manager account (manager@motocentro2.com). RLS on
// `report_recipients` enforces this server-side — this UI just hides the
// menu item for non-manager users so they don't see a tab they can't use.
//
// Two emails are sent every day Mon–Sat at 6pm VET:
//   • Main digest (deals + tesorería) — goes to anyone with recv_main = true
//   • Tesorería-only digest — goes to anyone with recv_tesoreria = true
//
// The "Enviar reporte de prueba" button triggers the Worker immediately
// via GET ?force=1, which bypasses the Sunday-skip and forces a send.
// Useful for verifying changes without waiting for tomorrow's 6pm.
// ═══════════════════════════════════════════════════════════════════════════
'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

const REPORTS_WORKER = 'https://autocore-reports.sano-franco.workers.dev'

type Recipient = {
  id: string
  nombre: string
  email: string
  recv_main: boolean
  recv_tesoreria: boolean
  activo: boolean
  notas: string | null
}

export default function ReportesTab() {
  const [rows, setRows] = useState<Recipient[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // Add-row form state
  const [newNombre, setNewNombre] = useState('')
  const [newEmail, setNewEmail]   = useState('')
  const [newMain, setNewMain]     = useState(true)
  const [newTes, setNewTes]       = useState(false)
  const [saving, setSaving] = useState(false)

  // Test button
  const [testing, setTesting] = useState(false)

  // ── Load ─────────────────────────────────────────────────────────────────
  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true); setErr(null)
    try {
      // Supabase JS has TS-inference quirks on Unicode columns; the cast +
      // Array.isArray guard is the same pattern used in NotificacionesTab.
      const { data, error } = await (supabase
        .from('report_recipients')
        .select('id, nombre, email, recv_main, recv_tesoreria, activo, notas')
        .order('nombre', { ascending: true }) as any)
      if (error) throw error
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setErr(e.message || 'Error cargando destinatarios')
    } finally {
      setLoading(false)
    }
  }

  // ── Add ──────────────────────────────────────────────────────────────────
  async function handleAdd() {
    setErr(null); setInfo(null)
    const nombre = newNombre.trim()
    const email  = newEmail.trim().toLowerCase()
    if (!nombre) { setErr('Nombre requerido'); return }
    if (!validEmail(email)) { setErr('Email inválido'); return }
    if (!newMain && !newTes) { setErr('Selecciona al menos un tipo de reporte'); return }
    if (rows.some(r => r.email.toLowerCase() === email)) {
      setErr('Ya hay un destinatario con ese email')
      return
    }
    setSaving(true)
    try {
      const { error } = await (supabase
        .from('report_recipients')
        .insert({
          nombre,
          email,
          recv_main:      newMain,
          recv_tesoreria: newTes,
          activo: true,
        }) as any)
      if (error) throw error
      setNewNombre(''); setNewEmail(''); setNewMain(true); setNewTes(false)
      setInfo('Destinatario agregado')
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error agregando destinatario')
    } finally {
      setSaving(false)
    }
  }

  // ── Toggle a boolean column on an existing row ───────────────────────────
  async function toggle(row: Recipient, field: 'recv_main' | 'recv_tesoreria' | 'activo') {
    setErr(null); setInfo(null)
    const newValue = !row[field]
    // Safeguard: can't have both report flags off AND active — that would
    // leave a row that does nothing. The DB CHECK constraint enforces this
    // for new inserts; for updates we surface a friendly message.
    if (field === 'recv_main' && !newValue && !row.recv_tesoreria && row.activo) {
      setErr('Este destinatario debe recibir al menos un reporte (o desactívalo).')
      return
    }
    if (field === 'recv_tesoreria' && !newValue && !row.recv_main && row.activo) {
      setErr('Este destinatario debe recibir al menos un reporte (o desactívalo).')
      return
    }
    // Also prevent deactivating the last main-digest recipient — if we let
    // them turn off every recv_main, no one would receive the daily report.
    if (field === 'recv_main' && row.activo && !newValue) {
      const otherMainActive = rows.filter(r =>
        r.id !== row.id && r.recv_main && r.activo
      ).length
      if (otherMainActive === 0) {
        setErr('No puedes quitar el último destinatario del reporte principal.')
        return
      }
    }
    try {
      const { error } = await (supabase
        .from('report_recipients')
        .update({ [field]: newValue })
        .eq('id', row.id) as any)
      if (error) throw error
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error actualizando destinatario')
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────
  async function handleDelete(row: Recipient) {
    setErr(null); setInfo(null)
    // Same safeguard as toggle — don't allow deleting the last active
    // main-digest recipient.
    if (row.recv_main && row.activo) {
      const otherMainActive = rows.filter(r =>
        r.id !== row.id && r.recv_main && r.activo
      ).length
      if (otherMainActive === 0) {
        setErr('No puedes eliminar al último destinatario del reporte principal.')
        return
      }
    }
    if (!confirm(`¿Eliminar a "${row.nombre}" (${row.email})?\n\nDejará de recibir todos los reportes.`)) return
    try {
      const { error } = await (supabase
        .from('report_recipients')
        .delete()
        .eq('id', row.id) as any)
      if (error) throw error
      setInfo('Destinatario eliminado')
      await load()
    } catch (e: any) {
      setErr(e.message || 'Error eliminando destinatario')
    }
  }

  // ── Test send ────────────────────────────────────────────────────────────
  async function handleTestSend() {
    setErr(null); setInfo(null)
    if (!confirm('¿Enviar reporte de prueba AHORA?\n\nUsará los destinatarios actualmente activos y el estado de hoy de los datos.')) return
    setTesting(true)
    try {
      // GET ?force=1 — bypasses Sunday-skip and triggers an immediate send.
      // Non-blocking: the Worker runs in the background; we just confirm the
      // trigger was accepted.
      const r = await fetch(REPORTS_WORKER + '/?force=1', { method: 'GET' })
      if (!r.ok) throw new Error(`Worker respondió ${r.status}`)
      setInfo('Reporte de prueba disparado. Llegará en ~10 segundos a los destinatarios activos.')
    } catch (e: any) {
      setErr('No se pudo disparar el reporte: ' + (e.message || 'error de red'))
    } finally {
      setTesting(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 920 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
        Destinatarios de Reportes
      </h2>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.5 }}>
        Quienes reciben los emails automáticos a las 6:00 PM VET, de lunes a sábado.
        Cada persona puede recibir el reporte principal (negocios + tesorería), el
        reporte exclusivo de tesorería, o ambos.
      </p>

      {/* Status banners */}
      {err && (
        <div style={{ background: 'rgba(187,22,43,0.08)', border: '1px solid rgba(187,22,43,0.3)', color: '#BB162B', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
          {err}
        </div>
      )}
      {info && (
        <div style={{ background: 'rgba(21,101,192,0.08)', border: '1px solid rgba(21,101,192,0.3)', color: '#1565C0', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
          {info}
        </div>
      )}

      {/* ── Add new ───────────────────────────────────────────────────── */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: 'var(--text-primary)' }}>Agregar destinatario</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <input
            type="text"
            placeholder="Nombre (ej. Mirla Admin)"
            value={newNombre}
            onChange={e => setNewNombre(e.target.value)}
            style={inputStyle}
          />
          <input
            type="email"
            placeholder="email@ejemplo.com"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 14 }}>
          <label style={cbLabel}>
            <input type="checkbox" checked={newMain} onChange={e => setNewMain(e.target.checked)} />
            Reporte principal
          </label>
          <label style={cbLabel}>
            <input type="checkbox" checked={newTes} onChange={e => setNewTes(e.target.checked)} />
            Reporte de tesorería
          </label>
        </div>
        <button
          onClick={handleAdd}
          disabled={saving}
          style={{ ...btnPrimary, opacity: saving ? 0.6 : 1, cursor: saving ? 'wait' : 'pointer' }}
        >
          {saving ? 'Agregando…' : '+ Agregar destinatario'}
        </button>
      </div>

      {/* ── Existing rows table ───────────────────────────────────────── */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
          Destinatarios actuales {rows.length > 0 && <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>· {rows.length}</span>}
        </div>
        {loading ? (
          <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 13 }}>Cargando…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
            No hay destinatarios. Agrega al menos uno arriba — sin destinatarios activos, el Worker usa la lista por defecto.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-page)', borderBottom: '1px solid var(--border)' }}>
                <th style={thStyle}>Nombre</th>
                <th style={thStyle}>Email</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Principal</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Tesorería</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Activo</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border)', opacity: r.activo ? 1 : 0.5 }}>
                  <td style={tdStyle}>{r.nombre}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: 12 }}>{r.email}</td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>
                    <button onClick={() => toggle(r, 'recv_main')} style={pillStyle(r.recv_main)}>
                      {r.recv_main ? '✓' : '—'}
                    </button>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>
                    <button onClick={() => toggle(r, 'recv_tesoreria')} style={pillStyle(r.recv_tesoreria)}>
                      {r.recv_tesoreria ? '✓' : '—'}
                    </button>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>
                    <button onClick={() => toggle(r, 'activo')} style={pillStyle(r.activo)}>
                      {r.activo ? '✓' : '—'}
                    </button>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <button
                      onClick={() => handleDelete(r)}
                      style={btnDelete}
                      title="Eliminar destinatario"
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Test send ─────────────────────────────────────────────────── */}
      <div style={{ background: 'rgba(21,101,192,0.04)', border: '1px solid rgba(21,101,192,0.2)', borderRadius: 10, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1565C0', marginBottom: 6 }}>Enviar reporte de prueba</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
          Dispara el reporte de hoy a TODOS los destinatarios activos, sin esperar a las 6 PM.
          Útil para verificar cambios. Usa los datos actuales del sistema.
        </div>
        <button
          onClick={handleTestSend}
          disabled={testing || loading || rows.length === 0}
          style={{
            ...btnSecondary,
            opacity: (testing || loading || rows.length === 0) ? 0.5 : 1,
            cursor: (testing || loading || rows.length === 0) ? 'not-allowed' : 'pointer',
          }}
        >
          {testing ? 'Enviando…' : 'Enviar reporte de prueba ahora'}
        </button>
      </div>
    </div>
  )
}

// ── Validation ─────────────────────────────────────────────────────────────
function validEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
}

// ── Styles (kept simple, matching the rest of /settings) ──────────────────
const inputStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-input)',
  fontSize: 13,
  color: 'var(--text-primary)',
  outline: 'none',
}
const cbLabel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 13,
  color: 'var(--text-primary)',
  cursor: 'pointer',
}
const btnPrimary: React.CSSProperties = {
  background: '#BB162B',
  color: 'white',
  border: 'none',
  padding: '8px 16px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
}
const btnSecondary: React.CSSProperties = {
  background: '#1565C0',
  color: 'white',
  border: 'none',
  padding: '8px 16px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
}
const btnDelete: React.CSSProperties = {
  background: 'transparent',
  color: '#BB162B',
  border: '1px solid rgba(187,22,43,0.3)',
  padding: '4px 10px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
}
const thStyle: React.CSSProperties = {
  padding: '10px 14px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
}
const tdStyle: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: 13,
  color: 'var(--text-primary)',
}
function pillStyle(on: boolean): React.CSSProperties {
  return {
    border: 'none',
    background: on ? '#1565C0' : 'var(--bg-input)',
    color: on ? 'white' : 'var(--text-secondary)',
    padding: '2px 12px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    minWidth: 36,
  }
}