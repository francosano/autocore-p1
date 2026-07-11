// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/crm/campanas/page.tsx
// AutoCore NPA — CRM · Campañas y Marketing (panel gerencial, tiempo real)
//
// 2026-06-25. Lente de marketing/adquisición del CRM. Responde "¿qué canal y
// qué campaña están funcionando?" y "¿dónde corregir?". Se actualiza en vivo.
//
// LEE (agregación en cliente, sin RPC):
//   • crm_leads      — adquisición por fuente/campana/meta_ad_id, modelo, AI score,
//                      presupuesto, temperatura (solo origen_carga='organico';
//                      el import masivo Apr-8/9 queda fuera, toggle para incluirlo)
//   • crm_etapa_log  — transiciones de etapa (citas, ganados, perdidos, días a
//                      cierre). Trigger acumula desde 2026-06-11.
//   • crm_citas      — show-rate (estados: agendada · cumplida · no_show · cancelada)
//   • crm_mensajes   — speed-to-lead (1ª respuesta) y share Claudia vs humano
//
// TIEMPO REAL: canal postgres_changes sobre crm_leads / crm_etapa_log /
//   crm_citas / crm_actividades / crm_mensajes → recarga con debounce 800ms.
//   Indicador "EN VIVO" pulsante mientras el canal está suscrito.
//
// Gate: npa_can_view_crm || npa_can_admin (igual que /crm/reportes).
//
// NOTA SOBRE INVERSIÓN: el gasto real viene de meta_ad_insights (spend diario por
//   anuncio, desde Ads Manager). Con eso se calculan CPL y CPA (costo por lead y
//   por venta ganada) por campaña — ver la sección "Costo de adquisición". NO se
//   calcula ROAS: la atribución de ingreso (venta cerrada → monto del negocio)
//   todavía no está cableada. campana / meta_ad_id solo se llenan en leads CTWA.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useAuthGate } from '../../components/useAuthGate'
import SessionErrorScreen from '../../components/SessionErrorScreen'
import { FUENTE_META } from '../fuentes'

// ── Constantes (alineadas con /crm) ─────────────────────────────────────────
const ETAPAS = [
  { key: 'nuevo',             label: 'Nuevo',             color: '#8A93A0' },
  { key: 'contactado',        label: 'Contactado',        color: '#5A8DEE' },
  { key: 'cita_agendada',     label: 'Cita agendada',     color: '#9B7DF0' },
  { key: 'visita_showroom',   label: 'Visita showroom',   color: '#E0A23C' },
  { key: 'oferta_presentada', label: 'Oferta presentada', color: '#E5689A' },
  { key: 'financiamiento',    label: 'Financiamiento',    color: '#2FBF8F' },
  { key: 'cerrado_ganado',    label: 'Cerrado ganado',    color: '#15A06E' },
  { key: 'cerrado_perdido',   label: 'Perdido',           color: '#E5556A' },
]
const ACTIVAS = ['nuevo', 'contactado', 'cita_agendada', 'visita_showroom', 'oferta_presentada', 'financiamiento']
const etapaInfo = (k: string | null | undefined) => ETAPAS.find(e => e.key === k) ?? { key: k || '?', label: k || '—', color: 'var(--text-muted)' }

// Registro de canales: paid=true marca adquisición paga / social-ad.
const fMeta = (f: string) => FUENTE_META[f] || { label: f || '—', color: '#7B8694', paid: false }
const isPaid = (f: string) => !!FUENTE_META[f]?.paid
// "Digital" = todo lo que no es walk-in / referido (adquisición no presencial).
const isDigital = (f: string) => f !== 'walk_in' && f !== 'referido'

const PERIODOS = [
  { dias: 7,  label: '7 días' },
  { dias: 30, label: '30 días' },
  { dias: 90, label: '90 días' },
  { dias: 0,  label: 'Todo' },
]

// ── Tipos ────────────────────────────────────────────────────────────────────
interface LeadRow {
  id: string
  fuente: string
  campana: string | null
  meta_ad_id: string | null
  etapa: string
  modelo_interes: string | null
  presupuesto_usd: number | null
  heat_score: number | null
  ai_score: number | null
  ai_close_prob: number | null
  motivo_perdido: string | null
  asignado_nombre: string | null
  ciudad: string | null
  created_at: string
  contacted_at: string | null
  ultimo_contacto: string | null
}
interface LogRow { lead_id: string; etapa_anterior: string | null; etapa_nueva: string; created_at: string }
interface CitaRow { id: string; lead_id: string | null; fecha: string; estado: string | null; created_at: string }
interface MsgRow { conversation_id: string | null; direction: string; is_bot: boolean | null; created_at: string }
interface MetaRow {
  fecha: string
  campaign_id: string | null
  campaign_name: string | null
  ad_id: string | null
  ad_name: string | null
  objective: string | null
  spend: number | null
  impressions: number | null
  clicks: number | null
  link_clicks: number | null
  reach: number | null
  frequency: number | null
  ctr: number | null
  cpc: number | null
  cpm: number | null
  meta_leads: number | null
  meta_messaging_started: number | null
}
interface MetaBreakdownRow {
  fecha: string
  campaign_id: string | null
  campaign_name: string | null
  breakdown_type: string
  dim1: string
  dim2: string
  spend: number | null
  impressions: number | null
  clicks: number | null
  meta_leads: number | null
  meta_messaging_started: number | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const daysSince = (iso: string | null) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 999
const fmtMoney = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const fmtMoney2 = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMins = (m: number | null) => {
  if (m == null) return '—'
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
const pctNum = (num: number, den: number) => den > 0 ? Math.round((num / den) * 100) : 0
const pct = (num: number, den: number) => den > 0 ? Math.round((num / den) * 100) + '%' : '—'
const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
const todayISO = () => new Date().toISOString().slice(0, 10)
const daysAgoISO = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

export default function CRMCampanasPage() {
  const gate = useAuthGate(p => p.npa_can_view_crm || p.npa_can_admin)

  const [from, setFrom] = useState(daysAgoISO(30))
  const [until, setUntil] = useState(todayISO())
  const [campFilter, setCampFilter] = useState('')   // campaign_id
  const [adFilter, setAdFilter] = useState('')       // ad_id
  const [chanFilter, setChanFilter] = useState('')   // '' | 'messaging' | 'leadform'
  const [incluirImport, setIncluirImport] = useState(false)
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(false)
  const [lastSync, setLastSync] = useState<Date | null>(null)

  const [leads, setLeads] = useState<LeadRow[]>([])
  const [logs, setLogs] = useState<LogRow[]>([])
  const [citas, setCitas] = useState<CitaRow[]>([])
  const [msgs, setMsgs] = useState<MsgRow[]>([])
  const [metaRows, setMetaRows] = useState<MetaRow[]>([])
  const [bdRows, setBdRows] = useState<MetaBreakdownRow[]>([])
  const [importCount, setImportCount] = useState(0)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    const desde = from + 'T00:00:00'
    const hasta = until + 'T23:59:59'
    const [leadsRes, logsRes, citasRes, msgsRes, importRes, metaRes, bdRes] = await Promise.all([
      supabase.from('crm_leads')
        .select('id,fuente,campana,meta_ad_id,etapa,modelo_interes,presupuesto_usd,heat_score,ai_score,ai_close_prob,motivo_perdido,asignado_nombre,ciudad,created_at,contacted_at,ultimo_contacto')
        .eq('origen_carga', 'organico')
        .limit(8000),
      supabase.from('crm_etapa_log')
        .select('lead_id,etapa_anterior,etapa_nueva,created_at')
        .gte('created_at', desde).lte('created_at', hasta).order('created_at', { ascending: true }).limit(8000),
      supabase.from('crm_citas')
        .select('id,lead_id,fecha,estado,created_at')
        .gte('created_at', desde).lte('created_at', hasta).limit(5000),
      supabase.from('crm_mensajes')
        .select('conversation_id,direction,is_bot,created_at')
        .gte('created_at', desde).lte('created_at', hasta).order('created_at', { ascending: true }).limit(8000),
      supabase.from('crm_leads').select('id', { count: 'exact', head: true }).eq('origen_carga', 'import_masivo'),
      supabase.from('meta_ad_insights')
        .select('fecha,campaign_id,campaign_name,ad_id,ad_name,objective,spend,impressions,clicks,link_clicks,reach,frequency,ctr,cpc,cpm,meta_leads,meta_messaging_started')
        .gte('fecha', from).lte('fecha', until).order('fecha', { ascending: true }).limit(40000),
      supabase.from('meta_ad_breakdowns')
        .select('fecha,campaign_id,campaign_name,breakdown_type,dim1,dim2,spend,impressions,clicks,meta_leads,meta_messaging_started')
        .gte('fecha', from).lte('fecha', until).limit(60000),
    ])
    setLeads((leadsRes.data as LeadRow[]) || [])
    setLogs((logsRes.data as LogRow[]) || [])
    setCitas((citasRes.data as CitaRow[]) || [])
    setMsgs((msgsRes.data as MsgRow[]) || [])
    setImportCount(importRes.count || 0)
    setMetaRows((metaRes.data as MetaRow[]) || [])
    setBdRows((bdRes.data as MetaBreakdownRow[]) || [])
    setLastSync(new Date())
    setLoading(false)
  }, [from, until])

  // carga inicial + al cambiar período
  useEffect(() => {
    if (gate.status === 'denied') window.location.href = '/dashboard'
  }, [gate.status])

  useEffect(() => {
    if (gate.status !== 'ok') return
    setLoading(true)
    load()
  }, [gate.status, from, until, load])

