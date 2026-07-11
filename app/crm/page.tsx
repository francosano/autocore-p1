// TARGET: autocore-npa/app/crm/page.tsx
'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../supabase'
import CrmShell from './CrmShell'
import { useNPAPermissions } from '../components/useNPAPermissions'
import LeadDetailModal from './LeadDetailModal'
import { FUENTES_SELECTABLE, fuenteLabel } from './fuentes'

const ETAPAS = [
  { key: 'nuevo',              label: 'Nuevo Lead',        color: '#8A93A0' },
  { key: 'contactado',         label: 'Contactado',        color: '#5A8DEE' },
  { key: 'cita_agendada',      label: 'Cita Agendada',     color: '#9B7DF0' },
  { key: 'visita_showroom',    label: 'Visita Showroom',   color: '#E0A23C' },
  { key: 'oferta_presentada',  label: 'Oferta Presentada', color: '#E5689A' },
  { key: 'financiamiento',     label: 'Financiamiento',    color: '#2FBF8F' },
  { key: 'cerrado_ganado',     label: 'Vendido',           color: '#15A06E' },
  { key: 'cerrado_perdido',    label: 'Perdido',            color: '#E5556A' },
]

const PIPELINE_ETAPAS = ETAPAS.filter(e => !['cerrado_ganado','cerrado_perdido'].includes(e.key))

const MODELOS_KIA = [
  'KIA Picanto','KIA Soluto','KIA Rio Stylus','KIA Sonet','KIA Seltos',
  'KIA Sportage','KIA Sorento','KIA Carnival','KIA Stinger','KIA Pregio','Otro',
]

const RESULTADOS = [
  { key: 'contactado',    label: 'Contactado' },
  { key: 'no_contesta',   label: 'No contesta' },
  { key: 'buzon',         label: 'Buzón de voz' },
  { key: 'reagendo',      label: 'Reagendó' },
  { key: 'no_interesado', label: 'No interesado' },
  { key: 'interesado',    label: 'Muy interesado' },
]

const TIPO_ICONS: Record<string, string> = {
  llamada: '📞', whatsapp: '💬', visita: '🚗',
  email: '📧', nota: '📝', cita: '📅',
}

interface Lead {
  id: string
  nombre: string
  apellidos: string
  cedula?: string
  cedula_prefix?: string
  telefono: string
  email?: string
  fuente: string
  referido_por?: string
  asignado_a?: string
  asignado_nombre?: string
  modelo_interes?: string
  presupuesto_usd?: number
  color_preferido?: string
  tiene_vehiculo?: boolean
  vehiculo_actual?: string
  etapa: string
  motivo_perdido?: string
  heat_score: number
  ultimo_contacto?: string
  contacted_at?: string | null
  esperando_contacto_at?: string | null
  frio_at?: string | null
  ai_score?: number | null
  archived_at?: string | null
  proxima_accion?: string
  proxima_accion_at?: string
  notas?: string
  created_at: string
  updated_at: string
}

interface Actividad {
  id: string
  lead_id: string
  tipo: string
  descripcion: string
  resultado?: string
  created_by?: string
  created_at: string
}

interface Conversation {
  id: string
  lead_id: string
  wa_phone: string
  status: string
  bot_active: boolean
  bot_mode: string
  assigned_to: string | null
  assigned_nombre: string | null
  unread_count: number
  last_message_at: string
  last_message_preview: string
  crm_leads?: any
}

interface Message {
  id: string
  conversation_id: string
  lead_id: string
  direction: 'in' | 'out'
  content: string
  status: string
  sent_by: string
  sent_by_nombre?: string
  is_bot: boolean
  created_at: string
}

const ETAPA_COLORS_MAP: Record<string, string> = {
  nuevo: '#8A93A0', contactado: '#5A8DEE', cita_agendada: '#9B7DF0',
  visita_showroom: '#E0A23C', oferta_presentada: '#E5689A',
  financiamiento: '#2FBF8F', cerrado_ganado: '#15A06E', cerrado_perdido: '#E5556A',
}

