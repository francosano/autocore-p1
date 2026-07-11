// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/crm/reportes/page.tsx
// AutoCore NPA — CRM Reportes (métricas estilo Elliott)
//
// 2026-06-11. Módulo de reportes del CRM. Lee:
//   • crm_leads        (solo origen_carga='organico'; el import masivo Apr-8/9
//                        queda fuera por defecto, toggle para incluirlo en embudo)
//   • crm_etapa_log    (transiciones de etapa — nuevo, trigger 2026-06-11)
//   • crm_mensajes     (speed-to-lead + share Claudia vs humanos)
//   • crm_actividades  (volumen de actividad por agente)
//
// Métricas clave (metodología Andy Elliott):
//   Speed-to-lead (mediana min a 1ra respuesta) · Citas agendadas · Show rate
//   Win rate · Días a cierre · Pipeline value · Leads fríos (+3d sin contacto)
//
// Notas:
//   • crm_mensajes está vacío hasta que el webhook de autocore-whatsapp escriba
//     al CRM — la sección muestra estado vacío, no error.
//   • Embudo usa estado actual de crm_leads; las transiciones del período salen
//     de crm_etapa_log (acumula desde 2026-06-11, no hay historia previa).
//   • Gate: npa_can_view_crm (primer consumidor de useAuthGate).
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useAuthGate } from '../../components/useAuthGate'
import SessionErrorScreen from '../../components/SessionErrorScreen'
import { fuenteLabel } from '../fuentes'

// ── Constantes compartidas con /crm ─────────────────────────────────────────
const ETAPAS = [
  { key: 'nuevo',             label: 'Nuevo Lead',        color: '#8A93A0' },
  { key: 'contactado',        label: 'Contactado',        color: '#5A8DEE' },
  { key: 'cita_agendada',     label: 'Cita Agendada',     color: '#9B7DF0' },
  { key: 'visita_showroom',   label: 'Visita Showroom',   color: '#E0A23C' },
  { key: 'oferta_presentada', label: 'Oferta Presentada', color: '#E5689A' },
  { key: 'financiamiento',    label: 'Financiamiento',    color: '#2FBF8F' },
  { key: 'cerrado_ganado',    label: 'Cerrado ✓',         color: '#15A06E' },
  { key: 'cerrado_perdido',   label: 'Perdido',           color: '#E5556A' },
]
const ACTIVAS = ['nuevo', 'contactado', 'cita_agendada', 'visita_showroom', 'oferta_presentada', 'financiamiento']
const etapaInfo = (key: string | null | undefined) => ETAPAS.find(e => e.key === key) ?? { key: key || '?', label: key || '—', color: 'var(--text-muted)' }


const PERIODOS = [
  { dias: 7,  label: '7 días' },
  { dias: 30, label: '30 días' },
  { dias: 90, label: '90 días' },
  { dias: 0,  label: 'Todo' },
]

