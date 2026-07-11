// TARGET: autocore-npa/app/crm/pulso/page.tsx
'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useNPAPermissions } from '../../components/useNPAPermissions'
import { fuenteLabel } from '../fuentes'

// ── Opportunity category palette ──────────────────────────────────────
const CAT = {
  hot_a: { label: 'HOT A', color: '#15A06E', bg: 'rgba(21,160,110,0.10)' },
  hot_b: { label: 'HOT B', color: '#E0A23C', bg: 'rgba(224,162,60,0.10)' },
  hot_c: { label: 'HOT C', color: '#4C82F7', bg: 'rgba(76,130,247,0.10)' },
  warm:  { label: 'WARM',  color: '#8A93A0', bg: 'rgba(138,147,160,0.10)' },
  sc:    { label: 'S/C',   color: '#E5689A', bg: 'rgba(229,104,154,0.10)' },
} as const


// ── data shape from crm_pulse_stats() ─────────────────────────────────
interface Pulse {
  hoy?: { leads_in: number; contactados_de_hoy: number; sin_contactar_de_hoy: number; contactados_hoy_total: number }
  sin_gestionar?: { total: number; mas_viejo_min: number; buckets?: { menos_1h: number; entre_1_4h: number; entre_4_24h: number; entre_1_3d: number; mas_3d: number } }
  velocidad?: { contactados: number; avg_min: number | null; mediana_min: number | null; sla_30m: number; sla_1h: number; sla_4h: number; sla_mas: number }
  solidez?: { contactados: number; efectivos: number; ai_close_avg: number | null; por_fuente?: { fuente: string; total: number; contactados: number; efectivos: number; hot: number }[] }
  categoria?: { hot_a: number; hot_b: number; hot_c: number; warm: number; sc: number; total: number; por_modelo?: { modelo: string; hot_a: number; hot_b: number; hot_c: number; warm: number; sc: number; total: number }[] }
  forecast?: { retail_mes: number; hot_a: number; hot_b: number; frcst: number }
}

interface DrillLead {
  id: string; nombre: string; apellidos: string; telefono: string
  modelo_interes: string | null; fuente: string | null; asignado_nombre: string | null
  etapa: string; ai_close_prob: number | null; edad_min: number; resp_min: number | null
}

interface AsesorRow {
  asesor: string; asesor_id: string | null
  asignados: number; sin_atender: number; contactados: number; mas_viejo_min: number
}

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([Promise.resolve(p), new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
}

const todayISO = () => new Date().toISOString().slice(0, 10)
const daysAgoISO = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
const monthStartISO = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10) }
const caracasYMD = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' })

const PERIODOS = [
  { key: 'hoy', label: 'Hoy', from: caracasYMD },
  { key: '7d',  label: '7d',  from: () => daysAgoISO(7) },
  { key: '30d', label: '30d', from: () => daysAgoISO(30) },
  { key: 'mes', label: 'Mes', from: monthStartISO },
]

const pct = (a: number, b: number) => b > 0 ? Math.round(100 * a / b) : 0
const waPhone = (t: string) => (t || '').replace(/\D/g, '')
const fLabel = (k?: string | null) => fuenteLabel(k)
const tidyModelo = (m?: string | null) => (m || 'Sin modelo')
const fmtAge = (min: number) => {
  const m = Math.round(min || 0)
  if (m < 60) return m + ' min'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h'
  const d = Math.floor(h / 24); const rh = h % 24
  return rh > 0 ? d + 'd ' + rh + 'h' : d + 'd'
}

type Seg = { key: string; label: string; value: number; color: string }

