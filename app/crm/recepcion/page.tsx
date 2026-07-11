// TARGET: autocore-npa/app/crm/recepcion/page.tsx
// AutoCore CRM — Recepción (front-desk closer with appointment + walk-in duties)
//
// Scope: this user sees ONLY her own assigned leads (asignado_nombre = her
// name), her citas, and her unscheduled leads ("por agendar"). She is NOT a
// central scheduler. Walk-ins she registers auto-assign to her.
//
// Reads/writes: crm_leads (own), crm_citas (her appointments). Booking a cita
// auto-advances the lead via the crm_cita_advance_lead trigger + etapa log.

'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useNPAPermissions } from '../../components/useNPAPermissions'
import { FUENTES_SELECTABLE } from '../fuentes'

const RED = 'var(--accent-solid)'
const MODELOS_KIA = [
  'KIA Picanto', 'KIA Soluto', 'KIA Rio Stylus', 'KIA Sonet', 'KIA Seltos',
  'KIA Sportage', 'KIA Sorento', 'KIA Carnival', 'KIA Stinger', 'KIA Pregio', 'Otro',
]
const ETAPA_LABELS: Record<string, string> = {
  nuevo: 'Nuevo', contactado: 'Contactado', cita_agendada: 'Cita agendada',
  visita_showroom: 'Visita', oferta_presentada: 'Oferta', financiamiento: 'Financiamiento',
  cerrado_ganado: 'Ganado', cerrado_perdido: 'Perdido',
}

