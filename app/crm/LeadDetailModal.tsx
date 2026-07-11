'use client'
// TARGET: app/crm/LeadDetailModal.tsx
import { useState, useRef, useEffect } from 'react'
import { supabase } from '../supabase'
import { useNPAPermissions } from '../components/useNPAPermissions'
import { FUENTES_SELECTABLE, fuenteLabel } from './fuentes'

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
  heat_reason?: string
  heat_updated_at?: string
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

interface LeadDetailModalProps {
  lead: Lead
  actividades: Actividad[]
  crmUsers: { user_id: string; full_name: string; crm_role: string }[]
  userId: string | null
  S: Record<string, any>
  onClose: () => void
  onChanged: () => void
}

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

const fmt = (d: string) => {
  if (!d) return '—'
  const dt = new Date(d)
  return dt.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const fmtFull = (d: string) => {
  if (!d) return ''
  return new Date(d).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
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

export default function LeadDetailModal({ lead, actividades, crmUsers, userId, S, onClose, onChanged }: LeadDetailModalProps) {
    const [activeTab, setActiveTab] = useState<'info' | 'actividad' | 'cita' | 'conversacion' | 'editar'>('info')
    const [activityForm, setActivityForm] = useState({ tipo: 'llamada', descripcion: '', resultado: '' })
    const [etapaEdit, setEtapaEdit] = useState(lead.etapa)
    const [saving, setSaving] = useState(false)
    const [saveErr, setSaveErr] = useState('')
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [marking, setMarking] = useState(false)
    const [markErr, setMarkErr] = useState('')
    const [contactedOk, setContactedOk] = useState(false)
    const [contactedInfo, setContactedInfo] = useState<{ at: string; by: string } | null>(null)
    const [editForm, setEditForm] = useState({
      nombre: lead.nombre || '', apellidos: lead.apellidos || '',
      cedula_prefix: lead.cedula_prefix || 'V', cedula: lead.cedula || '',
      telefono: lead.telefono || '', email: lead.email || '',
      fuente: lead.fuente || '', referido_por: lead.referido_por || '',
      modelo_interes: lead.modelo_interes || '',
      presupuesto_usd: lead.presupuesto_usd?.toString() || '',
      color_preferido: lead.color_preferido || '',
      tiene_vehiculo: lead.tiene_vehiculo || false,
      vehiculo_actual: lead.vehiculo_actual || '',
      asignado_a: (lead as any).asignado_a || '',
      asignado_nombre: lead.asignado_nombre || '',
      notas: lead.notas || '',
      proxima_accion: lead.proxima_accion || '',
      proxima_accion_at: lead.proxima_accion_at ? lead.proxima_accion_at.slice(0, 16) : '',
    })

    // Gobernanza: solo supervisor/jefe/Franco pueden marcar Perdido.
    const { permissions: npaPerms } = useNPAPermissions()

    // ── Recordatorios (crm_tareas) for this lead ──────────────────────────
    const [tareas, setTareas] = useState<any[]>([])
    const remLocal = (ms: number) => {
      const d = new Date(Date.now() + ms), p = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
    }
    const [remForm, setRemForm] = useState({ titulo: '', tipo: 'llamada', remind_at: remLocal(2 * 3600000) })
    const [remSaving, setRemSaving] = useState(false)
    const [remErr, setRemErr] = useState('')

    const loadTareas = async () => {
      try {
        const { data } = await supabase.from('crm_tareas')
          .select('id, titulo, tipo, remind_at, status, wa_enviado, origen')
          .eq('lead_id', lead.id).order('remind_at', { ascending: true })
        setTareas(Array.isArray(data) ? data : [])
      } catch { setTareas([]) }
    }
    useEffect(() => { loadTareas() }, []) // eslint-disable-line

    const recomputeHeat = async () => {
      try { await supabase.rpc('crm_recompute_heat', { p_lead_id: lead.id }) } catch { /* non-fatal */ }
    }

    const saveTarea = async () => {
      if (!remForm.titulo.trim() || !remForm.remind_at) { setRemErr('Título y fecha son obligatorios.'); return }
      setRemSaving(true); setRemErr('')
      try {
        await supabase.from('crm_tareas').insert({
          lead_id: lead.id,
          asignado_a: (lead as any).asignado_a || userId || null,
          asignado_nombre: lead.asignado_nombre || null,
          titulo: remForm.titulo.trim(), tipo: remForm.tipo,
          remind_at: new Date(remForm.remind_at).toISOString(),
          origen: 'manual', created_by: userId || null,
        })
        setRemForm({ titulo: '', tipo: 'llamada', remind_at: remLocal(2 * 3600000) })
        await loadTareas()
      } catch (e: any) { setRemErr(e?.message || 'No se pudo crear el recordatorio.') } finally { setRemSaving(false) }
    }

    const completarTarea = async (id: string) => {
      try {
        await supabase.from('crm_tareas').update({
          status: 'completada', completada_at: new Date().toISOString(),
          completada_por: userId || null, updated_at: new Date().toISOString(),
        }).eq('id', id)
        await loadTareas(); await recomputeHeat(); onChanged()
      } catch { /* no-op */ }
    }

    const [composeMode, setComposeMode] = useState<'nota' | 'whatsapp' | 'email' | 'llamada' | 'visita'>('nota')
    const [citaForm, setCitaForm] = useState({ fecha: '', hora: '', notas: '' })
    const [citaSaving, setCitaSaving] = useState(false)
    const [citaErr, setCitaErr] = useState('')
    const [citaOk, setCitaOk] = useState('')
    const [citas, setCitas] = useState<any[]>([])
    const [composeText, setComposeText] = useState('')
    const [composeResultado, setComposeResultado] = useState('')

    // ── Conversación de WhatsApp embebida en el lead ──
    // Reading messages works against the DB; SENDING requires a WhatsApp
    // Worker, which is not configured in this fork yet (see tenant.config.ts).
    const [leadConv, setLeadConv] = useState<any>(null)
    const [leadMsgs, setLeadMsgs] = useState<any[]>([])
    const [convLoading, setConvLoading] = useState(false)
    const [chatText, setChatText] = useState('')
    const [chatSending, setChatSending] = useState(false)
    const [chatErr, setChatErr] = useState('')
    const convScrollRef = useRef<HTMLDivElement>(null)

    const withTimeout = (p: any, ms = 8000): Promise<any> =>
      Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Tiempo de espera agotado')), ms))])

    const loadConv = async () => {
      setConvLoading(true); setChatErr('')
      let lastErr: any = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { data: convs, error: ce } = await withTimeout(
            supabase.from('crm_conversations').select('id,lead_id,wa_phone,bot_active,bot_mode').eq('lead_id', lead.id).limit(1), 12000
          )
          if (ce) throw ce
          const c = convs?.[0] || null
          setLeadConv(c)
          if (c) {
            const { data: msgs, error: me } = await withTimeout(
              supabase.from('crm_mensajes').select('id,direction,content,is_bot,sent_by_nombre,created_at').eq('conversation_id', c.id).order('created_at', { ascending: true }).limit(200), 12000
            )
            if (me) throw me
            setLeadMsgs(msgs || [])
          } else { setLeadMsgs([]) }
          setConvLoading(false)
          return // éxito
        } catch (e: any) {
          lastErr = e
          await new Promise(r => setTimeout(r, 600 * (attempt + 1))) // backoff 600/1200ms y reintenta
        }
      }
      setChatErr('No se pudo cargar la conversación (' + (lastErr?.message || 'error') + '). Toca ↻ para reintentar.')
      setConvLoading(false)
    }
    useEffect(() => { if (activeTab === 'conversacion' && !leadConv && !convLoading) loadConv() }, [activeTab]) // eslint-disable-line
    const loadCitas = async () => {
      try {
        const { data } = await supabase.from('crm_citas').select('id,fecha,hora,estado,asignado_nombre,notas').eq('lead_id', lead.id).order('fecha', { ascending: true })
        setCitas(Array.isArray(data) ? data : [])
      } catch (_) { setCitas([]) }
    }
    useEffect(() => { if (activeTab === 'cita') loadCitas() }, [activeTab]) // eslint-disable-line
    useEffect(() => {
      if (activeTab !== 'conversacion') return
      const el = convScrollRef.current
      if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    }, [leadMsgs, activeTab]) // eslint-disable-line

    // #2 — Realtime acotado a ESTA conversación. Los mensajes entrantes del
    // cliente aparecen solos en la pestaña WhatsApp del lead, sin recargar todo
    // y sin depender del botón ↻. Es estado interno de la pestaña: no remonta el
    // modal (ese era el bug 1.1) y no presiona conexiones re-consultando 200 filas.
    useEffect(() => {
      if (activeTab !== 'conversacion' || !leadConv?.id) return
      let channel: any = null
      try {
        channel = supabase
          .channel('crm_lead_conv_' + leadConv.id)
          .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'crm_mensajes', filter: 'conversation_id=eq.' + leadConv.id },
            (payload: any) => {
              const m = payload.new
              setLeadMsgs((prev: any[]) => prev.some((x: any) => x.id === m.id) ? prev : [...prev, m])
            })
          .subscribe()
      } catch (e) {}
      return () => { if (channel) supabase.removeChannel(channel) }
    }, [activeTab, leadConv?.id]) // eslint-disable-line

    const setBot = async (active: boolean) => {
      if (!leadConv) return
      await supabase.from('crm_conversations').update({ bot_active: active, bot_mode: active ? 'full' : 'off' }).eq('id', leadConv.id)
      setLeadConv((p: any) => p ? { ...p, bot_active: active } : p)
    }

    const sendChat = async () => {
      const t = chatText.trim()
      if (!t || !leadConv || chatSending) return
      setChatErr('Función no disponible: el envío de WhatsApp aún no está configurado para este entorno.')
    }

    const sendMedia = async (file: File) => {
      if (!file || !leadConv || chatSending) return
      setChatErr('Función no disponible: el envío de WhatsApp aún no está configurado para este entorno.')
    }

    const sendCompose = async () => {
      if (!composeText.trim() || saving) return
      setSaving(true)
      try {
        // Solo registra la interacción (nota/llamada/visita/WhatsApp/email) como
        // actividad. NO abre wa.me ni marca contactado: una nota es bitácora, no
        // prueba de contacto (ej. 'llamé, no contestó' no debe detener la escalera).
        await supabase.from('crm_actividades').insert({
          lead_id: lead.id, tipo: composeMode,
          descripcion: composeText.trim(),
          resultado: composeResultado || null,
          created_by: userId,
        })
        await supabase.from('crm_leads').update({
          ultimo_contacto: new Date().toISOString(),
        }).eq('id', lead.id)
        await recomputeHeat()
        setComposeText('')
        setComposeResultado('')
        onChanged()
      } finally {
        setSaving(false)
      }
    }
    const leadActividades = actividades.filter(a => a.lead_id === lead.id)
    const dias = daysSince(lead.ultimo_contacto)
    const etapa = etapaInfo(etapaEdit)
    const inp = (field: string, value: string | boolean) => setEditForm(p => ({ ...p, [field]: value }))

    const saveEdit = async () => {
      if (saving) return
      setSaving(true); setSaveErr('')
      const tr = (v: any) => (v == null ? '' : String(v)).trim()
      const prevAssigned = (lead as any).asignado_a || ''
      try {
        // Resolver el asesor asignado por UUID (el nombre se deriva del UUID elegido).
        const assignedUser = crmUsers.find(u => u.user_id === editForm.asignado_a)
        const { error } = await supabase.from('crm_leads').update({
          nombre: tr(editForm.nombre), apellidos: tr(editForm.apellidos),
          cedula_prefix: editForm.cedula_prefix, cedula: tr(editForm.cedula) || null,
          telefono: tr(editForm.telefono), email: tr(editForm.email) || null,
          fuente: editForm.fuente, referido_por: tr(editForm.referido_por) || null,
          modelo_interes: editForm.modelo_interes || null,
          presupuesto_usd: editForm.presupuesto_usd ? parseFloat(editForm.presupuesto_usd) : null,
          color_preferido: tr(editForm.color_preferido) || null,
          tiene_vehiculo: editForm.tiene_vehiculo, vehiculo_actual: tr(editForm.vehiculo_actual) || null,
          asignado_a: assignedUser ? assignedUser.user_id : null,
          asignado_nombre: assignedUser ? assignedUser.full_name : null,
          notas: tr(editForm.notas) || null,
          proxima_accion: tr(editForm.proxima_accion) || null,
          proxima_accion_at: editForm.proxima_accion_at ? new Date(editForm.proxima_accion_at).toISOString() : null,
        }).eq('id', lead.id)
        if (error) throw error
        await recomputeHeat()
        setActiveTab('info'); onChanged()
      } catch (e: any) {
        setSaveErr('No se pudo guardar (' + (e?.message || 'error') + '). Revisa los campos e intenta de nuevo.')
      } finally {
        setSaving(false)
      }
    }

    const saveActivity = async () => {
      if (!activityForm.descripcion) return
      setSaving(true)
      await supabase.from('crm_actividades').insert({
        lead_id: lead.id, tipo: activityForm.tipo,
        descripcion: activityForm.descripcion, resultado: activityForm.resultado || null, created_by: userId,
      })
      // Registrar el toque (ultimo_contacto = ahora) y la etapa. La TEMPERATURA
      // la calcula el servidor leyendo TODAS las actividades: un "No contesta"
      // ya no calienta al lead; sólo el contacto efectivo lo hace.
      await supabase.from('crm_leads').update({
        ultimo_contacto: new Date().toISOString(), etapa: etapaEdit,
      }).eq('id', lead.id)
      await recomputeHeat()
      setSaving(false)
      setActivityForm({ tipo: 'llamada', descripcion: '', resultado: '' })
      onChanged()
    }

    // Crear una cita manual. El encargado = asesor asignado al lead (asignado_a).
    // El worker (cron) manda recordatorios al cliente y al encargado 1 día y 2 horas antes.
    const saveCita = async () => {
      if (citaSaving) return
      if (!citaForm.fecha) { setCitaErr('Elige una fecha para la cita.'); return }
      setCitaSaving(true); setCitaErr(''); setCitaOk('')
      try {
        const { error } = await supabase.from('crm_citas').insert({
          lead_id: lead.id,
          fecha: citaForm.fecha,
          hora: citaForm.hora || null,
          estado: 'agendada',
          asignado_a: (lead as any).asignado_a || null,
          asignado_nombre: lead.asignado_nombre || null,
          notas: citaForm.notas.trim() || null,
          created_by: userId,
        })
        if (error) throw error
        // Mover el lead a 'Cita Agendada' (si no está más adelante).
        await supabase.from('crm_leads').update({ etapa: 'cita_agendada' }).eq('id', lead.id)
        setEtapaEdit('cita_agendada')
        setCitaOk('Cita agendada. Se enviarán recordatorios automáticos.')
        setCitaForm({ fecha: '', hora: '', notas: '' })
        await loadCitas()
        onChanged()
      } catch (e: any) {
        setCitaErr('No se pudo agendar (' + (e?.message || 'error') + ').')
      } finally {
        setCitaSaving(false)
      }
    }

    const updateEtapa = async (e: string) => {
      const fromEtapa = etapaEdit
      setEtapaEdit(e)
      await supabase.from('crm_leads').update({ etapa: e }).eq('id', lead.id)
      await recomputeHeat()
      logStageChange(lead.id, fromEtapa, e)
      onChanged()
    }

    const deleteLead = async () => {
      await supabase.from('crm_actividades').delete().eq('lead_id', lead.id)
      await supabase.from('crm_leads').delete().eq('id', lead.id)
      onClose(); onChanged()
    }

    // Marca el lead como contactado. En este fork no hay Worker de escalación,
    // así que el sello se estampa directamente en crm_leads.
    const markContacted = async () => {
      if (marking) return
      setMarking(true); setMarkErr('')
      try {
        const now = new Date().toISOString()
        const byNombre = crmUsers.find(u => u.user_id === userId)?.full_name || 'Equipo'
        const { error } = await withTimeout(supabase.from('crm_leads').update({
          contacted_at: now,
          contacted_by: userId || null,
          contacted_by_nombre: byNombre,
          ultimo_contacto: now,
          heat_score: calcHeat({ ...lead, ultimo_contacto: now }),
        }).eq('id', lead.id), 15000)
        if (error) throw error
        setContactedOk(true)
        setContactedInfo({ at: now, by: byNombre })
        onChanged()
      } catch (e: any) {
        setMarkErr('No se pudo marcar como contactado (' + (e?.message || 'error') + '). Intenta de nuevo.')
      } finally {
        setMarking(false)
      }
    }

    // Abrir el chat de WhatsApp del cliente = el asesor toma el lead → marca
    // Contactado (detiene la escalera) y registra quién lo abrió. Abre wa.me aparte.
    const openWaAndContact = async () => {
      window.open('https://wa.me/' + waPhone(lead.telefono), '_blank')
      if (!wasContacted) { try { await markContacted() } catch (_) {} }
    }

    const hc = heatColor(lead.heat_score)
    const waLink = 'https://wa.me/' + waPhone(lead.telefono)
    const cAt = contactedInfo?.at || (lead as any).contacted_at || null
    const cBy = contactedInfo?.by || (lead as any).contacted_by_nombre || null
    const wasContacted = !!cAt || contactedOk

    return (
      <div style={{ ...S.overlay, alignItems: 'flex-start', paddingTop: '0' }}>
        <div style={{
          width: '100%', maxWidth: '1140px', margin: '0 auto',
          height: '100vh', background: 'var(--bg-page)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          // Paleta profesional, aplicada solo a esta ventana
          ['--bg-page' as any]: '#15171C',
          ['--bg-card' as any]: '#1B1E24',
          ['--bg-deep' as any]: '#22262E',
          ['--bg-input' as any]: '#21252C',
          ['--border' as any]: '#2B313A',
          ['--text-primary' as any]: '#E7EAF0',
          ['--text-secondary' as any]: '#A8AFBB',
          ['--text-muted' as any]: '#6C7480',
          ['--accent' as any]: '#6E8AEC',
          ['--accent-solid' as any]: '#4F6FE0',
          ['--accent-border' as any]: 'rgba(110,138,236,0.32)',
          ['--ok' as any]: '#36C58C',
          ['--warn' as any]: '#DDA13B',
          ['--danger' as any]: '#E5594F',
        }}>
          {/* Móvil (<1024px): la pestaña Principal apila la columna de info
              sobre el historial (en vez de 300px fijos al lado) y el cuerpo
              scrollea completo. Solo presentación. */}
          <style>{`
            @media (max-width: 1023px) {
              .ldm-info { flex-direction: column !important; overflow-y: auto !important; }
              .ldm-left { width: 100% !important; border-right: none !important; border-bottom: 1px solid var(--border); overflow-y: visible !important; flex-shrink: 0 !important; }
              .ldm-right { overflow: visible !important; min-height: 60vh; }
            }
          `}</style>
          {/* ── TOP BAR ───────────────────────────────────────────────── */}
          <div style={{
            background: 'var(--bg-card)', borderBottom: '1px solid var(--border)',
            padding: '14px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              {/* Avatar */}
              <div style={{
                width: '44px', height: '44px', borderRadius: '50%', flexShrink: 0,
                background: etapa.color + '22', border: '2px solid ' + etapa.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '18px', fontWeight: 600, color: etapa.color, fontFamily: 'var(--font-inter), Inter, sans-serif',
              }}>
                {lead.nombre[0].toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.03em' }}>
                  {lead.nombre} {lead.apellidos}
                </div>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '3px' }}>
                  <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{lead.telefono}</span>
                  {lead.email && <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{lead.email}</span>}
                  <EtapaBadge etapa={etapaEdit} />
                  <HeatBadge score={lead.heat_score} />
                  {lead.frio_at && <span style={{ fontSize: '11px', fontWeight: 700, color: '#6E8AEC', background: 'rgba(110,138,236,0.14)', padding: '3px 9px', borderRadius: '99px' }}>Frío</span>}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              {lead.telefono && !String(lead.telefono).startsWith('kommo_') && (
                <button
                  title="Abre el chat del cliente y marca el lead como contactado"
                  style={{ ...S.btnSecondary, fontSize: '13px', color: '#25D366', borderColor: 'rgba(37,211,102,0.35)', cursor: 'pointer' }}
                  onClick={openWaAndContact}
                >
                  Abrir WhatsApp
                </button>
              )}
              <button
                title={wasContacted && cBy ? ('Contactado por ' + cBy + (cAt ? ' · ' + fmt(cAt) : '')) : ''}
                style={{ ...S.btnSecondary, fontSize: '13px', color: wasContacted ? 'var(--text-muted)' : 'var(--ok)', borderColor: wasContacted ? 'var(--border)' : 'rgba(54,197,140,0.32)', cursor: (marking || wasContacted) ? 'default' : 'pointer' }}
                onClick={markContacted}
                disabled={marking || wasContacted}
              >
                {wasContacted ? 'Contactado ✓' : (marking ? 'Marcando…' : 'Marcar contactado')}
              </button>
              <button style={S.closeBtn} onClick={() => onClose()}>✕</button>
            </div>
          </div>

          {/* ── #3 — error de "Marcar contactado" ─────────────────────── */}
          {markErr && (
            <div style={{ background: 'rgba(229,89,79,0.14)', borderBottom: '1px solid var(--danger)', padding: '10px 24px', fontSize: '13px', color: 'var(--danger)', flexShrink: 0 }}>
              {markErr}
            </div>
          )}

          {/* ── DELETE CONFIRM ────────────────────────────────────────── */}
          {confirmDelete && (
            <div style={{ background: 'rgba(240,85,106,0.14)', borderBottom: '1px solid var(--danger)', padding: '12px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: '14px', color: 'var(--danger)' }}>¿Eliminar este lead permanentemente?</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button style={{ ...S.btnSecondary, fontSize: '13px' }} onClick={() => setConfirmDelete(false)}>Cancelar</button>
                <button style={{ ...S.btnPrimary, fontSize: '13px', background: 'var(--danger)' }} onClick={deleteLead}>Sí, eliminar</button>
              </div>
            </div>
          )}

          {/* ── STAGE SELECTOR ────────────────────────────────────────── */}
          <div style={{
            background: 'var(--bg-card)', borderBottom: '1px solid var(--border)',
            padding: '10px 24px', display: 'flex', gap: '6px', flexWrap: 'wrap', flexShrink: 0,
          }}>
            {ETAPAS.map(e => {
              const lockedLost = e.key === 'cerrado_perdido' && !npaPerms.npa_can_mark_lost
              return (
              <button key={e.key} disabled={lockedLost}
                onClick={() => { if (lockedLost) return; updateEtapa(e.key) }}
                title={lockedLost ? 'Solo el supervisor puede marcar Perdido' : undefined} style={{
                fontSize: '11px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif',
                letterSpacing: '0.05em', padding: '5px 14px', borderRadius: '20px',
                cursor: lockedLost ? 'not-allowed' : 'pointer',
                border: etapaEdit === e.key ? '1px solid ' + e.color : '1px solid var(--border)',
                background: etapaEdit === e.key ? e.color : 'transparent',
                color: etapaEdit === e.key ? '#fff' : 'var(--text-secondary)',
                opacity: lockedLost ? 0.4 : 1,
                transition: 'all 0.15s',
              }}>
                {e.label}
              </button>
            )})}
          </div>

          {/* ── TABS ──────────────────────────────────────────────────── */}
          <div style={{
            background: 'var(--bg-card)', borderBottom: '1px solid var(--border)',
            padding: '0 24px', display: 'flex', gap: '0', flexShrink: 0,
          }}>
            {([['info','Principal'],['actividad','Actividad'],['cita','Cita'],['conversacion','WhatsApp'],['editar','Editar']] as [string,string][]).map(([key, label]) => (
              <button key={key} onClick={() => setActiveTab(key as any)} style={{
                padding: '12px 20px', border: 'none', background: 'transparent', cursor: 'pointer',
                fontSize: '13px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif',
                letterSpacing: '0.05em',
                color: activeTab === key ? 'var(--accent-solid)' : 'var(--text-secondary)',
                borderBottom: activeTab === key ? '2px solid var(--accent-solid)' : '2px solid transparent',
                marginBottom: '-1px',
              }}>
                {label}
              </button>
            ))}
          </div>

          {/* ── BODY ──────────────────────────────────────────────────── */}
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>

            {/* ── PRINCIPAL TAB ─────────────────────────────────────── */}
            {activeTab === 'info' && (
              <div className="ldm-info" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                {/* Left: contact info */}
                <div className="ldm-left" style={{
                  width: '300px', flexShrink: 0, borderRight: '1px solid var(--border)',
                  overflowY: 'auto', padding: '24px 20px', background: 'var(--bg-card)',
                }}>
                  {/* Heat score */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '24px', padding: '16px', background: 'var(--bg-deep)', borderRadius: '10px', border: '1px solid ' + hc + '33' }}>
                    <div style={{ fontSize: '40px', fontWeight: 600, color: hc, fontFamily: 'var(--font-inter), Inter, sans-serif', lineHeight: 1 }}>{lead.heat_score}</div>
                    <div>
                      <div style={{ fontSize: '13px', color: hc, fontWeight: 600 }}>{heatLabel(lead.heat_score)}</div>
                      {typeof lead.ai_score === 'number' && <div style={{ fontSize: '12px', color: '#9B7DF0', fontWeight: 600, marginTop: '2px' }}>IA: {lead.ai_score}/100 prob. cierre</div>}
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {dias === 999 ? 'Sin contacto' : dias === 0 ? 'Hoy' : 'Hace ' + dias + 'd'}
                      </div>
                      {lead.heat_reason && (
                        <div style={{ fontSize: '11px', color: hc, marginTop: '4px', lineHeight: 1.35, fontWeight: 600 }}>{lead.heat_reason}</div>
                      )}
                    </div>
                  </div>

                  {/* Fields */}
                  {[
                    ['Asignado a', lead.asignado_nombre || '—'],
                    ['Fuente', fuenteLabel(lead.fuente)],
                    ['Modelo', lead.modelo_interes || '—'],
                    ['Presupuesto', lead.presupuesto_usd ? '$' + lead.presupuesto_usd.toLocaleString() : '—'],
                    ['Color preferido', lead.color_preferido || '—'],
                    ['Cédula', lead.cedula ? (lead.cedula_prefix || 'V') + '-' + lead.cedula : '—'],
                    ['Vehículo actual', lead.tiene_vehiculo ? (lead.vehiculo_actual || 'Sí') : 'No'],
                    ['Registrado', fmt(lead.created_at)],
                    ['Último contacto', lead.ultimo_contacto ? fmt(lead.ultimo_contacto) : '—'],
                    ['Contactado por', cAt ? ((cBy || 'Equipo') + ' · ' + fmt(cAt)) : '—'],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--border)', gap: '8px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-inter), Inter, sans-serif', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', flexShrink: 0 }}>{k}</span>
                      <span style={{ fontSize: '13px', color: 'var(--text-primary)', textAlign: 'right' }}>{v}</span>
                    </div>
                  ))}

                  {/* Próxima acción */}
                  {lead.proxima_accion && (
                    <div style={{ marginTop: '16px', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px 14px' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.1em', fontWeight: 600, marginBottom: '6px' }}>PRÓXIMA ACCIÓN</div>
                      <div style={{ fontSize: '14px', color: 'var(--text-primary)', lineHeight: 1.4 }}>{lead.proxima_accion}</div>
                      {lead.proxima_accion_at && (
                        <div style={{ fontSize: '12px', marginTop: '6px', fontWeight: 600, color: new Date(lead.proxima_accion_at) < new Date() ? 'var(--danger)' : 'var(--warn)' }}>
                          {new Date(lead.proxima_accion_at).toLocaleDateString('es-VE')} {new Date(lead.proxima_accion_at).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}
                          {new Date(lead.proxima_accion_at) < new Date() && ' — VENCIDA'}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Notas */}
                  {lead.notas && (
                    <div style={{ marginTop: '12px', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px 14px' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.1em', fontWeight: 600, marginBottom: '6px' }}>NOTAS</div>
                      <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{lead.notas}</div>
                    </div>
                  )}
                  {/* ── RECORDATORIOS (crm_tareas) ──────────────────────── */}
                  <div style={{ marginTop: '16px', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px 14px' }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.1em', fontWeight: 600, marginBottom: '8px' }}>RECORDATORIOS</div>

                    {tareas.filter(t => t.status === 'pendiente').map(t => {
                      const overdue = new Date(t.remind_at) < new Date()
                      return (
                        <div key={t.id} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>{t.titulo}</div>
                            <div style={{ fontSize: '11px', marginTop: '2px', fontWeight: 600, color: overdue ? 'var(--danger)' : 'var(--warn)' }}>
                              {new Date(t.remind_at).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                              {overdue ? ' · vencido' : ''}{t.wa_enviado ? ' · WA✓' : ''}
                            </div>
                          </div>
                          <button onClick={() => completarTarea(t.id)} title="Completar" style={{ flexShrink: 0, padding: '3px 8px', borderRadius: '6px', border: '1px solid var(--ok)', background: 'rgba(21,160,110,0.12)', color: 'var(--ok)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>✓</button>
                        </div>
                      )
                    })}

                    <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <input value={remForm.titulo} onChange={e => setRemForm(p => ({ ...p, titulo: e.target.value }))}
                        placeholder="Ej: Llamar para confirmar cita"
                        style={{ ...S.input, fontSize: '13px', padding: '7px 9px' }} />
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <select value={remForm.tipo} onChange={e => setRemForm(p => ({ ...p, tipo: e.target.value }))}
                          style={{ ...S.input, fontSize: '12px', padding: '7px 8px', flex: 1 }}>
                          {[['llamada','Llamada'],['whatsapp','WhatsApp'],['visita','Visita'],['email','Email'],['seguimiento','Seguimiento'],['otro','Otro']].map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                        <input type="datetime-local" value={remForm.remind_at} onChange={e => setRemForm(p => ({ ...p, remind_at: e.target.value }))}
                          style={{ ...S.input, fontSize: '12px', padding: '7px 8px', flex: 1.4 }} />
                      </div>
                      <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                        {([['+2h', 2 * 3600000], ['Mañana', 24 * 3600000], ['Día 15', 15 * 86400000], ['Día 30', 30 * 86400000]] as [string, number][]).map(([lbl, ms]) => (
                          <button key={lbl} onClick={() => setRemForm(p => ({ ...p, remind_at: remLocal(ms) }))}
                            style={{ padding: '5px 9px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>{lbl}</button>
                        ))}
                      </div>
                      {remErr && <div style={{ fontSize: '11px', color: 'var(--danger)' }}>{remErr}</div>}
                      <button onClick={saveTarea} disabled={remSaving || !remForm.titulo.trim()}
                        style={{ ...S.btnPrimary, padding: '8px', fontSize: '13px', opacity: remSaving || !remForm.titulo.trim() ? 0.6 : 1 }}>
                        {remSaving ? 'Guardando…' : '+ Agregar recordatorio'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Right: activity timeline + compose bar */}
                <div className="ldm-right" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-page)' }}>

                  {/* Timeline scroll area */}
                  <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.1em', marginBottom: '20px' }}>
                      HISTORIAL · {leadActividades.length} registros
                    </div>

                    {leadActividades.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
                        <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Sin actividad registrada</div>
                        <div style={{ fontSize: '12px', marginTop: '6px' }}>Registra la primera con el área de abajo</div>
                      </div>
                    ) : (
                      <div style={{ position: 'relative' }}>
                        <div style={{ position: 'absolute', left: '16px', top: '0', bottom: '0', width: '2px', background: 'var(--border)' }} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                          {leadActividades.map(a => {
                            const resultado = RESULTADOS.find(r => r.key === a.resultado)
                            const resultColor = a.resultado === 'interesado' ? 'var(--accent)' : a.resultado === 'no_interesado' ? 'var(--danger)' : 'var(--warn)'
                            return (
                              <div key={a.id} style={{ display: 'flex', gap: '16px', paddingBottom: '20px', position: 'relative' }}>
                                <div style={{ width: '34px', height: '34px', borderRadius: '50%', flexShrink: 0, background: 'var(--bg-deep)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', fontFamily: 'var(--font-inter), Inter, sans-serif', position: 'relative', zIndex: 1 }}>
                                  {(a.tipo || '·')[0].toUpperCase()}
                                </div>
                                <div style={{ flex: 1, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px 16px', marginTop: '4px' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{a.tipo}</span>
                                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{fmtFull(a.created_at)}</span>
                                  </div>
                                  <div style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{a.descripcion}</div>
                                  {resultado && (
                                    <div style={{ marginTop: '8px', display: 'inline-block', fontSize: '11px', fontWeight: 600, color: resultColor, background: resultColor + '22', padding: '3px 10px', borderRadius: '10px' }}>
                                      {resultado.label}
                                    </div>
                                  )}
                                  {a.created_by === 'claudia' && (
                                    <div style={{ fontSize: '11px', color: 'var(--accent)', marginTop: '6px', fontWeight: 600 }}>Claudia IA</div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ── COMPOSE BAR (Kommo-style) ─────────────────────── */}
                  <div style={{ borderTop: '2px solid var(--border)', background: 'var(--bg-card)', flexShrink: 0 }}>
                    {/* Channel tabs */}
                    <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 16px' }}>
                      {([
                        { key: 'nota',     label: 'Nota',     color: 'var(--text-muted)' },
                        { key: 'whatsapp', label: 'WhatsApp', color: 'var(--accent)' },
                        { key: 'email',    label: 'Email',    color: 'var(--accent)' },
                        { key: 'llamada',  label: 'Llamada',  color: 'var(--warn)' },
                        { key: 'visita',   label: 'Visita',   color: 'var(--ok)' },
                      ] as const).map(ch => (
                        <button key={ch.key} onClick={() => setComposeMode(ch.key)} style={{
                          padding: '9px 16px', border: 'none', background: 'transparent', cursor: 'pointer',
                          fontSize: '12px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif',
                          color: composeMode === ch.key ? ch.color : 'var(--text-muted)',
                          borderBottom: composeMode === ch.key ? '2px solid ' + ch.color : '2px solid transparent',
                          marginBottom: '-1px',
                        }}>
                          {ch.label}
                        </button>
                      ))}
                      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
                        <select value={composeResultado} onChange={e => setComposeResultado(e.target.value)}
                          style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '6px', padding: '4px 8px', color: 'var(--text-secondary)', fontSize: '11px', outline: 'none' }}>
                          <option value="">Resultado (opcional)</option>
                          {RESULTADOS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                        </select>
                      </div>
                    </div>
                    {/* Input row */}
                    <div style={{ padding: '12px 16px', display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                      <textarea
                        value={composeText}
                        onChange={e => setComposeText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) sendCompose() }}
                        placeholder={
                          composeMode === 'nota' ? 'Escribe una nota interna...' :
                          composeMode === 'whatsapp' ? 'Resume lo que hablaste por WhatsApp con el cliente...' :
                          composeMode === 'email' ? 'Resume el correo que enviaste o recibiste...' :
                          composeMode === 'visita' ? 'Describe la visita del cliente al showroom...' :
                          'Describe la llamada con el cliente...'
                        }
                        rows={2}
                        style={{
                          flex: 1, padding: '10px 14px',
                          background: 'var(--bg-input)',
                          border: '1px solid ' + (composeText ? 'var(--accent)88' : 'var(--border)'),
                          borderRadius: '10px', color: 'var(--text-primary)', fontSize: '13px',
                          outline: 'none', resize: 'none', lineHeight: 1.5, fontFamily: 'inherit',
                        }}
                      />
                      <button onClick={sendCompose} disabled={!composeText.trim() || saving}
                        style={{
                          width: '42px', height: '42px', borderRadius: '50%', border: 'none', flexShrink: 0,
                          background: composeText.trim() ? (composeMode === 'llamada' ? 'var(--warn)' : composeMode === 'visita' ? 'var(--ok)' : composeMode === 'nota' ? 'var(--text-muted)' : 'var(--accent)') : 'var(--border)',
                          cursor: composeText.trim() ? 'pointer' : 'default',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                      </button>
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '0 16px 8px', textAlign: 'right' }}>Ctrl+Enter para enviar</div>
                  </div>
                </div>
              </div>
            )}

            {/* ── ACTIVIDAD TAB ─────────────────────────────────────── */}
            {activeTab === 'actividad' && (
              <div style={{ flex: 1, overflowY: 'auto', padding: '32px', maxWidth: '600px' }}>
                <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-inter), Inter, sans-serif', marginBottom: '24px' }}>
                  REGISTRAR ACTIVIDAD
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                  <div style={S.field}>
                    <label style={S.label}>TIPO</label>
                    <select style={S.input} value={activityForm.tipo} onChange={e => setActivityForm(p => ({ ...p, tipo: e.target.value }))}>
                      {[['llamada','Llamada'],['whatsapp','WhatsApp'],['visita','Visita'],['email','Email'],['nota','Nota'],['cita','Cita']].map(([k,v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div style={S.field}>
                    <label style={S.label}>RESULTADO</label>
                    <select style={S.input} value={activityForm.resultado} onChange={e => setActivityForm(p => ({ ...p, resultado: e.target.value }))}>
                      <option value="">-- Resultado --</option>
                      {RESULTADOS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ ...S.field, marginBottom: '20px' }}>
                  <label style={S.label}>DESCRIPCIÓN</label>
                  <textarea style={{ ...S.input, minHeight: '120px', resize: 'vertical', marginTop: '4px', fontSize: '14px', lineHeight: 1.6 }}
                    placeholder="Describe la actividad realizada..."
                    value={activityForm.descripcion}
                    onChange={e => setActivityForm(p => ({ ...p, descripcion: e.target.value }))} />
                </div>
                <button style={{ ...S.btnPrimary, width: '100%', padding: '12px', fontSize: '14px' }} onClick={saveActivity} disabled={saving}>
                  {saving ? 'Guardando...' : '+ Registrar Actividad'}
                </button>
              </div>
            )}

            {/* ── CONVERSACIÓN (WhatsApp) TAB ───────────────────────── */}
            {activeTab === 'cita' && (
              <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
                <div style={{ maxWidth: '520px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>Agendar cita</h3>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 16px' }}>
                    Encargado: <b style={{ color: 'var(--text-secondary)' }}>{lead.asignado_nombre || 'sin asignar'}</b>. 
                    Recordatorios automáticos por WhatsApp al cliente y al encargado 1 día y 2 horas antes.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div style={S.field}><label style={S.label}>FECHA *</label>
                      <input style={S.input} type="date" value={citaForm.fecha} onChange={e => setCitaForm(p => ({ ...p, fecha: e.target.value }))} /></div>
                    <div style={S.field}><label style={S.label}>HORA</label>
                      <input style={S.input} type="time" value={citaForm.hora} onChange={e => setCitaForm(p => ({ ...p, hora: e.target.value }))} /></div>
                  </div>
                  <div style={{ ...S.field, marginTop: '12px' }}><label style={S.label}>NOTAS</label>
                    <textarea style={{ ...S.input, minHeight: '70px', resize: 'vertical', marginTop: '4px' }} value={citaForm.notas} onChange={e => setCitaForm(p => ({ ...p, notas: e.target.value }))} placeholder="Ej: Prueba de manejo del Sportage" /></div>
                  {citaErr && <div style={{ color: 'var(--danger)', fontSize: '12px', marginTop: '8px' }}>{citaErr}</div>}
                  {citaOk && <div style={{ color: 'var(--ok)', fontSize: '12px', marginTop: '8px' }}>{citaOk}</div>}
                  <div style={{ marginTop: '14px' }}>
                    <button style={S.btnPrimary} onClick={saveCita} disabled={citaSaving}>{citaSaving ? 'Agendando…' : '✓ Agendar cita'}</button>
                  </div>

                  <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', margin: '28px 0 10px' }}>Próximas citas</h3>
                  {citas.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Sin citas registradas.</div>}
                  {citas.map(c => (
                    <div key={c.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 14px', marginBottom: '8px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{c.fecha}{c.hora ? ' · ' + String(c.hora).slice(0,5) : ''} <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>· {c.estado}</span></div>
                      {c.notas && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{c.notas}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'conversacion' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 24px', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)' }}>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {leadConv ? (leadConv.bot_active ? 'Claudia responde automáticamente' : 'En control manual · Claudia en pausa') : 'Sin conversación de WhatsApp'}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button style={{ ...S.btnSecondary, fontSize: '13px' }} onClick={loadConv}>↻</button>
                    {leadConv && (leadConv.bot_active
                      ? <button style={{ ...S.btnSecondary, fontSize: '13px', color: 'var(--warn)' }} onClick={() => setBot(false)}>Tomar control</button>
                      : <button style={{ ...S.btnSecondary, fontSize: '13px', color: 'var(--ok)' }} onClick={() => setBot(true)}>Reactivar IA</button>)}
                  </div>
                </div>

                <div ref={convScrollRef} style={{ flex: 1, overflowY: 'auto', padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: '10px', background: 'var(--bg-page)' }}>
                  {convLoading ? <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Cargando…</div>
                    : !leadConv ? <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', marginTop: '40px' }}>{chatErr || 'Este lead aún no tiene conversación de WhatsApp. Aparecerá aquí cuando el cliente escriba.'}</div>
                    : leadMsgs.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Sin mensajes.</div>
                    : leadMsgs.map((m: any) => {
                      const out = m.direction === 'out', bot = m.is_bot
                      return (
                        <div key={m.id} style={{ alignSelf: out ? 'flex-end' : 'flex-start', maxWidth: '78%' }}>
                          <div style={{
                            padding: '8px 12px', borderRadius: '12px', fontSize: '13px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            background: out ? (bot ? 'rgba(155,125,240,0.16)' : 'var(--accent-solid)') : 'var(--bg-card)',
                            color: out && !bot ? '#fff' : 'var(--text-primary)',
                            border: out && !bot ? 'none' : '1px solid var(--border)',
                          }}>{m.content}</div>
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', textAlign: out ? 'right' : 'left' }}>
                            {out ? (bot ? 'Claudia' : (m.sent_by_nombre || 'Equipo')) : 'Cliente'} · {new Date(m.created_at).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                      )
                    })}
                </div>

                {leadConv && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '12px 24px', background: 'var(--bg-card)' }}>
                    {chatErr && <div style={{ fontSize: '12px', color: 'var(--danger)', marginBottom: '8px' }}>{chatErr}</div>}
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                      <textarea value={chatText} onChange={e => setChatText(e.target.value)} placeholder="Escribe un mensaje al cliente por WhatsApp…" rows={2}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } }}
                        style={{ ...S.input, flex: 1, resize: 'none' }} />
                      <input id="crm-wa-file" type="file" accept="application/pdf,image/jpeg,image/png" style={{ display: 'none' }}
                        onChange={e => { const f = e.target.files?.[0]; if (f) sendMedia(f); e.currentTarget.value = '' }} />
                      <button onClick={() => document.getElementById('crm-wa-file')?.click()} disabled={chatSending} title="Adjuntar PDF o imagen"
                        style={{ padding: '9px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '16px', cursor: 'pointer', opacity: chatSending ? 0.5 : 1 }}>
                        📎
                      </button>
                      <button onClick={sendChat} disabled={!chatText.trim() || chatSending}
                        style={{ padding: '9px 16px', borderRadius: '8px', border: 'none', background: 'var(--accent-solid)', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', opacity: (!chatText.trim() || chatSending) ? 0.5 : 1 }}>
                        {chatSending ? '…' : 'Enviar'}
                      </button>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>Al enviar, Claudia se pausa y tú tomas la conversación.</div>
                  </div>
                )}
              </div>
            )}

            {/* ── EDITAR TAB ────────────────────────────────────────── */}
            {activeTab === 'editar' && (
              <div style={{ flex: 1, overflowY: 'auto', padding: '32px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px', maxWidth: '700px' }}>
                  <div style={S.field}><label style={S.label}>NOMBRE *</label><input style={S.input} value={editForm.nombre} onChange={e => inp('nombre', e.target.value)} /></div>
                  <div style={S.field}><label style={S.label}>APELLIDOS *</label><input style={S.input} value={editForm.apellidos} onChange={e => inp('apellidos', e.target.value)} /></div>
                  <div style={S.field}>
                    <label style={S.label}>CÉDULA</label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <select style={{ ...S.input, width: '70px' }} value={editForm.cedula_prefix} onChange={e => inp('cedula_prefix', e.target.value)}>
                        {['V','E','J','G','P'].map(p => <option key={p}>{p}</option>)}
                      </select>
                      <input style={{ ...S.input, flex: 1 }} value={editForm.cedula} onChange={e => inp('cedula', e.target.value)} />
                    </div>
                  </div>
                  <div style={S.field}><label style={S.label}>TELÉFONO *</label><input style={S.input} value={editForm.telefono} onChange={e => inp('telefono', e.target.value)} /></div>
                  <div style={S.field}><label style={S.label}>EMAIL</label><input style={S.input} value={editForm.email} onChange={e => inp('email', e.target.value)} /></div>
                  <div style={S.field}>
                    <label style={S.label}>FUENTE</label>
                    <select style={S.input} value={editForm.fuente} onChange={e => inp('fuente', e.target.value)}>
                      {FUENTES_SELECTABLE.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                  </div>
                  <div style={S.field}>
                    <label style={S.label}>MODELO</label>
                    <select style={S.input} value={editForm.modelo_interes} onChange={e => inp('modelo_interes', e.target.value)}>
                      <option value="">-- Seleccionar --</option>
                      {MODELOS_KIA.map(m => <option key={m}>{m}</option>)}
                    </select>
                  </div>
                  <div style={S.field}><label style={S.label}>PRESUPUESTO (USD)</label><input style={S.input} type="number" value={editForm.presupuesto_usd} onChange={e => inp('presupuesto_usd', e.target.value)} /></div>
                  <div style={S.field}><label style={S.label}>COLOR PREFERIDO</label><input style={S.input} value={editForm.color_preferido} onChange={e => inp('color_preferido', e.target.value)} /></div>
                  <div style={S.field}><label style={S.label}>ASIGNAR A</label>
                    <select style={S.input} value={editForm.asignado_a} onChange={e => inp('asignado_a', e.target.value)}>
                      <option value="">-- Sin asignar --</option>
                      {crmUsers.map(u => <option key={u.user_id} value={u.user_id}>{u.full_name}</option>)}
                    </select>
                  </div>
                  <div style={{ ...S.field, gridColumn: 'span 2' }}>
                    <label style={{ ...S.label, marginBottom: '6px' }}>¿TIENE VEHÍCULO ACTUAL?</label>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                      <label style={{ display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '13px' }}>
                        <input type="checkbox" checked={editForm.tiene_vehiculo} onChange={e => inp('tiene_vehiculo', e.target.checked)} />
                        Sí
                      </label>
                      {editForm.tiene_vehiculo && <input style={{ ...S.input, flex: 1 }} value={editForm.vehiculo_actual} onChange={e => inp('vehiculo_actual', e.target.value)} />}
                    </div>
                  </div>
                  <div style={{ ...S.field, gridColumn: 'span 2' }}>
                    <label style={S.label}>PRÓXIMA ACCIÓN</label>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                      <input style={{ ...S.input, flex: 1 }} value={editForm.proxima_accion} onChange={e => inp('proxima_accion', e.target.value)} placeholder="Ej: Llamar para confirmar cita" />
                      <input style={{ ...S.input, width: '210px' }} type="datetime-local" value={editForm.proxima_accion_at} onChange={e => inp('proxima_accion_at', e.target.value)} />
                    </div>
                  </div>
                  <div style={{ ...S.field, gridColumn: 'span 2' }}>
                    <label style={S.label}>NOTAS</label>
                    <textarea style={{ ...S.input, minHeight: '100px', resize: 'vertical', marginTop: '4px' }} value={editForm.notas} onChange={e => inp('notas', e.target.value)} />
                  </div>
                  {saveErr && <div style={{ gridColumn: 'span 2', color: 'var(--heat-hot, #E5556A)', fontSize: '12px' }}>{saveErr}</div>}
                  <div style={{ gridColumn: 'span 2', display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '8px' }}>
                    <button style={S.btnSecondary} onClick={() => setActiveTab('info')}>Cancelar</button>
                    <button style={S.btnPrimary} onClick={saveEdit} disabled={saving}>{saving ? 'Guardando...' : '✓ Guardar Cambios'}</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
}