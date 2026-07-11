// TARGET: autocore-npa/app/crm/calendario/page.tsx
// AutoCore CRM — Calendario de equipo (citas + recordatorios)
//
// Scope: shared team calendar. Anyone with npa_can_view_crm (including
// front-desk / recepción) can open it and see appointments and reminders.
// Three shapes: Día, Semana, Mes. An optional "Sólo lo mío" filter narrows
// to the signed-in user's own items.
//
// Reads (no writes except the quick "+ Recordatorio" composer):
//   • crm_citas        — appointments (fecha, hora, estado, asignado, lead)
//   • crm_actividades  — tipo='recordatorio' rows are reminders. Both Claudia
//                        (created_by null / bot) and manual ones surface here.
//   • crm_leads        — proxima_accion_at scheduled next-actions show as soft
//                        reminders so nothing assigned falls through.
//
// New reminders are written to crm_actividades as tipo='recordatorio' with the
// due datetime in `descripcion` prefixed [YYYY-MM-DDTHH:mm]· so we don't need a
// schema change. recordatorio_at is also set if the column exists (best-effort).
//
// Static-export safe: query-string routing, window.location for nav, no API
// routes. Realtime optional via crm_calendar channel.

'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useNPAPermissions } from '../../components/useNPAPermissions'

// ── date helpers (local-time, no UTC drift) ────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parseYMD = (s: string) => { const [y, m, dd] = s.split('-').map(Number); return new Date(y, m - 1, dd) }
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const startOfWeek = (d: Date) => addDays(d, -((d.getDay() + 6) % 7)) // Monday-first
const sameDay = (a: Date, b: Date) => ymd(a) === ymd(b)
const DOW = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
const MES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const fmtHora = (h: string | null) => { if (!h) return null; const [hh, mm] = h.split(':'); return `${hh}:${mm}` }
const ESTADO_LABEL: Record<string, string> = { agendada: 'Agendada', cumplida: 'Cumplida', no_show: 'No-show', cancelada: 'Cancelada' }
const fmtFechaLarga = (f: string) => { const d = parseYMD(f); return `${DOW[(d.getDay() + 6) % 7]} ${d.getDate()} ${MES[d.getMonth()]} ${d.getFullYear()}` }

// ── event model: everything normalises to this shape ───────────────────────
type EvKind = 'cita' | 'recordatorio' | 'accion'
interface CalEvent {
  id: string
  kind: EvKind
  fecha: string            // YYYY-MM-DD
  hora: string | null      // HH:mm or null (all-day)
  titulo: string
  sub: string | null       // lead name / context
  estado: string | null    // cita estado
  asignado: string | null
  leadId: string | null
}

const KIND_META: Record<EvKind, { label: string; color: string; soft: string }> = {
  cita:         { label: 'Cita',         color: 'var(--accent)',   soft: 'var(--accent-soft)' },
  recordatorio: { label: 'Recordatorio', color: 'var(--warn)',     soft: 'rgba(230,162,60,0.12)' },
  accion:       { label: 'Próx. acción', color: 'var(--heat-cold)',soft: 'rgba(87,166,201,0.12)' },
}
// cita estado overrides its dot colour
function citaColor(estado: string | null): string {
  if (estado === 'cumplida') return 'var(--ok)'
  if (estado === 'no_show' || estado === 'cancelada') return 'var(--danger)'
  return 'var(--accent)'
}

