// app/settings/WhatsAppLogTab.tsx
// ═══════════════════════════════════════════════════════════════════════════
// WHATSAPP LOG TAB — manager-only monitor of all outbound WhatsApp sends.
//
// 2026-05-29
//
// Reads public.whatsapp_log (written by the WhatsApp Worker, one row per
// send). Gerencia roles only — the settings menu hides this tab for everyone
// else, and RLS on whatsapp_log enforces it server-side too.
//
// Covers OUTBOUND only. Inbound conversation history lives in CRM chats.
// ═══════════════════════════════════════════════════════════════════════════
'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'

const PAGE = 200 // most-recent rows pulled per load

type LogRow = {
  id: string
  created_at: string
  direction: string | null
  to_phone: string | null
  to_name: string | null
  msg_type: string | null
  template_name: string | null
  evento: string | null
  body: string | null
  status: string | null
  meta_message_id: string | null
  error_msg: string | null
  triggered_by: string | null
  recipients_role: string | null
  raw_response: any
}

// DD/MM/YYYY HH:mm (VET-local as stored)
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}/${mm}/${yy} ${hh}:${mi}`
}

const st = {
  card:    { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, marginBottom: 20 } as const,
  input:   { padding: '8px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const },
  label:   { fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' },
  row:     { display: 'grid', gridTemplateColumns: '150px 1fr 160px 110px 150px 40px', gap: 12, alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, cursor: 'pointer' } as const,
  head:    { display: 'grid', gridTemplateColumns: '150px 1fr 160px 110px 150px 40px', gap: 12, padding: '8px 12px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1, color: 'var(--text-secondary)', borderBottom: '2px solid var(--border)' } as const,
  badge:   (color: string) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700, color, background: color + '22', textTransform: 'uppercase' as const, letterSpacing: 0.5 }),
  pre:     { background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const, maxHeight: 320, overflow: 'auto', margin: 0 },
}

function statusColor(s: string | null): string {
  if (s === 'failed') return 'var(--danger)'
  if (s === 'sent')   return '#1a7a4a'
  return '#6b7280'
}

export default function WhatsAppLogTab() {
  const [rows, setRows] = useState<LogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Filters
  const [q, setQ]               = useState('')
  const [status, setStatus]     = useState('all')
  const [template, setTemplate] = useState('all')
  const [trigger, setTrigger]   = useState('all')
  const [from, setFrom]         = useState('')
  const [to, setTo]             = useState('')

  useEffect(() => { load() }, [])

  async function load(offset = 0) {
    setLoading(true); setErr(null)
    const { data, error } = await supabase
      .from('whatsapp_log')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE - 1)
    if (error) {
      setErr(error.message)
      setLoading(false)
      return
    }
    const batch = (data || []) as LogRow[]
    setRows(prev => offset === 0 ? batch : [...prev, ...batch])
    setHasMore(batch.length === PAGE)
    setLoading(false)
  }

  // Filter option lists derived from loaded data
  const templates = useMemo(
    () => Array.from(new Set(rows.map(r => r.template_name).filter(Boolean))) as string[],
    [rows]
  )
  const triggers = useMemo(
    () => Array.from(new Set(rows.map(r => r.triggered_by).filter(Boolean))) as string[],
    [rows]
  )

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const fromMs = from ? new Date(from + 'T00:00:00').getTime() : null
    const toMs   = to   ? new Date(to   + 'T23:59:59').getTime() : null
    return rows.filter(r => {
      if (status !== 'all'   && (r.status || '') !== status) return false
      if (template !== 'all' && (r.template_name || '') !== template) return false
      if (trigger !== 'all'  && (r.triggered_by || '') !== trigger) return false
      if (fromMs || toMs) {
        const t = new Date(r.created_at).getTime()
        if (fromMs && t < fromMs) return false
        if (toMs && t > toMs) return false
      }
      if (needle) {
        const hay = [r.to_phone, r.to_name, r.body, r.evento, r.template_name]
          .filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [rows, q, status, template, trigger, from, to])

  const sentCount   = filtered.filter(r => r.status === 'sent').length
  const failedCount = filtered.filter(r => r.status === 'failed').length

  return (
    <div>
      <div style={st.card}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>Registro de WhatsApp</h2>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
          Mensajes salientes enviados por el sistema (recordatorios de cobranza, avisos de tesorería, plantillas).
          Solo lectura. Los chats del CRM y los mensajes entrantes no se incluyen aquí.
        </p>

        {/* Filters */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
          <div style={{ flex: '2 1 220px' }}>
            <label style={st.label}>Buscar (teléfono / nombre / texto)</label>
            <input style={{ ...st.input, width: '100%' }} value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar…" />
          </div>
          <div style={{ flex: '1 1 120px' }}>
            <label style={st.label}>Estado</label>
            <select style={{ ...st.input, width: '100%' }} value={status} onChange={e => setStatus(e.target.value)}>
              <option value="all">Todos</option>
              <option value="sent">Enviado</option>
              <option value="failed">Fallido</option>
            </select>
          </div>
          <div style={{ flex: '1 1 150px' }}>
            <label style={st.label}>Plantilla</label>
            <select style={{ ...st.input, width: '100%' }} value={template} onChange={e => setTemplate(e.target.value)}>
              <option value="all">Todas</option>
              {templates.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 150px' }}>
            <label style={st.label}>Origen</label>
            <select style={{ ...st.input, width: '100%' }} value={trigger} onChange={e => setTrigger(e.target.value)}>
              <option value="all">Todos</option>
              {triggers.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 130px' }}>
            <label style={st.label}>Desde</label>
            <input type="date" style={{ ...st.input, width: '100%' }} value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div style={{ flex: '1 1 130px' }}>
            <label style={st.label}>Hasta</label>
            <input type="date" style={{ ...st.input, width: '100%' }} value={to} onChange={e => setTo(e.target.value)} />
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          {filtered.length} mensaje(s) · <span style={st.badge('#1a7a4a')}>{sentCount} enviados</span>{' '}
          {failedCount > 0 && <span style={st.badge('var(--danger)')}>{failedCount} fallidos</span>}
        </div>

        {err && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>Error: {err}</div>}

        {/* Table */}
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={st.head}>
            <div>Fecha</div><div>Destinatario / Mensaje</div><div>Plantilla / Tipo</div>
            <div>Estado</div><div>Origen</div><div />
          </div>

          {loading && rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>Cargando…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>Sin mensajes.</div>
          ) : filtered.map(r => (
            <div key={r.id}>
              <div style={st.row} onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                <div style={{ color: 'var(--text-secondary)' }}>{fmtDateTime(r.created_at)}</div>
                <div style={{ overflow: 'hidden' }}>
                  <div style={{ fontWeight: 600 }}>{r.to_name || r.to_phone || '—'}</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.to_phone && r.to_name ? r.to_phone + ' · ' : ''}{(r.body || r.evento || '').slice(0, 90)}
                  </div>
                </div>
                <div>{r.template_name || r.msg_type || '—'}</div>
                <div><span style={st.badge(statusColor(r.status))}>{r.status || '—'}</span></div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{r.triggered_by || '—'}</div>
                <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>{expanded === r.id ? '▾' : '▸'}</div>
              </div>
              {expanded === r.id && (
                <div style={{ padding: '12px 16px', background: 'var(--bg-input)', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, fontSize: 12 }}>
                    <div>
                      <div style={st.label}>Mensaje</div>
                      <div style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}>{r.body || '—'}</div>
                      <div style={st.label}>Evento</div>
                      <div style={{ marginBottom: 12 }}>{r.evento || '—'}</div>
                      <div style={st.label}>Meta message id</div>
                      <div style={{ marginBottom: 12, fontFamily: 'monospace', fontSize: 11 }}>{r.meta_message_id || '—'}</div>
                      {r.recipients_role && (<><div style={st.label}>Audiencia</div><div>{r.recipients_role}</div></>)}
                      {r.error_msg && (
                        <>
                          <div style={{ ...st.label, color: 'var(--danger)' }}>Error</div>
                          <div style={{ color: 'var(--danger)' }}>{r.error_msg}</div>
                        </>
                      )}
                    </div>
                    <div>
                      <div style={st.label}>Respuesta cruda (Meta)</div>
                      <pre style={st.pre}>{r.raw_response ? JSON.stringify(r.raw_response, null, 2) : '—'}</pre>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {hasMore && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button
              onClick={() => load(rows.length)}
              disabled={loading}
              style={{ ...st.input, cursor: 'pointer', fontWeight: 700, color: 'var(--danger)', borderColor: 'rgba(240,85,106,0.35)' }}
            >
              {loading ? 'Cargando…' : 'Cargar más'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}