// ── Tipos ────────────────────────────────────────────────────────────────────
interface LeadRow {
  id: string
  nombre: string
  apellidos: string
  telefono: string
  etapa: string
  fuente: string
  presupuesto_usd: number | null
  heat_score: number | null
  motivo_perdido: string | null
  asignado_nombre: string | null
  modelo_interes: string | null
  created_at: string
  ultimo_contacto: string | null
}
interface LogRow {
  lead_id: string
  etapa_anterior: string | null
  etapa_nueva: string
  changed_by: string | null
  created_at: string
}
interface MsgRow {
  conversation_id: string | null
  direction: string
  is_bot: boolean | null
  sent_by_nombre: string | null
  created_at: string
}
interface ActRow {
  tipo: string
  resultado: string | null
  created_by: string | null
  created_at: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const daysSince = (iso: string | null) => {
  if (!iso) return 999
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}
const fmtMoney = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const fmtMins = (m: number) => {
  if (m < 60) return Math.round(m) + ' min'
  if (m < 1440) return (m / 60).toFixed(1) + ' h'
  return (m / 1440).toFixed(1) + ' d'
}
const median = (arr: number[]) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const pct = (num: number, den: number) => den > 0 ? Math.round((num / den) * 100) + '%' : '—'

// ── Estilos ──────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  page:    { maxWidth: '1280px', margin: '0 auto', padding: '24px 20px 60px' },
  card:    { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '18px' },
  kpiVal:  { fontSize: '26px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif', color: 'var(--text-primary)', lineHeight: 1.1 },
  kpiLbl:  { fontSize: '10px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', fontFamily: 'var(--font-inter), Inter, sans-serif', marginBottom: '6px' },
  kpiSub:  { fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' },
  secTitle:{ fontSize: '14px', fontWeight: 800, fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-primary)', margin: '0 0 14px' },
  th:      { textAlign: 'left', fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', padding: '6px 10px', borderBottom: '1px solid var(--border)' },
  td:      { fontSize: '13px', color: 'var(--text-primary)', padding: '8px 10px', borderBottom: '1px solid var(--border)' },
  empty:   { fontSize: '12px', color: 'var(--text-muted)', padding: '14px 4px', fontStyle: 'italic' },
  pill:    { display: 'inline-block', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600 },
}

export default function CRMReportesPage() {
  const gate = useAuthGate(p => p.npa_can_view_crm || p.npa_can_admin)

  const [dias, setDias] = useState(30)
  const [loading, setLoading] = useState(true)
  const [incluirImport, setIncluirImport] = useState(false)

  const [leads, setLeads] = useState<LeadRow[]>([])
  const [logs, setLogs] = useState<LogRow[]>([])
  const [msgs, setMsgs] = useState<MsgRow[]>([])
  const [acts, setActs] = useState<ActRow[]>([])
  const [importCount, setImportCount] = useState(0)
  const [botConvs, setBotConvs] = useState({ total: 0, botActive: 0 })
  const [nombres, setNombres] = useState<Record<string, string>>({})

  useEffect(() => {
    if (gate.status === 'denied') window.location.href = '/dashboard'
  }, [gate.status])

  useEffect(() => {
    if (gate.status !== 'ok') return
    let mounted = true
    const load = async () => {
      setLoading(true)
      const desde = dias > 0 ? new Date(Date.now() - dias * 86400000).toISOString() : '2000-01-01'

      const [leadsRes, logsRes, msgsRes, actsRes, importRes, convRes, convBotRes, rolesRes] = await Promise.all([
        supabase.from('crm_leads')
          .select('id,nombre,apellidos,telefono,etapa,fuente,presupuesto_usd,heat_score,motivo_perdido,asignado_nombre,modelo_interes,created_at,ultimo_contacto')
          .eq('origen_carga', 'organico')
          .limit(5000),
        supabase.from('crm_etapa_log')
          .select('lead_id,etapa_anterior,etapa_nueva,changed_by,created_at')
          .gte('created_at', desde)
          .order('created_at', { ascending: true })
          .limit(5000),
        supabase.from('crm_mensajes')
          .select('conversation_id,direction,is_bot,sent_by_nombre,created_at')
          .gte('created_at', desde)
          .order('created_at', { ascending: true })
          .limit(5000),
        supabase.from('crm_actividades')
          .select('tipo,resultado,created_by,created_at')
          .gte('created_at', desde)
          .limit(3000),
        supabase.from('crm_leads')
          .select('id', { count: 'exact', head: true })
          .eq('origen_carga', 'import_masivo'),
        supabase.from('crm_conversations').select('id', { count: 'exact', head: true }),
        supabase.from('crm_conversations').select('id', { count: 'exact', head: true }).eq('bot_active', true),
        supabase.from('user_roles').select('user_id,full_name').eq('is_active', true),
      ])

      if (!mounted) return
      setLeads((leadsRes.data as LeadRow[]) || [])
      setLogs((logsRes.data as LogRow[]) || [])
      setMsgs((msgsRes.data as MsgRow[]) || [])
      setActs((actsRes.data as ActRow[]) || [])
      setImportCount(importRes.count || 0)
      setBotConvs({ total: convRes.count || 0, botActive: convBotRes.count || 0 })
      const map: Record<string, string> = {}
      for (const r of (rolesRes.data as { user_id: string; full_name: string }[]) || []) map[r.user_id] = r.full_name
      setNombres(map)
      setLoading(false)
    }
    load()
    return () => { mounted = false }
  }, [gate.status, dias])

  // ── Cálculos ───────────────────────────────────────────────────────────────
  const calc = useMemo(() => {
    const desdeMs = dias > 0 ? Date.now() - dias * 86400000 : 0
    const enPeriodo = (iso: string) => new Date(iso).getTime() >= desdeMs

    const leadsNuevos = leads.filter(l => enPeriodo(l.created_at))
    const activos = leads.filter(l => ACTIVAS.includes(l.etapa))

    // Transiciones del período (crm_etapa_log)
    const citasSet = logs.filter(t => t.etapa_nueva === 'cita_agendada').length
    const visitas = logs.filter(t => t.etapa_nueva === 'visita_showroom').length
    const ganadosLog = logs.filter(t => t.etapa_nueva === 'cerrado_ganado')
    const perdidosLog = logs.filter(t => t.etapa_nueva === 'cerrado_perdido')

    // Días a cierre: created_at del lead → transición a cerrado_ganado
    const leadById = new Map(leads.map(l => [l.id, l]))
    const diasCierre: number[] = []
    for (const w of ganadosLog) {
      const l = leadById.get(w.lead_id)
      if (l) diasCierre.push((new Date(w.created_at).getTime() - new Date(l.created_at).getTime()) / 86400000)
    }

    // Speed-to-lead: por conversación, 1er 'in' → 1er 'out' posterior
    const byConv = new Map<string, MsgRow[]>()
    for (const m of msgs) {
      if (!m.conversation_id) continue
      const arr = byConv.get(m.conversation_id) || []
      arr.push(m)
      byConv.set(m.conversation_id, arr)
    }
    const respMins: number[] = []
    byConv.forEach(arr => {
      const firstIn = arr.find(m => m.direction === 'in')
      if (!firstIn) return
      const tIn = new Date(firstIn.created_at).getTime()
      const firstOut = arr.find(m => m.direction === 'out' && new Date(m.created_at).getTime() > tIn)
      if (firstOut) respMins.push((new Date(firstOut.created_at).getTime() - tIn) / 60000)
    })

    // Claudia vs humanos (mensajes salientes)
    const outMsgs = msgs.filter(m => m.direction === 'out')
    const botMsgs = outMsgs.filter(m => m.is_bot)

    // Embudo (estado actual)
    const funnel = ETAPAS.map(e => ({
      ...e,
      n: leads.filter(l => l.etapa === e.key).length + (incluirImport && e.key === 'contactado' ? importCount : 0),
    }))

    // Fuentes
    const fuentes = Object.keys(
      leads.reduce((acc, l) => { acc[l.fuente] = true; return acc }, {} as Record<string, boolean>)
    ).map(f => {
      const fl = leads.filter(l => l.fuente === f)
      const g = fl.filter(l => l.etapa === 'cerrado_ganado').length
      const p = fl.filter(l => l.etapa === 'cerrado_perdido').length
      return { fuente: f, total: fl.length, ganados: g, perdidos: p, valor: fl.reduce((s, l) => s + (l.presupuesto_usd || 0), 0) }
    }).sort((a, b) => b.total - a.total)

    // Motivos de pérdida
    const motivos = Object.entries(
      leads.filter(l => l.etapa === 'cerrado_perdido').reduce((acc, l) => {
        const k = l.motivo_perdido || 'Sin motivo registrado'
        acc[k] = (acc[k] || 0) + 1
        return acc
      }, {} as Record<string, number>)
    ).sort((a, b) => b[1] - a[1])

    // Actividad por agente
    const porAgente = new Map<string, { acts: number; msgs: number; cierres: number }>()
    const bump = (nombre: string, key: 'acts' | 'msgs' | 'cierres') => {
      const r = porAgente.get(nombre) || { acts: 0, msgs: 0, cierres: 0 }
      r[key]++
      porAgente.set(nombre, r)
    }
    for (const a of acts) bump(a.created_by ? (nombres[a.created_by] || 'Desconocido') : 'Desconocido', 'acts')
    for (const m of outMsgs) { if (!m.is_bot) bump(m.sent_by_nombre || 'Agente', 'msgs') }
    for (const w of ganadosLog) bump(w.changed_by ? (nombres[w.changed_by] || 'Desconocido') : 'Sistema', 'cierres')
    const agentes = [...porAgente.entries()].sort((a, b) => (b[1].acts + b[1].msgs) - (a[1].acts + a[1].msgs))

    // Leads fríos (regla Elliott: +3d sin contacto = lead muriendo)
    const frios = activos
      .filter(l => daysSince(l.ultimo_contacto) > 3)
      .sort((a, b) => (b.heat_score || 0) - (a.heat_score || 0))
      .slice(0, 12)

    return {
      leadsNuevos: leadsNuevos.length,
      activos: activos.length,
      pipelineValue: activos.reduce((s, l) => s + (l.presupuesto_usd || 0), 0),
      citasSet, visitas, showRate: pct(visitas, citasSet),
      ganados: ganadosLog.length, perdidos: perdidosLog.length,
      winRate: pct(ganadosLog.length, ganadosLog.length + perdidosLog.length),
      speedMed: median(respMins), speedN: respMins.length,
      diasCierreAvg: diasCierre.length ? diasCierre.reduce((s, d) => s + d, 0) / diasCierre.length : null,
      outMsgs: outMsgs.length, botMsgs: botMsgs.length, inMsgs: msgs.filter(m => m.direction === 'in').length,
      funnel, fuentes, motivos, agentes, frios,
      transiciones: ETAPAS.map(e => ({ ...e, n: logs.filter(t => t.etapa_nueva === e.key).length })).filter(t => t.n > 0),
    }
  }, [leads, logs, msgs, acts, importCount, incluirImport, nombres, dias])

  // ── Gate ───────────────────────────────────────────────────────────────────
  if (gate.status === 'loading') return (
    <CrmShell active="reportes" fluid>
      <div style={{ textAlign: 'center', paddingTop: '120px', color: 'var(--text-muted)', fontSize: '13px' }}>Cargando…</div>
    </CrmShell>
  )
  if (gate.status === 'error') return <SessionErrorScreen homeHref="/crm" />
  if (gate.status !== 'ok') return null

  const maxFunnel = Math.max(1, ...calc.funnel.map(f => f.n))

  return (
    <CrmShell active="reportes" fluid>
      <div style={S.page}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '22px' }}>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.15em', color: 'var(--text-muted)', marginBottom: '6px' }}>
              AUTOCORE NPA · CRM ·{' '}
              <a href="/crm" style={{ color: 'var(--accent-solid)', textDecoration: 'none' }}>← VOLVER AL PIPELINE</a>
            </div>
            <h1 style={{ margin: 0, fontSize: '28px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.04em' }}>REPORTES CRM</h1>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Pipeline orgánico · {importCount.toLocaleString()} contactos del import masivo excluidos de métricas
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {PERIODOS.map(p => (
              <button key={p.dias} onClick={() => setDias(p.dias)}
                style={{ padding: '8px 14px', borderRadius: '8px', cursor: 'pointer', fontFamily: 'var(--font-inter), Inter, sans-serif', fontWeight: 600, fontSize: '12px', letterSpacing: '0.06em',
                  border: '1px solid ' + (dias === p.dias ? 'var(--accent-solid)' : 'var(--border)'),
                  background: dias === p.dias ? 'var(--accent-solid)' : 'var(--bg-card)',
                  color: dias === p.dias ? '#fff' : 'var(--text-secondary)' }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px 0', color: 'var(--text-muted)', fontSize: '13px' }}>Calculando métricas…</div>
        ) : (
          <>
            {/* KPIs */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px', marginBottom: '20px' }}>
              <div style={S.card}>
                <div style={S.kpiLbl}>Speed-to-Lead</div>
                <div style={{ ...S.kpiVal, color: calc.speedMed == null ? 'var(--text-muted)' : calc.speedMed <= 5 ? 'var(--ok)' : calc.speedMed <= 60 ? 'var(--warn)' : 'var(--danger)' }}>
                  {calc.speedMed == null ? '—' : fmtMins(calc.speedMed)}
                </div>
                <div style={S.kpiSub}>{calc.speedN > 0 ? 'mediana 1ra respuesta · ' + calc.speedN + ' conv' : 'sin mensajes aún'}</div>
              </div>
              <div style={S.card}>
                <div style={S.kpiLbl}>Leads Nuevos</div>
                <div style={S.kpiVal}>{calc.leadsNuevos}</div>
                <div style={S.kpiSub}>{calc.activos} activos en pipeline</div>
              </div>
              <div style={S.card}>
                <div style={S.kpiLbl}>Citas Agendadas</div>
                <div style={S.kpiVal}>{calc.citasSet}</div>
                <div style={S.kpiSub}>show rate {calc.showRate} ({calc.visitas} visitas)</div>
              </div>
              <div style={S.card}>
                <div style={S.kpiLbl}>Cierres</div>
                <div style={{ ...S.kpiVal, color: 'var(--ok)' }}>{calc.ganados}</div>
                <div style={S.kpiSub}>win rate {calc.winRate} · {calc.perdidos} perdidos</div>
              </div>
              <div style={S.card}>
                <div style={S.kpiLbl}>Valor Pipeline</div>
                <div style={{ ...S.kpiVal, color: 'var(--warn)' }}>{fmtMoney(calc.pipelineValue)}</div>
                <div style={S.kpiSub}>presupuestos en etapas activas</div>
              </div>
              <div style={S.card}>
                <div style={S.kpiLbl}>Días a Cierre</div>
                <div style={S.kpiVal}>{calc.diasCierreAvg == null ? '—' : calc.diasCierreAvg.toFixed(1)}</div>
                <div style={S.kpiSub}>promedio lead → ganado</div>
              </div>
              <div style={S.card}>
                <div style={S.kpiLbl}>Leads Fríos</div>
                <div style={{ ...S.kpiVal, color: calc.frios.length > 0 ? 'var(--danger)' : 'var(--ok)' }}>{calc.frios.length}</div>
                <div style={S.kpiSub}>+3 días sin contacto</div>
              </div>
            </div>

            {/* Embudo + Transiciones */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px', marginBottom: '20px' }}>
              <div style={S.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={S.secTitle}>Embudo (estado actual)</h3>
                  <label style={{ fontSize: '11px', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <input type="checkbox" checked={incluirImport} onChange={e => setIncluirImport(e.target.checked)} />
                    incluir import
                  </label>
                </div>
                {calc.funnel.map(f => (
                  <div key={f.key} style={{ marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '3px' }}>
                      <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{f.label}</span>
                      <span style={{ color: f.color, fontWeight: 800 }}>{f.n.toLocaleString()}</span>
                    </div>
                    <div style={{ height: '8px', background: 'var(--bg-deep)', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: Math.max(2, (f.n / maxFunnel) * 100) + '%', background: f.color, borderRadius: '4px' }} />
                    </div>
                  </div>
                ))}
              </div>

              <div style={S.card}>
                <h3 style={S.secTitle}>Movimientos del período</h3>
                {calc.transiciones.length === 0 ? (
                  <div style={S.empty}>Sin cambios de etapa en el período. El log acumula desde el 11-jun-2026.</div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr><th style={S.th}>Llegaron a etapa</th><th style={{ ...S.th, textAlign: 'right' }}>Leads</th></tr></thead>
                    <tbody>
                      {calc.transiciones.map(t => (
                        <tr key={t.key}>
                          <td style={S.td}><span style={{ ...S.pill, background: t.color + '22', color: t.color }}>{t.label}</span></td>
                          <td style={{ ...S.td, textAlign: 'right', fontWeight: 800 }}>{t.n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            </div>

            {/* Fuentes + Motivos */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px', marginBottom: '20px' }}>
              <div style={S.card}>
                <h3 style={S.secTitle}>Por fuente</h3>
                <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={S.th}>Fuente</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Leads</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Ganados</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Win</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Valor</th>
                  </tr></thead>
                  <tbody>
                    {calc.fuentes.map(f => (
                      <tr key={f.fuente}>
                        <td style={S.td}>{fuenteLabel(f.fuente)}</td>
                        <td style={{ ...S.td, textAlign: 'right' }}>{f.total}</td>
                        <td style={{ ...S.td, textAlign: 'right', color: 'var(--ok)', fontWeight: 600 }}>{f.ganados}</td>
                        <td style={{ ...S.td, textAlign: 'right' }}>{pct(f.ganados, f.ganados + f.perdidos)}</td>
                        <td style={{ ...S.td, textAlign: 'right', color: 'var(--warn)' }}>{fmtMoney(f.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>

              <div style={S.card}>
                <h3 style={S.secTitle}>Motivos de pérdida</h3>
                {calc.motivos.length === 0 ? (
                  <div style={S.empty}>Sin leads perdidos con motivo registrado.</div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr><th style={S.th}>Motivo</th><th style={{ ...S.th, textAlign: 'right' }}>Leads</th></tr></thead>
                    <tbody>
                      {calc.motivos.map(([m, n]) => (
                        <tr key={m}>
                          <td style={S.td}>{m}</td>
                          <td style={{ ...S.td, textAlign: 'right', fontWeight: 800, color: 'var(--danger)' }}>{n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            </div>

            {/* Agentes + Claudia */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px', marginBottom: '20px' }}>
              <div style={S.card}>
                <h3 style={S.secTitle}>Actividad por agente</h3>
                {calc.agentes.length === 0 ? (
                  <div style={S.empty}>Sin actividades registradas en el período.</div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={S.th}>Agente</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>Actividades</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>Mensajes</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>Cierres</th>
                    </tr></thead>
                    <tbody>
                      {calc.agentes.map(([nombre, r]) => (
                        <tr key={nombre}>
                          <td style={S.td}>{nombre}</td>
                          <td style={{ ...S.td, textAlign: 'right' }}>{r.acts}</td>
                          <td style={{ ...S.td, textAlign: 'right' }}>{r.msgs}</td>
                          <td style={{ ...S.td, textAlign: 'right', color: 'var(--ok)', fontWeight: 800 }}>{r.cierres}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>

              <div style={S.card}>
                <h3 style={S.secTitle}>🤖 Claudia (agente IA)</h3>
                {calc.outMsgs === 0 ? (
                  <div style={S.empty}>
                    Aún no hay mensajes en el CRM. Esta sección se activa cuando el webhook de WhatsApp
                    (autocore-whatsapp) empiece a escribir en crm_mensajes.
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '12px' }}>
                      <div>
                        <div style={S.kpiLbl}>Mensajes Claudia</div>
                        <div style={{ ...S.kpiVal, color: 'var(--ok)', fontSize: '22px' }}>{calc.botMsgs}</div>
                        <div style={S.kpiSub}>{pct(calc.botMsgs, calc.outMsgs)} del total saliente</div>
                      </div>
                      <div>
                        <div style={S.kpiLbl}>Recibidos</div>
                        <div style={{ ...S.kpiVal, fontSize: '22px' }}>{calc.inMsgs}</div>
                        <div style={S.kpiSub}>{calc.outMsgs} enviados en total</div>
                      </div>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {botConvs.botActive} de {botConvs.total} conversaciones con Claudia activa
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Leads fríos */}
            <div style={S.card}>
              <h3 style={S.secTitle}>🔥 Leads fríos — seguimiento urgente (+3 días sin contacto)</h3>
              {calc.frios.length === 0 ? (
                <div style={S.empty}>Cero leads fríos. Pipeline al día.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={S.th}>Lead</th>
                    <th style={S.th}>Etapa</th>
                    <th style={S.th}>Modelo</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Heat</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Sin contacto</th>
                    <th style={S.th}>Asignado</th>
                  </tr></thead>
                  <tbody>
                    {calc.frios.map(l => {
                      const e = etapaInfo(l.etapa)
                      const d = daysSince(l.ultimo_contacto)
                      return (
                        <tr key={l.id} style={{ cursor: 'pointer' }} onClick={() => { window.location.href = '/crm' }}>
                          <td style={{ ...S.td, fontWeight: 600 }}>{l.nombre} {l.apellidos}</td>
                          <td style={S.td}><span style={{ ...S.pill, background: e.color + '22', color: e.color }}>{e.label}</span></td>
                          <td style={S.td}>{l.modelo_interes || '—'}</td>
                          <td style={{ ...S.td, textAlign: 'right', fontWeight: 800, color: (l.heat_score || 0) >= 70 ? 'var(--danger)' : 'var(--text-primary)' }}>{l.heat_score ?? '—'}</td>
                          <td style={{ ...S.td, textAlign: 'right', color: 'var(--danger)', fontWeight: 800 }}>{d === 999 ? 'Nunca' : d + ' d'}</td>
                          <td style={S.td}>{l.asignado_nombre || 'Sin asignar'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </CrmShell>
  )
}