const todayStr = () => new Date().toISOString().slice(0, 10)
const fmtHora = (h: string | null) => {
  if (!h) return '—'
  const [hh, mm] = h.split(':')
  return `${hh}:${mm}`
}
const fmtFecha = (d: string | null) => { if (!d) return '—'; const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}` }

// ── week helpers (local-time, Monday-first — same convention as /crm/calendario) ──
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const startOfWeek = (d: Date) => addDays(d, -((d.getDay() + 6) % 7))
const DOW = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
const MES3 = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
const nowHHMM = () => { const n = new Date(); return `${pad(n.getHours())}:${pad(n.getMinutes())}` }
// Canonical estados across the CRM: agendada · cumplida · no_show · cancelada.
// 'cumplida' is the showed-up value (labeled "Asistió" in this UI so it matches
// how the rest of the CRM — calendario, campañas show-rate — already reads it).
const ESTADO_LABEL: Record<string, string> = { agendada: 'Agendada', cumplida: 'Asistió', no_show: 'No-show', cancelada: 'Cancelada' }
const estadoColor = (e: string | null) =>
  e === 'cumplida' ? 'var(--ok)' : e === 'no_show' ? 'var(--danger)' : e === 'cancelada' ? 'var(--text-muted)' : 'var(--accent)'

interface Lead {
  id: string; nombre: string; apellidos: string; telefono: string
  email?: string; modelo_interes?: string; etapa: string
  asignado_a?: string; asignado_nombre?: string; heat_score?: number
}
interface Cita {
  id: string; lead_id: string; fecha: string; hora: string | null
  asignado_a?: string; asignado_nombre?: string; estado: string; notas?: string
  crm_leads?: Lead
}

export default function RecepcionPage() {
  const router = useRouter()
  const { permissions, loading: permsLoading, userId } = useNPAPermissions()

  const [me, setMe] = useState<{ user_id: string; full_name: string; crm_role: string } | null>(null)
  const [meLoaded, setMeLoaded] = useState(false)
  const [tab, setTab] = useState<'hoy' | 'agendar' | 'leads'>('hoy')
  const [leads, setLeads] = useState<Lead[]>([])
  const [citas, setCitas] = useState<Cita[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Walk-in form
  const [showWalkin, setShowWalkin] = useState(false)
  const [wi, setWi] = useState({ nombre: '', apellidos: '', telefono: '', email: '', modelo: '', fuente: 'walk_in' })
  const [wiSaving, setWiSaving] = useState(false)
  const nombreRef = useRef<HTMLInputElement>(null)
  // Auto-focus NOMBRE when the walk-in form opens, so recepción types right away.
  useEffect(() => { if (showWalkin) nombreRef.current?.focus() }, [showWalkin])

  // Cita booking
  const [bookLead, setBookLead] = useState<Lead | null>(null)
  const [bk, setBk] = useState({ fecha: todayStr(), hora: '10:00', notas: '' })
  const [bkSaving, setBkSaving] = useState(false)

  // ── Control center (house-wide agenda + backstop) ──
  const [weekCursor, setWeekCursor] = useState<Date>(new Date())
  const [weekCitas, setWeekCitas] = useState<Cita[]>([])
  const [weekLoading, setWeekLoading] = useState(false)
  const [fAsesor, setFAsesor] = useState('')
  const [fEstado, setFEstado] = useState('')
  const [backstop, setBackstop] = useState<Cita[]>([])
  const [houseTodayCitas, setHouseTodayCitas] = useState<Cita[]>([]) // house-wide, today, all estados (KPI)
  const [soloHoy, setSoloHoy] = useState(false)
  const [crmUsers, setCrmUsers] = useState<{ user_id: string; full_name: string; crm_role: string }[]>([])
  // Editar / reagendar / cancelar (one modal, three modes)
  const [editCita, setEditCita] = useState<Cita | null>(null)
  const [edMode, setEdMode] = useState<'editar' | 'reagendar' | 'cancelar'>('editar')
  const [ed, setEd] = useState({ fecha: '', hora: '', asignado_a: '', notas: '' })
  const [edMotivo, setEdMotivo] = useState('')
  const [edSaving, setEdSaving] = useState(false)

  // Gate: must be able to see CRM.
  useEffect(() => {
    if (!permsLoading && !permissions.npa_can_view_crm) router.replace('/dashboard')
  }, [permsLoading, permissions])

  // Load own identity (name used for assignment matching + role).
  useEffect(() => {
    if (!userId) return
    supabase.from('user_roles').select('user_id, full_name, crm_role').eq('user_id', userId).single()
      .then(({ data }) => { setMe(data as any); setMeLoaded(true) })
  }, [userId])

  const myName = me?.full_name || ''

  const load = useCallback(async () => {
    if (!myName && !userId) return
    setLoading(true); setErr(null)
    try {
      // Her leads: matched by asignado_a (uuid) OR asignado_nombre (string),
      // since the existing CRM assigns by name. Email-join not needed.
      const orFilter = [
        userId ? `asignado_a.eq.${userId}` : null,
        myName ? `asignado_nombre.eq.${myName}` : null,
      ].filter(Boolean).join(',')
      const { data: ld } = await (supabase
        .from('crm_leads')
        .select('id, nombre, apellidos, telefono, email, modelo_interes, etapa, asignado_a, asignado_nombre, heat_score')
        .or(orFilter)
        .not('etapa', 'in', '(cerrado_ganado,cerrado_perdido)')
        .order('heat_score', { ascending: false }) as any)
      const myLeads: Lead[] = Array.isArray(ld) ? ld : []
      setLeads(myLeads)

      // Her citas (today + upcoming), joined to lead for display.
      const myLeadIds = myLeads.map(l => l.id)
      const citaOr = [
        userId ? `asignado_a.eq.${userId}` : null,
        myName ? `asignado_nombre.eq.${myName}` : null,
      ].filter(Boolean).join(',')
      const { data: ci } = await (supabase
        .from('crm_citas')
        .select('id, lead_id, fecha, hora, asignado_a, asignado_nombre, estado, notas, crm_leads(id, nombre, apellidos, telefono, modelo_interes, etapa, asignado_nombre)')
        .or(citaOr)
        .gte('fecha', todayStr())
        .order('fecha', { ascending: true })
        .order('hora', { ascending: true }) as any)
      setCitas(Array.isArray(ci) ? ci : [])
    } catch (e: any) {
      setErr(e?.message || 'Error al cargar')
    } finally { setLoading(false) }
  }, [myName, userId])

  useEffect(() => { if (meLoaded) load() }, [meLoaded, load])

  // ── House-wide agenda for the selected week (ALL asesores). Client-filtered. ──
  const loadWeek = useCallback(async () => {
    setWeekLoading(true)
    try {
      const from = ymd(startOfWeek(weekCursor))
      const to = ymd(addDays(startOfWeek(weekCursor), 6))
      const { data } = await (supabase
        .from('crm_citas')
        .select('id, lead_id, fecha, hora, asignado_a, asignado_nombre, estado, notas, crm_leads(id, nombre, apellidos, telefono, modelo_interes, etapa, asignado_nombre)')
        .gte('fecha', from).lte('fecha', to)
        .order('fecha', { ascending: true })
        .order('hora', { ascending: true }) as any)
      setWeekCitas(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setErr(e?.message || 'No se pudo cargar la agenda.')
    } finally { setWeekLoading(false) }
  }, [weekCursor])

  // ── Backstop: still 'agendada' but past its hora (previous days, or today
  //    before now). The BDC cleanup queue. ──
  const loadBackstop = useCallback(async () => {
    try {
      const today = todayStr()
      const { data } = await (supabase
        .from('crm_citas')
        .select('id, lead_id, fecha, hora, asignado_a, asignado_nombre, estado, notas, crm_leads(id, nombre, apellidos, telefono, modelo_interes, etapa, asignado_nombre)')
        .eq('estado', 'agendada').lte('fecha', today)
        .order('fecha', { ascending: true })
        .order('hora', { ascending: true }) as any)
      const rows: Cita[] = Array.isArray(data) ? data : []
      const hhmm = nowHHMM()
      setBackstop(rows.filter(c => c.fecha < today || (c.fecha === today && !!c.hora && c.hora.slice(0, 5) < hhmm)))
    } catch { /* silent — backstop is best-effort */ }
  }, [])

  // ── House-wide count for TODAY (all asesores, all estados) — the "Citas hoy"
  //    KPI. Independent of week navigation so the card is always today. ──
  const loadToday = useCallback(async () => {
    try {
      const t = todayStr()
      const { data } = await (supabase
        .from('crm_citas')
        .select('id, lead_id, fecha, hora, asignado_a, asignado_nombre, estado, notas, crm_leads(id, nombre, apellidos, telefono, modelo_interes, etapa, asignado_nombre)')
        .eq('fecha', t)
        .order('hora', { ascending: true }) as any)
      setHouseTodayCitas(Array.isArray(data) ? data : [])
    } catch { /* silent */ }
  }, [])

  // Asesores for the filter + editar picker (same source as /crm main page).
  useEffect(() => {
    supabase.from('user_roles').select('user_id, full_name, crm_role')
      .eq('npa_can_view_crm', true).eq('is_active', true)
      .then(({ data }) => setCrmUsers(Array.isArray(data) ? (data as any) : []))
  }, [])

  useEffect(() => { if (meLoaded) { loadWeek(); loadBackstop(); loadToday() } }, [meLoaded, loadWeek, loadBackstop, loadToday])

  // Realtime: any cita change refreshes the house-wide views (pattern from /crm/calendario).
  useEffect(() => {
    const ch = supabase.channel('recepcion_citas')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_citas' }, () => { loadWeek(); loadBackstop(); loadToday() })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [loadWeek, loadBackstop, loadToday])

  // ── Register walk-in (auto-assigned to her) ──
  async function saveWalkin() {
    if (!wi.nombre.trim() || !wi.apellidos.trim() || !wi.telefono.trim()) {
      setErr('Nombre, apellidos y teléfono son obligatorios.'); return
    }
    setWiSaving(true); setErr(null)
    try {
      const { error } = await supabase.from('crm_leads').insert({
        nombre: wi.nombre.trim(), apellidos: wi.apellidos.trim(),
        telefono: wi.telefono.trim(), email: wi.email.trim() || null,
        modelo_interes: wi.modelo || null,
        fuente: wi.fuente || 'walk_in', etapa: 'nuevo', heat_score: 55,
        // Auto-asignado a ella: ambos campos de la MISMA fila user_roles (me),
        // nunca un UUID sin nombre ni un nombre sin UUID.
        asignado_a: me?.user_id || null, asignado_nombre: me?.full_name || null,
        created_by: userId, ultimo_contacto: new Date().toISOString(),
      })
      if (error) throw new Error(error.message)
      setWi({ nombre: '', apellidos: '', telefono: '', email: '', modelo: '', fuente: 'walk_in' })
      setShowWalkin(false)
      await load()
    } catch (e: any) {
      setErr('No se pudo registrar el walk-in: ' + (e?.message || ''))
    } finally { setWiSaving(false) }
  }

  // ── Book a cita (auto-advances lead via DB trigger) ──
  async function saveCita() {
    if (!bookLead) return
    if (!bk.fecha) { setErr('Indica la fecha.'); return }
    setBkSaving(true); setErr(null)
    try {
      const { error } = await supabase.from('crm_citas').insert({
        lead_id: bookLead.id, fecha: bk.fecha, hora: bk.hora || null,
        asignado_a: bookLead.asignado_a || userId || null,
        asignado_nombre: bookLead.asignado_nombre || myName || null,
        estado: 'agendada', notas: bk.notas.trim() || null,
        created_by: userId,
      })
      if (error) throw new Error(error.message)
      setBookLead(null); setBk({ fecha: todayStr(), hora: '10:00', notas: '' })
      await load()
    } catch (e: any) {
      setErr('No se pudo agendar la cita: ' + (e?.message || ''))
    } finally { setBkSaving(false) }
  }

  // ── Mark cita estado (cumplida / no_show) ──
  async function marcarCita(cita: Cita, estado: 'cumplida' | 'no_show') {
    setErr(null)
    try {
      const { error } = await supabase.from('crm_citas').update({ estado }).eq('id', cita.id)
      if (error) throw new Error(error.message)
      // On cumplida, optionally nudge lead to visita_showroom (only forward).
      if (estado === 'cumplida' && cita.crm_leads && cita.crm_leads.etapa === 'cita_agendada') {
        await supabase.from('crm_leads').update({ etapa: 'visita_showroom', ultimo_contacto: new Date().toISOString() }).eq('id', cita.lead_id)
      }
      await load()
    } catch (e: any) {
      setErr('No se pudo actualizar la cita: ' + (e?.message || ''))
    }
  }

  // ── Control-center actions (backstop + agenda semanal). Reloads all views. ──
  // Marking no_show ONLY sets estado='no_show' — the Worker recovery reads the
  // estado, nothing extra needed here. On 'cumplida' we mirror the existing
  // forward-only advance to visita_showroom.
  async function marcarResultado(c: Cita, estado: 'cumplida' | 'no_show') {
    setErr(null)
    try {
      const { error } = await supabase.from('crm_citas').update({ estado }).eq('id', c.id)
      if (error) throw new Error(error.message)
      if (estado === 'cumplida' && c.crm_leads && c.crm_leads.etapa === 'cita_agendada') {
        await supabase.from('crm_leads').update({ etapa: 'visita_showroom', ultimo_contacto: new Date().toISOString() }).eq('id', c.lead_id)
      }
      await Promise.all([load(), loadWeek(), loadBackstop(), loadToday()])
    } catch (e: any) {
      setErr('No se pudo actualizar la cita: ' + (e?.message || ''))
    }
  }

  function openEdit(c: Cita, mode: 'editar' | 'reagendar' | 'cancelar') {
    setEditCita(c); setEdMode(mode); setEdMotivo(''); setErr(null)
    setEd({ fecha: c.fecha, hora: c.hora ? c.hora.slice(0, 5) : '', asignado_a: c.asignado_a || '', notas: c.notas || '' })
  }

  async function saveEdit() {
    if (!editCita) return
    setEdSaving(true); setErr(null)
    try {
      let patch: any
      if (edMode === 'editar') {
        const u = crmUsers.find(x => x.user_id === ed.asignado_a)
        patch = {
          fecha: ed.fecha, hora: ed.hora || null,
          asignado_a: ed.asignado_a || editCita.asignado_a || null,
          asignado_nombre: u ? u.full_name : (editCita.asignado_nombre || null),
          notas: ed.notas.trim() || null,
        }
      } else if (edMode === 'reagendar') {
        if (!ed.fecha) { setErr('Indica la nueva fecha.'); setEdSaving(false); return }
        const prev = `Reprogramada: antes ${fmtFecha(editCita.fecha)}${editCita.hora ? ' ' + fmtHora(editCita.hora) : ''}`
        patch = { fecha: ed.fecha, hora: ed.hora || null, estado: 'agendada', notas: [editCita.notas, prev].filter(Boolean).join(' · ') }
      } else {
        const motivo = edMotivo.trim()
        patch = { estado: 'cancelada', notas: [editCita.notas, motivo ? 'Cancelada: ' + motivo : 'Cancelada'].filter(Boolean).join(' · ') }
      }
      const { error } = await supabase.from('crm_citas').update(patch).eq('id', editCita.id)
      if (error) throw new Error(error.message)
      setEditCita(null)
      await Promise.all([load(), loadWeek(), loadBackstop(), loadToday()])
    } catch (e: any) {
      setErr('No se pudo guardar el cambio: ' + (e?.message || ''))
    } finally { setEdSaving(false) }
  }

  if (permsLoading || !permissions.npa_can_view_crm) {
    return <CrmShell active="recepcion" fluid><div /></CrmShell>
  }

  // Derived lists.
  const today = todayStr()
  const citasHoy = citas.filter(c => c.fecha === today)
  const citaLeadIds = new Set(citas.filter(c => c.estado === 'agendada').map(c => c.lead_id))
  const porAgendar = leads.filter(l =>
    ['nuevo', 'contactado'].includes(l.etapa) && !citaLeadIds.has(l.id))

  // Manage gate: BDC/admin get the edit/reagendar/cancelar/marcar actions.
  const canManage = permissions.npa_can_admin || me?.crm_role === 'bdc'

  // Agenda semanal derived state.
  const weekStart = startOfWeek(weekCursor)
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const weekEnd = addDays(weekStart, 6)
  const weekLabel = `${weekStart.getDate()} ${MES3[weekStart.getMonth()]} – ${weekEnd.getDate()} ${MES3[weekEnd.getMonth()]} ${weekEnd.getFullYear()}`
  // Shared client-side filter (asesor + estado + solo hoy) applied to BOTH the
  // weekly agenda and the backstop strip.
  const matchF = (c: Cita) =>
    (!fAsesor || (c.asignado_nombre || '') === fAsesor) &&
    (!fEstado || (c.estado || 'agendada') === fEstado) &&
    (!soloHoy || c.fecha === today)
  const weekFiltered = weekCitas.filter(matchF)
  const backstopFiltered = backstop.filter(matchF)
  const weekByDay: Record<string, Cita[]> = {}
  for (const c of weekFiltered) (weekByDay[c.fecha] ||= []).push(c)
  // Asesor dropdown built from the asesores present in the LOADED citas.
  const asesorOpts = Array.from(new Set(
    [...weekCitas, ...backstop, ...houseTodayCitas].map(c => c.asignado_nombre || '').filter(Boolean),
  )).sort()
  const chip = (on: boolean) => ({
    fontSize: 12, padding: '6px 14px', borderRadius: 99, cursor: 'pointer',
    background: on ? 'rgba(59,130,246,0.15)' : 'transparent',
    color: on ? 'var(--accent)' : 'var(--text-secondary)',
    border: on ? '1px solid transparent' : '1px solid var(--border)',
  })

  const inp = { width: '100%', padding: '9px 10px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 }
  const lbl = { fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600, display: 'block' as const, marginBottom: 4 }
  const navBtn = { width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 18, lineHeight: 1, cursor: 'pointer' }
  const miniBtn = { padding: '6px 11px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }
  const miniOk = { ...miniBtn, background: 'var(--ok)', color: '#fff', border: 'none' }
  const miniWarn = { ...miniBtn, background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)' }
  const miniGhost = { ...miniBtn, background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)' }
  const miniDanger = { ...miniBtn, background: 'transparent', color: 'var(--danger)', border: '1px solid var(--border)' }

  return (
    <CrmShell active="recepcion" fluid>
      <div style={{ maxWidth: 920, margin: '0 auto', padding: '24px 16px 60px' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 2 }}>Recepción</div>
            <div style={{ fontSize: 26, fontWeight: 600, color: 'var(--text-primary)' }}>Mis citas y walk-ins</div>
            {myName && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{myName}</div>}
          </div>
          <button onClick={() => { setShowWalkin(v => !v); setErr(null) }}
            style={{ padding: '10px 18px', background: showWalkin ? 'transparent' : 'var(--accent)', color: showWalkin ? 'var(--text-secondary)' : '#fff', border: showWalkin ? '1px solid var(--border)' : 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            {showWalkin ? 'Cerrar' : '+ Registrar walk-in'}
          </button>
        </div>

        {err && <div style={{ padding: '10px 14px', background: 'rgba(187,22,43,0.1)', border: '1px solid rgba(187,22,43,0.35)', borderRadius: 8, color: RED, fontSize: 13, marginBottom: 16 }}>{err}</div>}

        {/* HOUSE KPIs — todo el equipo (not just mine) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 14 }}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 8, padding: '14px 16px' }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Citas hoy · equipo</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--accent)' }}>{houseTodayCitas.length}</div>
          </div>
          <div style={{ background: backstop.length ? 'rgba(230,162,60,0.10)' : 'var(--bg-card)', border: `1px solid ${backstop.length ? 'var(--warn)' : 'transparent'}`, borderRadius: 8, padding: '14px 16px' }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Sin resultado</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: backstop.length ? 'var(--warn)' : 'var(--text-primary)' }}>{backstop.length}</div>
          </div>
        </div>

        {/* Walk-in form — opens directly under the summary cards (collapsed by default) */}
        {showWalkin && (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>Registrar walk-in</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 10 }}>
              <div><label style={lbl}>NOMBRE *</label><input ref={nombreRef} style={inp} value={wi.nombre} onChange={e => setWi(p => ({ ...p, nombre: e.target.value }))} /></div>
              <div><label style={lbl}>APELLIDOS *</label><input style={inp} value={wi.apellidos} onChange={e => setWi(p => ({ ...p, apellidos: e.target.value }))} /></div>
              <div><label style={lbl}>TELÉFONO *</label><input style={inp} value={wi.telefono} onChange={e => setWi(p => ({ ...p, telefono: e.target.value }))} placeholder="+58 ..." /></div>
              <div><label style={lbl}>EMAIL</label><input style={inp} value={wi.email} onChange={e => setWi(p => ({ ...p, email: e.target.value }))} placeholder="opcional" /></div>
              <div>
                <label style={lbl}>MODELO DE INTERÉS</label>
                <select style={inp} value={wi.modelo} onChange={e => setWi(p => ({ ...p, modelo: e.target.value }))}>
                  <option value="">Sin definir</option>
                  {MODELOS_KIA.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>FUENTE</label>
                <select style={inp} value={wi.fuente} onChange={e => setWi(p => ({ ...p, fuente: e.target.value }))}>
                  {FUENTES_SELECTABLE.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
              Sin cédula en este punto — se cruza después con el nombre cuando se concreta el negocio. El lead se asigna a ti.
            </div>
            <button onClick={saveWalkin} disabled={wiSaving}
              style={{ padding: '9px 18px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: wiSaving ? 0.6 : 1 }}>
              {wiSaving ? 'Registrando…' : 'Registrar (se asigna a mí)'}
            </button>
          </div>
        )}

        {/* Shared filters — apply to the backstop strip AND the weekly agenda */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 20 }}>
          <select style={{ ...inp, width: 'auto', minWidth: 160 }} value={fAsesor} onChange={e => setFAsesor(e.target.value)}>
            <option value="">Todos los asesores</option>
            {asesorOpts.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          {([['', 'Todas'], ['agendada', 'Agendada'], ['cumplida', 'Asistió'], ['no_show', 'No-show'], ['cancelada', 'Cancelada']] as [string, string][]).map(([k, label]) => (
            <button key={k || 'all'} onClick={() => setFEstado(k)} style={chip(fEstado === k)}>{label}</button>
          ))}
          <button onClick={() => setSoloHoy(v => !v)} style={chip(soloHoy)}>Solo hoy</button>
        </div>

        {/* BACKSTOP — "Citas sin resultado" (BDC cleanup queue) */}
        {canManage && backstop.length > 0 && (
          <div style={{ background: 'rgba(230,162,60,0.10)', border: '1px solid var(--warn)', borderRadius: 12, padding: '14px 16px', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--warn)' }}>Citas sin resultado</span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>· {backstopFiltered.length} pendiente{backstopFiltered.length === 1 ? '' : 's'} de marcar{backstopFiltered.length !== backstop.length ? ` (de ${backstop.length})` : ''}</span>
            </div>
            {backstopFiltered.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Ninguna con este filtro.</div>
            ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {backstopFiltered.map(c => {
                const l = c.crm_leads
                return (
                  <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px' }}>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                      <b>{fmtFecha(c.fecha)} {fmtHora(c.hora)}</b>
                      {' · '}
                      <span onClick={() => l && router.push('/crm?search_lead=' + c.lead_id)} style={{ color: l ? 'var(--accent)' : 'var(--text-primary)', cursor: l ? 'pointer' : 'default', fontWeight: 600 }}>{l ? `${l.nombre} ${l.apellidos}` : 'Lead'}</span>
                      <span style={{ color: 'var(--text-secondary)' }}> · {c.asignado_nombre || '—'}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => marcarResultado(c, 'cumplida')} style={{ padding: '6px 12px', background: 'var(--ok)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>✓ Asistió</button>
                      <button onClick={() => marcarResultado(c, 'no_show')} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>No-show</button>
                    </div>
                  </div>
                )
              })}
            </div>
            )}
          </div>
        )}

        {/* Personal — tus números (house numbers live in the cards up top) */}
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 2, marginTop: 4, marginBottom: 8 }}>
          Personal{myName ? ` · ${myName}` : ''}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {([['hoy', `Citas de hoy (${citasHoy.length})`], ['agendar', `Por agendar (${porAgendar.length})`], ['leads', `Mis leads (${leads.length})`]] as [typeof tab, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{ fontSize: 12, padding: '6px 14px', borderRadius: 99, cursor: 'pointer',
                background: tab === k ? 'rgba(59,130,246,0.15)' : 'transparent',
                color: tab === k ? 'var(--accent)' : 'var(--text-secondary)',
                border: tab === k ? 'none' : '1px solid var(--border)' }}>
              {label}
            </button>
          ))}
        </div>

        {loading && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Cargando…</div>}

        {/* CITAS DE HOY */}
        {!loading && tab === 'hoy' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {citasHoy.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No tienes citas hoy.</div>}
            {citasHoy.map(c => {
              const done = c.estado === 'cumplida' || c.estado === 'no_show'
              const l = c.crm_leads
              return (
                <div key={c.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px', opacity: done ? 0.6 : 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, color: done ? 'var(--text-secondary)' : 'var(--accent)', minWidth: 50 }}>{fmtHora(c.hora)}</div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                          {l ? `${l.nombre} ${l.apellidos}` : 'Lead'}
                          {c.estado === 'cumplida' && <span style={{ fontSize: 11, color: 'var(--ok)', fontWeight: 600 }}> · cumplió</span>}
                          {c.estado === 'no_show' && <span style={{ fontSize: 11, color: RED, fontWeight: 600 }}> · no-show</span>}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                          {l?.modelo_interes || 'Sin modelo'} · {c.asignado_nombre || '—'}{l?.telefono ? ` · ${l.telefono}` : ''}
                        </div>
                      </div>
                    </div>
                    {!done && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => marcarCita(c, 'cumplida')}
                          style={{ padding: '7px 14px', background: 'var(--ok)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>✓ Cumplió</button>
                        <button onClick={() => marcarCita(c, 'no_show')}
                          style={{ padding: '7px 14px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>No-show</button>
                      </div>
                    )}
                  </div>
                  {c.notas && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>{c.notas}</div>}
                </div>
              )
            })}
            {/* Upcoming (after today) */}
            {citas.filter(c => c.fecha > today).length > 0 && (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, marginTop: 14, marginBottom: 4 }}>Próximas</div>
                {citas.filter(c => c.fecha > today).map(c => {
                  const l = c.crm_leads
                  return (
                    <div key={c.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>
                          <b>{fmtFecha(c.fecha)} {fmtHora(c.hora)}</b> · {l ? `${l.nombre} ${l.apellidos}` : 'Lead'}
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}> · {l?.modelo_interes || 'Sin modelo'}</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        )}

        {/* POR AGENDAR */}
        {!loading && tab === 'agendar' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {porAgendar.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No tienes leads por agendar.</div>}
            {porAgendar.map(l => (
              <div key={l.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{l.nombre} {l.apellidos}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {l.modelo_interes || 'Sin modelo'} · {ETAPA_LABELS[l.etapa] || l.etapa}{l.telefono ? ` · ${l.telefono}` : ''}
                    </div>
                  </div>
                  <button onClick={() => { setBookLead(l); setBk({ fecha: todayStr(), hora: '10:00', notas: '' }); setErr(null) }}
                    style={{ padding: '7px 14px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                    📅 Agendar cita
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* MIS LEADS */}
        {!loading && tab === 'leads' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {leads.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No tienes leads asignados.</div>}
            {leads.map(l => (
              <div key={l.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{l.nombre} {l.apellidos}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {l.modelo_interes || 'Sin modelo'} · {ETAPA_LABELS[l.etapa] || l.etapa}{l.telefono ? ` · ${l.telefono}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {!citaLeadIds.has(l.id) && ['nuevo', 'contactado'].includes(l.etapa) && (
                      <button onClick={() => { setBookLead(l); setBk({ fecha: todayStr(), hora: '10:00', notas: '' }); setErr(null) }}
                        style={{ padding: '6px 12px', background: 'transparent', color: 'var(--accent)', border: '1px solid rgba(59,130,246,0.5)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                        Agendar
                      </button>
                    )}
                    <button onClick={() => router.push('/crm?search_lead=' + l.id)}
                      style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                      Ver
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* AGENDA SEMANAL — house-wide, all asesores */}
        <div style={{ marginTop: 32, borderTop: '1px solid var(--border)', paddingTop: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 2 }}>Agenda semanal · equipo</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{weekLabel}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button onClick={() => setWeekCursor(addDays(startOfWeek(weekCursor), -7))} style={navBtn} aria-label="Semana anterior">‹</button>
              <button onClick={() => setWeekCursor(new Date())} style={{ ...navBtn, width: 'auto', padding: '0 12px', fontSize: 13, fontWeight: 600 }}>Hoy</button>
              <button onClick={() => setWeekCursor(addDays(startOfWeek(weekCursor), 7))} style={navBtn} aria-label="Semana siguiente">›</button>
            </div>
          </div>

          {(fAsesor || fEstado || soloHoy) && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 12 }}>
              Filtros activos{fAsesor ? ` · ${fAsesor}` : ''}{fEstado ? ` · ${ESTADO_LABEL[fEstado]}` : ''}{soloHoy ? ' · solo hoy' : ''} — se ajustan arriba.
            </div>
          )}

          {weekLoading ? <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Cargando agenda…</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {weekDays.map(d => {
                const key = ymd(d)
                const dayCitas = weekByDay[key] || []
                const isToday = key === today
                return (
                  <div key={key}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: isToday ? 'var(--accent)' : 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 1 }}>{DOW[(d.getDay() + 6) % 7]} {d.getDate()}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{dayCitas.length ? `${dayCitas.length} cita${dayCitas.length === 1 ? '' : 's'}` : 'sin citas'}</span>
                    </div>
                    {dayCitas.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {dayCitas.map(c => {
                          const l = c.crm_leads
                          const done = c.estado === 'cumplida' || c.estado === 'no_show' || c.estado === 'cancelada'
                          return (
                            <div key={c.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', opacity: c.estado === 'cancelada' ? 0.55 : 1 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                  <div style={{ fontSize: 14, fontWeight: 700, color: done ? 'var(--text-secondary)' : 'var(--accent)', minWidth: 46 }}>{fmtHora(c.hora)}</div>
                                  <div>
                                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                                      <span onClick={() => l && router.push('/crm?search_lead=' + c.lead_id)} style={{ cursor: l ? 'pointer' : 'default' }}>{l ? `${l.nombre} ${l.apellidos}` : 'Lead'}</span>
                                      <span style={{ fontSize: 11, fontWeight: 700, color: estadoColor(c.estado), marginLeft: 8 }}>{ESTADO_LABEL[c.estado || 'agendada'] || c.estado}</span>
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{l?.modelo_interes || 'Sin modelo'} · {c.asignado_nombre || '—'}</div>
                                  </div>
                                </div>
                                {canManage && (
                                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                    {c.estado === 'agendada' && (
                                      <>
                                        <button onClick={() => marcarResultado(c, 'cumplida')} style={miniOk}>✓ Asistió</button>
                                        <button onClick={() => marcarResultado(c, 'no_show')} style={miniWarn}>No-show</button>
                                      </>
                                    )}
                                    <button onClick={() => openEdit(c, 'editar')} style={miniGhost}>Editar</button>
                                    <button onClick={() => openEdit(c, 'reagendar')} style={miniGhost}>Reagendar</button>
                                    {c.estado !== 'cancelada' && <button onClick={() => openEdit(c, 'cancelar')} style={miniDanger}>Cancelar</button>}
                                  </div>
                                )}
                              </div>
                              {c.notas && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>{c.notas}</div>}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Editar / reagendar / cancelar modal */}
        {editCita && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}>
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 22, maxWidth: 420, width: '100%' }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                {edMode === 'editar' ? 'Editar cita' : edMode === 'reagendar' ? 'Reagendar cita' : 'Cancelar cita'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
                {editCita.crm_leads ? `${editCita.crm_leads.nombre} ${editCita.crm_leads.apellidos}` : 'Lead'} · {fmtFecha(editCita.fecha)} {fmtHora(editCita.hora)}
              </div>

              {edMode === 'cancelar' ? (
                <div style={{ marginBottom: 16 }}>
                  <label style={lbl}>MOTIVO</label>
                  <input style={inp} value={edMotivo} onChange={e => setEdMotivo(e.target.value)} placeholder="Motivo de la cancelación" />
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>Se marca la cita como cancelada y el motivo queda en las notas.</div>
                </div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
                    <div><label style={lbl}>FECHA</label><input type="date" style={inp} value={ed.fecha} onChange={e => setEd(p => ({ ...p, fecha: e.target.value }))} /></div>
                    <div><label style={lbl}>HORA</label><input type="time" style={inp} value={ed.hora} onChange={e => setEd(p => ({ ...p, hora: e.target.value }))} /></div>
                  </div>
                  {edMode === 'editar' && (
                    <>
                      <div style={{ marginBottom: 12 }}>
                        <label style={lbl}>ASESOR</label>
                        <select style={inp} value={ed.asignado_a} onChange={e => setEd(p => ({ ...p, asignado_a: e.target.value }))}>
                          <option value="">{editCita.asignado_nombre || 'Sin asignar'}</option>
                          {crmUsers.map(u => <option key={u.user_id} value={u.user_id}>{u.full_name}</option>)}
                        </select>
                      </div>
                      <div style={{ marginBottom: 16 }}>
                        <label style={lbl}>NOTAS</label>
                        <input style={inp} value={ed.notas} onChange={e => setEd(p => ({ ...p, notas: e.target.value }))} placeholder="opcional" />
                      </div>
                    </>
                  )}
                  {edMode === 'reagendar' && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 16 }}>La fecha y hora anteriores quedan registradas en las notas.</div>}
                </>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setEditCita(null)} style={{ flex: 1, padding: '10px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cerrar</button>
                <button onClick={saveEdit} disabled={edSaving} style={{ flex: 1, padding: '10px', background: edMode === 'cancelar' ? 'var(--danger)' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: edSaving ? 0.6 : 1 }}>
                  {edSaving ? 'Guardando…' : edMode === 'editar' ? 'Guardar' : edMode === 'reagendar' ? 'Reagendar' : 'Confirmar cancelación'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Cita booking modal */}
        {bookLead && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}>
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 22, maxWidth: 420, width: '100%' }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>Agendar cita</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
                {bookLead.nombre} {bookLead.apellidos} · {bookLead.modelo_interes || 'Sin modelo'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
                <div><label style={lbl}>FECHA</label><input type="date" style={inp} value={bk.fecha} onChange={e => setBk(p => ({ ...p, fecha: e.target.value }))} /></div>
                <div><label style={lbl}>HORA</label><input type="time" style={inp} value={bk.hora} onChange={e => setBk(p => ({ ...p, hora: e.target.value }))} /></div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={lbl}>NOTAS</label>
                <input style={inp} value={bk.notas} onChange={e => setBk(p => ({ ...p, notas: e.target.value }))} placeholder="opcional" />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setBookLead(null)}
                  style={{ flex: 1, padding: '10px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancelar</button>
                <button onClick={saveCita} disabled={bkSaving}
                  style={{ flex: 1, padding: '10px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: bkSaving ? 0.6 : 1 }}>
                  {bkSaving ? 'Agendando…' : 'Confirmar cita'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </CrmShell>
  )
}