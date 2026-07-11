'use client'
import { useState, useEffect, useCallback, ReactNode } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import NavBar from '../components/NavBar'
import NotificacionesTab from './NotificacionesTab'
import WhatsAppLogTab from './WhatsAppLogTab'
import UsuariosTab from './UsuariosTab'
import PlantillasTab from './PlantillasTab'

const fmtDateTime = (iso: string) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('es-VE') + ' ' + d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })
}

const CRM_ROLES = [
  { key: 'gerente_ventas', label: 'Gerente de Ventas', color: '#BB162B',  desc: 'Acceso completo, reasigna leads, ve todo el equipo' },
  { key: 'jefe_ventas',    label: 'Jefe de Ventas',    color: '#b8720a',  desc: 'Supervisa vendedores, ve todos los leads' },
  { key: 'vendedor',       label: 'Vendedor',           color: '#10B981',  desc: 'Gestiona sus leads, registra actividades' },
  { key: 'bdc',            label: 'BDC',                color: '#3B82F6',  desc: 'Califica leads entrantes, asigna a vendedores' },
  { key: 'jefe_bdc',       label: 'Jefe BDC',           color: '#8B5CF6',  desc: 'Supervisa equipo BDC, reportes de captación' },
  { key: 'postventa',      label: 'Postventa',          color: '#06B6D4',  desc: 'Seguimiento a clientes cerrados y servicio' },
]

const ROLE_COLORS: Record<string, string> = {
  admin: '#BB162B', manager: '#b8720a', auditoria: '#4a9eff',
  vendedor: '#2ecc8a', viewer: '#7E8083', administrador: '#BB162B',
  gerente: '#b8720a', bdc: '#3B82F6', jefe_ventas: '#8B5CF6',
}

const ACTION_COLORS: Record<string, string> = {
  'deal_saved': '#4a9eff', 'deal_approved': '#2ecc8a', 'deal_unlocked': '#b8720a',
  'deal_deleted': '#BB162B', 'role_changed': '#a855f7', 'user_invited': '#2ecc8a',
  'user_disabled': '#BB162B', 'user_enabled': '#2ecc8a', 'password_reset': '#b8720a',
  'user_login': '#4a9eff',
  'admin_users.invite': '#2ecc8a', 'admin_users.set_active': '#b8720a',
  'admin_users.set_role': '#a855f7', 'admin_users.set_permissions': '#4a9eff',
}

