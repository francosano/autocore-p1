// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/settings/NotificacionesTab.tsx
// v1 (2026-05-19) — Tesorería WhatsApp notifications: subscriber manager.
//
// Manages rows in `tesoreria_notify_subscribers`:
//   id, nombre, telefono, activo, notify_bancarizacion, created_at
//
// DESIGN DECISIONS (locked with Franco, 2026-05-19):
//  · Recipients are DEPARTMENTS / LOCATIONS — never personal names. `nombre`
//    holds a department label picked from a fixed dropdown (DEPARTAMENTOS).
//  · Every active subscriber receives every one of the 16 tesorería
//    notification templates ("everyone gets everything") — there is no
//    per-template routing yet, so `notify_bancarizacion` is treated as a
//    simple master on/off and shown as "Recibe notificaciones".
//  · Phone is stored as typed; the autocore-whatsapp worker normalizes any
//    Venezuelan format → E.164 at send time, so free-form local input is OK.
//
// Admin-only — rendered only inside the settings page, which already gates on
// role ∈ {admin, manager, administrador, gerente}. RLS on the table also
// restricts writes to has_perm('npa_can_admin') / has_perm('tesoreria_admin').
//
// Styling: reuses the parent settings page's `s` object shape and toggle
// pattern so it's visually identical to the other tabs. Self-contained —
// imports only supabase + react.
// ═══════════════════════════════════════════════════════════════════════════
'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'

// ─── Fixed department list ──────────────────────────────────────────────────
// "For now" per Franco — a dropdown keeps labels consistent and typo-free.
// Add entries here (and nothing else) to grow the list later.
const DEPARTAMENTOS = [
  'Ventas',
  'Administración',
  'Gerencia',
  'Dirección',
]

interface Subscriber {
  id: string
  nombre: string
  telefono: string
  activo: boolean
  notify_bancarizacion: boolean
  created_at: string
}

