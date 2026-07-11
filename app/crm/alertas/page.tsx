// TARGET: autocore-npa/app/crm/alertas/page.tsx
'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useNPAPermissions } from '../../components/useNPAPermissions'

type Alert = {
  id: string
  created_at: string
  to_phone: string | null
  to_name: string | null
  evento: string | null
  body: string | null
  status: string | null
  recipients_role: string | null
  triggered_by: string | null
  raw_response: any
}

const EVENTO = (k: string | null): { label: string; color: string } => {
  switch (k) {
    case 'solid_lead':       return { label: 'Lead caliente',          color: '#E5556A' }
    case 'handoff':          return { label: 'Entrega a asesor',       color: '#9B7DF0' }
    case 'escalation':       return { label: 'Escalación a gerencia',  color: '#E0A23C' }
    case 'cita_creada':      return { label: 'Cita creada',            color: '#2FBF8F' }
    case 'recordatorio_dia': return { label: 'Recordatorio (día antes)',   color: '#5A8DEE' }
    case 'recordatorio_horas': return { label: 'Recordatorio (horas antes)', color: '#5A8DEE' }
    default:                 return { label: k || 'Aviso',            color: '#8A93A0' }
  }
}
const ROL = (r: string | null) => r === 'ejecutivo' ? 'Vendedor' : r === 'bdc' ? 'BDC' : r === 'manager' ? 'Gerencia' : (r || '')