export default function CalendarioPage() {
  const { permissions, loading: permsLoading, userId } = useNPAPermissions()
  const [view, setView] = useState<'dia' | 'semana' | 'mes'>('semana')
  const [cursor, setCursor] = useState<Date>(new Date())
  const [onlyMine, setOnlyMine] = useState(false)
  const [myName, setMyName] = useState<string | null>(null)
  const [events, setEvents] = useState<CalEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // quick reminder composer
  const [showAdd, setShowAdd] = useState(false)
  const [rfDate, setRfDate] = useState(ymd(new Date()))
  const [rfTime, setRfTime] = useState('')
  const [rfText, setRfText] = useState('')
  const [saving, setSaving] = useState(false)

  // cita detail panel
  const [citaSel, setCitaSel] = useState<CalEvent | null>(null)
  const [citaSaving, setCitaSaving] = useState(false)
  const [reprog, setReprog] = useState(false)
  const [rpDate, setRpDate] = useState('')
  const [rpTime, setRpTime] = useState('')

  // resolve my display name (for "only mine" + reminder authorship)
  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: u } = await supabase.auth.getUser()
      const uid = u?.user?.id
      if (!uid) return
      const { data } = await supabase.from('user_roles').select('full_name').eq('user_id', uid).maybeSingle()
      if (active && data?.full_name) setMyName(data.full_name)
    })()
    return () => { active = false }
  }, [])

  // the visible window [from, to] inclusive, by view
  const range = useMemo(() => {
    if (view === 'dia') return { from: cursor, to: cursor }
    if (view === 'semana') { const s = startOfWeek(cursor); return { from: s, to: addDays(s, 6) } }
    // month grid: pad to full weeks
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
    return { from: startOfWeek(first), to: addDays(startOfWeek(last), 6) }
  }, [view, cursor])

  const loadData = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const from = ymd(range.from)
      const to = ymd(range.to)

      const [citasResp, actsResp, leadsResp] = await Promise.all([
        supabase.from('crm_citas')
          .select('id, lead_id, fecha, hora, asignado_nombre, estado, notas, crm_leads(id, nombre, apellidos, modelo_interes)')
          .gte('fecha', from).lte('fecha', to)
          .order('fecha', { ascending: true }),
        supabase.from('crm_actividades')
          .select('id, lead_id, tipo, descripcion, created_at, created_by, crm_leads(id, nombre, apellidos)')
          .eq('tipo', 'recordatorio')
          .order('created_at', { ascending: true })
          .limit(2000),
        supabase.from('crm_leads')
          .select('id, nombre, apellidos, proxima_accion, proxima_accion_at, asignado_nombre')
          .not('proxima_accion_at', 'is', null)
          .limit(2000),
      ])
      if (citasResp.error) throw citasResp.error

      const out: CalEvent[] = []

      // citas
      for (const c of (citasResp.data || []) as any[]) {
        const lead = c.crm_leads
        const nom = lead ? `${lead.nombre || ''} ${lead.apellidos || ''}`.trim() : null
        out.push({
          id: 'c_' + c.id, kind: 'cita', fecha: c.fecha, hora: c.hora,
          titulo: nom || 'Cita', sub: lead?.modelo_interes || c.notas || null,
          estado: c.estado, asignado: c.asignado_nombre || null, leadId: c.lead_id || null,
        })
      }

      // recordatorios: due datetime is embedded as a [ISO]· prefix in descripcion
      for (const a of (actsResp.data || []) as any[]) {
        const m = /^\[(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?\]·?\s*([\s\S]*)$/.exec(a.descripcion || '')
        const fecha = m ? m[1] : (a.created_at ? a.created_at.slice(0, 10) : null)
        if (!fecha || fecha < from || fecha > to) continue
        const hora = m && m[2] ? m[2] : null
        const text = m ? m[3] : (a.descripcion || 'Recordatorio')
        const lead = a.crm_leads
        const nom = lead ? `${lead.nombre || ''} ${lead.apellidos || ''}`.trim() : null
        out.push({
          id: 'r_' + a.id, kind: 'recordatorio', fecha, hora,
          titulo: text || 'Recordatorio', sub: nom,
          estado: null, asignado: null, leadId: a.lead_id || null,
        })
      }

      // proxima_accion_at next-actions
      for (const l of (leadsResp.data || []) as any[]) {
        if (!l.proxima_accion_at) continue
        const dt = new Date(l.proxima_accion_at)
        const fecha = ymd(dt)
        if (fecha < from || fecha > to) continue
        const hora = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`
        const nom = `${l.nombre || ''} ${l.apellidos || ''}`.trim()
        out.push({
          id: 'a_' + l.id, kind: 'accion', fecha, hora: hora === '00:00' ? null : hora,
          titulo: l.proxima_accion || 'Próxima acción', sub: nom || null,
          estado: null, asignado: l.asignado_nombre || null, leadId: l.id,
        })
      }

      setEvents(out)
    } catch (e: any) {
      setErr(e?.message || 'No se pudo cargar el calendario.')
    } finally {
      setLoading(false)
    }
  }, [range])

  useEffect(() => { if (!permsLoading && permissions.npa_can_view_crm) loadData() }, [permsLoading, permissions.npa_can_view_crm, loadData])

  // realtime: refresh on any cita/actividad change in the window
  useEffect(() => {
    const ch = supabase.channel('crm_calendar')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_citas' }, () => loadData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_actividades' }, () => loadData())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [loadData])

  const visible = useMemo(() => {
    if (!onlyMine || !myName) return events
    return events.filter(e => (e.asignado || '').toLowerCase() === myName.toLowerCase())
  }, [events, onlyMine, myName])

  const byDay = useMemo(() => {
    const m: Record<string, CalEvent[]> = {}
    for (const e of visible) (m[e.fecha] ||= []).push(e)
    for (const k of Object.keys(m)) {
      m[k].sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'))
    }
    return m
  }, [visible])

  // ── navigation ──
  const step = (dir: number) => {
    if (view === 'dia') setCursor(addDays(cursor, dir))
    else if (view === 'semana') setCursor(addDays(cursor, dir * 7))
    else setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1))
  }
  const goToday = () => setCursor(new Date())

  const heading = useMemo(() => {
    if (view === 'dia') return `${DOW[(cursor.getDay() + 6) % 7]} ${cursor.getDate()} ${MES[cursor.getMonth()]} ${cursor.getFullYear()}`
    if (view === 'semana') { const s = startOfWeek(cursor), e = addDays(s, 6); return `${s.getDate()} ${MES[s.getMonth()].slice(0,3)} – ${e.getDate()} ${MES[e.getMonth()].slice(0,3)} ${e.getFullYear()}` }
    return `${MES[cursor.getMonth()]} ${cursor.getFullYear()}`
  }, [view, cursor])

  const openLead = (id: string | null) => { if (id) window.location.href = '/crm?search_lead=' + id }

  // Click on a cita opens the detail panel; other kinds still jump to the lead.
  const openEvent = (e: CalEvent) => {
    if (e.kind === 'cita') {
      setCitaSel(e); setReprog(false)
      setRpDate(e.fecha); setRpTime(e.hora ? e.hora.slice(0, 5) : '')
    } else {
      openLead(e.leadId)
    }
  }

  const citaId = citaSel ? citaSel.id.replace(/^c_/, '') : null

  const setCitaEstado = async (estado: string) => {
    if (!citaId || citaSaving) return
    setCitaSaving(true)
    try {
      const { error } = await supabase.from('crm_citas').update({ estado }).eq('id', citaId)
      if (error) throw error
      // al cumplir, avanza el lead solo si estaba en cita_agendada (no degrada)
      if (estado === 'cumplida' && citaSel?.leadId) {
        const { data: ld } = await supabase.from('crm_leads').select('etapa').eq('id', citaSel.leadId).maybeSingle()
        if ((ld as any)?.etapa === 'cita_agendada') {
          await supabase.from('crm_leads').update({ etapa: 'visita_showroom' }).eq('id', citaSel.leadId)
        }
      }
      setCitaSel(null); loadData()
    } catch (e: any) {
      setErr(e?.message || 'No se pudo actualizar la cita.')
    } finally {
      setCitaSaving(false)
    }
  }

  const reprogramarCita = async () => {
    if (!citaId || !rpDate || citaSaving) return
    setCitaSaving(true)
    try {
      const { error } = await supabase.from('crm_citas')
        .update({ fecha: rpDate, hora: rpTime || null, estado: 'agendada' })
        .eq('id', citaId)
      if (error) throw error
      setCitaSel(null); setReprog(false); loadData()
    } catch (e: any) {
      setErr(e?.message || 'No se pudo reprogramar la cita.')
    } finally {
      setCitaSaving(false)
    }
  }

  const addReminder = async () => {
    if (!rfText.trim() || saving) return
    setSaving(true)
    try {
      const iso = rfTime ? `${rfDate}T${rfTime}` : rfDate
      const row: any = {
        tipo: 'recordatorio',
        descripcion: `[${iso}]· ${rfText.trim()}`,
        created_by: userId || null,
      }
      const { error } = await supabase.from('crm_actividades').insert(row)
      if (error) throw error
      setShowAdd(false); setRfText(''); setRfTime('')
      loadData()
    } catch (e: any) {
      setErr(e?.message || 'No se pudo guardar el recordatorio.')
    } finally {
      setSaving(false)
    }
  }

  if (permsLoading) return <Shell><div style={s.muted}>Cargando…</div></Shell>
  if (!permissions.npa_can_view_crm) return <Shell><div style={s.muted}>No tienes acceso al CRM.</div></Shell>

  return (
    <Shell>
      {/* header */}
      <div style={s.topRow}>
        <div>
          <div style={s.eyebrow}>CRM · Calendario</div>
          <h1 style={s.h1}>{heading}</h1>
        </div>
        <div style={s.topActions}>
          <button style={s.btnGhost} onClick={() => { setRfDate(view === 'dia' ? ymd(cursor) : ymd(new Date())); setShowAdd(true) }}>+ Recordatorio</button>
        </div>
      </div>

      {/* controls */}
      <div style={s.controls}>
        <div style={s.segGroup}>
          {(['dia', 'semana', 'mes'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              style={{ ...s.seg, ...(view === v ? s.segOn : {}) }}>
              {v === 'dia' ? 'Día' : v === 'semana' ? 'Semana' : 'Mes'}
            </button>
          ))}
        </div>
        <div style={s.navGroup}>
          <button style={s.navBtn} onClick={() => step(-1)} aria-label="Anterior">‹</button>
          <button style={s.todayBtn} onClick={goToday}>Hoy</button>
          <button style={s.navBtn} onClick={() => step(1)} aria-label="Siguiente">›</button>
        </div>
        <label style={s.mineToggle}>
          <input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} />
          Sólo lo mío
        </label>
        <div style={s.legend}>
          {(['cita', 'recordatorio', 'accion'] as EvKind[]).map(k => (
            <span key={k} style={s.legendItem}>
              <span style={{ ...s.dot, background: KIND_META[k].color }} />
              {KIND_META[k].label}
            </span>
          ))}
        </div>
      </div>

      {err && <div style={s.errBox}>{err}</div>}

      {loading ? (
        <div style={s.muted}>Cargando eventos…</div>
      ) : view === 'mes' ? (
        <MonthView from={range.from} cursor={cursor} byDay={byDay} onPick={(d) => { setCursor(d); setView('dia') }} onOpen={openEvent} />
      ) : view === 'semana' ? (
        <WeekView from={range.from} byDay={byDay} onOpen={openEvent} />
      ) : (
        <DayView day={cursor} events={byDay[ymd(cursor)] || []} onOpen={openEvent} />
      )}

      {/* add reminder modal */}
      {showAdd && (
        <div style={s.modalWrap} onClick={() => setShowAdd(false)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>Nuevo recordatorio</div>
            <div style={s.formRow}>
              <label style={s.label}>Fecha</label>
              <input type="date" value={rfDate} onChange={e => setRfDate(e.target.value)} style={s.input} />
            </div>
            <div style={s.formRow}>
              <label style={s.label}>Hora <span style={s.optional}>(opcional)</span></label>
              <input type="time" value={rfTime} onChange={e => setRfTime(e.target.value)} style={s.input} />
            </div>
            <div style={s.formRow}>
              <label style={s.label}>Recordatorio</label>
              <textarea value={rfText} onChange={e => setRfText(e.target.value)} rows={3}
                placeholder="Llamar a cliente, seguimiento de oferta…" style={{ ...s.input, resize: 'vertical' }} />
            </div>
            <div style={s.modalBtns}>
              <button style={s.btnGhost} onClick={() => setShowAdd(false)}>Cancelar</button>
              <button style={s.btnPrimary} onClick={addReminder} disabled={saving || !rfText.trim()}>
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* cita detail panel */}
      {citaSel && (
        <div style={s.modalWrap} onClick={() => setCitaSel(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>Detalle de cita</div>

            <div style={s.detailRow}><span style={s.detailLabel}>Cliente</span><span style={s.detailValue}>{citaSel.titulo}</span></div>
            <div style={s.detailRow}><span style={s.detailLabel}>Modelo</span><span style={s.detailValue}>{citaSel.sub || '—'}</span></div>
            <div style={s.detailRow}><span style={s.detailLabel}>Fecha</span><span style={s.detailValue}>{fmtFechaLarga(citaSel.fecha)}</span></div>
            <div style={s.detailRow}><span style={s.detailLabel}>Hora</span><span style={s.detailValue}>{fmtHora(citaSel.hora) || 'Sin hora'}</span></div>
            <div style={s.detailRow}><span style={s.detailLabel}>Responsable</span><span style={s.detailValue}>{citaSel.asignado || 'Sin asignar'}</span></div>
            <div style={s.detailRow}>
              <span style={s.detailLabel}>Estado</span>
              <span style={{ ...s.estadoBadge, color: citaColor(citaSel.estado) }}>
                {ESTADO_LABEL[citaSel.estado || 'agendada'] || citaSel.estado}
              </span>
            </div>

            {reprog ? (
              <div style={s.reprogBox}>
                <div style={s.formRow}>
                  <label style={s.label}>Nueva fecha</label>
                  <input type="date" value={rpDate} onChange={e => setRpDate(e.target.value)} style={s.input} />
                </div>
                <div style={s.formRow}>
                  <label style={s.label}>Nueva hora <span style={s.optional}>(opcional)</span></label>
                  <input type="time" value={rpTime} onChange={e => setRpTime(e.target.value)} style={s.input} />
                </div>
                <div style={s.modalBtns}>
                  <button style={s.btnGhost} onClick={() => setReprog(false)} disabled={citaSaving}>Atrás</button>
                  <button style={s.btnPrimary} onClick={reprogramarCita} disabled={citaSaving || !rpDate}>
                    {citaSaving ? 'Guardando…' : 'Guardar cambios'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div style={s.citaActions}>
                  <button style={s.btnOk} onClick={() => setCitaEstado('cumplida')} disabled={citaSaving}>Marcar cumplida</button>
                  <button style={s.btnWarn} onClick={() => setCitaEstado('no_show')} disabled={citaSaving}>No-show</button>
                  <button style={s.btnGhost} onClick={() => setReprog(true)} disabled={citaSaving}>Reprogramar</button>
                  <button style={s.btnDanger} onClick={() => setCitaEstado('cancelada')} disabled={citaSaving}>Cancelar cita</button>
                </div>
                <div style={s.modalBtns}>
                  {citaSel.leadId && <button style={s.btnGhost} onClick={() => openLead(citaSel.leadId)}>Ver lead</button>}
                  <button style={s.btnGhost} onClick={() => setCitaSel(null)}>Cerrar</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Shell>
  )
}

// ─────────────────────────────────────────────────────────────────────────
function Shell({ children }: { children: React.ReactNode }) {
  return <CrmShell active="calendario" maxWidth={1200}>{children}</CrmShell>
}

function EventChip({ e, onOpen, compact }: { e: CalEvent; onOpen: (e: CalEvent) => void; compact?: boolean }) {
  const color = e.kind === 'cita' ? citaColor(e.estado) : KIND_META[e.kind].color
  const done = e.estado === 'cumplida' || e.estado === 'no_show' || e.estado === 'cancelada'
  const clickable = e.kind === 'cita' || !!e.leadId
  return (
    <div onClick={() => onOpen(e)}
      style={{ ...s.chip, borderLeft: `3px solid ${color}`, background: KIND_META[e.kind].soft, cursor: clickable ? 'pointer' : 'default', opacity: done ? 0.6 : 1 }}
      title={e.titulo}>
      <div style={s.chipTop}>
        {e.hora && <span style={s.chipHora}>{fmtHora(e.hora)}</span>}
        <span style={{ ...s.chipTitle, ...(done ? { textDecoration: 'line-through' } : {}) }}>{e.titulo}</span>
      </div>
      {!compact && (e.sub || e.asignado || e.estado) && (
        <div style={s.chipSub}>
          {e.sub && <span>{e.sub}</span>}
          {e.asignado && <span> · {e.asignado}</span>}
          {e.kind === 'cita' && e.estado === 'cumplida' && <span style={{ color: 'var(--ok)' }}> · cumplió</span>}
          {e.kind === 'cita' && e.estado === 'no_show' && <span style={{ color: 'var(--danger)' }}> · no-show</span>}
        </div>
      )}
    </div>
  )
}

function DayView({ day, events, onOpen }: { day: Date; events: CalEvent[]; onOpen: (e: CalEvent) => void }) {
  const isToday = sameDay(day, new Date())
  return (
    <div style={s.dayCol}>
      <div style={{ ...s.dayHead, ...(isToday ? s.dayHeadToday : {}) }}>
        <span style={s.dayDow}>{DOW[(day.getDay() + 6) % 7]}</span>
        <span style={s.dayNum}>{day.getDate()}</span>
        <span style={s.dayCount}>{events.length} {events.length === 1 ? 'evento' : 'eventos'}</span>
      </div>
      {events.length === 0 ? (
        <div style={s.emptyDay}>Nada agendado este día.</div>
      ) : (
        <div style={s.dayList}>{events.map(e => <EventChip key={e.id} e={e} onOpen={onOpen} />)}</div>
      )}
    </div>
  )
}

function WeekView({ from, byDay, onOpen }: { from: Date; byDay: Record<string, CalEvent[]>; onOpen: (e: CalEvent) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i))
  return (
    <div style={{ overflowX: 'auto' }}>
    <div style={{ minWidth: '840px' }}>
    <div style={s.weekGrid}>
      {days.map(d => {
        const key = ymd(d)
        const evs = byDay[key] || []
        const isToday = sameDay(d, new Date())
        return (
          <div key={key} style={{ ...s.weekCol, ...(isToday ? s.weekColToday : {}) }}>
            <div style={s.weekColHead}>
              <span style={s.weekDow}>{DOW[(d.getDay() + 6) % 7]}</span>
              <span style={{ ...s.weekNum, ...(isToday ? s.weekNumToday : {}) }}>{d.getDate()}</span>
            </div>
            <div style={s.weekColBody}>
              {evs.length === 0 ? <div style={s.weekEmpty}>—</div>
                : evs.map(e => <EventChip key={e.id} e={e} onOpen={onOpen} compact />)}
            </div>
          </div>
        )
      })}
    </div>
    </div>
    </div>
  )
}

function MonthView({ from, cursor, byDay, onPick, onOpen }: {
  from: Date; cursor: Date; byDay: Record<string, CalEvent[]>
  onPick: (d: Date) => void; onOpen: (e: CalEvent) => void
}) {
  const weeks: Date[][] = []
  let d = new Date(from)
  for (let w = 0; w < 6; w++) {
    const row: Date[] = []
    for (let i = 0; i < 7; i++) { row.push(new Date(d)); d = addDays(d, 1) }
    weeks.push(row)
    if (d.getMonth() !== cursor.getMonth() && d > new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)) break
  }
  return (
    <div style={{ overflowX: 'auto' }}>
    <div style={{ minWidth: '840px' }}>
    <div>
      <div style={s.monthDow}>{DOW.map(x => <div key={x} style={s.monthDowCell}>{x}</div>)}</div>
      <div style={s.monthGrid}>
        {weeks.flat().map((day) => {
          const key = ymd(day)
          const evs = byDay[key] || []
          const inMonth = day.getMonth() === cursor.getMonth()
          const isToday = sameDay(day, new Date())
          return (
            <div key={key} onClick={() => onPick(day)}
              style={{ ...s.monthCell, ...(inMonth ? {} : s.monthCellOut), ...(isToday ? s.monthCellToday : {}) }}>
              <div style={s.monthCellTop}>
                <span style={{ ...s.monthDayNum, ...(isToday ? s.monthDayNumToday : {}) }}>{day.getDate()}</span>
                {evs.length > 0 && <span style={s.monthCount}>{evs.length}</span>}
              </div>
              <div style={s.monthCellEvents}>
                {evs.slice(0, 3).map(e => {
                  const color = e.kind === 'cita' ? citaColor(e.estado) : KIND_META[e.kind].color
                  return (
                    <div key={e.id} onClick={(ev) => { ev.stopPropagation(); onOpen(e) }}
                      style={{ ...s.monthEv, borderLeft: `3px solid ${color}` }} title={e.titulo}>
                      {e.hora && <span style={s.monthEvHora}>{fmtHora(e.hora)}</span>}
                      <span style={s.monthEvTitle}>{e.titulo}</span>
                    </div>
                  )
                })}
                {evs.length > 3 && <div style={s.monthMore}>+{evs.length - 3} más</div>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
    </div>
    </div>
  )
}

// ── styles (navy-charcoal token system) ─────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  muted: { color: 'var(--text-secondary)', fontSize: 14, padding: '40px 0', textAlign: 'center' },
  topRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, marginBottom: 18, flexWrap: 'wrap' },
  eyebrow: { fontSize: 11, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 4 },
  h1: { fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: 0, fontFamily: 'var(--font-inter), Inter, sans-serif' },
  topActions: { display: 'flex', gap: 8 },

  controls: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 18 },
  segGroup: { display: 'flex', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 3, gap: 2 },
  seg: { padding: '7px 16px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-inter), Inter, sans-serif' },
  segOn: { background: 'var(--accent-solid)', color: 'var(--on-accent)' },
  navGroup: { display: 'flex', alignItems: 'center', gap: 6 },
  navBtn: { width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 18, lineHeight: 1, cursor: 'pointer' },
  todayBtn: { padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  mineToggle: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' },
  legend: { display: 'flex', gap: 14, marginLeft: 'auto', flexWrap: 'wrap' },
  legendItem: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' },
  dot: { width: 9, height: 9, borderRadius: '50%', display: 'inline-block' },

  errBox: { padding: '10px 14px', borderRadius: 8, background: 'rgba(240,85,106,0.10)', border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 13, marginBottom: 14 },

  // chips
  chip: { padding: '7px 10px', borderRadius: 7, marginBottom: 6 },
  chipTop: { display: 'flex', alignItems: 'baseline', gap: 7 },
  chipHora: { fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 },
  chipTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chipSub: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  // day view
  dayCol: { maxWidth: 640 },
  dayHead: { display: 'flex', alignItems: 'baseline', gap: 10, padding: '12px 0', borderBottom: '2px solid var(--border)', marginBottom: 12 },
  dayHeadToday: { borderBottomColor: 'var(--accent)' },
  dayDow: { fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' },
  dayNum: { fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' },
  dayCount: { fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' },
  dayList: {},
  emptyDay: { padding: '30px 0', color: 'var(--text-muted)', fontSize: 14 },

  // week view
  weekGrid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8, alignItems: 'start' },
  weekCol: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', minHeight: 120 },
  weekColToday: { borderColor: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent)' },
  weekColHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-card-hover)' },
  weekDow: { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' },
  weekNum: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' },
  weekNumToday: { color: 'var(--accent)' },
  weekColBody: { padding: 7, minHeight: 60 },
  weekEmpty: { color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', padding: '14px 0' },

  // month view
  monthDow: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8, marginBottom: 8 },
  monthDowCell: { fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'center', padding: '4px 0' },
  monthGrid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 },
  monthCell: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 9, minHeight: 104, padding: 7, cursor: 'pointer', display: 'flex', flexDirection: 'column' },
  monthCellOut: { opacity: 0.4 },
  monthCellToday: { borderColor: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent)' },
  monthCellTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 },
  monthDayNum: { fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' },
  monthDayNumToday: { color: 'var(--accent)' },
  monthCount: { fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--bg-deep)', borderRadius: 99, padding: '1px 7px' },
  monthCellEvents: { display: 'flex', flexDirection: 'column', gap: 3 },
  monthEv: { display: 'flex', gap: 5, alignItems: 'baseline', padding: '2px 6px', borderRadius: 4, background: 'var(--bg-card-hover)', overflow: 'hidden' },
  monthEvHora: { fontFamily: 'monospace', fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', flexShrink: 0 },
  monthEvTitle: { fontSize: 11, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  monthMore: { fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, paddingLeft: 6 },

  // buttons / modal
  btnGhost: { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  btnPrimary: { padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--accent-solid)', color: 'var(--on-accent)', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  modalWrap: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 },
  modal: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 22, width: 'min(440px, 100%)' },
  modalTitle: { fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 },
  formRow: { marginBottom: 14 },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 },
  optional: { fontWeight: 400, color: 'var(--text-muted)' },
  input: { width: '100%', padding: '9px 11px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'var(--font-inter), Inter, sans-serif', boxSizing: 'border-box' },
  modalBtns: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 },

  // cita detail panel
  detailRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' },
  detailLabel: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' },
  detailValue: { fontSize: 14, color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right' },
  estadoBadge: { fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 99, background: 'var(--bg-deep)' },
  reprogBox: { marginTop: 16 },
  citaActions: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, margin: '18px 0 10px' },
  btnOk: { padding: '9px 14px', borderRadius: 8, border: 'none', background: 'var(--ok)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnWarn: { padding: '9px 14px', borderRadius: 8, border: '1px solid var(--warn)', background: 'transparent', color: 'var(--warn)', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnDanger: { padding: '9px 14px', borderRadius: 8, border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
}