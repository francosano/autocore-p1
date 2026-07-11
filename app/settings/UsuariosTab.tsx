// TARGET: autocore-p1/app/settings/UsuariosTab.tsx
'use client'
// ═══════════════════════════════════════════════════════════════════════════
// Configuración → Usuarios & Roles (worker-backed, DealerCenter-style UI)
//
// user_roles / user_permissions have NO browser-facing RLS (fail closed), so
// every read and mutation here goes through the autocore-admin-users worker
// with the caller's JWT. The worker requires npa_can_admin + is_active,
// rejects self-edit, and writes activity_log rows for every mutation.
//
// The ONLY direct Supabase calls are role_templates SELECT (admin policy)
// and auth.resetPasswordForEmail (auth API, not RLS).
// ═══════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../supabase'
import { TENANT } from '../tenant.config'

// Empty = feature disabled until the p1 admin-users Worker is deployed.
const WORKER_URL: string = TENANT.workers.adminUsers

// Corporate palette (DealerCenter-style)
const ACCENT = '#1B6EC2'
const GREEN = '#188A55'
const RED = '#C0392B'
const AMBER = '#B8720A'

// ── types ─────────────────────────────────────────────────────────────────────
interface AdminUser {
  user_id: string
  role: string
  email: string | null
  full_name: string | null
  is_active: boolean
  last_seen_at: string | null
  telefono_wa: string | null
  crm_role: string | null
  created_at: string | null
  permissions: Record<string, boolean> | null
}
interface RoleTemplate {
  role: string
  label: string | null
  permissions: Record<string, boolean> | null
}

// ── helpers ───────────────────────────────────────────────────────────────────
const fmtDateTime = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('es-VE') + ' ' + d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })
}

const flagLabel = (flag: string) =>
  flag.replace(/^npa_/, '').replace(/^tesoreria_/, '').replace(/^can_/, '').replace(/_/g, ' ')

function groupFlags(flags: string[]): { title: string; flags: string[] }[] {
  const npa = flags.filter(f => f.startsWith('npa_')).sort()
  const tesoreria = flags.filter(f => f.startsWith('tesoreria_')).sort()
  const cobranza = flags.filter(f => !f.startsWith('npa_') && !f.startsWith('tesoreria_')).sort()
  return [
    { title: 'NPA', flags: npa },
    { title: 'Tesorería', flags: tesoreria },
    { title: 'Cobranza / Portal', flags: cobranza },
  ].filter(g => g.flags.length > 0)
}

// phone → E.164 (+584121234567 style, no spaces)
type CountryCode = '+58' | '+1'
function toE164(country: CountryCode, raw: string): string | null {
  const d = String(raw || '').replace(/\D/g, '')
  if (!d) return null
  if (country === '+58') {
    if (d.length === 12 && d.startsWith('58')) return '+' + d
    if (d.length === 11 && d.startsWith('0')) return '+58' + d.slice(1)   // 04121234567
    if (d.length === 10) return '+58' + d                                  // 4121234567
    return null
  }
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  if (d.length === 10) return '+1' + d
  return null
}

// worker fetch — always sends the session access token
async function workerFetch(path: string, init?: RequestInit): Promise<any> {
  if (!WORKER_URL) throw new Error('Función no disponible: el Worker de administración de usuarios no está configurado.')
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new Error('Sesión expirada. Vuelve a iniciar sesión.')
  const r = await fetch(WORKER_URL + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    if (r.status === 401) throw new Error('Sesión inválida o expirada. Vuelve a iniciar sesión.')
    if (r.status === 403) throw new Error(j?.error || 'No tienes permisos para esta acción.')
    throw new Error(j?.error || `Error del servidor (${r.status}).`)
  }
  return j
}