const fmt = (d: string) => {
  if (!d) return '—'
  const dt = new Date(d)
  return dt.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const fmtFull = (d: string) => {
  if (!d) return ''
  return new Date(d).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const fmtTime = (iso: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diffDays === 0) return d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'Ayer'
  if (diffDays < 7) return d.toLocaleDateString('es-VE', { weekday: 'short' })
  return d.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit' })
}

const daysSince = (iso?: string) => {
  if (!iso) return 999
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

const calcHeat = (lead: Lead): number => {
  let score = 50
  const dias = daysSince(lead.ultimo_contacto)
  if (dias === 0) score += 20
  else if (dias <= 1) score += 10
  else if (dias <= 3) score += 0
  else if (dias <= 7) score -= 15
  else if (dias <= 14) score -= 30
  else score -= 45
  const etapaBonus: Record<string, number> = {
    nuevo: -5, contactado: 0, cita_agendada: 10,
    visita_showroom: 20, oferta_presentada: 25, financiamiento: 30,
  }
  score += etapaBonus[lead.etapa] ?? 0
  if (lead.fuente === 'referido') score += 10
  if (lead.presupuesto_usd && lead.presupuesto_usd >= 20000) score += 10
  if (lead.proxima_accion_at && new Date(lead.proxima_accion_at) < new Date()) score -= 10
  return Math.max(0, Math.min(100, score))
}

const heatColor = (score: number) => {
  if (score >= 75) return '#F0556A'
  if (score >= 50) return '#E6A23C'
  if (score >= 25) return '#57A6C9'
  return '#7B8694'
}

const heatLabel = (score: number) => {
  if (score >= 75) return 'Caliente'
  if (score >= 50) return 'Tibio'
  if (score >= 25) return 'Frío'
  return 'Inactivo'
}

const etapaInfo = (key: string) => ETAPAS.find(e => e.key === key) ?? ETAPAS[0]
const waPhone = (tel: string) => tel.replace(/\D/g, '')

const WORKER_URL = 'https://autocore-whatsapp.sano-franco.workers.dev'

async function logStageChange(leadId: string, from: string | null, to: string, userId?: string | null) {
  if (!to || from === to) return
  try {
    await supabase.from('crm_stage_history').insert({
      lead_id: leadId, from_etapa: from || null, to_etapa: to, source: 'user', changed_by: userId || null,
    })
  } catch { /* no-op */ }
}

function HeatBadge({ score }: { score: number }) {
  const color = heatColor(score)
  return (
    <span style={{
      fontSize: '11px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif',
      letterSpacing: '0.06em', padding: '3px 10px', borderRadius: '10px',
      background: color + '22', color, border: '1px solid ' + color + '44',
    }}>
      {score}
    </span>
  )
}

function EtapaBadge({ etapa }: { etapa: string }) {
  const info = etapaInfo(etapa)
  return (
    <span style={{
      fontSize: '11px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif',
      letterSpacing: '0.05em', padding: '3px 10px', borderRadius: '4px',
      background: info.color + '22', color: info.color,
    }}>
      {info.label}
    </span>
  )
}

export default function CRMPage() {
  const router = useRouter()
  const { permissions, loading: permsLoading, userId } = useNPAPermissions()

  const [leads, setLeads] = useState<Lead[]>([])
  const [actividades, setActividades] = useState<Actividad[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'pipeline' | 'leads' | 'leaderboard' | 'chats'>('pipeline')
  const [totalLeads, setTotalLeads] = useState(0)

  const [showNewLead, setShowNewLead] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [showAI, setShowAI] = useState(false)
  const [aiLead, setAiLead] = useState<Lead | null>(null)

  const [filterEtapa, setFilterEtapa] = useState('')
  const [filterVendedor, setFilterVendedor] = useState('')
  const [filterSearch, setFilterSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [crmUsers, setCrmUsers] = useState<{ user_id: string, full_name: string, crm_role: string }[]>([])

  // Chats state
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [msgLoading, setMsgLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [inputText, setInputText] = useState('')
  const [filterConvStatus, setFilterConvStatus] = useState<'all' | 'open' | 'pending' | 'resolved'>('open')
  const [convSearch, setConvSearch] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.push('/')
    })
  }, [router])

  useEffect(() => {
    if (!permsLoading && !permissions.npa_can_view_crm) router.push('/dashboard')
  }, [permsLoading, permissions, router])

  const loadData = useCallback(async () => {
    setLoading(true)
    const leadsQuery = supabase.from('crm_leads').select('*', { count: 'exact' }).order('updated_at', { ascending: false })
    if (!showArchived) leadsQuery.is('archived_at', null)
    const [{ data: leadsData, count }, { data: actData }, { data: usersData }] = await Promise.all([
      leadsQuery.limit(1000),
      supabase.from('crm_actividades').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('user_roles').select('user_id, full_name, crm_role').eq('npa_can_view_crm', true).eq('is_active', true),
    ])
    setLeads(leadsData || [])
    // Mantener el lead abierto en el modal sincronizado con los datos frescos
    // (si no, 'Marcar contactado' y otras ediciones no se ven sin refrescar).
    setSelectedLead(prev => prev ? ((leadsData || []).find((l: any) => l.id === prev.id) || prev) : prev)
    setTotalLeads(count || 0)
    setActividades(actData || [])
    setCrmUsers((usersData || []).filter((u: any) => u.full_name))
    setLoading(false)
  }, [showArchived])

  useEffect(() => { loadData() }, [loadData])

  // Abrir directamente el detalle de un lead si llega ?search_lead=<id> o ?lead=<id>
  // (p. ej. "Ver lead" desde el calendario, o "Ver →" desde Pendientes/Supervisor).
  // Busca el lead por id, así funciona aunque no esté entre los 1.000 cargados.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const leadId = params.get('search_lead') || params.get('lead')
    if (!leadId) return
    let active = true
    ;(async () => {
      const { data } = await supabase.from('crm_leads').select('*').eq('id', leadId).maybeSingle()
      if (active && data) { setSelectedLead(data as any); setShowDetail(true) }
    })()
    return () => { active = false }
  }, [])

  const loadConversations = useCallback(async () => {
    const { data } = await supabase
      .from('crm_conversations')
      .select('*, crm_leads(id, nombre, apellidos, telefono, modelo_interes, etapa, heat_score, asignado_nombre, fuente)')
      .order('last_message_at', { ascending: false })
    setConversations(data || [])
  }, [])

  useEffect(() => {
    if (tab === 'chats') loadConversations()
  }, [tab, loadConversations])

  useEffect(() => {
    if (tab !== 'chats') return // la suscripción es solo para la pestaña Chats; evita remontar el modal del lead al enviar
    let channel: any = null
    try {
      channel = supabase.channel('crm_chats_main')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'crm_conversations' }, () => loadConversations())
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crm_mensajes' }, (payload: any) => {
          const msg = payload.new as Message
          if (selectedConv && msg.conversation_id === selectedConv.id) {
            setMessages(prev => [...prev, msg])
            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
          }
          loadConversations()
        })
        .subscribe()
    } catch (e) {}
    return () => { if (channel) supabase.removeChannel(channel) }
  }, [selectedConv, loadConversations, tab])

  const loadMessages = useCallback(async (convId: string) => {
    setMsgLoading(true)
    const { data } = await supabase.from('crm_mensajes').select('*').eq('conversation_id', convId).order('created_at', { ascending: true })
    setMessages(data || [])
    setMsgLoading(false)
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
  }, [])

  const selectConversation = async (conv: Conversation) => {
    setSelectedConv(conv)
    await loadMessages(conv.id)
    await supabase.from('crm_conversations').update({ unread_count: 0 }).eq('id', conv.id)
    setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, unread_count: 0 } : c))
  }

  const sendMessage = async () => {
    if (!inputText.trim() || !selectedConv || sending) return
    const text = inputText.trim()
    setInputText('')
    setSending(true)
    try {
      const res = await fetch(WORKER_URL + '/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: selectedConv.id, lead_id: selectedConv.lead_id, to: selectedConv.wa_phone, message: text, sent_by: userId || 'agent', sent_by_nombre: 'Agente' })
      })
      const result = await res.json()
      if (!result.success) throw new Error('Worker failed')
    } catch {
      await supabase.from('crm_mensajes').insert({ conversation_id: selectedConv.id, lead_id: selectedConv.lead_id, direction: 'out', content: text, status: 'sent', sent_by: userId || 'agent', sent_by_nombre: 'Agente', is_bot: false })
      await supabase.from('crm_conversations').update({ last_message_at: new Date().toISOString(), last_message_preview: text.substring(0, 100) }).eq('id', selectedConv.id)
      loadMessages(selectedConv.id)
      loadConversations()
    }
    setSending(false)
  }

  const toggleBot = async (active: boolean) => {
    if (!selectedConv) return
    await supabase.from('crm_conversations').update({ bot_active: active, bot_mode: active ? 'full' : 'off' }).eq('id', selectedConv.id)
    setSelectedConv(prev => prev ? { ...prev, bot_active: active } : null)
    setConversations(prev => prev.map(c => c.id === selectedConv.id ? { ...c, bot_active: active } : c))
  }

  const filteredLeads = leads.filter(l => {
    if (filterEtapa && l.etapa !== filterEtapa) return false
    if (filterVendedor && l.asignado_nombre !== filterVendedor) return false
    if (filterSearch) {
      const q = filterSearch.toLowerCase()
      if (!`${l.nombre} ${l.apellidos} ${l.telefono} ${l.modelo_interes || ''}`.toLowerCase().includes(q)) return false
    }
    return true
  })

  const S = {
    overlay: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 200, display: 'flex', alignItems: 'stretch', justifyContent: 'center' },
    input: { background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '6px', padding: '9px 12px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', width: '100%' },
    label: { fontSize: '10px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.1em', color: 'var(--text-muted)', textTransform: 'uppercase' as const },
    field: { display: 'flex', flexDirection: 'column' as const, gap: '5px' },
    btnPrimary: { background: 'var(--accent-solid)', border: 'none', borderRadius: '6px', padding: '10px 20px', color: '#fff', fontSize: '13px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.06em', cursor: 'pointer' },
    btnSecondary: { background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', padding: '8px 16px', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif', cursor: 'pointer' },
    modal: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' },
    modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid var(--border)' },
    modalTitle: { fontSize: '14px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.08em', color: 'var(--text-primary)' },
    closeBtn: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px', padding: '4px 8px', lineHeight: 1 },
  }

  // ─── NEW LEAD MODAL ────────────────────────────────────────────────────────
  function NewLeadModal() {
    const [form, setForm] = useState({
      nombre: '', apellidos: '', cedula_prefix: 'V', cedula: '',
      telefono: '', email: '', fuente: 'walk_in', referido_por: '',
      modelo_interes: '', presupuesto_usd: '', color_preferido: '',
      tiene_vehiculo: false, vehiculo_actual: '', asignado_a: '', notas: '',
    })
    const [saving, setSaving] = useState(false)
    const inp = (field: string, value: string | boolean) => setForm(p => ({ ...p, [field]: value }))
    const save = async () => {
      if (!form.nombre || !form.apellidos || !form.telefono) return
      setSaving(true)
      // asignado_a (UUID) es la fuente de verdad; el nombre se deriva de la
      // MISMA fila de user_roles para que nunca queden desparejados.
      const asg = crmUsers.find(u => u.user_id === form.asignado_a)
      await supabase.from('crm_leads').insert({
        nombre: form.nombre.trim(), apellidos: form.apellidos.trim(),
        cedula_prefix: form.cedula_prefix, cedula: form.cedula.trim() || null,
        telefono: form.telefono.trim(), email: form.email.trim() || null,
        fuente: form.fuente, referido_por: form.referido_por.trim() || null,
        modelo_interes: form.modelo_interes || null,
        presupuesto_usd: form.presupuesto_usd ? parseFloat(form.presupuesto_usd) : null,
        color_preferido: form.color_preferido.trim() || null,
        tiene_vehiculo: form.tiene_vehiculo, vehiculo_actual: form.vehiculo_actual.trim() || null,
        asignado_a: asg?.user_id || null, asignado_nombre: asg?.full_name || null, notas: form.notas.trim() || null,
        etapa: 'nuevo', heat_score: 50, created_by: userId,
        ultimo_contacto: new Date().toISOString(),
      })
      setSaving(false); setShowNewLead(false); loadData()
    }
    return (
      <div style={S.overlay}>
        <div style={{ ...S.modal, maxWidth: '620px', margin: 'auto', maxHeight: '90vh', overflow: 'auto' }}>
          <div style={S.modalHeader}>
            <span style={S.modalTitle}>NUEVO LEAD</span>
            <button style={S.closeBtn} onClick={() => setShowNewLead(false)}>✕</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', padding: '24px' }}>
            <div style={S.field}><label style={S.label}>NOMBRE *</label><input style={S.input} value={form.nombre} onChange={e => inp('nombre', e.target.value)} placeholder="Nombre" /></div>
            <div style={S.field}><label style={S.label}>APELLIDOS *</label><input style={S.input} value={form.apellidos} onChange={e => inp('apellidos', e.target.value)} placeholder="Apellidos" /></div>
            <div style={S.field}>
              <label style={S.label}>CÉDULA</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <select style={{ ...S.input, width: '70px' }} value={form.cedula_prefix} onChange={e => inp('cedula_prefix', e.target.value)}>
                  {['V','E','J','G','P'].map(p => <option key={p}>{p}</option>)}
                </select>
                <input style={{ ...S.input, flex: 1 }} value={form.cedula} onChange={e => inp('cedula', e.target.value)} placeholder="12345678" />
              </div>
            </div>
            <div style={S.field}><label style={S.label}>TELÉFONO *</label><input style={S.input} value={form.telefono} onChange={e => inp('telefono', e.target.value)} placeholder="+58 424-0000000" /></div>
            <div style={S.field}><label style={S.label}>EMAIL</label><input style={S.input} value={form.email} onChange={e => inp('email', e.target.value)} /></div>
            <div style={S.field}>
              <label style={S.label}>FUENTE</label>
              <select style={S.input} value={form.fuente} onChange={e => inp('fuente', e.target.value)}>
                {FUENTES_SELECTABLE.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </div>
            {form.fuente === 'referido' && (
              <div style={{ ...S.field, gridColumn: 'span 2' }}><label style={S.label}>REFERIDO POR</label><input style={S.input} value={form.referido_por} onChange={e => inp('referido_por', e.target.value)} /></div>
            )}
            <div style={S.field}>
              <label style={S.label}>MODELO</label>
              <select style={S.input} value={form.modelo_interes} onChange={e => inp('modelo_interes', e.target.value)}>
                <option value="">-- Seleccionar --</option>
                {MODELOS_KIA.map(m => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div style={S.field}><label style={S.label}>PRESUPUESTO (USD)</label><input style={S.input} type="number" value={form.presupuesto_usd} onChange={e => inp('presupuesto_usd', e.target.value)} placeholder="25000" /></div>
            <div style={S.field}><label style={S.label}>COLOR PREFERIDO</label><input style={S.input} value={form.color_preferido} onChange={e => inp('color_preferido', e.target.value)} placeholder="Blanco, Negro..." /></div>
            <div style={S.field}><label style={S.label}>ASIGNAR A</label>
              <select style={S.input} value={form.asignado_a} onChange={e => inp('asignado_a', e.target.value)}>
                <option value="">-- Sin asignar --</option>
                {crmUsers.map(u => <option key={u.user_id} value={u.user_id}>{u.full_name}</option>)}
              </select>
            </div>
            <div style={{ ...S.field, gridColumn: 'span 2' }}>
              <label style={{ ...S.label, marginBottom: '6px' }}>¿TIENE VEHÍCULO ACTUAL?</label>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '13px' }}>
                  <input type="checkbox" checked={form.tiene_vehiculo} onChange={e => inp('tiene_vehiculo', e.target.checked)} />
                  Sí
                </label>
                {form.tiene_vehiculo && <input style={{ ...S.input, flex: 1 }} value={form.vehiculo_actual} onChange={e => inp('vehiculo_actual', e.target.value)} placeholder="Ej: Toyota Corolla 2018" />}
              </div>
            </div>
            <div style={{ ...S.field, gridColumn: 'span 2' }}><label style={S.label}>NOTAS</label><textarea style={{ ...S.input, minHeight: '80px', resize: 'vertical' }} value={form.notas} onChange={e => inp('notas', e.target.value)} /></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', padding: '0 24px 24px' }}>
            <button style={S.btnSecondary} onClick={() => setShowNewLead(false)}>Cancelar</button>
            <button style={S.btnPrimary} onClick={save} disabled={saving}>{saving ? 'Guardando...' : 'Crear Lead'}</button>
          </div>
        </div>
      </div>
    )
  }


  // ─── AI MODAL ─────────────────────────────────────────────────────────────
  function AIModal({ lead }: { lead: Lead }) {
    const [output, setOutput] = useState('')
    const [aiLoading, setAiLoading] = useState(false)
    const [context, setContext] = useState('')
    const generate = async () => {
      setAiLoading(true); setOutput('')
      const dias = daysSince(lead.ultimo_contacto)
      const prompt = 'Eres un experto en ventas de automóviles KIA en Venezuela, entrenado con técnicas de Andy Elliott.\nGenera un talk track específico y personalizado para este lead.\n\nDATOS:\n- Nombre: ' + lead.nombre + ' ' + lead.apellidos + '\n- Etapa: ' + etapaInfo(lead.etapa).label + '\n- Modelo: ' + (lead.modelo_interes || 'Sin definir') + '\n- Presupuesto: ' + (lead.presupuesto_usd ? '$' + lead.presupuesto_usd.toLocaleString() : 'No especificado') + '\n- Fuente: ' + fuenteLabel(lead.fuente) + '\n- Días sin contacto: ' + (dias === 999 ? 'Nunca' : dias) + '\n- Vehículo actual: ' + (lead.tiene_vehiculo ? (lead.vehiculo_actual || 'Sí') : 'No') + '\n- Notas: ' + (lead.notas || 'Ninguna') + '\n- Contexto: ' + (context || 'Ninguno') + '\n\nFormato: Script principal → Objeciones → Cierre'
      try {
        const res = await fetch('https://autocore-crm-bot.sano-franco.workers.dev/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'chat', messages: [{ role: 'user', content: prompt }] }),
        })
        const data = await res.json()
        setOutput(data.content?.[0]?.text || data.response || 'Error generando el talk track.')
      } catch { setOutput('Error conectando con el servidor de IA.') }
      setAiLoading(false)
    }
    return (
      <div style={S.overlay}>
        <div style={{ ...S.modal, maxWidth: '680px', margin: 'auto', maxHeight: '90vh', overflow: 'auto' }}>
          <div style={S.modalHeader}>
            <div>
              <div style={S.modalTitle}>🤖 TALK TRACK IA</div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{lead.nombre} {lead.apellidos} · {etapaInfo(lead.etapa).label}</div>
            </div>
            <button style={S.closeBtn} onClick={() => setShowAI(false)}>✕</button>
          </div>
          <div style={{ padding: '24px' }}>
            <div style={{ ...S.field, marginBottom: '16px' }}>
              <label style={S.label}>CONTEXTO ADICIONAL</label>
              <textarea style={{ ...S.input, marginTop: '6px', minHeight: '70px', resize: 'vertical' }} value={context} onChange={e => setContext(e.target.value)} placeholder="Ej: El cliente quiere comparar con Toyota." />
            </div>
            <button style={{ ...S.btnPrimary, width: '100%', marginBottom: '20px', padding: '12px' }} onClick={generate} disabled={aiLoading}>
              {aiLoading ? '✨ Generando script...' : '✨ Generar Talk Track'}
            </button>
            {output && (
              <div style={{ background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '8px', padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '14px' }}>
                  <span style={S.label}>SCRIPT GENERADO</span>
                  <button style={{ ...S.btnSecondary, fontSize: '11px', padding: '3px 10px' }} onClick={() => navigator.clipboard.writeText(output)}>Copiar</button>
                </div>
                <pre style={{ fontSize: '14px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', fontFamily: 'inherit', lineHeight: 1.7, margin: 0 }}>{output}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ─── PIPELINE VIEW ────────────────────────────────────────────────────────
  function PipelineView() {
    const [draggedId, setDraggedId] = useState<string | null>(null)
    const [dragOverEtapa, setDragOverEtapa] = useState<string | null>(null)

    const handleDrop = async (e: React.DragEvent, etapaKey: string) => {
      e.preventDefault()
      if (!draggedId) return
      const lead = leads.find(l => l.id === draggedId)
      if (!lead || lead.etapa === etapaKey) { setDraggedId(null); setDragOverEtapa(null); return }
      await supabase.from('crm_leads').update({ etapa: etapaKey, heat_score: calcHeat({ ...lead, etapa: etapaKey }) }).eq('id', draggedId)
      logStageChange(draggedId, lead.etapa, etapaKey, userId)
      setDraggedId(null); setDragOverEtapa(null); loadData()
    }

    return (
      <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '12px' }}>
        {PIPELINE_ETAPAS.map(etapa => {
          const etapaLeads = filteredLeads.filter(l => l.etapa === etapa.key)
          const totalVal = etapaLeads.reduce((s, l) => s + (l.presupuesto_usd || 0), 0)
          const isDragOver = dragOverEtapa === etapa.key
          return (
            <div key={etapa.key} style={{ minWidth: '220px', flex: '0 0 220px' }}
              onDragOver={e => { e.preventDefault(); setDragOverEtapa(etapa.key) }}
              onDrop={e => handleDrop(e, etapa.key)}
              onDragLeave={() => setDragOverEtapa(null)}
            >
              <div style={{ background: isDragOver ? etapa.color + '18' : 'var(--bg-card)', border: '1px solid ' + (isDragOver ? etapa.color : 'var(--border)'), borderTop: '3px solid ' + etapa.color, borderRadius: '6px', padding: '10px 12px', marginBottom: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '10px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.08em', color: etapa.color }}>{etapa.label.toUpperCase()}</span>
                  <span style={{ fontSize: '12px', fontWeight: 600, background: etapa.color + '22', color: etapa.color, borderRadius: '10px', padding: '1px 8px' }}>{etapaLeads.length}</span>
                </div>
                {totalVal > 0 && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>${totalVal.toLocaleString()}</div>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '80px', border: isDragOver ? '2px dashed ' + etapa.color : '2px dashed transparent', borderRadius: '6px', padding: isDragOver ? '6px' : '0' }}>
                {etapaLeads.map(lead => (
                  <div key={lead.id} draggable
                    onDragStart={e => { setDraggedId(lead.id); e.dataTransfer.effectAllowed = 'move' }}
                    onDragEnd={() => { setDraggedId(null); setDragOverEtapa(null) }}
                    onClick={() => { if (!draggedId) { setSelectedLead(lead); setShowDetail(true) } }}
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', padding: '12px', cursor: 'grab', opacity: draggedId === lead.id ? 0.4 : 1 }}
                    onMouseEnter={e => { if (!draggedId) e.currentTarget.style.borderColor = etapa.color + '88' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{lead.nombre} {lead.apellidos}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        {typeof lead.ai_score === 'number' && <span title="Probabilidad de cierre (IA)" style={{ fontSize: '10px', fontWeight: 700, color: '#9B7DF0', background: 'rgba(155,125,240,0.14)', padding: '2px 6px', borderRadius: '99px' }}>IA {lead.ai_score}</span>}
                        <HeatBadge score={lead.heat_score} />
                      </div>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>{lead.modelo_interes || 'Modelo TBD'}</div>
                    {lead.presupuesto_usd && <div style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 600 }}>${lead.presupuesto_usd.toLocaleString()}</div>}
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '10px', color: 'var(--text-muted)' }}>
                      <span>{fuenteLabel(lead.fuente)}</span>
                      <span>{lead.asignado_nombre || 'Sin asignar'}</span>
                    </div>
                    {lead.telefono && !lead.telefono.startsWith('kommo_') && (
                      <a href={'https://wa.me/' + waPhone(lead.telefono)} target="_blank" rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 600, textDecoration: 'none', display: 'inline-block', marginTop: '6px' }}>
                        💬 WhatsApp
                      </a>
                    )}
                    {lead.ultimo_contacto && (
                      <div style={{ fontSize: '10px', color: daysSince(lead.ultimo_contacto) > 3 ? 'var(--danger)' : 'var(--text-muted)', marginTop: '4px' }}>
                        {daysSince(lead.ultimo_contacto) === 0 ? 'Hoy' : 'Hace ' + daysSince(lead.ultimo_contacto) + 'd'}
                      </div>
                    )}
                    {lead.proxima_accion_at && new Date(lead.proxima_accion_at) < new Date() && (
                      <div style={{ fontSize: '10px', color: 'var(--danger)', fontWeight: 600, marginTop: '2px' }}>⚠ Acción vencida</div>
                    )}
                  </div>
                ))}
                {etapaLeads.length === 0 && (
                  <div style={{ fontSize: '11px', color: isDragOver ? etapa.color : 'var(--text-muted)', textAlign: 'center', padding: '20px 0', border: '1px dashed ' + (isDragOver ? etapa.color : 'var(--border)'), borderRadius: '6px' }}>
                    {isDragOver ? 'Soltar aquí' : 'Sin leads'}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  // ─── LEADS TABLE ──────────────────────────────────────────────────────────
  function LeadsView() {
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['CLIENTE', 'MODELO', 'FUENTE', 'ETAPA', 'HEAT', 'ÚLTIMO CONTACTO', 'ASIGNADO', ''].map(h => (
                <th key={h} style={{ fontSize: '10px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.1em', color: 'var(--text-muted)', padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid var(--border)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredLeads.map(lead => (
              <tr key={lead.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                onClick={() => { setSelectedLead(lead); setShowDetail(true) }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-deep)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '12px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{lead.nombre} {lead.apellidos}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{lead.telefono.startsWith('kommo_') ? '—' : lead.telefono}</div>
                </td>
                <td style={{ padding: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>{lead.modelo_interes || '—'}</td>
                <td style={{ padding: '12px', fontSize: '11px', color: 'var(--text-muted)' }}>{fuenteLabel(lead.fuente)}</td>
                <td style={{ padding: '12px' }}><EtapaBadge etapa={lead.etapa} /></td>
                <td style={{ padding: '12px' }}><HeatBadge score={lead.heat_score} /></td>
                <td style={{ padding: '12px', fontSize: '11px', color: daysSince(lead.ultimo_contacto) > 3 ? 'var(--danger)' : 'var(--text-muted)' }}>
                  {lead.ultimo_contacto ? (daysSince(lead.ultimo_contacto) === 0 ? 'Hoy' : 'Hace ' + daysSince(lead.ultimo_contacto) + 'd') : '—'}
                </td>
                <td style={{ padding: '12px', fontSize: '11px', color: 'var(--text-secondary)' }}>{lead.asignado_nombre || '—'}</td>
                <td style={{ padding: '12px' }}>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {lead.telefono && !lead.telefono.startsWith('kommo_') && (
                      <a href={'https://wa.me/' + waPhone(lead.telefono)} target="_blank" rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}>💬</a>
                    )}
                    <button style={{ ...S.btnSecondary, fontSize: '11px', padding: '3px 10px' }}
                      onClick={e => { e.stopPropagation(); setAiLead(lead); setShowAI(true) }}>🤖 IA</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredLeads.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: '13px' }}>No hay leads con los filtros seleccionados</div>
        )}
        {totalLeads > 1000 && (
          <div style={{ textAlign: 'center', padding: '16px', color: 'var(--text-muted)', fontSize: '12px', borderTop: '1px solid var(--border)' }}>
            Mostrando 1,000 de {totalLeads.toLocaleString()} leads · Usa los filtros para encontrar leads específicos
          </div>
        )}
      </div>
    )
  }

  // ─── CHATS VIEW ───────────────────────────────────────────────────────────
  function ChatsView() {
    const filteredConvs = conversations.filter(c => {
      const l = c.crm_leads as any
      const matchStatus = filterConvStatus === 'all' || c.status === filterConvStatus
      const matchSearch = !convSearch || (l?.nombre + ' ' + l?.apellidos + ' ' + c.wa_phone + ' ' + (l?.modelo_interes || '')).toLowerCase().includes(convSearch.toLowerCase())
      return matchStatus && matchSearch
    })
    const totalUnread = conversations.reduce((s, c) => s + (c.unread_count || 0), 0)
    const convLead = selectedConv?.crm_leads as any

    return (
      <div style={{ display: 'flex', height: 'calc(100vh - 180px)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
        {/* Móvil (<1024px): un panel a la vez — lista O conversación; el panel
            de lead se oculta. pcx-back solo existe en móvil (vuelve a la lista). */}
        <style>{`
          .pcx-back { display: none; }
          @media (max-width: 1023px) {
            .pcx-lead { display: none !important; }
            .pcx-list { width: 100% !important; border-right: none !important; }
            .pcx-list.pcx-hidden { display: none !important; }
            .pcx-main { display: none !important; }
            .pcx-main.pcx-show { display: flex !important; }
            .pcx-back { display: flex; }
          }
        `}</style>
        <div className={'pcx-list' + (selectedConv ? ' pcx-hidden' : '')} style={{ width: '300px', flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--bg-card)' }}>
          <div style={{ padding: '14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.08em', marginBottom: '10px' }}>
              CHATS WHATSAPP
              {totalUnread > 0 && <span style={{ marginLeft: '8px', background: 'var(--accent-solid)', color: '#fff', borderRadius: '10px', padding: '1px 7px', fontSize: '10px' }}>{totalUnread}</span>}
            </div>
            <input style={{ ...S.input, marginBottom: '8px' }} placeholder="🔍 Buscar..." value={convSearch} onChange={e => setConvSearch(e.target.value)} />
            <div style={{ display: 'flex', gap: '4px' }}>
              {(['all','open','pending','resolved'] as const).map(s => (
                <button key={s} onClick={() => setFilterConvStatus(s)} style={{ flex: 1, padding: '3px', borderRadius: '4px', border: 'none', cursor: 'pointer', background: filterConvStatus === s ? 'var(--accent-soft)' : 'transparent', color: filterConvStatus === s ? 'var(--accent-solid)' : 'var(--text-muted)', fontSize: '9px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif' }}>
                  {s === 'all' ? 'TODOS' : s === 'open' ? 'ABIERTO' : s === 'pending' ? 'PEND.' : 'CERRADO'}
                </button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filteredConvs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 16px', color: 'var(--text-muted)', fontSize: '12px' }}>No hay conversaciones</div>
            ) : filteredConvs.map(conv => {
              const l = conv.crm_leads as any
              const isSelected = selectedConv?.id === conv.id
              const ec = ETAPA_COLORS_MAP[l?.etapa || 'nuevo'] || 'var(--text-muted)'
              return (
                <div key={conv.id} onClick={() => selectConversation(conv)}
                  style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)', background: isSelected ? 'var(--accent-soft)' : 'transparent', borderLeft: isSelected ? '3px solid var(--accent-solid)' : '3px solid transparent' }}
                  onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-deep)' }}
                  onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '3px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: ec + '33', border: '2px solid ' + ec, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <span style={{ fontSize: '12px', fontWeight: 600, color: ec }}>{(l?.nombre || '?')[0].toUpperCase()}</span>
                      </div>
                      <div>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>{l ? l.nombre + ' ' + l.apellidos : conv.wa_phone}</div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{conv.wa_phone}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }}>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{fmtTime(conv.last_message_at)}</span>
                      {conv.unread_count > 0 && <span style={{ background: 'var(--accent)', color: '#fff', borderRadius: '10px', padding: '1px 6px', fontSize: '10px', fontWeight: 600 }}>{conv.unread_count}</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conv.last_message_preview || 'Sin mensajes'}</div>
                </div>
              )
            })}
          </div>
        </div>

        {selectedConv ? (
          <div className="pcx-main pcx-show" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button
                  className="pcx-back"
                  onClick={() => setSelectedConv(null)}
                  aria-label="Volver a la lista"
                  style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', padding: '6px 8px', color: 'var(--text-secondary)', cursor: 'pointer', alignItems: 'center' }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
                </button>
                <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: (ETAPA_COLORS_MAP[convLead?.etapa] || 'var(--text-muted)') + '33', border: '2px solid ' + (ETAPA_COLORS_MAP[convLead?.etapa] || 'var(--text-muted)'), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: ETAPA_COLORS_MAP[convLead?.etapa] || 'var(--text-muted)' }}>{(convLead?.nombre || '?')[0].toUpperCase()}</span>
                </div>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{convLead ? convLead.nombre + ' ' + convLead.apellidos : selectedConv.wa_phone}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{selectedConv.wa_phone} · {convLead?.modelo_interes || 'Modelo TBD'}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 10px', background: selectedConv.bot_active ? 'var(--accent-soft)' : 'var(--bg-deep)', borderRadius: '6px', border: '1px solid ' + (selectedConv.bot_active ? 'var(--accent-border)' : 'var(--border)') }}>
                  <span style={{ fontSize: '11px', color: selectedConv.bot_active ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 600 }}>🤖 Claudia</span>
                  <button onClick={() => toggleBot(!selectedConv.bot_active)} style={{ width: '28px', height: '16px', borderRadius: '8px', border: 'none', cursor: 'pointer', background: selectedConv.bot_active ? 'var(--accent)' : 'var(--border)', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: '2px', left: selectedConv.bot_active ? '12px' : '2px', width: '12px', height: '12px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                  </button>
                </div>
                {selectedConv.status !== 'resolved' && (
                  <button onClick={async () => { await supabase.from('crm_conversations').update({ status: 'resolved' }).eq('id', selectedConv.id); setSelectedConv(p => p ? { ...p, status: 'resolved' } : null); loadConversations() }}
                    style={{ padding: '5px 10px', background: 'var(--accent-soft)', border: '1px solid var(--accent-border)', borderRadius: '6px', color: 'var(--accent)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
                    ✓ Resolver
                  </button>
                )}
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '6px', background: 'var(--bg-page)' }}>
              {msgLoading ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>Cargando mensajes...</div>
              ) : messages.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '30px' }}>Sin mensajes aún</div>
              ) : messages.map((msg, idx) => {
                const isOut = msg.direction === 'out'
                const showDate = idx === 0 || new Date(msg.created_at).toDateString() !== new Date(messages[idx-1].created_at).toDateString()
                return (
                  <div key={msg.id}>
                    {showDate && <div style={{ textAlign: 'center', margin: '10px 0' }}><span style={{ fontSize: '10px', color: 'var(--text-muted)', background: 'var(--bg-card)', padding: '3px 10px', borderRadius: '10px', border: '1px solid var(--border)' }}>{new Date(msg.created_at).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' })}</span></div>}
                    <div style={{ display: 'flex', justifyContent: isOut ? 'flex-end' : 'flex-start', alignItems: 'flex-end', gap: '5px' }}>
                      {!isOut && <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><span style={{ fontSize: '11px' }}>👤</span></div>}
                      <div style={{ maxWidth: '60%' }}>
                        {isOut && msg.sent_by_nombre && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px', textAlign: 'right' }}>{msg.is_bot ? '🤖 Claudia' : msg.sent_by_nombre}</div>}
                        <div style={{ padding: '8px 14px', borderRadius: isOut ? '14px 3px 14px 14px' : '3px 14px 14px 14px', background: isOut ? (msg.is_bot ? 'var(--accent)' : 'var(--accent-solid)') : 'var(--bg-card)', color: isOut ? '#fff' : 'var(--text-primary)', border: isOut ? 'none' : '1px solid var(--border)', fontSize: '13px', lineHeight: 1.5 }}>
                          {msg.content}
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', textAlign: isOut ? 'right' : 'left' }}>
                          {fmtFull(msg.created_at)}
                          {isOut && <span style={{ marginLeft: '4px' }}>{msg.status === 'read' || msg.status === 'delivered' ? '✓✓' : '✓'}</span>}
                        </div>
                      </div>
                      {isOut && <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: msg.is_bot ? 'var(--accent-soft)' : 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><span style={{ fontSize: '11px' }}>{msg.is_bot ? '🤖' : '👤'}</span></div>}
                    </div>
                  </div>
                )
              })}
              <div ref={messagesEndRef} />
            </div>
            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--bg-card)' }}>
              {selectedConv.status === 'resolved' && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', textAlign: 'center' }}>
                  Conversación cerrada · <button onClick={async () => { await supabase.from('crm_conversations').update({ status: 'open' }).eq('id', selectedConv.id); setSelectedConv(p => p ? { ...p, status: 'open' } : null); loadConversations() }} style={{ color: 'var(--accent-solid)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 600 }}>Reabrir</button>
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                <textarea style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '10px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', resize: 'none', minHeight: '40px', maxHeight: '100px', lineHeight: 1.5, fontFamily: 'inherit' }}
                  placeholder="Escribe un mensaje..."
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
                  rows={1}
                  disabled={selectedConv.status === 'resolved'}
                />
                <button onClick={sendMessage} disabled={!inputText.trim() || sending || selectedConv.status === 'resolved'}
                  style={{ width: '40px', height: '40px', borderRadius: '50%', background: inputText.trim() ? 'var(--accent-solid)' : 'var(--border)', border: 'none', cursor: inputText.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="pcx-main" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-page)' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '40px', marginBottom: '12px' }}>💬</div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>WhatsApp CRM</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Selecciona una conversación</div>
            </div>
          </div>
        )}

        {selectedConv && convLead && (
          <div className="pcx-lead" style={{ width: '240px', flexShrink: 0, borderLeft: '1px solid var(--border)', background: 'var(--bg-card)', overflowY: 'auto', padding: '14px' }}>
            <div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '12px' }}>Info del Lead</div>
            <div style={{ textAlign: 'center', marginBottom: '12px', padding: '10px', background: 'var(--bg-deep)', borderRadius: '8px' }}>
              <div style={{ fontSize: '32px', fontWeight: 600, color: heatColor(convLead.heat_score), fontFamily: 'var(--font-inter), Inter, sans-serif' }}>{convLead.heat_score}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Heat Score</div>
            </div>
            {[['Nombre', convLead.nombre + ' ' + convLead.apellidos], ['Teléfono', convLead.telefono], ['Modelo', convLead.modelo_interes || '—'], ['Etapa', convLead.etapa], ['Asignado', convLead.asignado_nombre || '—']].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', fontFamily: 'var(--font-inter), Inter, sans-serif', fontWeight: 600 }}>{k}</span>
                <span style={{ fontSize: '11px', color: 'var(--text-primary)', textAlign: 'right', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
              </div>
            ))}
            <div style={{ marginTop: '12px', padding: '10px', background: selectedConv.bot_active ? 'var(--accent-soft)' : 'var(--bg-deep)', borderRadius: '8px', border: '1px solid ' + (selectedConv.bot_active ? 'var(--accent-soft)' : 'var(--border)') }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: selectedConv.bot_active ? 'var(--accent)' : 'var(--text-muted)', marginBottom: '4px' }}>🤖 {selectedConv.bot_active ? 'Claudia Activa' : 'Claudia Inactiva'}</div>
              <button onClick={() => toggleBot(!selectedConv.bot_active)} style={{ width: '100%', padding: '5px', borderRadius: '5px', border: 'none', cursor: 'pointer', background: selectedConv.bot_active ? 'rgba(240,85,106,0.14)' : 'var(--accent-soft)', color: selectedConv.bot_active ? 'var(--danger)' : 'var(--accent)', fontSize: '11px', fontWeight: 600 }}>
                {selectedConv.bot_active ? 'Desactivar' : 'Activar'}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ─── LEADERBOARD ──────────────────────────────────────────────────────────
  function LeaderboardView() {
    const now = new Date()
    const vendMap: Record<string, { nombre: string; total: number; cerrados: number; pipeline: number; leads: Lead[] }> = {}
    leads.forEach(l => {
      const name = l.asignado_nombre || 'Sin asignar'
      if (!vendMap[name]) vendMap[name] = { nombre: name, total: 0, cerrados: 0, pipeline: 0, leads: [] }
      vendMap[name].total++
      vendMap[name].leads.push(l)
      if (l.etapa === 'cerrado_ganado') vendMap[name].cerrados++
      if (!['cerrado_ganado', 'cerrado_perdido'].includes(l.etapa)) vendMap[name].pipeline += (l.presupuesto_usd || 0)
    })
    const ranking = Object.values(vendMap).sort((a, b) => b.cerrados - a.cerrados || b.pipeline - a.pipeline)
    const medals = ['🥇', '🥈', '🥉']
    return (
      <div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '20px' }}>
          Ranking · {now.toLocaleString('es-VE', { month: 'long', year: 'numeric' })}
        </div>
        <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '600px' }}>
          {ranking.map((v, i) => {
            const convRate = v.total > 0 ? Math.round((v.cerrados / v.total) * 100) : 0
            return (
              <div key={v.nombre} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderLeft: i === 0 ? '4px solid #E0A23C' : i === 1 ? '4px solid #AEB6C2' : i === 2 ? '4px solid #C07A33' : '4px solid var(--border)', borderRadius: '8px', padding: '16px 20px', display: 'grid', gridTemplateColumns: '40px 1fr repeat(4, minmax(84px, 120px))', alignItems: 'center', gap: '12px' }}>
                <div style={{ fontSize: '24px', textAlign: 'center' }}>{medals[i] || '#' + (i + 1)}</div>
                <div>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>{v.nombre}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{v.total} leads totales</div>
                </div>
                {[['CERRADOS', v.cerrados.toString(), 'var(--accent)'], ['PIPELINE', '$' + v.pipeline.toLocaleString(), 'var(--accent)'], ['CONVERSIÓN', convRate + '%', convRate >= 30 ? 'var(--accent)' : convRate >= 15 ? 'var(--warn)' : 'var(--danger)'], ['HEAT AVG', (v.leads.length > 0 ? Math.round(v.leads.reduce((s, l) => s + l.heat_score, 0) / v.leads.length) : 0).toString(), 'var(--text-muted)']].map(([label, value, color]) => (
                  <div key={label} style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '18px', fontWeight: 600, color, fontFamily: 'var(--font-inter), Inter, sans-serif' }}>{value}</div>
                    <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.1em', marginTop: '2px' }}>{label}</div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginTop: '24px' }}>
          {[['Total Leads', totalLeads.toLocaleString(), 'var(--accent)'], ['En Pipeline', leads.filter(l => !['cerrado_ganado','cerrado_perdido'].includes(l.etapa)).length.toString(), 'var(--heat-cold)'], ['Cerrados', leads.filter(l => l.etapa === 'cerrado_ganado').length.toString(), 'var(--accent)'], ['Pipeline USD', '$' + leads.filter(l => !['cerrado_ganado','cerrado_perdido'].includes(l.etapa)).reduce((s,l) => s + (l.presupuesto_usd||0), 0).toLocaleString(), 'var(--warn)']].map(([label, value, color]) => (
            <div key={label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '28px', fontWeight: 600, color, fontFamily: 'var(--font-inter), Inter, sans-serif' }}>{value}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.1em', marginTop: '4px' }}>{label}</div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (loading || permsLoading) {
    return (
      <CrmShell active="pipeline" fluid>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - 52px)', color: 'var(--text-muted)', fontSize: '13px' }}>
          Cargando CRM...
        </div>
      </CrmShell>
    )
  }

  return (
    <CrmShell active="pipeline" fluid>
      {showNewLead && <NewLeadModal />}
      {showDetail && selectedLead && <LeadDetailModal lead={selectedLead} actividades={actividades} crmUsers={crmUsers} userId={userId} S={S} onClose={() => setShowDetail(false)} onChanged={loadData} />}
      {showAI && aiLead && <AIModal lead={aiLead} />}

      <div style={{ maxWidth: '1600px', margin: '0 auto', padding: '28px 32px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.15em', color: 'var(--text-muted)', marginBottom: '6px' }}>AUTOCORE NPA · CRM</div>
            <h1 style={{ margin: 0, fontSize: '28px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.04em' }}>GESTIÓN DE LEADS</h1>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
              {totalLeads.toLocaleString()} leads totales ·{' '}
              {leads.filter(l => !['cerrado_ganado','cerrado_perdido'].includes(l.etapa)).length} activos ·{' '}
              <span style={{ color: 'var(--danger)' }}>
                {leads.filter(l => daysSince(l.ultimo_contacto) > 3 && !['cerrado_ganado','cerrado_perdido'].includes(l.etapa)).length} sin contacto +3d
              </span>
            </div>
          </div>
          <button style={S.btnPrimary} onClick={() => setShowNewLead(true)} hidden={tab === 'chats'}>+ Nuevo Lead</button>
        </div>

        <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', borderBottom: '1px solid var(--border)' }}>
          {([['pipeline','Pipeline'],['leads','Todos los Leads'],['leaderboard','Leaderboard']] as [string,string][]).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key as any)} style={{ fontFamily: 'var(--font-inter), Inter, sans-serif', fontWeight: 600, fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '10px 18px', border: 'none', borderBottom: tab === key ? '2px solid var(--accent-solid)' : '2px solid transparent', background: 'transparent', color: tab === key ? 'var(--accent-solid)' : 'var(--text-secondary)', cursor: 'pointer', marginBottom: '-1px' }}>
              {label}
            </button>
          ))}
          <button onClick={() => setTab('chats')} style={{ fontFamily: 'var(--font-inter), Inter, sans-serif', fontWeight: 600, fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '10px 18px', border: 'none', borderBottom: tab === 'chats' ? '2px solid var(--accent)' : '2px solid transparent', background: 'transparent', color: tab === 'chats' ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', marginBottom: '-1px' }}>
            💬 Chats WA
            {conversations.reduce((s, c) => s + (c.unread_count || 0), 0) > 0 && (
              <span style={{ marginLeft: '6px', background: 'var(--accent-solid)', color: '#fff', borderRadius: '10px', padding: '1px 6px', fontSize: '10px' }}>
                {conversations.reduce((s, c) => s + (c.unread_count || 0), 0)}
              </span>
            )}
          </button>
          <button onClick={() => { window.location.href = '/crm/calendario' }} style={{ fontFamily: 'var(--font-inter), Inter, sans-serif', fontWeight: 600, fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '10px 18px', border: 'none', borderBottom: '2px solid transparent', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', marginBottom: '-1px', marginLeft: 'auto' }}>
            📅 Calendario
          </button>
          <button onClick={() => { window.location.href = '/crm/recepcion' }} style={{ fontFamily: 'var(--font-inter), Inter, sans-serif', fontWeight: 600, fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '10px 18px', border: 'none', borderBottom: '2px solid transparent', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', marginBottom: '-1px' }}>
            🛎 Recepción
          </button>
          <button onClick={() => { window.location.href = '/crm/reportes' }} style={{ fontFamily: 'var(--font-inter), Inter, sans-serif', fontWeight: 600, fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '10px 18px', border: 'none', borderBottom: '2px solid transparent', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', marginBottom: '-1px' }}>
            📊 Reportes
          </button>
        </div>

        {(tab === 'pipeline' || tab === 'leads') && (
          <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <input style={{ ...S.input, width: '220px' }} placeholder="🔍 Buscar lead..." value={filterSearch} onChange={e => setFilterSearch(e.target.value)} />
            <select style={{ ...S.input, width: '160px' }} value={filterEtapa} onChange={e => setFilterEtapa(e.target.value)}>
              <option value="">Todas las etapas</option>
              {ETAPAS.map(e => <option key={e.key} value={e.key}>{e.label}</option>)}
            </select>
            <select style={{ ...S.input, width: '160px' }} value={filterVendedor} onChange={e => setFilterVendedor(e.target.value)}>
              <option value="">Todos los vendedores</option>
              {[...new Set(leads.map(l => l.asignado_nombre).filter(Boolean))].map(n => (
                <option key={n} value={n!}>{n}</option>
              ))}
            </select>
            {(filterSearch || filterEtapa || filterVendedor) && (
              <button style={S.btnSecondary} onClick={() => { setFilterSearch(''); setFilterEtapa(''); setFilterVendedor('') }}>Limpiar</button>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer', alignSelf: 'center' }}>
              <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
              Ver archivados
            </label>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', alignSelf: 'center', marginLeft: 'auto' }}>{filteredLeads.length} resultados</span>
          </div>
        )}

        {tab === 'pipeline' && <PipelineView />}
        {tab === 'leads' && <LeadsView />}
        {tab === 'leaderboard' && <LeaderboardView />}
        {tab === 'chats' && <ChatsView />}
      </div>
    </CrmShell>
  )
}