// Local mirror of the parent page's style object (same keys/values) so this
// component renders identically without importing from page.tsx.
const s: any = {
  card:    { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', marginBottom: '20px' },
  input:   { width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  btnRed:  { padding: '9px 20px', background: 'var(--brand-primary)', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', letterSpacing: '1px' },
  btnGray: { padding: '9px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' },
  label:   { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.5px', display: 'block', marginBottom: '6px' },
  toggle:  (on: boolean) => ({
    width: '36px', height: '20px', borderRadius: '10px', position: 'relative' as const,
    background: on ? '#10B981' : 'var(--border)', cursor: 'pointer', border: 'none',
    transition: 'background 0.2s', flexShrink: 0,
  }),
  toggleDot: (on: boolean) => ({
    position: 'absolute' as const, top: '3px', left: on ? '17px' : '3px',
    width: '14px', height: '14px', borderRadius: '50%', background: '#fff',
    transition: 'left 0.2s', pointerEvents: 'none' as const,
  }),
}

const thTd: any = { padding: '10px 12px', textAlign: 'left', fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px' }

function Toast({ msg, type }: { msg: string, type: 'success' | 'error' }) {
  return (
    <div style={{ position: 'fixed', bottom: '24px', right: '24px', background: type === 'success' ? '#1a7a4a' : 'var(--brand-primary)', color: '#fff', padding: '12px 20px', borderRadius: '10px', fontSize: '13px', fontWeight: 600, zIndex: 9999, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
      {type === 'success' ? '✓' : '✕'} {msg}
    </div>
  )
}

export default function NotificacionesTab() {
  const [subs, setSubs] = useState<Subscriber[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string, type: 'success' | 'error' } | null>(null)

  // Add/edit form. editId = null → adding; otherwise editing that row.
  const [editId, setEditId] = useState<string | null>(null)
  const [formDept, setFormDept] = useState(DEPARTAMENTOS[0])
  const [formPhone, setFormPhone] = useState('')

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async () => {
    setLoading(true)
    // `as any` wrap — guards against the Supabase TS-inference bug on
    // chains touching Unicode data. Array.isArray guard handles the case
    // where the mangled type yields a non-array.
    const { data, error } = await (supabase
      .from('tesoreria_notify_subscribers')
      .select('id, nombre, telefono, activo, notify_bancarizacion, created_at')
      .order('created_at', { ascending: true }) as any)
    if (error) {
      showToast('Error al cargar: ' + error.message, 'error')
      setSubs([])
    } else {
      setSubs(Array.isArray(data) ? (data as Subscriber[]) : [])
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const resetForm = () => {
    setEditId(null)
    setFormDept(DEPARTAMENTOS[0])
    setFormPhone('')
  }

  const startEdit = (sub: Subscriber) => {
    setEditId(sub.id)
    // If a stored dept isn't in the current list, fall back to the first
    // option so the <select> stays controlled.
    setFormDept(DEPARTAMENTOS.includes(sub.nombre) ? sub.nombre : DEPARTAMENTOS[0])
    setFormPhone(sub.telefono || '')
  }

  // Light client-side phone sanity check. The worker does real E.164
  // normalization — here we only block obviously-empty / too-short input.
  const phoneLooksValid = (p: string) => p.replace(/\D/g, '').length >= 10

  const saveForm = async () => {
    if (!phoneLooksValid(formPhone)) {
      showToast('Teléfono inválido — incluye el código de área', 'error')
      return
    }
    setSaving(true)
    try {
      if (editId) {
        // `as any` wrap — Supabase JS TS-inference bug mangles chains whose
        // payload/columns involve Unicode (e.g. nombre = 'Tesorería'); the
        // mangled call can hang. Casting bypasses the broken inference.
        const { error } = await (supabase
          .from('tesoreria_notify_subscribers')
          .update({ nombre: formDept, telefono: formPhone.trim() })
          .eq('id', editId) as any)
        if (error) throw error
        showToast('Suscriptor actualizado')
      } else {
        const { error } = await (supabase
          .from('tesoreria_notify_subscribers')
          .insert({
            nombre: formDept,
            telefono: formPhone.trim(),
            activo: true,
            notify_bancarizacion: true,
          }) as any)
        if (error) throw error
        showToast('Suscriptor agregado')
      }
      resetForm()
      load()
    } catch (e: any) {
      showToast('Error: ' + (e?.message || 'no se pudo guardar'), 'error')
    } finally {
      // Always clears "Guardando…" — even on a thrown error.
      setSaving(false)
    }
  }

  const toggleActivo = async (sub: Subscriber) => {
    const next = !sub.activo
    // Optimistic update.
    setSubs(xs => xs.map(x => x.id === sub.id ? { ...x, activo: next } : x))
    const { error } = await (supabase
      .from('tesoreria_notify_subscribers')
      .update({ activo: next })
      .eq('id', sub.id) as any)
    if (error) {
      showToast('Error: ' + error.message, 'error')
      load() // revert to server truth
    } else {
      showToast(next ? 'Suscriptor activado' : 'Suscriptor desactivado')
    }
  }

  const remove = async (sub: Subscriber) => {
    if (!confirm(`¿Eliminar a "${sub.nombre}" (${sub.telefono}) de las notificaciones?`)) return
    const { error } = await (supabase
      .from('tesoreria_notify_subscribers')
      .delete()
      .eq('id', sub.id) as any)
    if (error) { showToast('Error: ' + error.message, 'error'); return }
    showToast('Suscriptor eliminado')
    if (editId === sub.id) resetForm()
    load()
  }

  const activeCount = subs.filter(x => x.activo).length

  return (
    <div>
      {toast && <Toast msg={toast.msg} type={toast.type} />}

      {/* ── Explainer ── */}
      <div style={{ ...s.card, background: 'rgba(30,79,163,0.05)', borderColor: 'rgba(30,79,163,0.2)' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
          Notificaciones por WhatsApp
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Los departamentos en esta lista reciben alertas del sistema por
          WhatsApp. Todos los suscriptores activos reciben todas las
          notificaciones. Usa el interruptor para activar o pausar un
          departamento sin eliminarlo.
        </div>
      </div>

      {/* ── Add / edit form ── */}
      <div style={s.card}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--border)' }}>
          {editId ? 'Editar Suscriptor' : 'Agregar Suscriptor'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '12px', alignItems: 'end' }}>
          <div>
            <label style={s.label}>Departamento / Ubicación</label>
            <select style={s.input} value={formDept} onChange={e => setFormDept(e.target.value)}>
              {DEPARTAMENTOS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={s.label}>Teléfono WhatsApp</label>
            <input
              style={s.input}
              value={formPhone}
              onChange={e => setFormPhone(e.target.value)}
              placeholder="0424-3494018"
            />
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {editId && (
              <button style={s.btnGray} onClick={resetForm} disabled={saving}>Cancelar</button>
            )}
            <button style={{ ...s.btnRed, opacity: saving ? 0.5 : 1 }} onClick={saveForm} disabled={saving}>
              {saving ? 'Guardando…' : editId ? 'Guardar' : '+ Agregar'}
            </button>
          </div>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
          El teléfono puede escribirse en formato local (0424-…) — el sistema lo
          convierte automáticamente al enviar.
        </div>
      </div>

      {/* ── Subscriber list ── */}
      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Departamentos Suscritos
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            {subs.length} suscriptor{subs.length !== 1 ? 'es' : ''} · {activeCount} activo{activeCount !== 1 ? 's' : ''}
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-secondary)', fontSize: '13px' }}>Cargando…</div>
        ) : subs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-secondary)', fontSize: '13px' }}>
            Aún no hay departamentos suscritos. Agrega el primero arriba.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Departamento', 'Teléfono', 'Recibe Notificaciones', 'Acciones'].map(h => (
                  <th key={h} style={thTd}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subs.map(sub => (
                <tr key={sub.id} style={{ borderBottom: '1px solid var(--border)', opacity: sub.activo ? 1 : 0.5 }}>
                  <td style={{ padding: '14px 12px', fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>
                    {sub.nombre}
                  </td>
                  <td style={{ padding: '14px 12px', fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                    {sub.telefono}
                  </td>
                  <td style={{ padding: '14px 12px' }}>
                    <button style={s.toggle(sub.activo)} onClick={() => toggleActivo(sub)}>
                      <div style={s.toggleDot(sub.activo)} />
                    </button>
                  </td>
                  <td style={{ padding: '14px 12px' }}>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        onClick={() => startEdit(sub)}
                        style={{ padding: '4px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => remove(sub)}
                        style={{ padding: '4px 12px', background: 'transparent', border: '1px solid #EF444444', borderRadius: '6px', color: '#EF4444', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                      >
                        Eliminar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}