// ── styles (corporate) ────────────────────────────────────────────────────────
const s: any = {
  panel: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', marginBottom: '16px', overflow: 'hidden' },
  panelHead: { padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-deep)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' as const },
  panelTitle: { fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' },
  input: { padding: '8px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '12.5px', outline: 'none', boxSizing: 'border-box' as const, width: '100%' },
  btn: (bg: string) => ({ padding: '8px 16px', background: bg, color: '#fff', border: 'none', borderRadius: '4px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }),
  btnGhost: { padding: '8px 16px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' },
  btnLink: { padding: '2px 6px', background: 'transparent', border: 'none', color: ACCENT, fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
  label: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.2px', display: 'block', marginBottom: '6px' },
  th: { padding: '9px 12px', textAlign: 'left' as const, fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '1px', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' as const },
  td: { padding: '9px 12px', fontSize: '12.5px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' as const },
  badge: (color: string) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: '3px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.5px', background: color + '1A', color, border: `1px solid ${color}40`, whiteSpace: 'nowrap' as const }),
  toggle: (on: boolean, disabled?: boolean) => ({
    width: '34px', height: '18px', borderRadius: '9px', position: 'relative' as const,
    background: on ? GREEN : 'var(--border)', cursor: disabled ? 'default' : 'pointer', border: 'none',
    transition: 'background 0.2s', flexShrink: 0, opacity: disabled ? 0.5 : 1,
  }),
  toggleDot: (on: boolean) => ({
    position: 'absolute' as const, top: '3px', left: on ? '19px' : '3px',
    width: '12px', height: '12px', borderRadius: '50%', background: '#fff',
    transition: 'left 0.2s', pointerEvents: 'none' as const,
  }),
  modalWrap: { position: 'fixed', inset: 0, background: 'rgba(9,17,28,0.75)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' },
  modal: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', maxWidth: '480px', width: '100%', maxHeight: '90vh', overflowY: 'auto' as const, boxShadow: '0 10px 40px rgba(0,0,0,0.35)' },
  modalHead: { padding: '14px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg-deep)' },
  modalBody: { padding: '20px' },
  modalFoot: { padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: '10px' },
  drawerWrap: { position: 'fixed', inset: 0, background: 'rgba(9,17,28,0.6)', zIndex: 9998, display: 'flex', justifyContent: 'flex-end' },
  drawer: { background: 'var(--bg-card)', borderLeft: '1px solid var(--border)', width: '100%', maxWidth: '500px', height: '100%', display: 'flex', flexDirection: 'column' as const, boxShadow: '-6px 0 24px rgba(0,0,0,0.25)' },
  groupBox: { border: '1px solid var(--border)', borderRadius: '6px', marginTop: '12px', overflow: 'hidden' },
  groupHead: { padding: '8px 12px', background: 'var(--bg-deep)', borderBottom: '1px solid var(--border)', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '1.2px', color: 'var(--text-secondary)' },
}

function Toast({ msg, type }: { msg: string, type: 'success' | 'error' }) {
  return (
    <div style={{ position: 'fixed', bottom: '24px', right: '24px', background: type === 'success' ? GREEN : RED, color: '#fff', padding: '12px 20px', borderRadius: '4px', fontSize: '13px', fontWeight: 600, zIndex: 10002, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
      {msg}
    </div>
  )
}

function ConfirmModal({ title, message, confirmLabel, danger, busy, onConfirm, onCancel }: {
  title: string, message: string, confirmLabel: string, danger?: boolean, busy?: boolean,
  onConfirm: () => void, onCancel: () => void
}) {
  return (
    <div style={{ ...s.modalWrap, zIndex: 10001 }}>
      <div style={{ ...s.modal, maxWidth: '420px' }}>
        <div style={s.modalHead}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: danger ? RED : 'var(--text-primary)' }}>{title}</div>
        </div>
        <div style={{ ...s.modalBody, fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-line' as const }}>{message}</div>
        <div style={s.modalFoot}>
          <button onClick={onCancel} style={s.btnGhost} disabled={busy}>Cancelar</button>
          <button onClick={onConfirm} disabled={busy} style={{ ...s.btn(danger ? RED : ACCENT), opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Guardando...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── MAIN TAB ──────────────────────────────────────────────────────────────────
export default function UsuariosTab({ currentUserId }: { currentUserId: string | undefined }) {
  // Graceful degrade: the whole tab is worker-backed, so without a configured
  // Worker there is nothing to show or mutate.
  if (!WORKER_URL) {
    return (
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', padding: '32px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
        Función no disponible: el Worker de administración de usuarios aún no está configurado para este entorno.
      </div>
    )
  }
  const [users, setUsers] = useState<AdminUser[]>([])
  const [templates, setTemplates] = useState<RoleTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState<{ msg: string, type: 'success' | 'error' } | null>(null)
  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 4000)
  }

  const roleLabel = useCallback((role: string) => {
    const t = templates.find(t => t.role === role)
    return t?.label || role
  }, [templates])

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    try {
      const j = await workerFetch('/users')
      setUsers(Array.isArray(j?.users) ? j.users : [])
    } catch (e: any) {
      setLoadError(e?.message || 'No se pudo cargar la lista de usuarios.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    ;(async () => {
      try {
        const { data } = await (supabase.from('role_templates').select('role, label, permissions').order('role') as any)
        if (Array.isArray(data)) setTemplates(data as RoleTemplate[])
      } catch { /* dropdown falls back to raw role strings */ }
    })()
  }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return users
    return users.filter(u =>
      `${u.full_name || ''} ${u.email || ''} ${u.role || ''} ${u.telefono_wa || ''}`.toLowerCase().includes(q))
  }, [users, search])

  // ── drawer state ────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<AdminUser | null>(null)
  const [draft, setDraft] = useState<Record<string, boolean>>({})
  const [roleDraft, setRoleDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [drawerError, setDrawerError] = useState('')
  const [confirm, setConfirm] = useState<{ title: string, message: string, label: string, danger?: boolean, fn: () => void } | null>(null)
  const isSelf = !!selected && selected.user_id === currentUserId

  function openDrawer(u: AdminUser) {
    setSelected(u); setDraft({ ...(u.permissions || {}) }); setRoleDraft(u.role); setDrawerError('')
  }
  function closeDrawer() {
    if (busy) return
    setSelected(null); setDraft({}); setRoleDraft(''); setDrawerError('')
  }

  const changedFlags = useMemo(() => {
    if (!selected?.permissions) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(draft)) {
      if (selected.permissions[k] !== v) out[k] = v
    }
    return out
  }, [draft, selected])
  const dirty = Object.keys(changedFlags).length > 0

  // Reload and re-point the drawer at the fresh row.
  async function reloadKeeping(userId: string) {
    try {
      const j = await workerFetch('/users')
      const list: AdminUser[] = Array.isArray(j?.users) ? j.users : []
      setUsers(list)
      const fresh = list.find(u => u.user_id === userId)
      if (fresh) { setSelected(fresh); setDraft({ ...(fresh.permissions || {}) }); setRoleDraft(fresh.role) }
    } catch { /* list refresh failed; mutation already succeeded */ }
  }

  async function handleSavePermissions() {
    if (!selected || !dirty || isSelf) return
    setBusy(true); setDrawerError('')
    try {
      await workerFetch('/set-permissions', {
        method: 'POST',
        body: JSON.stringify({ user_id: selected.user_id, permissions: changedFlags }),
      })
      showToast('Permisos actualizados')
      await reloadKeeping(selected.user_id)
    } catch (e: any) {
      setDrawerError(e?.message || 'No se pudieron guardar los permisos.')
    } finally {
      setBusy(false)
    }
  }

  function askChangeRole() {
    if (!selected || isSelf || roleDraft === selected.role) return
    setConfirm({
      title: 'Cambiar rol',
      message: `${selected.full_name || selected.email} pasará al rol "${roleLabel(roleDraft)}".\n\nATENCIÓN: los permisos actuales se reinician a la plantilla del nuevo rol; cualquier ajuste manual se pierde.`,
      label: 'Cambiar rol',
      danger: true,
      fn: doChangeRole,
    })
  }
  async function doChangeRole() {
    if (!selected) return
    setBusy(true); setDrawerError('')
    try {
      await workerFetch('/set-role', {
        method: 'POST',
        body: JSON.stringify({ user_id: selected.user_id, role: roleDraft }),
      })
      showToast(`Rol cambiado a ${roleLabel(roleDraft)}`)
      setConfirm(null)
      await reloadKeeping(selected.user_id)
    } catch (e: any) {
      setDrawerError(e?.message || 'No se pudo cambiar el rol.')
      setRoleDraft(selected.role)
      setConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  function askToggleActive() {
    if (!selected || isSelf) return
    const next = !selected.is_active
    setConfirm({
      title: next ? 'Activar usuario' : 'Desactivar usuario',
      message: next
        ? `${selected.full_name || selected.email} recuperará acceso al sistema.`
        : `${selected.full_name || selected.email} perderá acceso al sistema inmediatamente.`,
      label: next ? 'Activar' : 'Desactivar',
      danger: !next,
      fn: () => doToggleActive(next),
    })
  }
  async function doToggleActive(next: boolean) {
    if (!selected) return
    setBusy(true); setDrawerError('')
    try {
      await workerFetch('/set-active', {
        method: 'POST',
        body: JSON.stringify({ user_id: selected.user_id, is_active: next }),
      })
      showToast(next ? 'Usuario activado' : 'Usuario desactivado')
      setConfirm(null)
      await reloadKeeping(selected.user_id)
    } catch (e: any) {
      setDrawerError(e?.message || 'No se pudo cambiar el estado.')
      setConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  // Reset password: auth API (works from the browser; not an RLS table write).
  function askResetPassword(u: AdminUser) {
    if (!u.email) return
    setConfirm({
      title: 'Resetear contraseña',
      message: `Se enviará un correo de restablecimiento a ${u.email}.`,
      label: 'Enviar correo',
      fn: () => doResetPassword(u),
    })
  }
  async function doResetPassword(u: AdminUser) {
    setBusy(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(u.email as string, {
        redirectTo: window.location.origin + '/reset-password',
      })
      if (error) throw error
      showToast('Correo de restablecimiento enviado a ' + u.email)
    } catch (e: any) {
      showToast('Error: ' + (e?.message || e), 'error')
    } finally {
      setConfirm(null)
      setBusy(false)
    }
  }

  // ── invite modal ────────────────────────────────────────────────────────────
  const [inviteOpen, setInviteOpen] = useState(false)
  const [invEmail, setInvEmail] = useState('')
  const [invName, setInvName] = useState('')
  const [invRole, setInvRole] = useState('')
  const [invCountry, setInvCountry] = useState<CountryCode>('+58')
  const [invPhone, setInvPhone] = useState('')
  const [invBusy, setInvBusy] = useState(false)
  const [invError, setInvError] = useState('')

  function openInvite() {
    setInvEmail(''); setInvName(''); setInvRole(''); setInvCountry('+58'); setInvPhone(''); setInvError('')
    setInviteOpen(true)
  }
  const invPhoneE164 = invPhone.trim() ? toE164(invCountry, invPhone) : null
  const invPhoneInvalid = invPhone.trim().length > 0 && !invPhoneE164

  async function handleInvite() {
    setInvError('')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invEmail.trim())) { setInvError('Email inválido.'); return }
    if (!invName.trim()) { setInvError('Indica el nombre completo.'); return }
    if (!invRole) { setInvError('Selecciona un rol.'); return }
    if (invPhoneInvalid) { setInvError('Teléfono inválido para el país seleccionado.'); return }
    setInvBusy(true)
    try {
      await workerFetch('/invite', {
        method: 'POST',
        body: JSON.stringify({
          email: invEmail.trim().toLowerCase(),
          full_name: invName.trim(),
          role: invRole,
          telefono_wa: invPhoneE164 || '',
        }),
      })
      showToast(`Invitación enviada a ${invEmail.trim().toLowerCase()}`)
      setInviteOpen(false)
      await load()
    } catch (e: any) {
      setInvError(e?.message || 'No se pudo enviar la invitación.')
    } finally {
      setInvBusy(false)
    }
  }

  // ── render ──────────────────────────────────────────────────────────────────
  const groups = selected?.permissions ? groupFlags(Object.keys(selected.permissions)) : []

  return (
    <div>
      {/* row hover — inline styles can't express :hover */}
      <style>{`.uzt-row:hover { background: var(--bg-deep); }`}</style>
      {toast && <Toast msg={toast.msg} type={toast.type} />}
      {confirm && (
        <ConfirmModal
          title={confirm.title} message={confirm.message} confirmLabel={confirm.label}
          danger={confirm.danger} busy={busy}
          onConfirm={confirm.fn} onCancel={() => { if (!busy) setConfirm(null) }}
        />
      )}

      <div style={s.panel}>
        <div style={s.panelHead}>
          <div style={s.panelTitle}>
            Usuarios del Sistema
            <span style={{ marginLeft: '10px', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
              {users.length} total · {users.filter(u => u.is_active).length} activos
            </span>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <input
              style={{ ...s.input, width: '240px' }}
              placeholder="Buscar nombre, email, rol..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <button onClick={openInvite} style={s.btn(ACCENT)}>+ Invitar Usuario</button>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)', fontSize: '13px' }}>Cargando usuarios...</div>
        ) : loadError ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <div style={{ fontSize: '13px', color: RED, marginBottom: '12px' }}>{loadError}</div>
            <button style={s.btnGhost} onClick={load}>Reintentar</button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)', fontSize: '13px' }}>
            {users.length === 0 ? 'No hay usuarios' : 'Sin resultados para la búsqueda'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Usuario', 'Rol', 'Teléfono', 'Estado', 'Última conexión', ''].map((h, i) => (
                    <th key={i} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(u => {
                  const self = u.user_id === currentUserId
                  return (
                    <tr key={u.user_id} className="uzt-row" style={{ opacity: u.is_active ? 1 : 0.55 }}>
                      <td style={s.td}>
                        <div style={{ fontWeight: 600 }}>
                          {u.full_name || '—'}
                          {self && <span style={{ marginLeft: '6px', ...s.badge(ACCENT), padding: '1px 6px' }}>Tú</span>}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{u.email || '—'}</div>
                      </td>
                      <td style={s.td}><span style={s.badge('#5A7BA6')}>{roleLabel(u.role)}</span></td>
                      <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '11.5px', color: 'var(--text-secondary)' }}>{u.telefono_wa || '—'}</td>
                      <td style={s.td}>
                        <span style={s.badge(u.is_active ? GREEN : RED)}>{u.is_active ? 'Activo' : 'Inactivo'}</span>
                      </td>
                      <td style={{ ...s.td, fontSize: '11.5px', color: 'var(--text-secondary)', fontFamily: 'monospace', whiteSpace: 'nowrap' as const }}>{fmtDateTime(u.last_seen_at)}</td>
                      <td style={{ ...s.td, textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
                        <button onClick={() => openDrawer(u)} style={s.btnLink}>{self ? 'Ver' : 'Editar'}</button>
                        {u.email && (
                          <button onClick={() => askResetPassword(u)} style={{ ...s.btnLink, color: 'var(--text-secondary)' }}>Reset Pwd</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── ROW DRAWER ─────────────────────────────────────────────────────── */}
      {selected && (
        <div style={s.drawerWrap} onClick={closeDrawer}>
          <div style={s.drawer} onClick={e => e.stopPropagation()}>
            {/* header */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg-deep)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>{selected.full_name || selected.email}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '3px' }}>
                  {selected.email || '—'}{selected.telefono_wa ? ` · ${selected.telefono_wa}` : ''}
                </div>
                <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' as const }}>
                  <span style={s.badge(selected.is_active ? GREEN : RED)}>{selected.is_active ? 'Activo' : 'Inactivo'}</span>
                  <span style={s.badge('#5A7BA6')}>{roleLabel(selected.role)}</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Última conexión: {fmtDateTime(selected.last_seen_at)}</span>
                </div>
              </div>
              <button style={{ ...s.btnGhost, padding: '5px 12px' }} onClick={closeDrawer} disabled={busy}>Cerrar</button>
            </div>

            {/* body */}
            <div style={{ flex: 1, overflowY: 'auto' as const, padding: '20px' }}>
              {isSelf && (
                <div style={{ padding: '10px 12px', borderRadius: '4px', border: `1px solid ${AMBER}66`, background: `${AMBER}14`, fontSize: '12px', color: 'var(--text-primary)', marginBottom: '16px' }}>
                  No puedes editar tu propio acceso.
                </div>
              )}

              {drawerError && (
                <div style={{ padding: '10px 12px', borderRadius: '4px', border: `1px solid ${RED}66`, background: `${RED}14`, fontSize: '12px', color: RED, marginBottom: '16px' }}>
                  {drawerError}
                </div>
              )}

              {/* Role */}
              <label style={s.label}>Rol del Sistema</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <select
                  style={{ ...s.input, flex: 1 }}
                  value={roleDraft}
                  disabled={isSelf || busy}
                  onChange={e => setRoleDraft(e.target.value)}
                >
                  {/* current role may not exist in role_templates (e.g. auditoria_ingresos) —
                      keep it visible so the select never silently shows a wrong role */}
                  {!templates.some(t => t.role === roleDraft) && <option value={roleDraft}>{roleDraft} (sin plantilla)</option>}
                  {templates.map(t => <option key={t.role} value={t.role}>{t.label || t.role}</option>)}
                </select>
                <button
                  style={{ ...s.btn(ACCENT), opacity: (isSelf || busy || roleDraft === selected.role) ? 0.5 : 1 }}
                  disabled={isSelf || busy || roleDraft === selected.role}
                  onClick={askChangeRole}
                >Cambiar</button>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                Cambiar el rol reinicia los permisos a la plantilla del nuevo rol.
              </div>

              {/* Permissions */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '24px' }}>
                <label style={{ ...s.label, marginBottom: 0 }}>Permisos</label>
                <button
                  style={{ ...s.btn(GREEN), padding: '6px 14px', opacity: (!dirty || isSelf || busy) ? 0.5 : 1 }}
                  disabled={!dirty || isSelf || busy}
                  onClick={handleSavePermissions}
                >{busy ? 'Guardando...' : dirty ? `Guardar cambios (${Object.keys(changedFlags).length})` : 'Guardar cambios'}</button>
              </div>
              {!selected.permissions ? (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '10px' }}>
                  Este usuario no tiene fila de permisos. Asigna un rol para crearla desde la plantilla.
                </div>
              ) : (
                groups.map(g => (
                  <div key={g.title} style={s.groupBox}>
                    <div style={s.groupHead}>{g.title}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                      {g.flags.map(f => (
                        <div key={f} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '7px 12px', borderBottom: '1px solid var(--border)' }}>
                          <span style={{ fontSize: '11.5px', color: 'var(--text-primary)', textTransform: 'capitalize' as const }}>{flagLabel(f)}</span>
                          <button
                            style={s.toggle(draft[f] === true, isSelf || busy)}
                            disabled={isSelf || busy}
                            onClick={() => setDraft(d => ({ ...d, [f]: !d[f] }))}
                          >
                            <div style={s.toggleDot(draft[f] === true)} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* footer */}
            {!isSelf && (
              <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg-deep)', display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  style={s.btn(selected.is_active ? RED : GREEN)}
                  disabled={busy}
                  onClick={askToggleActive}
                >{selected.is_active ? 'Desactivar usuario' : 'Activar usuario'}</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── INVITE MODAL ───────────────────────────────────────────────────── */}
      {inviteOpen && (
        <div style={s.modalWrap} onClick={() => { if (!invBusy) setInviteOpen(false) }}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHead}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Invitar Usuario</div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '3px' }}>
                Se envía una invitación por email. El usuario se crea con el rol seleccionado y los permisos de su plantilla.
              </div>
            </div>

            <div style={s.modalBody}>
              {invError && (
                <div style={{ fontSize: '11px', color: RED, marginBottom: '16px', padding: '8px 12px', background: `${RED}14`, border: `1px solid ${RED}44`, borderRadius: '4px' }}>{invError}</div>
              )}

              <div style={{ display: 'grid', gap: '16px' }}>
                <div>
                  <label style={s.label}>Nombre Completo *</label>
                  <input style={s.input} value={invName} onChange={e => setInvName(e.target.value)} placeholder="Ej: María González" />
                </div>
                <div>
                  <label style={s.label}>Correo Electrónico *</label>
                  <input style={s.input} type="email" value={invEmail} onChange={e => setInvEmail(e.target.value)} placeholder="usuario@correo.com" />
                </div>
                <div>
                  <label style={s.label}>Rol del Sistema *</label>
                  <select style={s.input} value={invRole} onChange={e => setInvRole(e.target.value)}>
                    <option value="">Selecciona un rol...</option>
                    {templates.map(t => <option key={t.role} value={t.role}>{t.label || t.role}</option>)}
                  </select>
                  {templates.length === 0 && (
                    <div style={{ fontSize: '11px', color: RED, marginTop: '4px' }}>No se pudieron cargar las plantillas de rol.</div>
                  )}
                </div>
                <div>
                  <label style={s.label}>Teléfono (WhatsApp)</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <select style={{ ...s.input, maxWidth: '150px' }} value={invCountry} onChange={e => setInvCountry(e.target.value as CountryCode)}>
                      <option value="+58">+58 Venezuela</option>
                      <option value="+1">+1 USA</option>
                    </select>
                    <input style={s.input} inputMode="tel" value={invPhone} onChange={e => setInvPhone(e.target.value)} placeholder={invCountry === '+58' ? '0412 1234567' : '(555) 123-4567'} />
                  </div>
                  {invPhoneInvalid
                    ? <div style={{ fontSize: '11px', color: RED, marginTop: '4px' }}>Número inválido para {invCountry === '+58' ? 'Venezuela' : 'USA'}.</div>
                    : invPhoneE164
                      ? <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', fontFamily: 'monospace' }}>Se guardará como {invPhoneE164}</div>
                      : <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>Opcional.</div>}
                </div>
              </div>
            </div>

            <div style={s.modalFoot}>
              <button onClick={() => setInviteOpen(false)} style={s.btnGhost} disabled={invBusy}>Cancelar</button>
              <button onClick={handleInvite} disabled={invBusy} style={{ ...s.btn(ACCENT), opacity: invBusy ? 0.5 : 1 }}>
                {invBusy ? 'Enviando...' : 'Enviar Invitación'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
