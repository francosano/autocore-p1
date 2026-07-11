// TARGET: autocore-npa/app/crm/tareas/page.tsx
'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useNPAPermissions } from '../../components/useNPAPermissions'

// Reminders / pending tasks a rep sets for themselves ("call this client in 2h").
// The WhatsApp reminder leg is dispatched by the crm-bot cron (Delivery 2); this
// page is the in-system view + management (complete / snooze / cancel / quick-add).

const TIPO: Record<string, { label: string; icon: string }> = {
  llamada:     { label: 'Llamada',     icon: '📞' },
  whatsapp:    { label: 'WhatsApp',    icon: '💬' },
  visita:      { label: 'Visita',      icon: '🏬' },
  email:       { label: 'Email',       icon: '✉️' },
  seguimiento: { label: 'Seguimiento', icon: '🔁' },
  otro:        { label: 'Tarea',       icon: '•'  },
}

interface Tarea {
  id: string; lead_id: string | null; lead_nombre: string; lead_telefono: string | null
  titulo: string; tipo: string; remind_at: string; status: string; notas: string | null
  origen: string; wa_enviado: boolean; resultado: string | null
  asignado_a: string | null; asignado_nombre: string | null
  created_at: string; completada_at: string | null
}

const fmtWhen = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleString('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const relWhen = (iso: string) => {
  const diff = Date.parse(iso) - Date.now()
  const m = Math.round(diff / 60000)
  const abs = Math.abs(m)
  const s = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.floor(abs / 60)} h` : `${Math.floor(abs / 1440)} d`
  return m < 0 ? `hace ${s}` : `en ${s}`
}
const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const isToday = (iso: string) => {
  const d = new Date(iso), n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

export default function CrmTareasPage() {
  const { permissions, loading: permsLoading } = useNPAPermissions()
  const [rows, setRows] = useState<Tarea[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [me, setMe] = useState<{ id: string; nombre: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // quick-add
  const [qTitulo, setQTitulo] = useState('')
  const [qTipo, setQTipo] = useState('llamada')
  const [qWhen, setQWhen] = useState(localInput(new Date(Date.now() + 2 * 3600000)))
  const [qSaving, setQSaving] = useState(false)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user
      if (u) setMe({ id: u.id, nombre: (u.user_metadata as any)?.full_name || u.email || 'Yo' })
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const { data, error } = await supabase.rpc('crm_tareas_feed', { p_all: showAll })
      if (error) throw error
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setErr(e?.message || 'Error cargando tareas')
    } finally {
      setLoading(false)
    }
  }, [showAll])

  useEffect(() => { if (!permsLoading && permissions.npa_can_view_crm) load() }, [permsLoading, permissions.npa_can_view_crm, load])

  const recompute = async (leadId: string | null) => {
    if (!leadId) return
    try { await supabase.rpc('crm_recompute_heat', { p_lead_id: leadId }) } catch { /* non-fatal */ }
  }

  const completar = async (t: Tarea) => {
    setBusyId(t.id)
    try {
      await supabase.from('crm_tareas').update({
        status: 'completada', completada_at: new Date().toISOString(),
        completada_por: me?.id || null, updated_at: new Date().toISOString(),
      }).eq('id', t.id)
      await recompute(t.lead_id)
      await load()
    } catch (e: any) { setErr(e?.message || 'No se pudo completar') } finally { setBusyId(null) }
  }

  const cancelar = async (t: Tarea) => {
    setBusyId(t.id)
    try {
      await supabase.from('crm_tareas').update({
        status: 'cancelada', updated_at: new Date().toISOString(),
      }).eq('id', t.id)
      await recompute(t.lead_id)
      await load()
    } catch (e: any) { setErr(e?.message || 'No se pudo cancelar') } finally { setBusyId(null) }
  }

  const posponer = async (t: Tarea, horas: number) => {
    setBusyId(t.id)
    try {
      const base = Date.parse(t.remind_at) > Date.now() ? Date.parse(t.remind_at) : Date.now()
      await supabase.from('crm_tareas').update({
        remind_at: new Date(base + horas * 3600000).toISOString(),
        wa_enviado: false, wa_status: null, updated_at: new Date().toISOString(),
      }).eq('id', t.id)
      await recompute(t.lead_id)
      await load()
    } catch (e: any) { setErr(e?.message || 'No se pudo posponer') } finally { setBusyId(null) }
  }

  const quickAdd = async () => {
    if (!qTitulo.trim() || !qWhen || !me) return
    setQSaving(true)
    try {
      await supabase.from('crm_tareas').insert({
        lead_id: null, asignado_a: me.id, asignado_nombre: me.nombre,
        titulo: qTitulo.trim(), tipo: qTipo, remind_at: new Date(qWhen).toISOString(),
        origen: 'manual', created_by: me.id,
      })
      setQTitulo(''); setQWhen(localInput(new Date(Date.now() + 2 * 3600000)))
      await load()
    } catch (e: any) { setErr(e?.message || 'No se pudo crear la tarea') } finally { setQSaving(false) }
  }

  if (permsLoading) return <Shell><div style={s.muted}>Cargando…</div></Shell>
  if (!permissions.npa_can_view_crm) return <Shell><div style={s.muted}>No tienes acceso al CRM.</div></Shell>

  const all = (rows || []).filter(r => r.status === 'pendiente')
  const now = Date.now()
  const vencidas = all.filter(r => Date.parse(r.remind_at) < now).sort((a, b) => Date.parse(a.remind_at) - Date.parse(b.remind_at))
  const hoy = all.filter(r => Date.parse(r.remind_at) >= now && isToday(r.remind_at)).sort((a, b) => Date.parse(a.remind_at) - Date.parse(b.remind_at))
  const proximas = all.filter(r => Date.parse(r.remind_at) >= now && !isToday(r.remind_at)).sort((a, b) => Date.parse(a.remind_at) - Date.parse(b.remind_at))
  const hechas = (rows || []).filter(r => r.status !== 'pendiente').slice(0, 20)

  return (
    <Shell>
      <div style={s.headRow}>
        <div>
          <div style={s.eyebrow}>CRM · Recordatorios</div>
          <h1 style={s.title}>{showAll ? 'Tareas del equipo' : 'Mis tareas'}</h1>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {permissions.npa_can_admin && (
            <button style={showAll ? s.btnActive : s.btnGhost} onClick={() => setShowAll(v => !v)}>
              {showAll ? 'Ver solo las mías' : 'Ver todo el equipo'}
            </button>
          )}
          <a href="/crm/pendientes" style={s.btnGhost}>Alertas IA →</a>
          <button style={s.btnGhost} onClick={load} disabled={loading}>{loading ? '…' : '↻'}</button>
        </div>
      </div>

      {err && <div style={s.error}>{err}</div>}

      {/* Quick add */}
      <div style={s.addCard}>
        <input style={{ ...s.input, flex: 1, minWidth: 180 }} placeholder="Nueva tarea rápida (ej. Llamar a Pérez)"
          value={qTitulo} onChange={e => setQTitulo(e.target.value)} />
        <select style={s.input} value={qTipo} onChange={e => setQTipo(e.target.value)}>
          {Object.entries(TIPO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <input style={s.input} type="datetime-local" value={qWhen} onChange={e => setQWhen(e.target.value)} />
        <div style={{ display: 'flex', gap: 4 }}>
          {[['+2h', 2], ['+1d', 24]].map(([lbl, h]) => (
            <button key={lbl as string} style={s.chip} onClick={() => setQWhen(localInput(new Date(Date.now() + (h as number) * 3600000)))}>{lbl}</button>
          ))}
        </div>
        <button style={s.btnPrimary} onClick={quickAdd} disabled={qSaving || !qTitulo.trim()}>{qSaving ? '…' : '+ Agregar'}</button>
      </div>

      {loading && !rows && <div style={s.muted}>Cargando tareas…</div>}

      {rows && (
        <>
          <div style={s.kpiRow}>
            <Kpi n={vencidas.length} label="Vencidas" color={vencidas.length ? 'var(--danger)' : 'var(--ok)'} />
            <Kpi n={hoy.length} label="Para hoy" color="var(--warn)" />
            <Kpi n={proximas.length} label="Próximas" color="var(--text-primary)" />
          </div>

          {all.length === 0 && (
            <div style={s.card}>
              <div style={{ fontSize: 15, color: 'var(--ok)', fontWeight: 700 }}>Sin tareas pendientes ✓</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
                Crea recordatorios desde el detalle de un lead o con la barra de arriba. Sigue el ritmo Elliott: Día&nbsp;1 agresivo, luego Día&nbsp;15 y Día&nbsp;30.
              </div>
            </div>
          )}

          <Section title="Vencidas" rows={vencidas} tone="danger" onDo={completar} onSnooze={posponer} onCancel={cancelar} busyId={busyId} showAsesor={showAll} />
          <Section title="Para hoy" rows={hoy} tone="warn" onDo={completar} onSnooze={posponer} onCancel={cancelar} busyId={busyId} showAsesor={showAll} />
          <Section title="Próximas" rows={proximas} tone="muted" onDo={completar} onSnooze={posponer} onCancel={cancelar} busyId={busyId} showAsesor={showAll} />

          {hechas.length > 0 && (
            <div style={{ marginTop: 22 }}>
              <div style={s.sectionHead}>Completadas / canceladas recientes</div>
              {hechas.map(t => (
                <div key={t.id} style={{ ...s.taskRow, opacity: 0.55 }}>
                  <span style={{ fontSize: 16, flex: '0 0 auto' }}>{t.status === 'completada' ? '✓' : '✕'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, textDecoration: 'line-through' }}>{t.titulo}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {t.lead_nombre} · {t.status === 'completada' ? 'completada' : 'cancelada'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Shell>
  )
}

function Kpi({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div style={s.kpi}>
      <div style={{ ...s.kpiNum, color }}>{n}</div>
      <div style={s.kpiLabel}>{label}</div>
    </div>
  )
}

function Section({ title, rows, tone, onDo, onSnooze, onCancel, busyId, showAsesor }: {
  title: string; rows: Tarea[]; tone: 'danger' | 'warn' | 'muted'
  onDo: (t: Tarea) => void; onSnooze: (t: Tarea, h: number) => void; onCancel: (t: Tarea) => void
  busyId: string | null; showAsesor: boolean
}) {
  if (rows.length === 0) return null
  const accent = tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--text-muted)'
  return (
    <div style={{ marginTop: 18 }}>
      <div style={s.sectionHead}><span style={{ color: accent }}>{title}</span> · {rows.length}</div>
      {rows.map(t => {
        const meta = TIPO[t.tipo] || TIPO.otro
        const overdue = Date.parse(t.remind_at) < Date.now()
        const busy = busyId === t.id
        return (
          <div key={t.id} style={s.taskRow}>
            <span style={{ flex: '0 0 auto', fontSize: 16, marginTop: 1 }}>{meta.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 600 }}>{t.titulo}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
                {t.lead_id
                  ? <a href={`/crm?lead=${t.lead_id}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{t.lead_nombre} →</a>
                  : <span style={{ color: 'var(--text-muted)' }}>sin lead</span>}
                {showAsesor && t.asignado_nombre && <span style={{ color: 'var(--text-muted)' }}> · {t.asignado_nombre}</span>}
              </div>
              {t.notas && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{t.notas}</div>}
              <div style={{ fontSize: 11, marginTop: 5, fontWeight: 600, color: overdue ? 'var(--danger)' : 'var(--warn)' }}>
                {fmtWhen(t.remind_at)} · {relWhen(t.remind_at)}
                {t.wa_enviado && <span style={{ color: 'var(--ok)', marginLeft: 8 }}>WA enviado ✓</span>}
              </div>
            </div>
            <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end' }}>
              <button style={s.doBtn} disabled={busy} onClick={() => onDo(t)}>{busy ? '…' : '✓ Hecho'}</button>
              <div style={{ display: 'flex', gap: 4 }}>
                <button style={s.miniBtn} disabled={busy} onClick={() => onSnooze(t, 1)}>+1h</button>
                <button style={s.miniBtn} disabled={busy} onClick={() => onSnooze(t, 24)}>+1d</button>
                <button style={s.miniBtnDanger} disabled={busy} onClick={() => onCancel(t)}>✕</button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <CrmShell active="tareas" maxWidth={1100}>{children}</CrmShell>
}

