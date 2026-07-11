// TARGET: autocore-npa/app/settings/PlantillasTab.tsx
'use client'
// ═══════════════════════════════════════════════════════════════════════════
// Configuración → Plantillas de Rol (worker-backed, solo gerencia)
//
// Edita role_templates: la plantilla de permisos que recibe un usuario al ser
// invitado o al cambiar de rol. Lectura directa (SELECT admin); escritura vía
// POST /set-template del worker autocore-admin-users (gate: admin/manager/
// administrador + npa_can_admin — el worker lo re-verifica server-side).
//
// Roles sin plantilla no se pueden asignar en Usuarios & Roles — esta pantalla
// existe para cerrar ese hueco sin tocar SQL a mano.
// ═══════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../supabase'

const WORKER_URL = 'https://autocore-admin-users.sano-franco.workers.dev'
const ACCENT = '#1B6EC2'
const GREEN = '#188A55'
const RED = '#C0392B'

// Catálogo de roles — refleja el CHECK constraint de user_roles.role
// (mantener en sync con ROLE_CATALOG del worker).
const ROLE_CATALOG: { role: string; nombre: string }[] = [
  { role: 'admin',              nombre: 'Admin' },
  { role: 'administrador',      nombre: 'Administrador' },
  { role: 'manager',            nombre: 'Manager' },
  { role: 'gerente',            nombre: 'Gerente' },
  { role: 'jefe_ventas',        nombre: 'Jefe de Ventas' },
  { role: 'asesor_ventas',      nombre: 'Asesor de Ventas' },
  { role: 'bdc',                nombre: 'BDC / Recepción' },
  { role: 'gte_cobranza',       nombre: 'Gte. Cobranza' },
  { role: 'asist_cobranza',     nombre: 'Asist. Cobranza' },
  { role: 'asist_admin',        nombre: 'Asist. Admin' },
  { role: 'auditoria',          nombre: 'Auditoría' },
  { role: 'auditoria_ingresos', nombre: 'Auditoría Ingresos' },
  { role: 'tesoreria',          nombre: 'Tesorería' },
  { role: 'facturacion',        nombre: 'Facturación' },
  { role: 'cliente',            nombre: 'Cliente' },
  { role: 'user',               nombre: 'Usuario' },
]

// Espejo del whitelist del worker (PERMISSION_COLUMNS) — mantener en sync.
const PERMISSION_COLUMNS = [
  'can_view_prestamos', 'can_create_prestamos', 'can_edit_prestamos',
  'can_delete_prestamos', 'can_register_pagos', 'can_verify_pagos',
  'can_send_whatsapp', 'can_view_whatsapp_log', 'can_view_reportes',
  'can_view_crm', 'can_manage_crm', 'can_view_inventory',
  'can_manage_inventory', 'can_manage_settings', 'can_view_solicitudes',
  'can_create_solicitudes', 'can_approve_solicitudes', 'can_delete_solicitudes',
  'can_view_mensajes', 'can_send_mensajes', 'can_view_activity_log',
  'can_view_cobranza', 'can_manage_usdt',
  'can_register_pagos_recibidos', 'can_cancel_pagos_recibidos',
  'npa_can_view_dashboard', 'npa_can_view_clientes', 'npa_can_view_deals',
  'npa_can_audit_deals', 'npa_can_view_cobranza', 'npa_can_register_pagos',
  'npa_can_approve_deals', 'npa_can_ajuste_cuadre', 'npa_can_nota_entrega',
  'npa_can_admin', 'npa_can_view_crm', 'npa_can_view_inventory_finance',
  'npa_can_view_management_pnl', 'npa_can_mark_lost',
  'tesoreria_can_pickup', 'tesoreria_can_dispatch', 'tesoreria_can_view_balance',
  'tesoreria_can_replenish_cc', 'tesoreria_can_confirm_fx',
  'tesoreria_can_request_salida', 'tesoreria_can_approve_salida',
  'tesoreria_can_register_cc_gasto', 'tesoreria_admin', 'tesoreria_can_arqueo',
  'tesoreria_can_request_cc_repo', 'tesoreria_can_register_ingreso',
]

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