const s: any = {
  page:    { minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'sans-serif' },
  content: { padding: '24px 32px', maxWidth: '1280px', margin: '0 auto' },
  card:    { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', padding: '20px', marginBottom: '16px' },
  input:   { width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  btnRed:  { padding: '9px 20px', background: '#BB162B', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', letterSpacing: '1px' },
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

// ── TOAST ─────────────────────────────────────────────────────────────────────
function Toast({ msg, type }: { msg: string, type: 'success' | 'error' }) {
  return (
    <div style={{ position: 'fixed', bottom: '24px', right: '24px', background: type === 'success' ? '#1a7a4a' : '#BB162B', color: '#fff', padding: '12px 20px', borderRadius: '10px', fontSize: '13px', fontWeight: 600, zIndex: 9999, boxShadow: '0 4px 20px rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', gap: '8px' }}>
      {type === 'success' ? '✓' : '✕'} {msg}
    </div>
  )
}

// ── CRM TAB ───────────────────────────────────────────────────────────────────
function CRMTab({ logAction }: {
  logAction: (action: string, targetType: string, targetId: string, details: any) => Promise<void>
}) {
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string, type: 'success' | 'error' } | null>(null)

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3500)
  }

  const loadUsers = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('user_roles')
      .select('user_id, role, full_name, email, is_active, crm_role, npa_can_view_crm, created_at')
      .order('full_name', { ascending: true })
    setUsers((data || []).filter(u => u.is_active !== false))
    setLoading(false)
  }, [])

  useEffect(() => { loadUsers() }, [loadUsers])

  const updateCrmAccess = async (userId: string, field: string, value: any) => {
    setSaving(userId)
    await supabase.from('user_roles').update({ [field]: value }).eq('user_id', userId)
    if (field === 'npa_can_view_crm') {
      await supabase.from('user_permissions').upsert({ user_id: userId, npa_can_view_crm: value }, { onConflict: 'user_id' })
    }
    setUsers(us => us.map(u => u.user_id === userId ? { ...u, [field]: value } : u))
    await logAction('crm_access_updated', 'user', userId, { field, value })
    setSaving(null)
    showToast('Acceso CRM actualizado')
  }

  const crmUsers = users.filter(u => u.npa_can_view_crm)
  const nonCrmUsers = users.filter(u => !u.npa_can_view_crm)

  return (
    <div>
      {toast && <Toast msg={toast.msg} type={toast.type} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '20px' }}>
        {[
          ['Usuarios CRM', crmUsers.length.toString(), '#BB162B'],
          ...CRM_ROLES.slice(0, 3).map(r => [r.label, crmUsers.filter(u => u.crm_role === r.key).length.toString(), r.color]),
        ].map(([label, value, color]) => (
          <div key={String(label)} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '16px', textAlign: 'center' }}>
            <div style={{ fontSize: '28px', fontWeight: 900, color: String(color), fontFamily: 'monospace' }}>{value}</div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', marginTop: '4px' }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={s.card}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--border)' }}>
          Equipo con Acceso CRM ({crmUsers.length})
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>Cargando...</div>
        ) : crmUsers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>
            Ningún usuario tiene acceso CRM aún. Actívalo abajo.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {crmUsers.map(u => {
              const crmRole = CRM_ROLES.find(r => r.key === u.crm_role)
              return (
                <div key={u.user_id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center', gap: '16px', padding: '12px 16px', background: 'var(--bg-deep)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{u.full_name || '—'}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{u.email} · {u.role}</div>
                  </div>
                  <div style={{ minWidth: '160px' }}>
                    <select
                      value={u.crm_role || ''}
                      onChange={e => updateCrmAccess(u.user_id, 'crm_role', e.target.value)}
                      disabled={saving === u.user_id}
                      style={{ padding: '6px 10px', background: 'var(--bg-input)', border: '1px solid ' + (crmRole?.color || 'var(--border)'), borderRadius: '6px', color: crmRole?.color || 'var(--text-primary)', fontSize: '12px', fontWeight: 700, outline: 'none', width: '100%' }}
                    >
                      <option value="">-- Rol CRM --</option>
                      {CRM_ROLES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </select>
                  </div>
                  <button
                    style={s.toggle(true)}
                    onClick={() => updateCrmAccess(u.user_id, 'npa_can_view_crm', false)}
                    disabled={saving === u.user_id}
                  >
                    <div style={s.toggleDot(true)} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {nonCrmUsers.length > 0 && (
        <div style={s.card}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--border)' }}>
            Sin Acceso CRM ({nonCrmUsers.length}) — Activar
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {nonCrmUsers.map(u => (
              <div key={u.user_id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: '16px', padding: '10px 16px', background: 'var(--bg-deep)', borderRadius: '8px', border: '1px solid var(--border)', opacity: 0.7 }}>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{u.full_name || '—'}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{u.email} · {u.role}</div>
                </div>
                <button
                  style={s.toggle(false)}
                  onClick={() => updateCrmAccess(u.user_id, 'npa_can_view_crm', true)}
                  disabled={saving === u.user_id}
                >
                  <div style={s.toggleDot(false)} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={s.card}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: '#BB162B', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--border)' }}>
          Roles CRM — Referencia
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
          {CRM_ROLES.map(r => (
            <div key={r.key} style={{ background: 'var(--bg-deep)', borderRadius: '8px', padding: '14px', borderLeft: '3px solid ' + r.color }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: r.color, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>{r.label}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{r.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── ACTIVITY LOG TAB ──────────────────────────────────────────────────────────
function ActivityLogTab() {
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filterAction, setFilterAction] = useState('')
  const [filterUser, setFilterUser] = useState('')
  const [page, setPage] = useState(0)
  const PER_PAGE = 50

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const { data } = await supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(500)
      setLogs(data || [])
      setLoading(false)
    }
    load()
  }, [])

  const filtered = logs.filter(l => {
    const matchAction = !filterAction || l.action === filterAction
    const matchUser = !filterUser || (l.user_email || '').toLowerCase().includes(filterUser.toLowerCase())
    return matchAction && matchUser
  })
  const paged = filtered.slice(page * PER_PAGE, (page + 1) * PER_PAGE)
  const totalPages = Math.ceil(filtered.length / PER_PAGE)
  const uniqueActions = [...new Set(logs.map(l => l.action))].sort()

  const actionLabel: Record<string, string> = {
    'deal_saved': 'Negocio guardado', 'deal_approved': 'Negocio aprobado',
    'deal_unlocked': 'Negocio desbloqueado', 'deal_deleted': 'Negocio eliminado',
    'role_changed': 'Rol cambiado', 'user_invited': 'Usuario invitado',
    'password_reset': 'Contraseña reseteada', 'user_login': 'Inicio de sesión',
    'user_enabled': 'Usuario activado', 'user_disabled': 'Usuario desactivado',
    'permissions_updated': 'Permisos actualizados', 'crm_access_updated': 'Acceso CRM actualizado',
    'admin_users.invite': 'Usuario invitado', 'admin_users.set_active': 'Activación cambiada',
    'admin_users.set_role': 'Rol cambiado', 'admin_users.set_permissions': 'Permisos actualizados',
  }

  return (
    <div>
      <div style={s.card}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '12px', alignItems: 'end' }}>
          <div>
            <label style={s.label}>Filtrar por Acción</label>
            <select value={filterAction} onChange={e => { setFilterAction(e.target.value); setPage(0) }} style={s.input}>
              <option value="">Todas las acciones</option>
              {uniqueActions.map(a => <option key={a} value={a}>{actionLabel[a] || a}</option>)}
            </select>
          </div>
          <div>
            <label style={s.label}>Filtrar por Usuario</label>
            <input style={s.input} value={filterUser} onChange={e => { setFilterUser(e.target.value); setPage(0) }} placeholder="Buscar por correo..." />
          </div>
          <button onClick={() => { setFilterAction(''); setFilterUser(''); setPage(0) }} style={s.btnGray}>Limpiar</button>
        </div>
        <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--text-secondary)' }}>
          {filtered.length} registro{filtered.length !== 1 ? 's' : ''}
        </div>
      </div>

      <div style={s.card}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-secondary)' }}>Cargando...</div>
        ) : paged.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-secondary)', fontSize: '13px' }}>No hay registros</div>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Fecha y Hora', 'Usuario', 'Acción', 'Objetivo', 'Detalles'].map(h => <th key={h} style={thTd}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {paged.map((log: any) => (
                  <tr key={log.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 12px', fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{fmtDateTime(log.created_at)}</td>
                    <td style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text-primary)', fontFamily: 'monospace' }}>{log.user_email || '—'}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ padding: '3px 10px', borderRadius: '4px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', background: (ACTION_COLORS[log.action] || '#7E8083') + '22', color: ACTION_COLORS[log.action] || '#7E8083' }}>
                        {actionLabel[log.action] || log.action}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {log.target_type === 'deal' ? 'Negocio #' + (log.details?.negocio_num || log.target_id) : log.target_type === 'user' ? (log.details?.email || log.target_id) : log.target_id || '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: '11px', color: 'var(--text-secondary)', maxWidth: '240px' }}>
                      {(log.action === 'role_changed' || log.action === 'admin_users.set_role') && log.details && (
                        <span>{log.details.old_role} → <strong style={{ color: ROLE_COLORS[log.details.new_role] || 'var(--text-primary)' }}>{log.details.new_role}</strong></span>
                      )}
                      {log.action === 'deal_unlocked' && log.details?.reason && <span style={{ fontStyle: 'italic' }}>"{log.details.reason}"</span>}
                      {log.target_type === 'deal' && log.details?.cliente_nombre && <span>{log.details.cliente_nombre}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={{ ...s.btnGray, opacity: page === 0 ? 0.4 : 1 }}>← Anterior</button>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Página {page + 1} de {totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{ ...s.btnGray, opacity: page >= totalPages - 1 ? 0.4 : 1 }}>Siguiente →</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── SIDEBAR (DealerCenter-style) ──────────────────────────────────────────────
type TabKey = 'usuarios' | 'plantillas' | 'crm' | 'actividad' | 'notificaciones' | 'whatsapp'

const NAVY = '#16283E'
const NAVY_ACCENT = '#3B82F6'

function SectionIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {children}
    </svg>
  )
}

const SECTION_ICONS: Record<TabKey, ReactNode> = {
  usuarios: <SectionIcon><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></SectionIcon>,
  plantillas: <SectionIcon><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></SectionIcon>,
  crm: <SectionIcon><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></SectionIcon>,
  actividad: <SectionIcon><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></SectionIcon>,
  notificaciones: <SectionIcon><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></SectionIcon>,
  whatsapp: <SectionIcon><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></SectionIcon>,
}

// ── MAIN PAGE ─────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>('usuarios')
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [userRole, setUserRole] = useState('')
  const [currentUser, setCurrentUser] = useState<any>(null)

  useEffect(() => {
    const init = async () => {
      const { data: authData } = await supabase.auth.getUser()
      if (!authData.user) { router.push('/'); return }
      setCurrentUser(authData.user)
      const { data: roleData } = await supabase.from('user_roles').select('role').eq('user_id', authData.user.id).single()
      setUserRole(roleData?.role || '')
      setLoading(false)
    }
    init()
  }, [])

  const logAction = async (action: string, targetType: string, targetId: string, details: any) => {
    if (!currentUser) return
    await supabase.from('activity_log').insert({
      user_id: currentUser.id, user_email: currentUser.email,
      action, target_type: targetType, target_id: String(targetId), details,
    })
  }

  if (loading) return (
    <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: 'var(--text-secondary)' }}>Cargando...</div>
    </div>
  )

  const hasAccess = ['admin', 'manager', 'administrador', 'gerente'].includes(userRole)
  if (!hasAccess) return (
    <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>Acceso Restringido</div>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '24px' }}>No tienes permisos para acceder a Configuración.</div>
        <button onClick={() => router.push('/dashboard')} style={s.btnGray}>← Volver</button>
      </div>
    </div>
  )

  const isManager = currentUser?.email === 'manager@motocentro2.com'
  // Plantillas de Rol: solo gerencia (el worker re-verifica server-side).
  const isGerencia = ['admin', 'manager', 'administrador'].includes(userRole)

  const groups: { title: string; items: { key: TabKey; label: string; desc: string }[] }[] = [
    {
      title: 'Administración',
      items: [
        { key: 'usuarios',  label: 'Usuarios & Roles',      desc: 'Acceso, roles y permisos del equipo' },
        ...(isGerencia ? [
          { key: 'plantillas' as TabKey, label: 'Plantillas de Rol', desc: 'Permisos por defecto de cada rol' },
        ] : []),
        { key: 'crm',       label: 'Equipo CRM',            desc: 'Acceso y roles del módulo CRM' },
        { key: 'actividad', label: 'Registro de Actividad', desc: 'Auditoría de acciones del sistema' },
      ],
    },
    {
      title: 'Sistema',
      items: [
        { key: 'notificaciones', label: 'Notificaciones', desc: 'Suscriptores de alertas WhatsApp' },
        ...(isManager ? [
          { key: 'whatsapp' as TabKey, label: 'Log de WhatsApp', desc: 'Historial de mensajes enviados' },
        ] : []),
      ],
    },
  ]

  const active = groups.flatMap(g => g.items).find(i => i.key === tab)

  return (
    <div style={s.page}>
      <NavBar />
      <div style={s.content}>
        <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start', flexWrap: 'wrap' }}>

          {/* ── Sidebar ─────────────────────────────────────────────────── */}
          <aside style={{ width: '236px', flexShrink: 0, background: NAVY, borderRadius: '8px', overflow: 'hidden', position: 'sticky', top: '16px', boxShadow: '0 2px 10px rgba(0,0,0,0.18)' }}>
            <div style={{ padding: '16px 18px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '2px', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase' }}>Sistema</div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff', marginTop: '2px' }}>Configuración</div>
            </div>
            {groups.map(g => (
              <div key={g.title} style={{ padding: '10px 0 6px' }}>
                <div style={{ padding: '4px 18px 6px', fontSize: '10px', fontWeight: 700, letterSpacing: '1.5px', color: 'rgba(255,255,255,0.38)', textTransform: 'uppercase' }}>{g.title}</div>
                {g.items.map(item => {
                  const isActive = tab === item.key
                  return (
                    <button
                      key={item.key}
                      onClick={() => setTab(item.key)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
                        padding: '9px 18px', border: 'none', cursor: 'pointer', textAlign: 'left',
                        fontSize: '12.5px', fontWeight: 600,
                        background: isActive ? 'rgba(59,130,246,0.16)' : 'transparent',
                        color: isActive ? '#fff' : 'rgba(255,255,255,0.68)',
                        boxShadow: isActive ? `inset 3px 0 0 ${NAVY_ACCENT}` : 'none',
                        transition: 'background 0.15s, color 0.15s',
                      }}
                    >
                      {SECTION_ICONS[item.key]}
                      {item.label}
                    </button>
                  )
                })}
              </div>
            ))}
            <div style={{ padding: '12px 18px', borderTop: '1px solid rgba(255,255,255,0.08)', fontSize: '10.5px', color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>
              {currentUser?.email}
            </div>
          </aside>

          {/* ── Content ─────────────────────────────────────────────────── */}
          <main style={{ flex: 1, minWidth: '320px' }}>
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>
                Configuración <span style={{ margin: '0 4px' }}>/</span> <span style={{ color: 'var(--text-secondary)' }}>{active?.label}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>{active?.label}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{active?.desc}</div>
              </div>
            </div>

            {tab === 'usuarios'      && <UsuariosTab currentUserId={currentUser?.id} />}
            {tab === 'plantillas'    && isGerencia && <PlantillasTab />}
            {tab === 'crm'           && <CRMTab logAction={logAction} />}
            {tab === 'actividad'     && <ActivityLogTab />}
            {tab === 'notificaciones' && <NotificacionesTab />}
            {tab === 'whatsapp' && isManager && <WhatsAppLogTab />}
          </main>
        </div>
      </div>
    </div>
  )
}