// ── Velocidad y SLA: qué tan rápido se contacta un lead y quién va lento ──
// Pega esta función en app/crm/pulso/page.tsx (nivel superior) y renderiza
// <VelocidadSLA /> donde quieras la sección. Mide los últimos 30 días.
function VelocidadSLA() {
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    supabase.rpc('crm_velocity_stats', {}).then(({ data, error }: any) => {
      if (!alive) return
      if (error) setErr(error.message); else setD(data)
    })
    return () => { alive = false }
  }, [])

  const fmtMin = (m: number) => {
    m = Math.round(m || 0)
    if (m <= 0) return '—'
    if (m < 60) return m + ' min'
    if (m < 1440) { const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${r} m` : `${h} h` }
    const dd = Math.floor(m / 1440), h = Math.round((m % 1440) / 60); return h ? `${dd} d ${h} h` : `${dd} d`
  }

  const card = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 18px 8px', marginTop: 18 }
  const th = { padding: '8px 10px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.04em', whiteSpace: 'nowrap' as const, borderBottom: '1px solid var(--border)', textAlign: 'center' as const }
  const td = { padding: '9px 10px', fontSize: 13, textAlign: 'center' as const, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' as const }

  const SLA = [
    { k: 'm15', label: '≤ 15 min', color: '#15A06E' },
    { k: 'h1', label: '15 m – 1 h', color: '#5BA84F' },
    { k: 'h4', label: '1 – 4 h', color: '#E0A23C' },
    { k: 'h24', label: '4 – 24 h', color: '#E5803C' },
    { k: 'mas24', label: '> 24 h', color: 'var(--brand-primary)' },
    { k: 'sin', label: 'Sin contactar', color: '#8a93a0' },
  ]

  return (
    <section style={card}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Velocidad</div>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '2px 0 4px', color: 'var(--text-primary)' }}>Tiempo de respuesta y SLA</h2>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>Últimos 30 días · tiempo desde que entra el lead hasta el primer contacto</div>
      {err && <div style={{ fontSize: 13, color: 'var(--danger)', paddingBottom: 12 }}>{err}</div>}
      {!d && !err && <div style={{ fontSize: 13, color: 'var(--text-muted)', paddingBottom: 12 }}>Cargando…</div>}
      {d && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
            <div style={{ flex: '1 1 150px', background: 'var(--bg-page)', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Mediana a 1er contacto</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)' }}>{fmtMin(d.ttc_mediana_min)}</div>
            </div>
            <div style={{ flex: '1 1 150px', background: 'var(--bg-page)', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Contactados</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)' }}>{d.pct_contactados}%</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{d.contactados} de {d.total}</div>
            </div>
            <div style={{ flex: '1 1 150px', background: (d.overdue_abiertos > 0 ? 'rgba(30,79,163,0.08)' : 'var(--bg-page)'), borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Vencidos ahora (&gt;1 h sin contactar)</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: d.overdue_abiertos > 0 ? 'var(--brand-primary)' : 'var(--text-primary)' }}>{d.overdue_abiertos}</div>
            </div>
          </div>

          {d.total > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', border: '1px solid var(--border)' }}>
                {SLA.map(s => { const n = (d.sla?.[s.k] || 0); const pct = d.total ? (100 * n / d.total) : 0; return pct > 0 ? <div key={s.k} title={`${s.label}: ${n}`} style={{ width: pct + '%', background: s.color }} /> : null })}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 8 }}>
                {SLA.map(s => <span key={s.k} style={{ fontSize: 12, color: 'var(--text-secondary)' }}><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: s.color, marginRight: 5 }} />{s.label}: <b>{d.sla?.[s.k] || 0}</b></span>)}
              </div>
            </div>
          )}

          {Array.isArray(d.por_asesor) && d.por_asesor.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left' as const }}>Responsable</th>
                    <th style={th}>Leads</th>
                    <th style={th}>Contactados</th>
                    <th style={th}>Resp. mediana</th>
                    <th style={th}>Dentro 1 h</th>
                    <th style={th}>Pendientes</th>
                  </tr>
                </thead>
                <tbody>
                  {d.por_asesor.map((a: any, i: number) => {
                    const slow = a.resp_mediana_min > 60 && a.contactados > 0
                    const unassigned = !a.asesor_id
                    return (
                      <tr key={i} style={{ background: unassigned ? 'rgba(229,104,154,0.06)' : 'transparent' }}>
                        <td style={{ ...td, textAlign: 'left' as const, fontWeight: 600, color: unassigned ? '#E5689A' : 'var(--text-primary)' }}>{a.asesor}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{a.leads}</td>
                        <td style={td}>{a.contactados} <span style={{ color: 'var(--text-muted)' }}>({a.pct}%)</span></td>
                        <td style={{ ...td, fontWeight: 600, color: slow ? 'var(--brand-primary)' : 'var(--text-primary)' }}>{fmtMin(a.resp_mediana_min)}</td>
                        <td style={td}>{a.dentro_1h}</td>
                        <td style={td}><span style={{ color: a.pendientes > 0 ? '#E0A23C' : 'var(--text-muted)', fontWeight: a.pendientes > 0 ? 700 : 400 }}>{a.pendientes}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

// ── Leads por responsable: total, contactados / sin contactar, y por etapa ──
// Pega esta función en app/crm/pulso/page.tsx (nivel superior, p. ej. justo
// antes de "const s = {...}") y renderiza <AsesorEtapas /> donde quieras la tabla.
function AsesorEtapas() {
  const [rows, setRows] = useState<any[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    supabase.rpc('crm_pulse_asesor_etapas').then(({ data, error }: any) => {
      if (!alive) return
      if (error) setErr(error.message)
      else setRows(Array.isArray(data) ? data : [])
    })
    return () => { alive = false }
  }, [])

  const STAGES = [
    { k: 'nuevo', label: 'Nuevo' },
    { k: 'contactado', label: 'Contactado' },
    { k: 'cita_agendada', label: 'Cita' },
    { k: 'visita_showroom', label: 'Showroom' },
    { k: 'oferta_presentada', label: 'Oferta' },
    { k: 'financiamiento', label: 'Financ.' },
    { k: 'cerrado_ganado', label: 'Vendido' },
    { k: 'cerrado_perdido', label: 'Perdido' },
  ]

  const th = { padding: '8px 10px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.04em', whiteSpace: 'nowrap' as const, borderBottom: '1px solid var(--border)', textAlign: 'center' as const }
  const td = { padding: '9px 10px', fontSize: 13, textAlign: 'center' as const, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' as const }

  const totals: any = (rows || []).reduce((a: any, r: any) => {
    a.total += r.total || 0; a.contactados += r.contactados || 0; a.sin_contactar += r.sin_contactar || 0
    STAGES.forEach(s => { a[s.k] = (a[s.k] || 0) + (r[s.k] || 0) })
    return a
  }, { total: 0, contactados: 0, sin_contactar: 0 })

  return (
    <section style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 18px 6px', marginTop: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Responsables</div>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '2px 0 14px', color: 'var(--text-primary)' }}>Leads por responsable</h2>
      {err && <div style={{ fontSize: 13, color: 'var(--danger)', paddingBottom: 12 }}>{err}</div>}
      {!rows && !err && <div style={{ fontSize: 13, color: 'var(--text-muted)', paddingBottom: 12 }}>Cargando…</div>}
      {rows && rows.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)', paddingBottom: 12 }}>Sin leads.</div>}
      {rows && rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' as const }}>Responsable</th>
                <th style={th}>Total</th>
                <th style={{ ...th, color: '#15A06E' }}>Contactados</th>
                <th style={{ ...th, color: '#E0A23C' }}>Sin contactar</th>
                {STAGES.map(s => <th key={s.k} style={th}>{s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any, i: number) => {
                const unassigned = !r.asesor_id
                return (
                  <tr key={i} style={{ background: unassigned ? 'rgba(229,104,154,0.06)' : 'transparent' }}>
                    <td style={{ ...td, textAlign: 'left' as const, fontWeight: 600, color: unassigned ? '#E5689A' : 'var(--text-primary)' }}>{r.asesor}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{r.total || 0}</td>
                    <td style={td}><span style={{ color: (r.contactados || 0) > 0 ? '#15A06E' : 'var(--text-muted)', fontWeight: (r.contactados || 0) > 0 ? 600 : 400 }}>{r.contactados || 0}</span></td>
                    <td style={td}><span style={{ color: (r.sin_contactar || 0) > 0 ? '#E0A23C' : 'var(--text-muted)', fontWeight: (r.sin_contactar || 0) > 0 ? 700 : 400 }}>{r.sin_contactar || 0}</span></td>
                    {STAGES.map(s => <td key={s.k} style={td}><span style={{ color: (r[s.k] || 0) > 0 ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: (r[s.k] || 0) > 0 ? 600 : 400 }}>{r[s.k] || 0}</span></td>)}
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: 'var(--bg-page)' }}>
                <td style={{ ...td, textAlign: 'left' as const, fontWeight: 700 }}>Total</td>
                <td style={{ ...td, fontWeight: 700 }}>{totals.total}</td>
                <td style={{ ...td, fontWeight: 700, color: '#15A06E' }}>{totals.contactados}</td>
                <td style={{ ...td, fontWeight: 700, color: '#E0A23C' }}>{totals.sin_contactar}</td>
                {STAGES.map(s => <td key={s.k} style={{ ...td, fontWeight: 700 }}>{totals[s.k] || 0}</td>)}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}

export default function CrmPulsoPage() {
  const { permissions, loading: permsLoading } = useNPAPermissions()
  const [from, setFrom] = useState(monthStartISO())
  const [until, setUntil] = useState(todayISO())
  const [data, setData] = useState<Pulse | null>(null)
  const [asesores, setAsesores] = useState<AsesorRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [drill, setDrill] = useState<{ title: string; loading: boolean; rows: DrillLead[]; metric: 'edad' | 'resp' | 'ai'; error?: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [statsR, asesR] = await Promise.all([
        supabase.rpc('crm_pulse_stats', { p_from: from, p_until: until }),
        supabase.rpc('crm_pulse_asesores'),
      ])
      if (statsR.error) throw new Error(statsR.error.message)
      setData((statsR.data || {}) as Pulse)
      setAsesores((asesR.data || []) as AsesorRow[])
    } catch (e: any) {
      setErr(e?.message || 'No se pudieron cargar los indicadores.')
    } finally { setLoading(false) }
  }, [from, until])

  useEffect(() => { if (!permsLoading && permissions.npa_can_view_crm) load() }, [permsLoading, permissions.npa_can_view_crm, load])
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrill(null) }
    window.addEventListener('keydown', onEsc); return () => window.removeEventListener('keydown', onEsc)
  }, [])

  // ── drill: fetch the leads behind a clicked segment / tile via RPC ──
  // Uses crm_pulse_drill (security definer) so it bypasses RLS and can't hang.
  async function openDrill(kind: string, title: string) {
    const metric: 'edad' | 'resp' | 'ai' = kind.startsWith('vel_') ? 'resp' : (kind.startsWith('cat_') || kind.startsWith('sol_') || kind === 'hoy_contact') ? 'ai' : 'edad'
    setDrill({ title, loading: true, rows: [], metric })
    try {
      const { data: rows, error } = await withTimeout(
        supabase.rpc('crm_pulse_drill', { p_kind: kind, p_from: from, p_until: until }), 9000
      )
      if (error) throw error
      const arr = (rows || []) as DrillLead[]
      setDrill({ title: title + ' · ' + arr.length, loading: false, rows: arr, metric })
    } catch (e: any) {
      setDrill({ title, loading: false, rows: [], metric, error: 'No se pudieron cargar los leads. ' + (e?.message === 'timeout' ? '(tardó demasiado)' : '') })
    }
  }

  async function openDrillAsesor(asesorId: string | null, name: string) {
    setDrill({ title: 'Sin atender · ' + name, loading: true, rows: [], metric: 'edad' })
    try {
      const { data: rows, error } = await withTimeout(supabase.rpc('crm_pulse_drill_asesor', { p_asesor_id: asesorId }), 9000)
      if (error) throw error
      const arr = (rows || []) as DrillLead[]
      setDrill({ title: 'Sin atender · ' + name + ' · ' + arr.length, loading: false, rows: arr, metric: 'edad' })
    } catch (e: any) {
      setDrill({ title: 'Sin atender · ' + name, loading: false, rows: [], metric: 'edad', error: 'No se pudieron cargar los leads.' })
    }
  }

  if (permsLoading) return <Shell><div style={s.muted}>Cargando…</div></Shell>
  if (!permissions.npa_can_view_crm) return <Shell><div style={s.muted}>No tienes acceso al CRM.</div></Shell>

  const hoy = data?.hoy, sg = data?.sin_gestionar, vel = data?.velocidad, sol = data?.solidez, cat = data?.categoria, fc = data?.forecast
  const bk = sg?.buckets
  const sgLt4 = bk ? bk.menos_1h + bk.entre_1_4h : 0
  const sg424 = bk ? bk.entre_4_24h : 0
  const sgGt24 = bk ? bk.entre_1_3d + bk.mas_3d : 0

  const donutHoy: Seg[] = hoy ? [
    { key: 'hoy_contact', label: 'Contactados', value: hoy.contactados_de_hoy, color: '#15A06E' },
    { key: 'hoy_pend',    label: 'Sin contactar', value: Math.max(0, hoy.leads_in - hoy.contactados_de_hoy), color: '#B7BDC6' },
  ] : []
  const donutSg: Seg[] = sg ? [
    { key: 'sg_lt4',   label: '< 4h',   value: sgLt4,  color: '#E0A23C' },
    { key: 'sg_4_24',  label: '4–24h',  value: sg424,  color: '#E8884E' },
    { key: 'sg_gt24',  label: '+24h',   value: sgGt24, color: '#E5556A' },
  ] : []
  const donutVel: Seg[] = vel ? [
    { key: 'vel_30',   label: '< 30 min', value: vel.sla_30m, color: '#15A06E' },
    { key: 'vel_60',   label: '30–60 min', value: vel.sla_1h, color: '#E0A23C' },
    { key: 'vel_240',  label: '1–4 h',    value: vel.sla_4h, color: '#4C82F7' },
    { key: 'vel_more', label: '+4 h',     value: vel.sla_mas, color: '#E5556A' },
  ] : []
  const donutSol: Seg[] = sol ? [
    { key: 'sol_efectivos', label: 'Efectivos', value: sol.efectivos, color: '#9B7DF0' },
    { key: 'sol_resto',     label: 'Sin avanzar', value: Math.max(0, sol.contactados - sol.efectivos), color: '#B7BDC6' },
  ] : []

  return (
    <Shell>
      <div style={s.headRow}>
        <div>
          <div style={s.eyebrow}>CRM · Operativo</div>
          <h1 style={s.title}>Pulso CRM</h1>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {PERIODOS.map(p => {
            const pf = p.from(); const isOn = from === pf && until === todayISO()
            return <button key={p.key} onClick={() => { setFrom(pf); setUntil(todayISO()) }} style={{ ...s.chip, ...(isOn ? s.chipOn : {}) }}>{p.label}</button>
          })}
          <input type="date" value={from} max={until} onChange={e => setFrom(e.target.value)} style={s.dateInput} />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>→</span>
          <input type="date" value={until} min={from} max={todayISO()} onChange={e => setUntil(e.target.value)} style={s.dateInput} />
          <button style={s.btnGhost} onClick={load} disabled={loading}>{loading ? '…' : '↻'}</button>
        </div>
      </div>

      {err && <div style={s.error}>{err}</div>}
      {loading && !data && <div style={s.muted}>Cargando indicadores…</div>}

      {/* ── CAKE CHARTS (clickable) ─────────────────────────── */}
      {data && (
        <div style={s.donutRow}>
          <DonutCard title="Leads hoy"   segments={donutHoy} center={(hoy?.leads_in ?? 0).toString()} sub="leads" onPick={openDrill} />
          <DonutCard title="Sin gestionar" segments={donutSg} center={(sg?.total ?? 0).toString()} sub="pendientes" onPick={openDrill} accent={(sg?.total ?? 0) > 0 ? '#E5556A' : undefined} />
          <DonutCard title="Velocidad"   segments={donutVel} center={(vel?.mediana_min ?? 0).toString()} sub="min · mediana" onPick={openDrill} />
          <DonutCard title="Solidez"     segments={donutSol} center={(sol?.efectivos ?? 0).toString()} sub={pct(sol?.efectivos ?? 0, sol?.contactados ?? 0) + '% efectivos'} onPick={openDrill} accent="#9B7DF0" />
        </div>
      )}

      {/* ── ATENCIÓN POR ASESOR (accountability monitor) ─────── */}
      {asesores.length > 0 && (
        <section style={s.card}>
          <div style={s.cardTitle}>Atención por asesor <span style={s.cardSub}>leads asignados sin primer contacto · toca un asesor para ver cuáles</span></div>
          <div style={s.mHead}>
            <span style={{ flex: 2 }}>Asesor</span>
            <span style={{ flex: 1, textAlign: 'right' }}>Asignados</span>
            <span style={{ flex: 1, textAlign: 'right' }}>Sin atender</span>
            <span style={{ flex: 1, textAlign: 'right' }}>Más viejo</span>
          </div>
          {asesores.map(a => (
            <button key={a.asesor_id || a.asesor} onClick={() => a.sin_atender > 0 && openDrillAsesor(a.asesor_id, a.asesor)} disabled={a.sin_atender === 0} style={{ ...s.mRowBtn, cursor: a.sin_atender > 0 ? 'pointer' : 'default' }}>
              <span style={{ flex: 2, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'left' }}>{a.asesor}</span>
              <span style={{ flex: 1, textAlign: 'right' }}>{a.asignados}</span>
              <span style={{ flex: 1, textAlign: 'right', fontWeight: 700, color: a.sin_atender > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>{a.sin_atender}</span>
              <span style={{ flex: 1, textAlign: 'right', color: a.mas_viejo_min >= 1440 ? 'var(--danger)' : a.mas_viejo_min >= 240 ? 'var(--warn)' : 'var(--text-secondary)' }}>{a.sin_atender > 0 ? fmtAge(a.mas_viejo_min) : '—'}</span>
            </button>
          ))}
        </section>
      )}

      {/* ── CATEGORÍA (compact) + FORECAST beside ────────────── */}
      {cat && (
        <section style={s.card}>
          <div style={s.cardTitle}>Categoría — oportunidades abiertas <span style={s.titleNum}>{cat.total}</span></div>
          <div style={s.catRow}>
            <div style={s.catTiles}>
              {(['hot_a', 'hot_b', 'hot_c', 'warm', 'sc'] as const).map(k => (
                <button key={k} onClick={() => openDrill('cat_' + CAT[k].label.replace(' ', '_').replace('/', ''), CAT[k].label)} style={{ ...s.catTile, background: CAT[k].bg }} aria-label={CAT[k].label + ': ' + cat[k] + ' leads'}>
                  <div style={{ ...s.catNum, color: CAT[k].color }}>{cat[k]}</div>
                  <div style={{ ...s.catLabel, color: CAT[k].color }}>{CAT[k].label}</div>
                </button>
              ))}
            </div>
            {fc && (
              <div style={s.fcBox}>
                <div style={s.fcLabel}>Forecast mes</div>
                <div style={s.fcLine}>Retail <b style={s.fcB}>{fc.retail_mes}</b> + A <b style={{ color: CAT.hot_a.color }}>{fc.hot_a}</b> + B <b style={{ color: CAT.hot_b.color }}>{fc.hot_b}</b></div>
                <div style={s.fcTotal}>{fc.frcst}</div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── OPORTUNIDADES x MODELO (minimal) ─────────────────── */}
      {cat && (cat.por_modelo?.length ?? 0) > 0 && (
        <section style={s.card}>
          <div style={s.cardTitle}>Oportunidades abiertas x modelo</div>
          <div style={s.mHead}>
            <span style={{ flex: 2 }}>Modelo</span>
            {(['hot_a', 'hot_b', 'hot_c', 'warm', 'sc'] as const).map(k => <span key={k} style={{ flex: 1, textAlign: 'right', color: CAT[k].color }}>{CAT[k].label}</span>)}
            <span style={{ flex: 1, textAlign: 'right' }}>Total</span>
          </div>
          {cat.por_modelo!.map(m => (
            <div key={m.modelo} style={s.mRow}>
              <span style={{ flex: 2, fontWeight: 600, color: 'var(--text-primary)' }}>{tidyModelo(m.modelo)}</span>
              {(['hot_a', 'hot_b', 'hot_c', 'warm', 'sc'] as const).map(k => (
                <span key={k} style={{ flex: 1, textAlign: 'right', color: m[k] > 0 ? CAT[k].color : 'var(--text-muted)', fontWeight: m[k] > 0 ? 700 : 400 }}>{m[k] || ''}</span>
              ))}
              <span style={{ flex: 1, textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)' }}>{m.total}</span>
            </div>
          ))}
        </section>
      )}

      {/* ── SOLIDEZ x FUENTE (minimal) ───────────────────────── */}
      {sol && (sol.por_fuente?.length ?? 0) > 0 && (
        <section style={s.card}>
          <div style={s.cardTitle}>Solidez por fuente <span style={s.cardSub}>cierre IA prom {sol.ai_close_avg ?? '—'}</span></div>
          <div style={s.mHead}>
            <span style={{ flex: 2 }}>Fuente</span>
            <span style={{ flex: 1, textAlign: 'right' }}>Total</span>
            <span style={{ flex: 1, textAlign: 'right' }}>Contact.</span>
            <span style={{ flex: 1.3, textAlign: 'right' }}>Efectivos</span>
            <span style={{ flex: 1, textAlign: 'right' }}>HOT</span>
          </div>
          {sol.por_fuente!.map(f => (
            <div key={f.fuente} style={s.mRow}>
              <span style={{ flex: 2, fontWeight: 600, color: 'var(--text-primary)' }}>{fLabel(f.fuente)}</span>
              <span style={{ flex: 1, textAlign: 'right' }}>{f.total}</span>
              <span style={{ flex: 1, textAlign: 'right' }}>{f.contactados}</span>
              <span style={{ flex: 1.3, textAlign: 'right', color: pct(f.efectivos, f.contactados) >= 25 ? 'var(--ok)' : 'var(--text-secondary)', fontWeight: 700 }}>{f.efectivos} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· {pct(f.efectivos, f.contactados)}%</span></span>
              <span style={{ flex: 1, textAlign: 'right', color: f.hot > 0 ? CAT.hot_a.color : 'var(--text-muted)', fontWeight: 700 }}>{f.hot}</span>
            </div>
          ))}
        </section>
      )}

      {drill && <DrillModal drill={drill} onClose={() => setDrill(null)} />}
    </Shell>
  )
}

// ── Donut (cake) chart, clickable segments + accessible legend ────────
function DonutCard({ title, segments, center, sub, onPick, accent }: { title: string; segments: Seg[]; center: string; sub: string; onPick: (kind: string, label: string) => void; accent?: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0)
  const R = 46, SW = 15, C = 2 * Math.PI * R, cx = 60, cy = 60
  let acc = 0
  return (
    <div style={s.donutCard}>
      <div style={s.donutTitle}>{title}</div>
      <div style={{ position: 'relative', width: 120, height: 120, margin: '6px auto 4px' }}>
        <svg viewBox="0 0 120 120" width={120} height={120} role="img" aria-label={title + ': ' + segments.map(x => x.label + ' ' + x.value).join(', ')}>
          <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--bg-deep)" strokeWidth={SW} />
          {total > 0 && segments.map(seg => {
            const len = (seg.value / total) * C
            const el = (
              <circle key={seg.key} cx={cx} cy={cy} r={R} fill="none" stroke={seg.color} strokeWidth={SW}
                strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} transform={`rotate(-90 ${cx} ${cy})`}
                style={{ cursor: seg.value > 0 ? 'pointer' : 'default' }}
                onClick={() => seg.value > 0 && onPick(seg.key, title + ' · ' + seg.label)}>
                <title>{seg.label}: {seg.value}</title>
              </circle>
            )
            acc += len
            return el
          })}
        </svg>
        <div style={s.donutCenter}>
          <div style={{ ...s.donutNum, color: accent || 'var(--text-primary)' }}>{center}</div>
          <div style={s.donutSub}>{sub}</div>
        </div>
      </div>
      <div style={s.legend}>
        {segments.map(seg => (
          <button key={seg.key} onClick={() => seg.value > 0 && onPick(seg.key, title + ' · ' + seg.label)} disabled={seg.value === 0} style={s.legendBtn}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: seg.color, display: 'inline-block', flexShrink: 0 }} />
            <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{seg.label}</span>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{seg.value}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{pct(seg.value, total)}%</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Drill modal — the leads behind a clicked segment ──────────────────
function DrillModal({ drill, onClose }: { drill: { title: string; loading: boolean; rows: DrillLead[]; metric: 'edad' | 'resp' | 'ai'; error?: string }; onClose: () => void }) {
  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={s.modalHead}>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 15 }}>{drill.title}</span>
          <button onClick={onClose} style={s.modalClose} aria-label="Cerrar">✕</button>
        </div>
        <div style={s.modalBody}>
          {drill.loading && <div style={s.muted}>Cargando leads…</div>}
          {!drill.loading && drill.error && <div style={s.muted}>{drill.error}</div>}
          {!drill.loading && !drill.error && drill.rows.length === 0 && <div style={s.muted}>Sin leads en este segmento.</div>}
          {!drill.loading && !drill.error && drill.rows.map(l => {
            let m = ''
            if (drill.metric === 'resp' && l.resp_min != null) m = fmtAge(l.resp_min)
            else if (drill.metric === 'ai' && l.ai_close_prob != null) m = 'IA ' + l.ai_close_prob
            else m = 'hace ' + fmtAge(l.edad_min)
            return (
              <div key={l.id} style={s.drillRow}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>{l.nombre} {l.apellidos}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{tidyModelo(l.modelo_interes)} · {fLabel(l.fuente)} · {l.asignado_nombre || 'sin asignar'}</div>
                </div>
                <span style={s.drillMetric}>{m}</span>
                {l.telefono && <a href={'https://wa.me/' + waPhone(l.telefono)} target="_blank" rel="noreferrer" style={s.waBtn} title="WhatsApp">WA</a>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <CrmShell active="pulso" maxWidth={1100}>{children}</CrmShell>
}

const s: Record<string, React.CSSProperties> = {
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 20, gap: 12, flexWrap: 'wrap' },
  eyebrow: { fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  title: { fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0 0', fontFamily: 'var(--font-inter), Inter, sans-serif' },
  muted: { color: 'var(--text-muted)', fontSize: 14, padding: '30px 0', textAlign: 'center' },
  error: { background: 'rgba(229,85,106,0.12)', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16 },
  btnGhost: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  chip: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  chipOn: { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' },
  dateInput: { padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 12, fontFamily: 'inherit' },

  donutRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginBottom: 16 },
  donutCard: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 12px 14px' },
  donutTitle: { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textAlign: 'center', letterSpacing: '0.04em', textTransform: 'uppercase' },
  donutCenter: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
  donutNum: { fontSize: 26, fontWeight: 800, lineHeight: 1, fontFamily: 'var(--font-inter), Inter, sans-serif' },
  donutSub: { fontSize: 10, color: 'var(--text-muted)', marginTop: 2 },
  legend: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 },
  legendBtn: { display: 'flex', alignItems: 'center', gap: 7, padding: '3px 4px', border: 'none', background: 'transparent', borderRadius: 5, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)', width: '100%', fontFamily: 'inherit' },

  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px', marginBottom: 16 },
  cardTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14, letterSpacing: '0.02em', display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  cardSub: { fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' },
  titleNum: { fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--bg-deep)', borderRadius: 99, padding: '1px 9px' },

  catRow: { display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' },
  catTiles: { flex: '2 1 440px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 },
  catTile: { borderRadius: 10, padding: '10px 6px', textAlign: 'center', border: 'none', cursor: 'pointer', fontFamily: 'inherit' },
  catNum: { fontSize: 22, fontWeight: 800, lineHeight: 1, fontFamily: 'var(--font-inter), Inter, sans-serif' },
  catLabel: { fontSize: 11, fontWeight: 700, marginTop: 3, letterSpacing: '0.04em' },

  fcBox: { flex: '1 1 200px', background: 'var(--bg-deep)', borderRadius: 10, padding: '10px 16px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 },
  fcLabel: { fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  fcLine: { fontSize: 13, color: 'var(--text-secondary)' },
  fcB: { fontWeight: 700, color: 'var(--text-primary)' },
  fcTotal: { fontSize: 26, fontWeight: 800, color: 'var(--ok)', fontFamily: 'var(--font-inter), Inter, sans-serif', lineHeight: 1 },

  mHead: { display: 'flex', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  mRow: { display: 'flex', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--text-secondary)' },
  mRowBtn: { display: 'flex', alignItems: 'center', width: '100%', padding: '9px 4px', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', borderRadius: 6, fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'inherit' },

  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '60px 16px', zIndex: 1000 },
  modal: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 520, maxHeight: '78vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  modalHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' },
  modalClose: { border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer', lineHeight: 1 },
  modalBody: { overflowY: 'auto', padding: '6px 8px 14px' },
  drillRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: '1px solid var(--border)' },
  drillMetric: { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', whiteSpace: 'nowrap' },
  waBtn: { fontSize: 11, fontWeight: 700, color: 'var(--ok)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 7px', textDecoration: 'none', flexShrink: 0 },
}