const s: Record<string, React.CSSProperties> = {
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 18, gap: 12, flexWrap: 'wrap' },
  eyebrow: { fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  title: { fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0 0', fontFamily: 'var(--font-inter), Inter, sans-serif' },
  muted: { color: 'var(--text-muted)', fontSize: 14, padding: '40px 0', textAlign: 'center' },
  error: { background: 'rgba(229,85,106,0.12)', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16 },
  btnGhost: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', textDecoration: 'none' },
  btnActive: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnPrimary: { padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  addCard: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', marginBottom: 18 },
  input: { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit' },
  chip: { padding: '6px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  kpiRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 6 },
  kpi: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' },
  kpiNum: { fontSize: 30, fontWeight: 800, lineHeight: 1, fontFamily: 'var(--font-inter), Inter, sans-serif' },
  kpiLabel: { fontSize: 12, color: 'var(--text-muted)', marginTop: 6, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', marginTop: 14 },
  sectionHead: { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px 2px' },
  taskRow: { display: 'flex', gap: 12, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '13px 15px', marginBottom: 9, alignItems: 'flex-start' },
  doBtn: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--ok)', background: 'rgba(21,160,110,0.12)', color: 'var(--ok)', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  miniBtn: { padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  miniBtnDanger: { padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--danger)', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
}