  // suscripción en tiempo real (debounced)
  useEffect(() => {
    if (gate.status !== 'ok') return
    const queue = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => { load() }, 800)
    }
    const ch = supabase.channel('crm_campanas_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_leads' }, queue)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_etapa_log' }, queue)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_citas' }, queue)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_actividades' }, queue)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crm_mensajes' }, queue)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'meta_ad_insights' }, queue)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'meta_ad_breakdowns' }, queue)
      .subscribe((status) => setLive(status === 'SUBSCRIBED'))
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      supabase.removeChannel(ch)
      setLive(false)
    }
  }, [gate.status, load])

  // ── Cálculos ───────────────────────────────────────────────────────────────
  const m = useMemo(() => {
    const fromMs = new Date(from + 'T00:00:00').getTime()
    const untilMs = new Date(until + 'T23:59:59').getTime()
    const inPeriod = (iso: string) => { const t = new Date(iso).getTime(); return t >= fromMs && t <= untilMs }

    // canal por objetivo: OUTCOME_LEADS = formulario; el resto = mensajería
    const channelOf = (obj: string | null | undefined) => (obj === 'OUTCOME_LEADS' ? 'leadform' : 'messaging')
    // mapas ad → campaña / canal y campaña → canal (desde meta_ad_insights)
    const adToCampaign: Record<string, string> = {}
    const adToChannel: Record<string, string> = {}
    const campToChannel: Record<string, string> = {}
    metaRows.forEach(r => {
      if (r.ad_id) { if (r.campaign_id) adToCampaign[r.ad_id] = r.campaign_id; adToChannel[r.ad_id] = channelOf(r.objective) }
      if (r.campaign_id) campToChannel[r.campaign_id] = channelOf(r.objective)
    })

    const anyFilter = !!(campFilter || adFilter || chanFilter)
    const metaPass = (r: MetaRow) =>
      (!campFilter || r.campaign_id === campFilter) &&
      (!adFilter || r.ad_id === adFilter) &&
      (!chanFilter || channelOf(r.objective) === chanFilter)
    const bdPass = (r: MetaBreakdownRow) =>
      (!campFilter || r.campaign_id === campFilter) &&
      (!chanFilter || (r.campaign_id ? campToChannel[r.campaign_id] === chanFilter : false))
    // un lead CRM "pasa" si su meta_ad_id corresponde al filtro. Con filtro activo,
    // los leads sin meta_ad_id quedan fuera (corte por campaña = solo esa campaña).
    const leadPass = (l: LeadRow) => {
      if (!anyFilter) return true
      const ad = l.meta_ad_id
      if (!ad) return false
      if (adFilter && ad !== adFilter) return false
      if (campFilter && adToCampaign[ad] !== campFilter) return false
      if (chanFilter && adToChannel[ad] !== chanFilter) return false
      return true
    }

    // opciones para los selectores (siempre desde el universo meta, sin filtrar)
    const campOptions = [...new Map(
      metaRows.filter(r => r.campaign_id).map(r => [r.campaign_id as string, r.campaign_name || (r.campaign_id as string)])
    ).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
    const adOptions = [...new Map(
      metaRows.filter(r => r.ad_id && (!campFilter || r.campaign_id === campFilter)).map(r => [r.ad_id as string, r.ad_name || (r.ad_id as string)])
    ).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))

    const scope = leads.filter(leadPass)
    const nuevos = scope.filter(l => inPeriod(l.created_at))
    const activos = scope.filter(l => ACTIVAS.includes(l.etapa))
    const byId = new Map(scope.map(l => [l.id, l]))

    // transiciones del período
    const citasLog = logs.filter(t => t.etapa_nueva === 'cita_agendada')
    const ganadosLog = logs.filter(t => t.etapa_nueva === 'cerrado_ganado')
    const perdidosLog = logs.filter(t => t.etapa_nueva === 'cerrado_perdido')

    const totalLeads = nuevos.length
    const totalGanados = ganadosLog.length
    const totalPerdidos = perdidosLog.length
    const winRate = pctNum(totalGanados, totalGanados + totalPerdidos)
    const pipelineActivo = activos.reduce((s, l) => s + (l.presupuesto_usd || 0), 0)
    const pagasLeads = nuevos.filter(l => isPaid(l.fuente)).length
    const digitalLeads = nuevos.filter(l => isDigital(l.fuente)).length

    // ── por canal (fuente) ──
    const fuentes = [...new Set(nuevos.map(l => l.fuente || 'desconocido'))]
    const porFuente = fuentes.map(f => {
      const fl = nuevos.filter(l => (l.fuente || 'desconocido') === f)
      const cit = citasLog.filter(t => (byId.get(t.lead_id)?.fuente || 'desconocido') === f).length
      const gan = ganadosLog.filter(t => (byId.get(t.lead_id)?.fuente || 'desconocido') === f).length
      const per = perdidosLog.filter(t => (byId.get(t.lead_id)?.fuente || 'desconocido') === f).length
      const ai = fl.map(l => l.ai_score).filter((x): x is number => x != null)
      const pipe = activos.filter(l => (l.fuente || 'desconocido') === f).reduce((s, l) => s + (l.presupuesto_usd || 0), 0)
      return {
        fuente: f, leads: fl.length, share: pctNum(fl.length, totalLeads),
        citas: cit, ganados: gan, perdidos: per, winPct: pctNum(gan, gan + per),
        aiAvg: ai.length ? Math.round(avg(ai)!) : null, pipeline: pipe, paid: isPaid(f),
      }
    }).sort((a, b) => b.leads - a.leads)

    // ── por campaña (Meta CTWA) ──
    const camps = [...new Set(nuevos.map(l => (l.campana || '').trim()).filter(Boolean))]
    const porCampana = camps.map(c => {
      const cl = nuevos.filter(l => (l.campana || '').trim() === c)
      const ids = new Set(cl.map(l => l.id))
      const gan = ganadosLog.filter(t => ids.has(t.lead_id)).length
      const per = perdidosLog.filter(t => ids.has(t.lead_id)).length
      const cp = cl.map(l => l.ai_close_prob).filter((x): x is number => x != null)
      // modelo dominante
      const mc: Record<string, number> = {}
      cl.forEach(l => { const k = l.modelo_interes || '—'; mc[k] = (mc[k] || 0) + 1 })
      const topModelo = Object.entries(mc).sort((a, b) => b[1] - a[1])[0]?.[0] || '—'
      return {
        campana: c, leads: cl.length, ganados: gan, perdidos: per, winPct: pctNum(gan, gan + per),
        closeProb: cp.length ? Math.round(avg(cp)!) : null, topModelo,
        pipe: cl.filter(l => ACTIVAS.includes(l.etapa)).reduce((s, l) => s + (l.presupuesto_usd || 0), 0),
      }
    }).sort((a, b) => b.leads - a.leads)

    // ── por anuncio (meta_ad_id) ──
    const ads = [...new Set(nuevos.map(l => (l.meta_ad_id || '').trim()).filter(Boolean))]
    const porAnuncio = ads.map(a => {
      const al = nuevos.filter(l => (l.meta_ad_id || '').trim() === a)
      const ids = new Set(al.map(l => l.id))
      const gan = ganadosLog.filter(t => ids.has(t.lead_id)).length
      const per = perdidosLog.filter(t => ids.has(t.lead_id)).length
      const camp = al[0]?.campana || '—'
      return { adId: a, campana: camp, leads: al.length, ganados: gan, winPct: pctNum(gan, gan + per) }
    }).sort((a, b) => b.leads - a.leads).slice(0, 8)

    // ── demanda por modelo ──
    const modelos = [...new Set(nuevos.map(l => (l.modelo_interes || '').trim()).filter(Boolean))]
    const porModelo = modelos.map(mo => {
      const ml = nuevos.filter(l => (l.modelo_interes || '').trim() === mo)
      const ids = new Set(ml.map(l => l.id))
      const gan = ganadosLog.filter(t => ids.has(t.lead_id)).length
      const fc: Record<string, number> = {}
      ml.forEach(l => { const k = l.fuente || 'desconocido'; fc[k] = (fc[k] || 0) + 1 })
      const topFuente = Object.entries(fc).sort((a, b) => b[1] - a[1])[0]?.[0] || '—'
      return { modelo: mo, leads: ml.length, ganados: gan, topFuente }
    }).sort((a, b) => b.leads - a.leads).slice(0, 8)

    // ── tendencia (paid vs resto) ──
    const dayMs = 86400000
    const spanDays = Math.max(1, Math.round((untilMs - fromMs) / dayMs) + 1)
    const bucketDays = spanDays <= 31 ? 1 : 7
    const nB = Math.max(1, Math.ceil(spanDays / bucketDays))
    const baseStart = new Date(from + 'T00:00:00').getTime()
    const buckets: { start: number; end: number; paid: number; otros: number; label: string }[] = []
    for (let i = 0; i < nB; i++) {
      const start = baseStart + i * bucketDays * dayMs
      const end = start + bucketDays * dayMs
      const d = new Date(start)
      const label = `${d.getDate()}/${d.getMonth() + 1}`
      buckets.push({ start, end, paid: 0, otros: 0, label })
    }
    nuevos.forEach(l => {
      const t = new Date(l.created_at).getTime()
      const bk = buckets.find(bk => t >= bk.start && t < bk.end)
      if (bk) { if (isPaid(l.fuente)) bk.paid++; else bk.otros++ }
    })

    // ── embudo (estado actual) ──
    const funnelOrder = ['nuevo', 'contactado', 'cita_agendada', 'visita_showroom', 'oferta_presentada', 'financiamiento', 'cerrado_ganado']
    const stageRank: Record<string, number> = {}
    funnelOrder.forEach((s, i) => { stageRank[s] = i })
    const reachedAtLeast = (idx: number) => scope.filter(l => {
      const r = stageRank[l.etapa]
      return r != null && r >= idx
    }).length
    const funnel = funnelOrder.map((stg, i) => ({ stage: stg, label: etapaInfo(stg).label, reached: reachedAtLeast(i) }))

    // ── speed-to-lead (crm_mensajes) ──
    const byConv = new Map<string, MsgRow[]>()
    msgs.forEach(x => { if (x.conversation_id) { const a = byConv.get(x.conversation_id) || []; a.push(x); byConv.set(x.conversation_id, a) } })
    const respMin: number[] = []
    byConv.forEach(arr => {
      const firstIn = arr.find(x => x.direction === 'in')
      if (!firstIn) return
      const out = arr.find(x => x.direction === 'out' && new Date(x.created_at).getTime() > new Date(firstIn.created_at).getTime())
      if (out) respMin.push((new Date(out.created_at).getTime() - new Date(firstIn.created_at).getTime()) / 60000)
    })
    const speedMedian = median(respMin)
    const speedUnder5 = pctNum(respMin.filter(x => x <= 5).length, respMin.length)
    const speedUnder60 = pctNum(respMin.filter(x => x <= 60).length, respMin.length)
    const botShare = pctNum(msgs.filter(x => x.direction === 'out' && x.is_bot).length, msgs.filter(x => x.direction === 'out').length)

    // ── días a cierre ──
    const dc: number[] = []
    ganadosLog.forEach(w => { const l = byId.get(w.lead_id); if (l) dc.push((new Date(w.created_at).getTime() - new Date(l.created_at).getTime()) / dayMs) })
    const diasCierre = median(dc)

    // ── citas / show-rate ──
    const citasPeriodo = citas
    const citCumplidas = citasPeriodo.filter(c => c.estado === 'cumplida').length
    const citNoShow = citasPeriodo.filter(c => c.estado === 'no_show').length
    const citAgendadas = citasPeriodo.filter(c => c.estado === 'agendada' || !c.estado).length
    const citCanceladas = citasPeriodo.filter(c => c.estado === 'cancelada').length
    const showRate = pctNum(citCumplidas, citCumplidas + citNoShow)

    // ── temperatura ──
    const tBuckets = { caliente: 0, tibio: 0, frio: 0, inactivo: 0 }
    activos.forEach(l => {
      const sc = l.heat_score ?? 0
      if (sc >= 75) tBuckets.caliente++
      else if (sc >= 50) tBuckets.tibio++
      else if (sc >= 25) tBuckets.frio++
      else tBuckets.inactivo++
    })

    // ── leaderboard ejecutivos ──
    const execNames = [...new Set(nuevos.map(l => l.asignado_nombre).filter(Boolean) as string[])]
    const execs = execNames.map(nombre => {
      const el = nuevos.filter(l => l.asignado_nombre === nombre)
      const ids = new Set(el.map(l => l.id))
      const gan = ganadosLog.filter(t => ids.has(t.lead_id)).length
      const per = perdidosLog.filter(t => ids.has(t.lead_id)).length
      const cit = citasLog.filter(t => ids.has(t.lead_id)).length
      const act = scope.filter(l => l.asignado_nombre === nombre && ACTIVAS.includes(l.etapa)).length
      return { nombre, leads: el.length, citas: cit, ganados: gan, activos: act, winPct: pctNum(gan, gan + per) }
    }).sort((a, b) => b.ganados - a.ganados || b.leads - a.leads)

    // ── razones de pérdida ──
    const lossMap: Record<string, number> = {}
    scope.filter(l => l.etapa === 'cerrado_perdido' && l.motivo_perdido).forEach(l => {
      const k = (l.motivo_perdido || '').trim() || '—'; lossMap[k] = (lossMap[k] || 0) + 1
    })
    const perdidasRazones = Object.entries(lossMap).map(([motivo, n]) => ({ motivo, n })).sort((a, b) => b.n - a.n).slice(0, 6)

    // ── riesgo ──
    const frios = activos.filter(l => daysSince(l.ultimo_contacto || null) >= 3).length
    const hotUnattended = scope.filter(l => (l.ai_score ?? 0) >= 80 && !l.contacted_at && ACTIVAS.includes(l.etapa)).length
    const sinAsignar = scope.filter(l => !l.asignado_nombre && ACTIVAS.includes(l.etapa)).length

    // ── META ADS (meta_ad_insights · gasto real desde Ads Manager) ──
    const metaScope = metaRows.filter(r => r.fecha && metaPass(r))
    const mSpend = metaScope.reduce((s, r) => s + (r.spend || 0), 0)
    const mImpr = metaScope.reduce((s, r) => s + (r.impressions || 0), 0)
    const mClicks = metaScope.reduce((s, r) => s + (r.clicks || 0), 0)
    const mLeadsM = metaScope.reduce((s, r) => s + (r.meta_leads || 0), 0)
    const mMsg = metaScope.reduce((s, r) => s + (r.meta_messaging_started || 0), 0)
    const mCtr = mImpr > 0 ? (mClicks / mImpr) * 100 : 0
    const mCpl = mLeadsM > 0 ? mSpend / mLeadsM : null
    const mCpMsg = mMsg > 0 ? mSpend / mMsg : null
    const metaDays = [...new Set(metaScope.map(r => r.fecha))].sort()

    // leads CRM por anuncio (join meta_ad_id ↔ ad_id)
    const crmByAd: Record<string, number> = {}
    nuevos.forEach(l => { if (l.meta_ad_id) crmByAd[l.meta_ad_id] = (crmByAd[l.meta_ad_id] || 0) + 1 })
    const crmGanByAd: Record<string, number> = {}
    ganadosLog.forEach(t => { const l = byId.get(t.lead_id); if (l && l.meta_ad_id) crmGanByAd[l.meta_ad_id] = (crmGanByAd[l.meta_ad_id] || 0) + 1 })

    // por campaña
    const campMap = new Map<string, any>()
    metaScope.forEach(r => {
      const k = r.campaign_id || r.campaign_name || '—'
      const e = campMap.get(k) || { name: r.campaign_name || '(sin nombre)', spend: 0, impr: 0, clicks: 0, leads: 0, msg: 0, adIds: new Set<string>() }
      e.spend += r.spend || 0; e.impr += r.impressions || 0; e.clicks += r.clicks || 0
      e.leads += r.meta_leads || 0; e.msg += r.meta_messaging_started || 0
      if (r.ad_id) e.adIds.add(r.ad_id)
      campMap.set(k, e)
    })
    const metaCampanas = [...campMap.values()].map(e => {
      let crmLeads = 0, crmGan = 0
      e.adIds.forEach((ad: string) => { crmLeads += crmByAd[ad] || 0; crmGan += crmGanByAd[ad] || 0 })
      return {
        name: e.name, spend: e.spend, impr: e.impr, clicks: e.clicks, leads: e.leads, msg: e.msg,
        ctr: e.impr > 0 ? (e.clicks / e.impr) * 100 : 0,
        cpl: e.leads > 0 ? e.spend / e.leads : null,
        crmLeads, crmGanados: crmGan,
      }
    }).sort((a, b) => b.spend - a.spend)

    // por anuncio (con frecuencia para señal de fatiga)
    const adMap = new Map<string, any>()
    metaScope.forEach(r => {
      const k = r.ad_id || '—'
      const e = adMap.get(k) || { ad_id: r.ad_id, name: r.ad_name || '(sin nombre)', camp: r.campaign_name || '—', spend: 0, impr: 0, clicks: 0, leads: 0, msg: 0, freqSum: 0, freqN: 0 }
      e.spend += r.spend || 0; e.impr += r.impressions || 0; e.clicks += r.clicks || 0
      e.leads += r.meta_leads || 0; e.msg += r.meta_messaging_started || 0
      if (r.frequency != null && (r.impressions || 0) > 0) { e.freqSum += r.frequency; e.freqN += 1 }
      adMap.set(k, e)
    })
    const metaAnuncios = [...adMap.values()].map(e => ({
      name: e.name, camp: e.camp, spend: e.spend, impr: e.impr, clicks: e.clicks, leads: e.leads, msg: e.msg,
      ctr: e.impr > 0 ? (e.clicks / e.impr) * 100 : 0,
      cpl: e.leads > 0 ? e.spend / e.leads : null,
      freq: e.freqN > 0 ? e.freqSum / e.freqN : null,
      crmLeads: e.ad_id ? (crmByAd[e.ad_id] || 0) : 0,
    })).sort((a, b) => b.spend - a.spend)

    // fatiga: frecuencia media ≥ 2.8 con gasto real (saturación de público)
    const fatiga = metaAnuncios.filter(a => a.freq != null && a.freq >= 2.8 && a.spend > 0)
      .sort((a, b) => (b.freq || 0) - (a.freq || 0))

    // ventas atribuidas a Meta (vía meta_ad_id) y costo por venta — el cierre que
    // las plataformas externas no pueden calcular porque no son dueñas del CRM.
    const metaGanados = Object.values(crmGanByAd).reduce((s, n) => s + n, 0)
    const costPerSale = metaGanados > 0 ? mSpend / metaGanados : null

    // gasto diario
    const dayMap = new Map<string, { spend: number; leads: number }>()
    metaScope.forEach(r => {
      const e = dayMap.get(r.fecha) || { spend: 0, leads: 0 }
      e.spend += r.spend || 0; e.leads += r.meta_leads || 0
      dayMap.set(r.fecha, e)
    })
    const metaDaily = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([fecha, v]) => ({ fecha, spend: v.spend, leads: v.leads }))

    // ── COSTO DE ADQUISICIÓN (gasto Meta ↔ leads CRM atribuidos, por campaña) ──
    // Atribución de cada lead: primero meta_ad_id → campaña (vía ad_id); si no,
    // campana ↔ campaign_name. Sin ninguno → bucket "Orgánico / sin atribución".
    // El gasto de campañas con cero leads atribuidos queda visible ("spend sin
    // leads"). Solo métricas de costo — NO ROAS: la atribución de ingreso
    // (venta cerrada → monto del negocio) todavía no está cableada.
    const campNameToId: Record<string, string> = {}
    const acqCampName: Record<string, string> = {}
    const acqSpend: Record<string, number> = {}
    metaScope.forEach(r => {
      if (r.campaign_id) {
        acqSpend[r.campaign_id] = (acqSpend[r.campaign_id] || 0) + (r.spend || 0)
        if (r.campaign_name) { acqCampName[r.campaign_id] = r.campaign_name; campNameToId[r.campaign_name.trim()] = r.campaign_id }
      }
    })
    const citaLeadIds = new Set(citasLog.map(t => t.lead_id))
    const ganadoLeadIds = new Set(ganadosLog.map(t => t.lead_id))
    const attribOf = (l: LeadRow): string | null => {
      if (l.meta_ad_id && adToCampaign[l.meta_ad_id]) return adToCampaign[l.meta_ad_id]
      const c = (l.campana || '').trim()
      if (c && campNameToId[c]) return campNameToId[c]
      return null
    }
    const ORGANIC = '__organic__'
    const acqMap = new Map<string, { campId: string; leads: number; citas: number; ganados: number; hot: number }>()
    // sembrar campañas con gasto (para exponer "spend sin leads")
    Object.keys(acqSpend).forEach(id => acqMap.set(id, { campId: id, leads: 0, citas: 0, ganados: 0, hot: 0 }))
    nuevos.forEach(l => {
      const id = attribOf(l) ?? ORGANIC
      const e = acqMap.get(id) || { campId: id, leads: 0, citas: 0, ganados: 0, hot: 0 }
      e.leads++
      if (citaLeadIds.has(l.id)) e.citas++       // llegó a cita_agendada en el rango
      if (ganadoLeadIds.has(l.id)) e.ganados++   // cerrado_ganado en el rango
      if ((l.ai_score ?? 0) >= 80) e.hot++
      acqMap.set(id, e)
    })
    const acqRowsRaw = [...acqMap.values()].map(e => {
      const isOrganic = e.campId === ORGANIC
      const spend = isOrganic ? 0 : (acqSpend[e.campId] || 0)
      const name = isOrganic ? 'Orgánico / sin atribución' : (acqCampName[e.campId] || '(sin nombre)')
      return {
        campId: e.campId, name, isOrganic,
        spend, leads: e.leads, citas: e.citas, ganados: e.ganados, hot: e.hot,
        cpl: e.leads > 0 && spend > 0 ? spend / e.leads : null,
        costPorCita: e.citas > 0 && spend > 0 ? spend / e.citas : null,
        // CPA = costo por venta ganada. NO es ROAS (falta el monto del negocio).
        cpa: e.ganados > 0 && spend > 0 ? spend / e.ganados : null,
        hotPct: pctNum(e.hot, e.leads),
      }
    })
    // campañas pagas primero (por gasto desc); el bucket orgánico al final
    const acqPaid = acqRowsRaw.filter(r => !r.isOrganic).sort((a, b) => b.spend - a.spend)
    const acqOrganic = acqRowsRaw.find(r => r.isOrganic) || null
    const acqRows = acqOrganic ? [...acqPaid, acqOrganic] : acqPaid
    // totales de costo: solo campañas pagas atribuidas — el bucket orgánico aporta
    // $0 de gasto y diluiría CPL/CPA, así que queda fuera del denominador.
    const acqTot = acqPaid.reduce((t, r) => ({
      spend: t.spend + r.spend, leads: t.leads + r.leads, citas: t.citas + r.citas,
      ganados: t.ganados + r.ganados, hot: t.hot + r.hot,
    }), { spend: 0, leads: 0, citas: 0, ganados: 0, hot: 0 })
    const acqTotals = {
      spend: acqTot.spend, leads: acqTot.leads, citas: acqTot.citas, ganados: acqTot.ganados,
      organicLeads: acqOrganic?.leads || 0,
      cpl: acqTot.leads > 0 ? acqTot.spend / acqTot.leads : null,
      costPorCita: acqTot.citas > 0 ? acqTot.spend / acqTot.citas : null,
      cpa: acqTot.ganados > 0 ? acqTot.spend / acqTot.ganados : null,
      hotPct: pctNum(acqTot.hot, acqTot.leads),
    }
    // "spend sin leads": campañas con gasto y cero leads CRM atribuidos
    const acqSinLeads = acqPaid.filter(r => r.spend > 0 && r.leads === 0)
    const acqSpendSinLeads = acqSinLeads.reduce((s, r) => s + r.spend, 0)

    // ── Desgloses (placement / edad-género / región) desde meta_ad_breakdowns ──
    const bdScope = bdRows.filter(bdPass)
    const aggBreakdown = (type: string, joinDims: boolean) => {
      const map = new Map<string, { label: string; spend: number; impr: number; clicks: number; leads: number; msg: number }>()
      bdScope.filter(r => r.breakdown_type === type).forEach(r => {
        const label = joinDims ? [r.dim1, r.dim2].filter(Boolean).join(' · ') || '—' : (r.dim1 || '—')
        const e = map.get(label) || { label, spend: 0, impr: 0, clicks: 0, leads: 0, msg: 0 }
        e.spend += r.spend || 0; e.impr += r.impressions || 0; e.clicks += r.clicks || 0
        e.leads += r.meta_leads || 0; e.msg += r.meta_messaging_started || 0
        map.set(label, e)
      })
      return [...map.values()].map(e => ({
        ...e,
        ctr: e.impr > 0 ? (e.clicks / e.impr) * 100 : 0,
        cpl: e.leads > 0 ? e.spend / e.leads : null,
      })).sort((a, b) => b.spend - a.spend)
    }
    const bdPlacement = aggBreakdown('placement', true)
    const bdDemographic = aggBreakdown('demographic', true)
    const bdRegion = aggBreakdown('region', false).slice(0, 12)

    // pirámide demográfica: banda de edad → hombres / mujeres (gasto + CPL)
    const AGE_ORDER = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+']
    const demoMap = new Map<string, { age: string; mSpend: number; fSpend: number; mLeads: number; fLeads: number }>()
    bdScope.filter(r => r.breakdown_type === 'demographic').forEach(r => {
      const age = r.dim1 || '—'
      const g = (r.dim2 || '').toLowerCase()
      const e = demoMap.get(age) || { age, mSpend: 0, fSpend: 0, mLeads: 0, fLeads: 0 }
      if (g === 'male') { e.mSpend += r.spend || 0; e.mLeads += r.meta_leads || 0 }
      else if (g === 'female') { e.fSpend += r.spend || 0; e.fLeads += r.meta_leads || 0 }
      demoMap.set(age, e)
    })
    const demoPyramid = AGE_ORDER.map(a => demoMap.get(a)).filter((e): e is NonNullable<typeof e> => !!e).map(e => ({
      age: e.age, mSpend: e.mSpend, fSpend: e.fSpend,
      mCpl: e.mLeads > 0 ? e.mSpend / e.mLeads : null,
      fCpl: e.fLeads > 0 ? e.fSpend / e.fLeads : null,
    }))

    // insight automático: mejor y peor CPL de un set de breakdown
    const insightOf = (rows: { label: string; spend: number; cpl: number | null }[]) => {
      const withCpl = rows.filter(r => r.cpl != null && r.spend > 0)
      if (withCpl.length < 2) return null
      const best = withCpl.reduce((a, b) => (b.cpl! < a.cpl! ? b : a))
      const worst = withCpl.reduce((a, b) => (b.cpl! > a.cpl! ? b : a))
      const topSpend = [...rows].sort((a, b) => b.spend - a.spend)[0]
      return { bestLabel: best.label, bestCpl: best.cpl!, worstLabel: worst.label, worstCpl: worst.cpl!, topSpendLabel: topSpend?.label || '', topSpendCpl: topSpend?.cpl ?? null }
    }
    const insPlacement = insightOf(bdPlacement)
    const insRegion = insightOf(bdRegion)

    // ── Señales ejecutivas: "qué hacer", no solo "qué pasó" ──
    const senales: { kind: 'warn' | 'good' | 'info'; text: string }[] = []
    if (insPlacement && insPlacement.topSpendCpl != null && insPlacement.bestCpl > 0 && insPlacement.topSpendCpl > insPlacement.bestCpl * 3) {
      senales.push({ kind: 'warn', text: `El mayor gasto va a ${insPlacement.topSpendLabel} a ${fmtMoney2(insPlacement.topSpendCpl)}/lead; ${insPlacement.bestLabel} entrega a ${fmtMoney2(insPlacement.bestCpl)}. Reasignar presupuesto.` })
    }
    if (fatiga.length > 0) {
      senales.push({ kind: 'warn', text: `${fatiga.length} anuncio${fatiga.length > 1 ? 's' : ''} con frecuencia ≥ 2.8 (señal de fatiga). Refrescar creativo o ampliar el público.` })
    }
    if (metaGanados > 0 && costPerSale != null) {
      senales.push({ kind: 'good', text: `${metaGanados} venta${metaGanados > 1 ? 's' : ''} atribuida${metaGanados > 1 ? 's' : ''} a Meta · costo por venta ${fmtMoney2(costPerSale)}.` })
    } else if (mLeadsM > 0) {
      senales.push({ kind: 'info', text: `Aún sin ventas atribuidas a Meta en el período. ${Math.round(mLeadsM)} leads Meta en el embudo.` })
    }
    if (insRegion && insRegion.bestCpl != null && insRegion.worstCpl > insRegion.bestCpl * 4) {
      senales.push({ kind: 'info', text: `${insRegion.bestLabel} rinde el lead más barato (${fmtMoney2(insRegion.bestCpl)}); ${insRegion.worstLabel} el más caro (${fmtMoney2(insRegion.worstCpl)}).` })
    }
    const senalesTop = senales.slice(0, 4)

    return {
      totalLeads, totalGanados, totalPerdidos, winRate, pipelineActivo, pagasLeads, digitalLeads,
      porFuente, porCampana, porAnuncio, porModelo, buckets, bucketDays, funnel,
      speedMedian, speedUnder5, speedUnder60, botShare, diasCierre,
      citCumplidas, citNoShow, citAgendadas, citCanceladas, showRate, citTotal: citasPeriodo.length,
      tBuckets, execs, perdidasRazones, frios, hotUnattended, sinAsignar,
      anyFilter, campOptions, adOptions,
      meta: {
        spend: mSpend, impr: mImpr, clicks: mClicks, leads: mLeadsM, msg: mMsg,
        ctr: mCtr, cpl: mCpl, cpMsg: mCpMsg,
        dateMin: metaDays[0] || null, dateMax: metaDays[metaDays.length - 1] || null,
        hasData: metaScope.length > 0,
      },
      metaCampanas, metaAnuncios, metaDaily,
      acqRows, acqTotals, acqSpendSinLeads, acqSinLeadsCount: acqSinLeads.length,
      bdPlacement, bdDemographic, bdRegion, demoPyramid, insPlacement, insRegion,
      senales: senalesTop, fatiga, metaGanados, costPerSale,
    }
  }, [leads, logs, citas, msgs, metaRows, bdRows, from, until, campFilter, adFilter, chanFilter])

  if (gate.status === 'loading') return <Shell live={false} lastSync={null}><div style={S.muted}>Cargando…</div></Shell>
  if (gate.status === 'error') return <SessionErrorScreen />
  if (gate.status !== 'ok') return null

  const maxFuente = Math.max(1, ...m.porFuente.map(x => x.leads))
  const maxTrend = Math.max(1, ...m.buckets.map(b => b.paid + b.otros))
  const funnelTop = Math.max(1, ...m.funnel.map(x => x.reached))
  const tTotal = m.tBuckets.caliente + m.tBuckets.tibio + m.tBuckets.frio + m.tBuckets.inactivo

  return (
    <Shell live={live} lastSync={lastSync}>
      {/* HEADER */}
      <div style={S.headRow}>
        <div>
          <div style={S.eyebrow}>CRM · Marketing</div>
          <h1 style={S.title}>Marketing 360</h1>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {PERIODOS.map(p => {
            const pf = p.dias > 0 ? daysAgoISO(p.dias) : '2025-01-01'
            const isOn = from === pf && until === todayISO()
            return (
              <button key={p.dias} onClick={() => { setFrom(pf); setUntil(todayISO()) }}
                style={{ ...S.chip, ...(isOn ? S.chipOn : {}) }}>{p.label}</button>
            )
          })}
          <input type="date" value={from} max={until} onChange={e => setFrom(e.target.value)} style={S.dateInput} />
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>→</span>
          <input type="date" value={until} min={from} max={todayISO()} onChange={e => setUntil(e.target.value)} style={S.dateInput} />
          <button style={S.btnGhost} onClick={() => { setLoading(true); load() }} disabled={loading}>
            {loading ? '…' : '↻'}
          </button>
        </div>
      </div>

      {/* FILTROS (cortan TODO el panel, incluidas las secciones CRM) */}
      <div style={S.filterBar}>
        <select style={S.select} value={campFilter} onChange={e => { setCampFilter(e.target.value); setAdFilter('') }}>
          <option value="">Todas las campañas</option>
          {m.campOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={S.select} value={adFilter} onChange={e => setAdFilter(e.target.value)}>
          <option value="">Todos los anuncios</option>
          {m.adOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select style={S.select} value={chanFilter} onChange={e => setChanFilter(e.target.value)}>
          <option value="">Mensajería + Formulario</option>
          <option value="messaging">Solo mensajería</option>
          <option value="leadform">Solo formulario</option>
        </select>
        {m.anyFilter && (
          <button style={S.btnGhost} onClick={() => { setCampFilter(''); setAdFilter(''); setChanFilter('') }}>Limpiar</button>
        )}
      </div>

      {m.anyFilter && (
        <div style={{ ...S.note, borderColor: 'var(--accent)', color: 'var(--accent)' }}>
          Filtro activo — todo el panel (incluidas las métricas CRM) muestra solo los leads atribuidos a esta selección. Los leads sin atribución Meta quedan fuera.
        </div>
      )}

      {importCount > 0 && (
        <div style={S.note}>
          {importCount.toLocaleString()} leads del import masivo (sin atribución de campaña) quedan fuera de este panel.
        </div>
      )}

      {/* ── SEÑALES EJECUTIVAS (qué hacer, no solo qué pasó) ── */}
      {m.senales.length > 0 && (
        <div style={S.senalWrap}>
          <div style={S.senalHead}>Señales · acciones sugeridas</div>
          {m.senales.map((s, i) => (
            <div key={i} style={{ ...S.senal, ...(s.kind === 'warn' ? S.senalWarn : s.kind === 'good' ? S.senalGood : S.senalInfo) }}>
              <span style={S.senalDot}>{s.kind === 'warn' ? '!' : s.kind === 'good' ? '✓' : 'i'}</span>
              <span>{s.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* RESUMEN */}
      <SectionLabel>Resumen</SectionLabel>
      <div style={S.kpiRow}>
        <Kpi label="Leads (período)" value={m.totalLeads} color="var(--text-primary)" />
        <Kpi label="Inversión paga" value={`${pct(m.pagasLeads, m.totalLeads)}`} sub={`${m.pagasLeads} leads · ${pct(m.digitalLeads, m.totalLeads)} digital`} color="var(--accent)" raw />
        <Kpi label="Citas generadas" value={m.citAgendadas + m.citCumplidas + m.citNoShow} color="#9B7DF0" />
        <Kpi label="Ganados" value={m.totalGanados} sub={`${m.totalPerdidos} perdidos`} color="#15A06E" />
        <Kpi label="Win rate" value={`${m.winRate}%`} color={m.winRate >= 25 ? '#15A06E' : 'var(--warn)'} raw />
        <Kpi label="Pipeline activo" value={fmtMoney(m.pipelineActivo)} color="var(--text-primary)" raw />
      </div>

      {/* ── INVERSIÓN (Meta Ads · canal: Meta) ── */}
      <SectionLabel>Inversión · Meta Ads</SectionLabel>
      {!m.meta.hasData ? (
        <section style={S.card}>
          <div style={S.empty}>
            Sin datos de Meta para este período. El worker autocore-meta-insights trae los últimos 28 días;
            si elegiste un rango mayor verás solo lo disponible.
          </div>
        </section>
      ) : (
        <>
          <div style={S.kpiRow}>
            <Kpi label="Gasto total" value={fmtMoney2(m.meta.spend)} color="var(--accent)" raw />
            <Kpi label="Impresiones" value={m.meta.impr} color="var(--text-primary)" />
            <Kpi label="Clicks" value={m.meta.clicks} sub={`CTR ${m.meta.ctr.toFixed(2)}%`} color="var(--text-primary)" />
            <Kpi label="Leads (Meta)" value={m.meta.leads} color="#15A06E" />
            <Kpi label="Costo / lead" value={m.meta.cpl != null ? fmtMoney2(m.meta.cpl) : '—'} color="var(--text-primary)" raw />
            <Kpi label="Conversaciones" value={m.meta.msg} sub={m.meta.cpMsg != null ? `${fmtMoney2(m.meta.cpMsg)} c/u` : undefined} color="#9B7DF0" />
          </div>
          {m.meta.dateMin && (
            <div style={S.note}>Datos Meta: {m.meta.dateMin} → {m.meta.dateMax}. Gasto en USD, reportado por Ads Manager.</div>
          )}

          <section style={S.card}>
            <div style={S.cardTitle}>Gasto diario</div>
            <MetaSpendChart daily={m.metaDaily} />
          </section>

          <section style={S.card}>
            <div style={S.cardTitle}>Gasto por campaña</div>
            <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 640 }}>
            <div style={S.tHead}>
              <span style={{ flex: 2.4 }}>Campaña</span>
              <span style={S.tNum}>Gasto</span>
              <span style={S.tNum}>Impr.</span>
              <span style={S.tNum}>Clicks</span>
              <span style={S.tNum}>CTR</span>
              <span style={S.tNum}>Leads</span>
              <span style={S.tNum}>C/Lead</span>
              <span style={S.tNum}>Conv.</span>
              <span style={S.tNum}>CRM</span>
            </div>
            {m.metaCampanas.map((c, i) => (
              <div key={i} style={S.tRow}>
                <span style={{ flex: 2.4, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.name}>{c.name}</span>
                <span style={{ ...S.tNum, fontWeight: 700, color: 'var(--accent)' }}>{fmtMoney2(c.spend)}</span>
                <span style={S.tNum}>{c.impr.toLocaleString()}</span>
                <span style={S.tNum}>{c.clicks.toLocaleString()}</span>
                <span style={S.tNum}>{c.ctr.toFixed(1)}%</span>
                <span style={{ ...S.tNum, color: '#15A06E', fontWeight: 700 }}>{c.leads}</span>
                <span style={S.tNum}>{c.cpl != null ? fmtMoney2(c.cpl) : '—'}</span>
                <span style={S.tNum}>{c.msg}</span>
                <span style={{ ...S.tNum, color: c.crmLeads > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>{c.crmLeads}</span>
              </div>
            ))}
            </div></div>
            <div style={S.note}>"Leads" y "Conv." son los que reporta Meta. "CRM" = leads que entraron a AutoCore por ese anuncio (vía meta_ad_id); la diferencia suele ser leads de formulario que van a Kommo.</div>
          </section>

          <section style={S.card}>
            <div style={S.cardTitle}>Gasto por anuncio (top 12)</div>
            <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 560 }}>
            <div style={S.tHead}>
              <span style={{ flex: 2 }}>Anuncio</span>
              <span style={{ flex: 1.6 }}>Campaña</span>
              <span style={S.tNum}>Gasto</span>
              <span style={S.tNum}>CTR</span>
              <span style={S.tNum}>Leads</span>
              <span style={S.tNum}>C/Lead</span>
              <span style={S.tNum}>CRM</span>
            </div>
            {m.metaAnuncios.slice(0, 12).map((a, i) => (
              <div key={i} style={S.tRow}>
                <span style={{ flex: 2, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>{a.name}</span>
                <span style={{ flex: 1.6, color: 'var(--text-muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.camp}>{a.camp}</span>
                <span style={{ ...S.tNum, fontWeight: 700, color: 'var(--accent)' }}>{fmtMoney2(a.spend)}</span>
                <span style={S.tNum}>{a.ctr.toFixed(1)}%</span>
                <span style={{ ...S.tNum, color: '#15A06E' }}>{a.leads}</span>
                <span style={S.tNum}>{a.cpl != null ? fmtMoney2(a.cpl) : '—'}</span>
                <span style={{ ...S.tNum, color: a.crmLeads > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>{a.crmLeads}</span>
              </div>
            ))}
            </div></div>
          </section>

          {m.fatiga.length > 0 && (
            <section style={{ ...S.card, border: '1px solid var(--warn)' }}>
              <div style={{ ...S.cardTitle, color: 'var(--warn)' }}>Fatiga de creativos · {m.fatiga.length} anuncio{m.fatiga.length > 1 ? 's' : ''}</div>
              <div style={S.note}>Frecuencia media ≥ 2.8: el mismo público ve el anuncio demasiadas veces. Suele subir el CPM y caer el CTR — momento de refrescar creativo o ampliar público.</div>
              {m.fatiga.slice(0, 6).map((a, i) => (
                <div key={i} style={S.tRow}>
                  <span style={{ flex: 2, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>{a.name}</span>
                  <span style={{ ...S.tNum, color: 'var(--warn)', fontWeight: 700 }}>{a.freq != null ? a.freq.toFixed(1) + '×' : '—'}</span>
                  <span style={S.tNum}>{a.ctr.toFixed(1)}% CTR</span>
                  <span style={{ ...S.tNum, fontWeight: 700, color: 'var(--accent)' }}>{fmtMoney2(a.spend)}</span>
                </div>
              ))}
            </section>
          )}

          <SectionLabel>Audiencia · quién ve y responde tus anuncios</SectionLabel>
          <section style={S.card}>
            <div style={S.cardTitle}>Por edad y género</div>
            <DemographicPyramid rows={m.demoPyramid} />
          </section>
          <div style={S.bdGrid}>
            <RankedViz title="Por ubicación (placement)" rows={m.bdPlacement.slice(0, 8)}
              hint="Plataforma × posición. La ubicación con menor costo por lead es hacia dónde mover presupuesto." />
            <RankedViz title="Por región" rows={m.bdRegion.slice(0, 8)}
              hint="Meta no asigna región a todas las impresiones; suma menos que el gasto total." />
          </div>
        </>
      )}

      {/* ── COSTO DE ADQUISICIÓN (gasto Meta ↔ leads CRM atribuidos) ── */}
      <SectionLabel>Costo de adquisición</SectionLabel>
      {!m.meta.hasData ? (
        <section style={S.card}>
          <div style={S.empty}>
            Sin gasto de Meta en el período: no hay costo de adquisición que calcular.
            El volumen y la conversión de los leads están en las secciones de más abajo.
          </div>
        </section>
      ) : (
        <section style={S.card}>
          <div style={S.cardTitle}>Por campaña — gasto, CPL, costo por cita y por venta</div>
          <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 640 }}>
          <div style={S.tHead}>
            <span style={{ flex: 2.4 }}>Campaña</span>
            <span style={S.tNum}>Gasto</span>
            <span style={S.tNum}>Leads</span>
            <span style={S.tNum}>CPL</span>
            <span style={S.tNum}>Citas</span>
            <span style={S.tNum}>$/Cita</span>
            <span style={S.tNum}>Ganados</span>
            <span style={S.tNum}>CPA</span>
            <span style={S.tNum}>% HOT</span>
          </div>
          {m.acqRows.map((c, i) => (
            <div key={i} style={S.tRow}>
              <span style={{ flex: 2.4, fontWeight: 600, color: c.isOrganic ? 'var(--text-muted)' : 'var(--text-primary)', fontStyle: c.isOrganic ? 'italic' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.name}>{c.name}</span>
              <span style={{ ...S.tNum, fontWeight: 700, color: c.spend > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>{c.spend > 0 ? fmtMoney2(c.spend) : '—'}</span>
              <span style={{ ...S.tNum, fontWeight: 700, color: 'var(--text-primary)' }}>{c.leads}</span>
              <span style={S.tNum}>{c.cpl != null ? fmtMoney2(c.cpl) : '—'}</span>
              <span style={{ ...S.tNum, color: '#9B7DF0' }}>{c.citas}</span>
              <span style={S.tNum}>{c.costPorCita != null ? fmtMoney2(c.costPorCita) : '—'}</span>
              <span style={{ ...S.tNum, color: '#15A06E', fontWeight: 700 }}>{c.ganados}</span>
              <span style={S.tNum}>{c.cpa != null ? fmtMoney2(c.cpa) : '—'}</span>
              <span style={{ ...S.tNum, color: c.leads > 0 && c.hotPct >= 40 ? '#15A06E' : 'var(--text-secondary)' }}>{c.leads > 0 ? c.hotPct + '%' : '—'}</span>
            </div>
          ))}
          {/* TOTALES — costo solo sobre campañas pagas; el bucket orgánico no diluye */}
          <div style={{ ...S.tRow, borderTop: '2px solid var(--border)', borderBottom: 'none' }}>
            <span style={{ flex: 2.4, fontWeight: 800, color: 'var(--text-primary)' }}>Total (campañas pagas)</span>
            <span style={{ ...S.tNum, fontWeight: 800, color: 'var(--accent)' }}>{fmtMoney2(m.acqTotals.spend)}</span>
            <span style={{ ...S.tNum, fontWeight: 800, color: 'var(--text-primary)' }}>{m.acqTotals.leads}</span>
            <span style={{ ...S.tNum, fontWeight: 700 }}>{m.acqTotals.cpl != null ? fmtMoney2(m.acqTotals.cpl) : '—'}</span>
            <span style={{ ...S.tNum, fontWeight: 700, color: '#9B7DF0' }}>{m.acqTotals.citas}</span>
            <span style={{ ...S.tNum, fontWeight: 700 }}>{m.acqTotals.costPorCita != null ? fmtMoney2(m.acqTotals.costPorCita) : '—'}</span>
            <span style={{ ...S.tNum, fontWeight: 800, color: '#15A06E' }}>{m.acqTotals.ganados}</span>
            <span style={{ ...S.tNum, fontWeight: 700 }}>{m.acqTotals.cpa != null ? fmtMoney2(m.acqTotals.cpa) : '—'}</span>
            <span style={{ ...S.tNum, fontWeight: 700 }}>{m.acqTotals.leads > 0 ? m.acqTotals.hotPct + '%' : '—'}</span>
          </div>
          </div></div>
          <div style={S.note}>
            Atribución: se une <code style={S.code}>meta_ad_id</code> del lead al anuncio (ad_id) y, si no, <code style={S.code}>campana</code> al nombre de campaña. Los leads sin ninguno caen en "Orgánico / sin atribución"{m.acqTotals.organicLeads > 0 ? ` (${m.acqTotals.organicLeads})` : ''}. Los totales de costo (CPL, $/Cita, CPA) usan solo campañas pagas, para no diluir con leads orgánicos. Citas (cita_agendada) y ganados (cerrado_ganado) provienen de crm_etapa_log en el rango. Sin ROAS: la atribución de ingreso (venta → monto del negocio) aún no está cableada.
            {m.acqSpendSinLeads > 0 && ` ${fmtMoney2(m.acqSpendSinLeads)} en gasto sin leads CRM atribuidos (${m.acqSinLeadsCount} campaña${m.acqSinLeadsCount > 1 ? 's' : ''}).`}
          </div>
        </section>
      )}

      <SectionLabel>Adquisición · canales y tendencia</SectionLabel>

      {/* CANALES */}
      <section style={S.card}>
        <div style={S.cardTitle}>Rendimiento por canal</div>
        <div style={S.legendRow}>
          <span style={S.legendItem}><span style={{ ...S.dot, background: 'var(--accent)' }} /> Paga / social-ad</span>
          <span style={S.legendItem}><span style={{ ...S.dot, background: 'var(--text-muted)' }} /> Orgánica / directa</span>
        </div>
        <div style={{ overflowX: 'auto' }}><div style={{ minWidth: 600 }}>
        <div style={S.tHead}>
          <span style={{ flex: 2 }}>Canal</span>
          <span style={S.tNum}>Leads</span>
          <span style={S.tNum}>Share</span>
          <span style={S.tNum}>Citas</span>
          <span style={S.tNum}>Ganados</span>
          <span style={S.tNum}>Win</span>
          <span style={S.tNum}>AI</span>
          <span style={{ ...S.tNum, flex: 1.3 }}>Pipeline</span>
        </div>
        {m.porFuente.length === 0 && <div style={S.empty}>Sin leads en el período.</div>}
        {m.porFuente.map(x => (
          <div key={x.fuente} style={S.tRow}>
            <span style={{ flex: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ ...S.dot, background: fMeta(x.fuente).color }} />
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fMeta(x.fuente).label}</span>
              {x.paid && <span style={S.tagPaid}>PAGA</span>}
            </span>
            <span style={{ ...S.tNum, fontWeight: 700, color: 'var(--text-primary)' }}>{x.leads}</span>
            <span style={S.tNum}>{x.share}%</span>
            <span style={S.tNum}>{x.citas}</span>
            <span style={{ ...S.tNum, color: '#15A06E', fontWeight: 700 }}>{x.ganados}</span>
            <span style={{ ...S.tNum, color: x.winPct >= 25 ? '#15A06E' : 'var(--text-secondary)' }}>{x.winPct}%</span>
            <span style={S.tNum}>{x.aiAvg ?? '—'}</span>
            <span style={{ ...S.tNum, flex: 1.3, color: 'var(--text-secondary)' }}>{fmtMoney(x.pipeline)}</span>
          </div>
        ))}
        </div></div>
        <div style={{ marginTop: 10 }}>
          {m.porFuente.map(x => (
            <div key={x.fuente} style={S.barRow}>
              <div style={S.barLabel}>{fMeta(x.fuente).label}</div>
              <div style={S.barTrack}>
                <div style={{ ...S.barFill, width: `${Math.round(100 * x.leads / maxFuente)}%`, background: fMeta(x.fuente).color }} />
              </div>
              <div style={S.barMetaSm}>{x.leads}</div>
            </div>
          ))}
        </div>
      </section>

      {/* TENDENCIA */}
      <section style={S.card}>
        <div style={S.cardTitle}>Tendencia de leads — paga vs orgánica</div>
        <TrendChart buckets={m.buckets} max={maxTrend} bucketDays={m.bucketDays} />
      </section>

      {/* CAMPAÑAS META */}
      <section style={S.card}>
        <div style={S.cardTitle}>Campañas pagas (Meta Click-to-WhatsApp)</div>
        {m.porCampana.length === 0 ? (
          <div style={S.empty}>
            Aún no hay leads con campaña atribuida. Aparecerán aquí cuando los anuncios de Meta
            etiqueten <code style={S.code}>campana</code> y <code style={S.code}>meta_ad_id</code> vía Click-to-WhatsApp.
          </div>
        ) : (
          <>
            <div style={S.tHead}>
              <span style={{ flex: 2.2 }}>Campaña</span>
              <span style={S.tNum}>Leads</span>
              <span style={S.tNum}>Ganados</span>
              <span style={S.tNum}>Win</span>
              <span style={S.tNum}>Close AI</span>
              <span style={{ flex: 1.4 }}>Top modelo</span>
            </div>
            {m.porCampana.map(c => (
              <div key={c.campana} style={S.tRow}>
                <span style={{ flex: 2.2, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.campana}</span>
                <span style={{ ...S.tNum, fontWeight: 700, color: 'var(--text-primary)' }}>{c.leads}</span>
                <span style={{ ...S.tNum, color: '#15A06E', fontWeight: 700 }}>{c.ganados}</span>
                <span style={S.tNum}>{c.winPct}%</span>
                <span style={S.tNum}>{c.closeProb != null ? c.closeProb + '%' : '—'}</span>
                <span style={{ flex: 1.4, color: 'var(--text-secondary)', fontSize: 12 }}>{c.topModelo}</span>
              </div>
            ))}
          </>
        )}
        {m.porAnuncio.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div style={{ ...S.cardTitle, fontSize: 12 }}>Anuncios con más leads</div>
            <div style={S.tHead}>
              <span style={{ flex: 2 }}>Ad ID</span>
              <span style={{ flex: 1.6 }}>Campaña</span>
              <span style={S.tNum}>Leads</span>
              <span style={S.tNum}>Ganados</span>
              <span style={S.tNum}>Win</span>
            </div>
            {m.porAnuncio.map(a => (
              <div key={a.adId} style={S.tRow}>
                <span style={{ flex: 2, color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.adId}</span>
                <span style={{ flex: 1.6, color: 'var(--text-muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.campana}</span>
                <span style={{ ...S.tNum, fontWeight: 700, color: 'var(--text-primary)' }}>{a.leads}</span>
                <span style={{ ...S.tNum, color: '#15A06E' }}>{a.ganados}</span>
                <span style={S.tNum}>{a.winPct}%</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* DEMANDA POR MODELO */}
      {m.porModelo.length > 0 && (
        <section style={S.card}>
          <div style={S.cardTitle}>Demanda por modelo — qué pide cada lead</div>
          <div style={S.tHead}>
            <span style={{ flex: 2 }}>Modelo</span>
            <span style={S.tNum}>Leads</span>
            <span style={S.tNum}>Ganados</span>
            <span style={{ flex: 1.4 }}>Canal dominante</span>
          </div>
          {m.porModelo.map(x => (
            <div key={x.modelo} style={S.tRow}>
              <span style={{ flex: 2, fontWeight: 600, color: 'var(--text-primary)' }}>{x.modelo}</span>
              <span style={{ ...S.tNum, fontWeight: 700, color: 'var(--text-primary)' }}>{x.leads}</span>
              <span style={{ ...S.tNum, color: '#15A06E' }}>{x.ganados}</span>
              <span style={{ flex: 1.4, color: 'var(--text-secondary)', fontSize: 12 }}>{fMeta(x.topFuente).label}</span>
            </div>
          ))}
        </section>
      )}

      <SectionLabel>Embudo y ventas</SectionLabel>

      <div style={S.kpiRow}>
        <Kpi label="Gasto Meta" value={m.meta.hasData ? fmtMoney2(m.meta.spend) : '—'} color="var(--accent)" raw />
        <Kpi label="Leads Meta → CRM" value={m.metaCampanas.reduce((s, c) => s + c.crmLeads, 0)} color="var(--text-primary)" />
        <Kpi label="Ventas atribuidas" value={m.metaGanados} sub="vía meta_ad_id" color="#15A06E" />
        <Kpi label="Costo por venta" value={m.costPerSale != null ? fmtMoney2(m.costPerSale) : '—'} sub={m.costPerSale == null ? 'sin ventas aún' : 'gasto ÷ ventas Meta'} color="var(--text-primary)" raw />
        <Kpi label="Costo por lead" value={m.meta.cpl != null ? fmtMoney2(m.meta.cpl) : '—'} color="var(--text-primary)" raw />
        <Kpi label="Win rate" value={`${m.winRate}%`} color={m.winRate >= 25 ? '#15A06E' : 'var(--warn)'} raw />
      </div>
      <div style={S.note}>Costo por venta = gasto Meta ÷ ventas cerradas atribuidas a un anuncio (vía meta_ad_id). Este cierre real es lo que las plataformas externas no pueden calcular, porque no son dueñas del CRM.</div>

      <div style={S.grid2}>
        {/* EMBUDO */}
        <section style={S.card}>
          <div style={S.cardTitle}>Embudo de conversión</div>
          {m.funnel.map((x, i) => {
            const prev = i > 0 ? m.funnel[i - 1].reached : x.reached
            const conv = prev > 0 ? Math.round(100 * x.reached / prev) : 100
            return (
              <div key={x.stage} style={S.barRow}>
                <div style={S.barLabel}>{x.label}</div>
                <div style={S.barTrack}>
                  <div style={{ ...S.barFill, width: `${Math.round(100 * x.reached / funnelTop)}%`, background: etapaInfo(x.stage).color }} />
                </div>
                <div style={S.barMeta}>
                  <span style={S.barNum}>{x.reached}</span>
                  {i > 0 && <span style={{ ...S.barSub, color: conv < 50 ? 'var(--danger)' : 'var(--text-muted)' }}>{conv}% pasa</span>}
                </div>
              </div>
            )
          })}
        </section>

        {/* VELOCIDAD */}
        <section style={S.card}>
          <div style={S.cardTitle}>Velocidad y citas</div>
          <Metric label="Speed-to-lead (mediana 1ª resp.)" value={fmtMins(m.speedMedian)} hint={m.speedMedian == null ? 'Sin datos de mensajes aún' : `${m.speedUnder5}% < 5min · ${m.speedUnder60}% < 1h`} />
          <Metric label="Respuestas de Claudia (bot)" value={`${m.botShare}%`} hint="del total de salientes" />
          <Metric label="Días a cierre (mediana)" value={m.diasCierre != null ? `${Math.round(m.diasCierre)} d` : '—'} />
          <Metric label="Show-rate de citas" value={m.citTotal ? `${m.showRate}%` : '—'} hint={`${m.citCumplidas} cumplidas · ${m.citNoShow} no-show · ${m.citCanceladas} canceladas`} />
        </section>
      </div>

      {/* TEMPERATURA */}
      <section style={S.card}>
        <div style={S.cardTitle}>Temperatura del pipeline activo</div>
        <div style={S.tempRow}>
          <TempBar label="Caliente" n={m.tBuckets.caliente} total={tTotal} color="var(--heat-hot)" />
          <TempBar label="Tibio" n={m.tBuckets.tibio} total={tTotal} color="var(--heat-warm)" />
          <TempBar label="Frío" n={m.tBuckets.frio} total={tTotal} color="var(--heat-cold)" />
          <TempBar label="Inactivo" n={m.tBuckets.inactivo} total={tTotal} color="var(--text-muted)" />
        </div>
      </section>

      <SectionLabel>Equipo y riesgo</SectionLabel>

      {/* RIESGO */}
      <div style={S.kpiRow3}>
        <RiskCard label="Hot leads sin gestionar" value={m.hotUnattended} danger={m.hotUnattended > 0} hint="AI ≥ 80, sin primer contacto" />
        <RiskCard label="Activos fríos (3d+ sin contacto)" value={m.frios} danger={m.frios > 0} hint="requieren seguimiento" />
        <RiskCard label="Activos sin asignar" value={m.sinAsignar} danger={m.sinAsignar > 0} hint="sin ejecutivo responsable" />
      </div>

      {/* LEADERBOARD */}
      <section style={S.card}>
        <div style={S.cardTitle}>Ranking de ejecutivos (período)</div>
        <div style={S.tHead}>
          <span style={{ flex: 2 }}>Ejecutivo</span>
          <span style={S.tNum}>Leads</span>
          <span style={S.tNum}>Citas</span>
          <span style={S.tNum}>Activos</span>
          <span style={S.tNum}>Ganados</span>
          <span style={S.tNum}>Win</span>
        </div>
        {m.execs.length === 0 && <div style={S.empty}>Sin actividad asignada en el período.</div>}
        {m.execs.map((x, i) => (
          <div key={x.nombre} style={S.tRow}>
            <span style={{ flex: 2, fontWeight: 600, color: 'var(--text-primary)' }}>
              {i < 3 && <span style={{ marginRight: 6 }}>{['🥇', '🥈', '🥉'][i]}</span>}{x.nombre}
            </span>
            <span style={S.tNum}>{x.leads}</span>
            <span style={S.tNum}>{x.citas}</span>
            <span style={S.tNum}>{x.activos}</span>
            <span style={{ ...S.tNum, color: '#15A06E', fontWeight: 700 }}>{x.ganados}</span>
            <span style={S.tNum}>{x.winPct}%</span>
          </div>
        ))}
      </section>

      {/* RAZONES DE PÉRDIDA */}
      {m.perdidasRazones.length > 0 && (
        <section style={S.card}>
          <div style={S.cardTitle}>Razones de pérdida — dónde corregir</div>
          {m.perdidasRazones.map(x => {
            const top = Math.max(1, ...m.perdidasRazones.map(r => r.n))
            return (
              <div key={x.motivo} style={S.barRow}>
                <div style={{ ...S.barLabel, width: 200 }}>{x.motivo}</div>
                <div style={S.barTrack}>
                  <div style={{ ...S.barFill, width: `${Math.round(100 * x.n / top)}%`, background: 'var(--danger)' }} />
                </div>
                <div style={S.barMetaSm}>{x.n}</div>
              </div>
            )
          })}
        </section>
      )}

      <div style={{ ...S.note, marginTop: 8 }}>
        Transiciones (citas, ganados, días a cierre) provienen de crm_etapa_log, que acumula desde 2026-06-11.
        El gasto de Meta (meta_ad_insights) alimenta CPL y CPA por campaña en "Costo de adquisición"; no se calcula ROAS porque la atribución de ingreso (venta → monto) aún no está cableada.
      </div>
    </Shell>
  )
}

// ── Subcomponentes ────────────────────────────────────────────────────────────
function Kpi({ label, value, sub, color, raw }: { label: string; value: number | string; sub?: string; color: string; raw?: boolean }) {
  return (
    <div style={S.kpi}>
      <div style={{ ...S.kpiNum, color }}>{raw ? value : (typeof value === 'number' ? value.toLocaleString() : value)}</div>
      <div style={S.kpiLabel}>{label}</div>
      {sub && <div style={S.kpiSub}>{sub}</div>}
    </div>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={S.metricRow}>
      <div>
        <div style={S.metricLabel}>{label}</div>
        {hint && <div style={S.metricHint}>{hint}</div>}
      </div>
      <div style={S.metricVal}>{value}</div>
    </div>
  )
}

function RiskCard({ label, value, danger, hint }: { label: string; value: number; danger: boolean; hint: string }) {
  return (
    <div style={{ ...S.kpi, border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`, background: danger ? 'rgba(229,85,106,0.06)' : 'var(--bg-card)' }}>
      <div style={{ ...S.kpiNum, color: danger ? 'var(--danger)' : 'var(--text-muted)' }}>{value}</div>
      <div style={S.kpiLabel}>{label}</div>
      <div style={S.kpiSub}>{hint}</div>
    </div>
  )
}

function TempBar({ label, n, total, color }: { label: string; n: number; total: number; color: string }) {
  const p = total > 0 ? Math.round(100 * n / total) : 0
  return (
    <div style={{ flex: 1, textAlign: 'center' }}>
      <div style={{ height: 90, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{ width: 40, height: `${Math.max(4, p)}%`, background: color, borderRadius: '6px 6px 0 0', transition: 'height 0.3s' }} />
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>{n}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p}%</div>
    </div>
  )
}

function TrendChart({ buckets, max, bucketDays }: { buckets: { paid: number; otros: number; label: string }[]; max: number; bucketDays: number }) {
  const W = 720, H = 200, padB = 26, padL = 4
  const n = buckets.length
  const gap = 3
  const bw = Math.max(3, (W - padL * 2) / n - gap)
  const chartH = H - padB
  const everyLabel = Math.ceil(n / 12)
  return (
    <div>
      <div style={{ ...S.legendRow, marginBottom: 6 }}>
        <span style={S.legendItem}><span style={{ ...S.dot, background: 'var(--accent)' }} /> Paga</span>
        <span style={S.legendItem}><span style={{ ...S.dot, background: 'var(--text-muted)' }} /> Orgánica</span>
        <span style={{ ...S.legendItem, marginLeft: 'auto', color: 'var(--text-muted)' }}>{bucketDays === 1 ? 'por día' : 'por semana'}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
        {buckets.map((b, i) => {
          const x = padL + i * (bw + gap)
          const totH = Math.round((b.paid + b.otros) / max * chartH)
          const paidH = Math.round(b.paid / max * chartH)
          const otrosH = totH - paidH
          const yTop = chartH - totH
          return (
            <g key={i}>
              {otrosH > 0 && <rect x={x} y={chartH - otrosH} width={bw} height={otrosH} fill="var(--text-muted)" opacity={0.5} rx={2} />}
              {paidH > 0 && <rect x={x} y={yTop} width={bw} height={paidH} fill="var(--accent)" rx={2} />}
              {i % everyLabel === 0 && (
                <text x={x + bw / 2} y={H - 8} fontSize={10} fill="var(--text-muted)" textAnchor="middle">{b.label}</text>
              )}
            </g>
          )
        })}
        <line x1={padL} y1={chartH} x2={W - padL} y2={chartH} stroke="var(--border)" strokeWidth={1} />
      </svg>
    </div>
  )
}

function MetaSpendChart({ daily }: { daily: { fecha: string; spend: number; leads: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const n = Math.max(1, daily.length)
  const max = Math.max(1, ...daily.map(d => d.spend))
  const total = daily.reduce((s, d) => s + d.spend, 0)
  const fmtFecha = (iso: string) => { const [y, mo, d] = iso.split('-'); return `${d}/${mo}/${y}` }
  return (
    <div>
      <div style={{ ...S.legendRow, marginBottom: 6 }}>
        <span style={S.legendItem}><span style={{ ...S.dot, background: 'var(--accent)' }} /> Gasto diario (USD)</span>
        <span style={{ ...S.legendItem, marginLeft: 'auto', color: 'var(--text-muted)' }}>Total {fmtMoney2(total)}</span>
      </div>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 2, height: 180, paddingTop: 30 }}>
        {daily.map((d, i) => {
          const h = Math.max(2, Math.round(d.spend / max * 150))
          const active = hover === i
          return (
            <div key={i}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              style={{ flex: 1, minWidth: 2, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', cursor: 'pointer' }}>
              <div style={{ width: '100%', height: h, background: active ? 'var(--text-primary)' : 'var(--accent)', borderRadius: '3px 3px 0 0', transition: 'background 0.1s', opacity: hover != null && !active ? 0.55 : 1 }} />
            </div>
          )
        })}
        {hover != null && daily[hover] && (
          <div style={{
            position: 'absolute', top: 0,
            left: `${((hover + 0.5) / n) * 100}%`, transform: 'translateX(-50%)',
            background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 8,
            padding: '6px 10px', pointerEvents: 'none', whiteSpace: 'nowrap',
            boxShadow: '0 6px 20px rgba(0,0,0,0.32)', zIndex: 5,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{fmtFecha(daily[hover].fecha)}</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--accent)' }}>{fmtMoney2(daily[hover].spend)}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{daily[hover].leads} leads (Meta)</div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
        <span>{daily[0]?.fecha.slice(5) || ''}</span>
        <span>{daily[daily.length - 1]?.fecha.slice(5) || ''}</span>
      </div>
    </div>
  )
}

interface BdRow { label: string; spend: number; impr: number; clicks: number; leads: number; msg: number; ctr: number; cpl: number | null }

function DemographicPyramid({ rows }: { rows: { age: string; mSpend: number; fSpend: number; mCpl: number | null; fCpl: number | null }[] }) {
  if (!rows.length) return <div style={S.note}>Sin datos demográficos para este período o filtro.</div>
  const max = Math.max(1, ...rows.map(r => Math.max(r.mSpend, r.fSpend)))
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 24, fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
        <span style={S.legendItem}><span style={{ ...S.dot, background: '#4C82F7' }} /> Hombres</span>
        <span style={S.legendItem}><span style={{ ...S.dot, background: '#E0598B' }} /> Mujeres</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 56px 1fr', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.mCpl != null ? fmtMoney2(r.mCpl) : ''}</span>
            <div style={{ height: 18, borderRadius: '3px 0 0 3px', background: '#4C82F7', width: `${Math.max(2, Math.round(100 * r.mSpend / max))}%` }} />
          </div>
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-secondary)' }}>{r.age}</div>
          <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: 8 }}>
            <div style={{ height: 18, borderRadius: '0 3px 3px 0', background: '#E0598B', width: `${Math.max(2, Math.round(100 * r.fSpend / max))}%` }} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.fCpl != null ? fmtMoney2(r.fCpl) : ''}</span>
          </div>
        </div>
      ))}
      <div style={S.note}>Barras = gasto por segmento; el monto al lado es el costo por lead (cuando hay leads). Hombres a la izquierda, mujeres a la derecha.</div>
    </div>
  )
}

function RankedViz({ title, rows, hint }: { title: string; rows: BdRow[]; hint?: string }) {
  const max = Math.max(1, ...rows.map(r => r.spend))
  const withCpl = rows.filter(r => r.cpl != null && r.spend > 0)
  const bestCpl = withCpl.length ? Math.min(...withCpl.map(r => r.cpl as number)) : null
  const worstCpl = withCpl.length ? Math.max(...withCpl.map(r => r.cpl as number)) : null
  return (
    <section style={S.card}>
      <div style={S.cardTitle}>{title}</div>
      {rows.length === 0 ? (
        <div style={S.note}>Sin datos para este período o filtro.</div>
      ) : (
        <>
          {rows.map((r, i) => {
            const isBest = r.cpl != null && r.cpl === bestCpl
            const isWorst = r.cpl != null && r.cpl === worstCpl && worstCpl !== bestCpl
            const cplColor = isBest ? '#15A06E' : isWorst ? 'var(--warn)' : 'var(--text-primary)'
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ width: 110, flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>{r.label}</span>
                <div style={{ flex: 1, height: 16, background: 'var(--bg-deep)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 3, background: isBest ? '#15A06E' : 'var(--accent)', width: `${Math.max(2, Math.round(100 * r.spend / max))}%` }} />
                </div>
                <span style={{ width: 64, flexShrink: 0, textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}>{fmtMoney2(r.spend)}</span>
                <span style={{ width: 56, flexShrink: 0, textAlign: 'right', fontSize: 12, fontWeight: 600, color: cplColor }}>{r.cpl != null ? fmtMoney2(r.cpl) : '—'}</span>
              </div>
            )
          })}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            <span>Gasto</span><span style={{ width: 8 }} /><span>Costo/lead</span>
          </div>
          {hint && <div style={S.note}>{hint}</div>}
        </>
      )}
    </section>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={S.sectionLabel}>{children}</div>
}

function Shell({ children, live, lastSync }: { children: React.ReactNode; live: boolean; lastSync: Date | null }) {
  return (
    <CrmShell active="campanas" maxWidth={1100}>
      <div style={S.liveBar}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: live ? 'var(--ok)' : 'var(--text-muted)', boxShadow: live ? '0 0 0 3px rgba(52,211,153,0.18)' : 'none', animation: live ? 'pulse 2s infinite' : 'none' }} />
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: live ? 'var(--ok)' : 'var(--text-muted)' }}>{live ? 'EN VIVO' : 'CONECTANDO…'}</span>
        </span>
        {lastSync && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Actualizado {lastSync.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
      </div>
      {children}
      <style>{`@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,0.35)}70%{box-shadow:0 0 0 6px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}`}</style>
    </CrmShell>
  )
}

// ── Estilos ──────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  liveBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  eyebrow: { fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  title: { fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0 0', fontFamily: 'var(--font-inter), Inter, sans-serif' },
  muted: { color: 'var(--text-muted)', fontSize: 14, padding: '40px 0', textAlign: 'center' },
  note: { fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, fontStyle: 'italic', lineHeight: 1.5 },
  code: { background: 'var(--bg-deep)', padding: '1px 5px', borderRadius: 4, fontSize: 11, fontFamily: 'monospace' },

  chip: { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  chipOn: { background: 'var(--accent-soft)', borderColor: 'var(--accent-border)', color: 'var(--accent)' },
  dateInput: { padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 12, fontFamily: 'inherit' },
  select: { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', maxWidth: 260 },
  filterBar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 14px' },
  bdGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 },
  senalWrap: { display: 'flex', flexDirection: 'column', gap: 6, margin: '4px 0 8px' },
  senalHead: { fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 2 },
  senal: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', borderRadius: 10, fontSize: 13, lineHeight: 1.4, border: '1px solid var(--border)' },
  senalWarn: { background: 'rgba(212,142,30,0.10)', borderColor: 'rgba(212,142,30,0.35)', color: 'var(--text-primary)' },
  senalGood: { background: 'rgba(21,160,110,0.10)', borderColor: 'rgba(21,160,110,0.35)', color: 'var(--text-primary)' },
  senalInfo: { background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text-primary)' },
  senalDot: { flexShrink: 0, width: 20, height: 20, borderRadius: 999, background: 'var(--bg-deep)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, marginTop: 1 },
  btnGhost: { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', minWidth: 38 },

  sectionLabel: { fontSize: 12, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '24px 0 12px', paddingBottom: 6, borderBottom: '1px solid var(--border)' },

  kpiRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 8 },
  kpiRow3: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 },
  kpi: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' },
  kpiNum: { fontSize: 24, fontWeight: 800, lineHeight: 1.05, fontFamily: 'var(--font-inter), Inter, sans-serif' },
  kpiLabel: { fontSize: 10, color: 'var(--text-muted)', marginTop: 6, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' },
  kpiSub: { fontSize: 11, color: 'var(--text-muted)', marginTop: 3 },

  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 16 },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', marginBottom: 16 },
  cardTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14, letterSpacing: '0.02em' },

  legendRow: { display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' },
  legendItem: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 },
  dot: { width: 9, height: 9, borderRadius: '50%', flexShrink: 0, display: 'inline-block' },
  tagPaid: { fontSize: 9, fontWeight: 800, letterSpacing: '0.05em', color: 'var(--accent)', background: 'var(--accent-soft)', padding: '1px 5px', borderRadius: 4 },

  tHead: { display: 'flex', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  tRow: { display: 'flex', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--text-secondary)' },
  tNum: { flex: 1, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  empty: { fontSize: 12, color: 'var(--text-muted)', padding: '14px 4px', fontStyle: 'italic', lineHeight: 1.6 },

  barRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' },
  barLabel: { width: 130, flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 },
  barTrack: { flex: 1, height: 20, background: 'var(--bg-deep)', borderRadius: 6, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 6, minWidth: 2, transition: 'width 0.3s' },
  barMeta: { width: 110, flexShrink: 0, textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 1 },
  barMetaSm: { width: 44, flexShrink: 0, textAlign: 'right', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' },
  barNum: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' },
  barSub: { fontSize: 11, color: 'var(--text-muted)' },

  metricRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderBottom: '1px solid var(--border)', gap: 12 },
  metricLabel: { fontSize: 13, color: 'var(--text-secondary)', fontWeight: 600 },
  metricHint: { fontSize: 11, color: 'var(--text-muted)', marginTop: 2 },
  metricVal: { fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },

  tempRow: { display: 'flex', gap: 12, alignItems: 'flex-end' },
}