async function workerFetch(path: string, init?: RequestInit): Promise<any> {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new Error('Sesión expirada. Vuelve a iniciar sesión.')
  const r = await fetch(WORKER_URL + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    if (r.status === 401) throw new Error('Sesión inválida o expirada. Vuelve a iniciar sesión.')
    if (r.status === 403) throw new Error(j?.error || 'No tienes permisos para esta acción.')
    throw new Error(j?.error || `Error del servidor (${r.status}).`)
  }
  return j
}

interface RoleTemplate { role: string; label: string | null; permissions: Record<string, boolean> | null }

// ── estilos (corporativos, mismos tokens que UsuariosTab) ────────────────────
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

export default function PlantillasTab() {
  const [templates, setTemplates] = useState<RoleTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [toast, setToast] = useState<{ msg: string, type: 'success' | 'error' } | null>(null)
  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 4000)
  }

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    try {
      const { data, error } = await (supabase.from('role_templates').select('role, label, permissions').order('role') as any)
      if (error) throw new Error(error.message)
      setTemplates(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setLoadError(e?.message || 'No se pudieron cargar las plantillas.')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  const templateFor = (role: string) => templates.find(t => t.role === role) || null

  // ── editor drawer ───────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<string | null>(null)   // role key
  const [labelDraft, setLabelDraft] = useState('')
  const [draft, setDraft] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [drawerError, setDrawerError] = useState('')

  function openEditor(role: string) {
    const t = templateFor(role)
    const cat = ROLE_CATALOG.find(r => r.role === role)
    setEditing(role)
    setLabelDraft(t?.label || cat?.nombre || role)
    const flags: Record<string, boolean> = {}
    for (const f of PERMISSION_COLUMNS) flags[f] = t?.permissions?.[f] === true
    setDraft(flags)
    setDrawerError('')
  }
  function closeEditor() { if (!busy) { setEditing(null); setDraft({}); setDrawerError('') } }

  function copyFrom(role: string) {
    const t = templateFor(role)
    if (!t) return
    const flags: Record<string, boolean> = {}
    for (const f of PERMISSION_COLUMNS) flags[f] = t.permissions?.[f] === true
    setDraft(flags)
    showToast(`Flags copiados de ${t.label || role} (sin guardar)`)
  }

  async function handleSave() {
    if (!editing) return
    if (!labelDraft.trim()) { setDrawerError('Indica una etiqueta para el rol.'); return }
    setBusy(true); setDrawerError('')
    try {
      await workerFetch('/set-template', {
        method: 'POST',
        body: JSON.stringify({ role: editing, label: labelDraft.trim(), permissions: draft }),
      })
      showToast(`Plantilla de ${labelDraft.trim()} guardada`)
      setEditing(null)
      await load()
    } catch (e: any) {
      setDrawerError(e?.message || 'No se pudo guardar la plantilla.')
    } finally {
      setBusy(false)
    }
  }

  const groups = groupFlags(PERMISSION_COLUMNS)
  const flagsOn = Object.values(draft).filter(Boolean).length
  const editingName = editing ? (ROLE_CATALOG.find(r => r.role === editing)?.nombre || editing) : ''

  return (
    <div>
      <style>{`.plt-row:hover { background: var(--bg-deep); }`}</style>
      {toast && <Toast msg={toast.msg} type={toast.type} />}

      <div style={s.panel}>
        <div style={s.panelHead}>
          <div style={s.panelTitle}>
            Plantillas de Rol
            <span style={{ marginLeft: '10px', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
              {templates.length} de {ROLE_CATALOG.length} roles con plantilla
            </span>
          </div>
        </div>
        <div style={{ padding: '10px 16px', fontSize: '12px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', lineHeight: 1.5 }}>
          La plantilla define los permisos que recibe un usuario al ser invitado con ese rol o al cambiar de rol.
          Un rol <strong>sin plantilla</strong> no se puede asignar desde Usuarios &amp; Roles.
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)', fontSize: '13px' }}>Cargando plantillas...</div>
        ) : loadError ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <div style={{ fontSize: '13px', color: RED, marginBottom: '12px' }}>{loadError}</div>
            <button style={s.btnGhost} onClick={load}>Reintentar</button>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Rol', 'Etiqueta', 'Estado', 'Permisos activos', ''].map((h, i) => <th key={i} style={s.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {ROLE_CATALOG.map(rc => {
                  const t = templateFor(rc.role)
                  const nOn = t ? PERMISSION_COLUMNS.filter(f => t.permissions?.[f] === true).length : 0
                  return (
                    <tr key={rc.role} className="plt-row">
                      <td style={{ ...s.td, fontFamily: 'monospace', fontSize: '11.5px', color: 'var(--text-secondary)' }}>{rc.role}</td>
                      <td style={{ ...s.td, fontWeight: 600 }}>{t?.label || rc.nombre}</td>
                      <td style={s.td}>
                        {t
                          ? <span style={s.badge(GREEN)}>Con plantilla</span>
                          : <span style={s.badge('#B8720A')}>Sin plantilla</span>}
                      </td>
                      <td style={{ ...s.td, fontVariantNumeric: 'tabular-nums' as const }}>{t ? nOn : '—'}</td>
                      <td style={{ ...s.td, textAlign: 'right' as const }}>
                        <button style={s.btnLink} onClick={() => openEditor(rc.role)}>{t ? 'Editar' : 'Crear'}</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── EDITOR DRAWER ──────────────────────────────────────────────────── */}
      {editing && (
        <div style={s.drawerWrap} onClick={closeEditor}>
          <div style={s.drawer} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg-deep)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>Plantilla — {editingName}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '3px' }}>{editing} · {flagsOn} permisos activos</div>
              </div>
              <button style={{ ...s.btnGhost, padding: '5px 12px' }} onClick={closeEditor} disabled={busy}>Cerrar</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' as const, padding: '20px' }}>
              {drawerError && (
                <div style={{ padding: '10px 12px', borderRadius: '4px', border: `1px solid ${RED}66`, background: `${RED}14`, fontSize: '12px', color: RED, marginBottom: '16px' }}>
                  {drawerError}
                </div>
              )}

              <label style={s.label}>Etiqueta (nombre visible)</label>
              <input style={s.input} value={labelDraft} onChange={e => setLabelDraft(e.target.value)} maxLength={60} disabled={busy} />

              <div style={{ marginTop: '16px' }}>
                <label style={s.label}>Copiar flags de otra plantilla</label>
                <select style={s.input} value="" disabled={busy} onChange={e => { if (e.target.value) copyFrom(e.target.value) }}>
                  <option value="">Selecciona una plantilla...</option>
                  {templates.filter(t => t.role !== editing).map(t => <option key={t.role} value={t.role}>{t.label || t.role}</option>)}
                </select>
              </div>

              {groups.map(g => (
                <div key={g.title} style={s.groupBox}>
                  <div style={s.groupHead}>{g.title}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                    {g.flags.map(f => (
                      <div key={f} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '7px 12px', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ fontSize: '11.5px', color: 'var(--text-primary)', textTransform: 'capitalize' as const }}>{flagLabel(f)}</span>
                        <button
                          style={s.toggle(draft[f] === true, busy)}
                          disabled={busy}
                          onClick={() => setDraft(d => ({ ...d, [f]: !d[f] }))}
                        >
                          <div style={s.toggleDot(draft[f] === true)} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg-deep)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Afecta invitaciones y cambios de rol futuros; no modifica usuarios existentes.
              </div>
              <button style={{ ...s.btn(ACCENT), opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={handleSave}>
                {busy ? 'Guardando...' : 'Guardar plantilla'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