export default function CrmAlertasPage() {
  const { permissions, loading: permsLoading } = useNPAPermissions()
  const [rows, setRows] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [fStatus, setFStatus] = useState<'all' | 'sent' | 'failed'>('all')
  const [fRecipient, setFRecipient] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const { data, error } = await supabase
        .from('whatsapp_log')
        .select('id, created_at, to_phone, to_name, evento, body, status, recipients_role, triggered_by, raw_response')
        .ilike('triggered_by', 'claudia%')
        .order('created_at', { ascending: false })
        .limit(300)
      if (error) throw new Error(error.message)
      setRows((data || []) as Alert[])
    } catch (e: any) {
      setErr(e?.message || 'No se pudieron cargar las alertas.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (!permsLoading && permissions.npa_can_view_crm) load() }, [permsLoading, permissions.npa_can_view_crm, load])

  if (permsLoading) return <Shell><div style={s.muted}>Cargando…</div></Shell>
  if (!permissions.npa_can_view_crm) return <Shell><div style={s.muted}>No tienes acceso al CRM.</div></Shell>

  const recipients = [...new Set(rows.map(r => r.to_name).filter(Boolean))] as string[]
  const filtered = rows.filter(r =>
    (fStatus === 'all' || (r.status || 'sent') === fStatus) &&
    (!fRecipient || r.to_name === fRecipient)
  )
  const failedCount = rows.filter(r => r.status === 'failed').length
  const fmt = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleString('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  }
  const openLead = (id?: string) => { if (id) window.location.href = '/crm?search_lead=' + id }

  return (
    <Shell>
      <div style={s.headRow}>
        <div>
          <div style={s.eyebrow}>CRM · Claudia</div>
          <h1 style={s.title}>Alertas al equipo</h1>
        </div>
        <button style={s.btnGhost} onClick={load} disabled={loading}>{loading ? 'Actualizando…' : '↻ Actualizar'}</button>
      </div>

      <p style={s.lede}>Lo que Claudia avisa a tu equipo: leads calientes, entregas, escalaciones y citas — con el estado de entrega de cada mensaje.</p>

      {err && <div style={s.error}>{err}</div>}

      <div style={s.kpiRow}>
        <div style={s.kpi}><div style={{ ...s.kpiNum, color: 'var(--text-primary)' }}>{rows.length}</div><div style={s.kpiLabel}>Avisos (últimos 300)</div></div>
        <div style={s.kpi}><div style={{ ...s.kpiNum, color: failedCount ? '#E5556A' : '#15A06E' }}>{failedCount}</div><div style={s.kpiLabel}>No entregados</div></div>
      </div>

      <div style={s.filters}>
        <select style={s.input} value={fStatus} onChange={e => setFStatus(e.target.value as any)}>
          <option value="all">Todos los estados</option>
          <option value="sent">Entregados</option>
          <option value="failed">No entregados</option>
        </select>
        <select style={s.input} value={fRecipient} onChange={e => setFRecipient(e.target.value)}>
          <option value="">Todo el equipo</option>
          {recipients.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <span style={s.count}>{filtered.length} mensajes</span>
      </div>

      {loading && !rows.length ? <div style={s.muted}>Cargando…</div> : filtered.length === 0 ? (
        <div style={s.empty}>Sin alertas todavía. Cuando Claudia detecte un lead caliente o agende una cita, el aviso a tu equipo aparece aquí.</div>
      ) : (
        <div style={s.card}>
          {filtered.map(r => {
            const ev = EVENTO(r.evento)
            const failed = r.status === 'failed'
            const leadId = r.raw_response?.lead_id
            return (
              <div key={r.id} style={s.row}>
                <div style={s.cWhen}>{fmt(r.created_at)}</div>
                <div style={s.cWho}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.to_name || r.to_phone || '—'}</div>
                  {r.recipients_role && <div style={s.rol}>{ROL(r.recipients_role)}</div>}
                </div>
                <div style={s.cMid}>
                  <span style={{ ...s.evento, color: ev.color, background: ev.color + '22' }}>{ev.label}</span>
                  <div style={s.body}>{r.body || ''}</div>
                </div>
                <div style={s.cEnd}>
                  <span style={{ ...s.badge, color: failed ? '#E5556A' : '#15A06E', background: (failed ? '#E5556A' : '#15A06E') + '1e' }}>
                    {failed ? 'No entregado' : 'Entregado'}
                  </span>
                  {leadId && <button style={s.leadBtn} onClick={() => openLead(leadId)}>Ver lead</button>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {failedCount > 0 && (
        <p style={s.note}>Los “No entregados” suelen ser mensajes fuera de la ventana de 24h de WhatsApp. Se resuelven aprobando la plantilla de alerta interna en Meta.</p>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <CrmShell active="alertas" maxWidth={1000}>{children}</CrmShell>
}

const s: Record<string, React.CSSProperties> = {
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 6 },
  eyebrow: { fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  title: { fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0 0', fontFamily: 'var(--font-inter), Inter, sans-serif' },
  lede: { fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 18px' },
  muted: { color: 'var(--text-muted)', fontSize: 14, padding: '40px 0', textAlign: 'center' },
  empty: { color: 'var(--text-muted)', fontSize: 14, padding: '40px 20px', textAlign: 'center', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12 },
  error: { background: 'rgba(229,85,106,0.12)', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16 },
  btnGhost: { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },

  kpiRow: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,200px))', gap: 12, marginBottom: 18 },
  kpi: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' },
  kpiNum: { fontSize: 28, fontWeight: 800, lineHeight: 1, fontFamily: 'var(--font-inter), Inter, sans-serif' },
  kpiLabel: { fontSize: 12, color: 'var(--text-muted)', marginTop: 6, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' },

  filters: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' },
  input: { padding: '8px 11px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'var(--font-inter), Inter, sans-serif' },
  count: { fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' },

  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' },
  row: { display: 'flex', alignItems: 'flex-start', gap: 14, padding: '13px 18px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' },
  cWhen: { width: 92, flexShrink: 0, fontSize: 12, color: 'var(--text-muted)', paddingTop: 2, fontVariantNumeric: 'tabular-nums' },
  cWho: { width: 130, flexShrink: 0, fontSize: 13 },
  rol: { fontSize: 11, color: 'var(--text-muted)', marginTop: 1 },
  cMid: { flex: 1, minWidth: 160 },
  evento: { display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99, marginBottom: 5 },
  body: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  cEnd: { width: 120, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 },
  badge: { fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 99, whiteSpace: 'nowrap' },
  leadBtn: { fontSize: 12, fontWeight: 600, color: 'var(--accent)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, padding: '4px 10px', cursor: 'pointer' },
  note: { fontSize: 12, color: 'var(--text-muted)', marginTop: 14, fontStyle: 'italic' },
}