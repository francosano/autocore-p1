// TARGET: app/crm/chats/page.tsx
'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useNPAPermissions } from '../../components/useNPAPermissions'
import { fuenteLabel } from '../fuentes'
import { TENANT } from '../../tenant.config'

// Empty = WhatsApp send disabled; messages fall back to a local DB insert
// until the p1 WhatsApp Worker is deployed.
const WORKER_URL: string = TENANT.workers.whatsapp

const ETAPAS_LIST = [
  { key: 'nuevo',             label: 'Nuevo Lead' },
  { key: 'contactado',        label: 'Contactado' },
  { key: 'cita_agendada',     label: 'Cita Agendada' },
  { key: 'visita_showroom',   label: 'Visita Showroom' },
  { key: 'oferta_presentada', label: 'Oferta Presentada' },
  { key: 'financiamiento',    label: 'Financiamiento' },
  { key: 'cerrado_ganado',    label: 'Cerrado' },
  { key: 'cerrado_perdido',   label: 'Perdido' },
]
const etapaLabel = (k: string) => ETAPAS_LIST.find(e => e.key === k)?.label || k

const ETAPA_COLORS: Record<string, string> = {
  nuevo: '#8A93A0', contactado: '#5A8DEE', cita_agendada: '#9B7DF0',
  visita_showroom: '#E0A23C', oferta_presentada: '#E5689A',
  financiamiento: '#2FBF8F', cerrado_ganado: '#15A06E', cerrado_perdido: '#E5556A',
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
  crm_leads?: Lead
}

interface Lead {
  id: string
  nombre: string
  apellidos: string
  telefono: string
  modelo_interes?: string
  etapa: string
  heat_score: number
  asignado_nombre?: string
  fuente: string
}

interface Message {
  id: string
  conversation_id: string
  lead_id: string
  direction: 'in' | 'out'
  content: string
  media_url?: string
  status: string
  sent_by: string
  sent_by_nombre?: string
  is_bot: boolean
  created_at: string
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

const fmtFull = (iso: string) => {
  if (!iso) return ''
  return new Date(iso).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function ChatsPage() {
  const router = useRouter()
  const { permissions, loading: permsLoading, userId } = useNPAPermissions()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [msgLoading, setMsgLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [inputText, setInputText] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'pending' | 'resolved'>('open')
  const [search, setSearch] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userFullName, setUserFullName] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const selectedConvIdRef = useRef<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) { router.push('/'); return }
      setUserEmail(data.user.email || '')
      supabase.from('user_roles').select('full_name').eq('user_id', data.user.id).single()
        .then(({ data: r }) => setUserFullName(r?.full_name || data.user.email || ''))
    })
  }, [router])

  // CRM access is checked via auth guard above

  // Load conversations
  const loadConversations = useCallback(async (opts?: { silent?: boolean; preserveOrder?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    const { data } = await supabase
      .from('crm_conversations')
      .select('*, crm_leads(id, nombre, apellidos, telefono, modelo_interes, etapa, heat_score, asignado_nombre, fuente)')
      .order('last_message_at', { ascending: false })
    const batch = (data || []) as Conversation[]
    if (opts?.preserveOrder) {
      // Mantener el orden actual en pantalla (no saltar mientras se escribe):
      // refrescar datos de las existentes y poner las NUEVAS arriba.
      setConversations(prev => {
        const byId: Record<string, Conversation> = {}
        batch.forEach(c => { byId[c.id] = c })
        const existingIds = new Set(prev.map(c => c.id))
        const refreshed = prev.filter(c => byId[c.id]).map(c => byId[c.id])
        const nuevas = batch.filter(c => !existingIds.has(c.id))
        return [...nuevas, ...refreshed]
      })
    } else {
      setConversations(batch)
    }
    if (!opts?.silent) setLoading(false)
  }, [])

  useEffect(() => { loadConversations() }, [loadConversations])

  // Ref del id seleccionado para los handlers de realtime (sin re-suscribir el canal).
  useEffect(() => { selectedConvIdRef.current = selectedConv?.id || null }, [selectedConv])

  // Realtime — actualización EN SITIO. No recarga toda la lista ni hace setLoading
  // (eso desmontaba el chat y hacía perder el foco al escribir) ni reordena bajo el
  // usuario. Suscripción estable: lee el id seleccionado de un ref, no re-suscribe.
  useEffect(() => {
    let channel: any = null
    let reloadTimer: any = null
    const silentReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => loadConversations({ silent: true, preserveOrder: true }), 600)
    }
    try {
      channel = supabase
        .channel('crm_chats_main')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crm_mensajes' }, (payload: any) => {
          const msg = payload.new as Message
          if (selectedConvIdRef.current === msg.conversation_id) {
            setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg])
            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 80)
          }
          setConversations(prev => prev.map(c => c.id === msg.conversation_id
            ? {
                ...c,
                last_message_preview: (msg.content || '').slice(0, 100),
                last_message_at: msg.created_at,
                unread_count: selectedConvIdRef.current === msg.conversation_id
                  ? 0
                  : (msg.direction === 'in' ? (c.unread_count || 0) + 1 : (c.unread_count || 0)),
              }
            : c))
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crm_conversations' }, () => {
          silentReload()
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'crm_conversations' }, (payload: any) => {
          const c2 = payload.new as Conversation
          setConversations(prev => prev.map(c => c.id === c2.id ? { ...c, ...c2, crm_leads: c.crm_leads } : c))
        })
        .subscribe()
    } catch (e) {
      console.log('Realtime subscription error:', e)
    }
    return () => { if (reloadTimer) clearTimeout(reloadTimer); if (channel) supabase.removeChannel(channel) }
  }, [loadConversations])

  // Load messages for selected conversation
  const loadMessages = useCallback(async (convId: string) => {
    setMsgLoading(true)
    const { data } = await supabase
      .from('crm_mensajes')
      .select('*')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
    setMessages(data || [])
    setMsgLoading(false)
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
  }, [])

  const selectConversation = async (conv: Conversation) => {
    setSelectedConv(conv)
    await loadMessages(conv.id)
    // Mark as read
    await supabase.from('crm_conversations').update({ unread_count: 0 }).eq('id', conv.id)
    setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, unread_count: 0 } : c))
  }

  // Send a specific text (used by composer + by the Claudia suggestion rail)
  const sendText = async (rawText: string) => {
    const text = (rawText || '').trim()
    if (!text || !selectedConv || sending) return

    try {
      if (!WORKER_URL) throw new Error('WhatsApp Worker no configurado')
      const res = await fetch(WORKER_URL + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: selectedConv.id,
          lead_id: selectedConv.lead_id,
          to: selectedConv.wa_phone,
          message: text,
          sent_by: userId || 'agent',
          sent_by_nombre: userFullName || userEmail,
        })
      })
      const result = await res.json()
      if (!result.success) {
        // Fallback: save locally even if WA fails (for testing without live number)
        await supabase.from('crm_mensajes').insert({
          conversation_id: selectedConv.id,
          lead_id: selectedConv.lead_id,
          direction: 'out',
          content: text,
          status: 'sent',
          sent_by: userId || 'agent',
          sent_by_nombre: userFullName || userEmail,
          is_bot: false,
        })
        await supabase.from('crm_conversations').update({
          last_message_at: new Date().toISOString(),
          last_message_preview: text.substring(0, 100),
        }).eq('id', selectedConv.id)
        loadMessages(selectedConv.id)
        loadConversations({ silent: true, preserveOrder: true })
      }
    } catch (e) {
      // Save locally for testing
      await supabase.from('crm_mensajes').insert({
        conversation_id: selectedConv.id,
        lead_id: selectedConv.lead_id,
        direction: 'out',
        content: text,
        status: 'sent',
        sent_by: userId || 'agent',
        sent_by_nombre: userFullName || userEmail,
        is_bot: false,
      })
      loadMessages(selectedConv.id)
      loadConversations({ silent: true, preserveOrder: true })
    }
  }

  // Send message from composer
  const sendMessage = async () => {
    if (!inputText.trim() || !selectedConv || sending) return
    const text = inputText.trim()
    setInputText('')
    setSending(true)
    await sendText(text)
    setSending(false)
  }

  // Toggle bot
  const toggleBot = async (active: boolean) => {
    if (!selectedConv) return
    if (WORKER_URL) {
      await fetch(WORKER_URL + '/bot/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: selectedConv.id, bot_active: active, bot_mode: active ? 'full' : 'off' })
      }).catch(() => {})
    }
    // Also update Supabase directly
    await supabase.from('crm_conversations').update({ bot_active: active, bot_mode: active ? 'full' : 'off' }).eq('id', selectedConv.id)
    setSelectedConv(prev => prev ? { ...prev, bot_active: active, bot_mode: active ? 'full' : 'off' } : null)
    setConversations(prev => prev.map(c => c.id === selectedConv.id ? { ...c, bot_active: active } : c))
  }

  // Resolve conversation
  const resolveConversation = async () => {
    if (!selectedConv) return
    await supabase.from('crm_conversations').update({ status: 'resolved' }).eq('id', selectedConv.id)
    setSelectedConv(prev => prev ? { ...prev, status: 'resolved' } : null)
    loadConversations({ silent: true, preserveOrder: true })
  }

  // Filter conversations
  const filtered = conversations.filter(c => {
    const lead = c.crm_leads as any
    const matchStatus = filterStatus === 'all' || c.status === filterStatus
    const matchSearch = !search || (
      (lead?.nombre + ' ' + lead?.apellidos + ' ' + c.wa_phone + ' ' + (lead?.modelo_interes || '')).toLowerCase().includes(search.toLowerCase())
    )
    return matchStatus && matchSearch
  })

  const totalUnread = conversations.reduce((s, c) => s + (c.unread_count || 0), 0)

  if (loading) {
    return (
      <CrmShell active="chats" fluid>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - 52px)', color: 'var(--text-muted)', fontSize: '13px' }}>
          Cargando chats...
        </div>
      </CrmShell>
    )
  }

  const lead = selectedConv?.crm_leads as any

  return (
    <CrmShell active="chats" fluid>
      {/* Móvil (<1024px): un panel a la vez — lista O conversación; el panel
          de lead se oculta (el botón "Ver Lead" cubre ese caso). El botón
          chx-back solo existe en móvil y vuelve a la lista. */}
      <style>{`
        .chx-back { display: none; }
        @media (max-width: 1023px) {
          .chx-lead { display: none !important; }
          .chx-list { width: 100% !important; border-right: none !important; }
          .chx-list.chx-hidden { display: none !important; }
          .chx-main { display: none !important; }
          .chx-main.chx-show { display: flex !important; }
          .chx-back { display: flex; }
        }
      `}</style>
      <div style={{ display: 'flex', flex: 1, height: 'calc(100vh - 52px)', overflow: 'hidden' }}>

        {/* ── LEFT PANEL: Conversation List ─────────────────────────────── */}
        <div className={'chx-list' + (selectedConv ? ' chx-hidden' : '')} style={{ width: '320px', flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--bg-card)' }}>
          {/* Header */}
          <div style={{ padding: '16px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.08em' }}>
                  CHATS WHATSAPP
                  {totalUnread > 0 && (
                    <span style={{ marginLeft: '8px', background: 'var(--accent-solid)', color: '#fff', borderRadius: '10px', padding: '1px 7px', fontSize: '10px', fontWeight: 600 }}>
                      {totalUnread}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{filtered.length} conversaciones</div>
              </div>
              <button
                onClick={() => window.location.href = '/crm'}
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', padding: '4px 10px', color: 'var(--text-muted)', fontSize: '11px', cursor: 'pointer' }}
              >
                ← CRM
              </button>
            </div>
            <input
              style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '12px', outline: 'none', boxSizing: 'border-box' }}
              placeholder="🔍 Buscar conversación..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {/* Status filters */}
            <div style={{ display: 'flex', gap: '4px', marginTop: '10px' }}>
              {(['all','open','pending','resolved'] as const).map(s => (
                <button key={s} onClick={() => setFilterStatus(s)} style={{
                  flex: 1, padding: '4px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                  background: filterStatus === s ? 'var(--accent-soft)' : 'transparent',
                  color: filterStatus === s ? 'var(--accent-solid)' : 'var(--text-muted)',
                  fontSize: '10px', fontWeight: 600, fontFamily: 'var(--font-inter), Inter, sans-serif', letterSpacing: '0.05em',
                }}>
                  {s === 'all' ? 'TODOS' : s === 'open' ? 'ABIERTOS' : s === 'pending' ? 'PENDIENTE' : 'CERRADOS'}
                </button>
              ))}
            </div>
          </div>

          {/* Conversation list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--text-muted)', fontSize: '12px' }}>
                No hay conversaciones
              </div>
            ) : (
              filtered.map(conv => {
                const l = conv.crm_leads as any
                const isSelected = selectedConv?.id === conv.id
                const etapaColor = ETAPA_COLORS[l?.etapa || 'nuevo'] || 'var(--text-muted)'
                return (
                  <div
                    key={conv.id}
                    onClick={() => selectConversation(conv)}
                    style={{
                      padding: '12px 16px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
                      background: isSelected ? 'var(--accent-soft)' : 'transparent',
                      borderLeft: isSelected ? '3px solid var(--accent-solid)' : '3px solid transparent',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-deep)' }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {/* Avatar */}
                        <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: etapaColor + '33', border: '2px solid ' + etapaColor, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: etapaColor }}>
                            {(l?.nombre || '?')[0].toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {l ? l.nombre + ' ' + l.apellidos : conv.wa_phone}
                          </div>
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{conv.wa_phone}</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{fmtTime(conv.last_message_at)}</span>
                        {conv.unread_count > 0 && (
                          <span style={{ background: 'var(--accent)', color: '#fff', borderRadius: '10px', padding: '1px 6px', fontSize: '10px', fontWeight: 600 }}>
                            {conv.unread_count}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>
                        {conv.last_message_preview || 'Sin mensajes'}
                      </div>
                      <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                        {conv.bot_active && (
                          <span style={{ fontSize: '9px', background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: '4px', padding: '1px 5px', fontWeight: 600 }}>BOT</span>
                        )}
                        {l?.modelo_interes && (
                          <span style={{ fontSize: '9px', background: 'rgba(87,166,201,0.14)', color: 'var(--heat-cold)', borderRadius: '4px', padding: '1px 5px', fontWeight: 600 }}>
                            {l.modelo_interes}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* ── CENTER PANEL: Chat ─────────────────────────────────────────── */}
        {selectedConv ? (
          <div className="chx-main chx-show" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Chat header */}
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button
                  className="chx-back"
                  onClick={() => setSelectedConv(null)}
                  aria-label="Volver a la lista"
                  style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', padding: '7px 9px', color: 'var(--text-secondary)', cursor: 'pointer', alignItems: 'center' }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
                </button>
                <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: (ETAPA_COLORS[lead?.etapa] || 'var(--text-muted)') + '33', border: '2px solid ' + (ETAPA_COLORS[lead?.etapa] || 'var(--text-muted)'), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: '16px', fontWeight: 600, color: ETAPA_COLORS[lead?.etapa] || 'var(--text-muted)' }}>
                    {(lead?.nombre || '?')[0].toUpperCase()}
                  </span>
                </div>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {lead ? lead.nombre + ' ' + lead.apellidos : selectedConv.wa_phone}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {selectedConv.wa_phone} · {lead?.modelo_interes || 'Modelo TBD'}
                    {selectedConv.assigned_nombre && ` · Asignado: ${selectedConv.assigned_nombre}`}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {/* Bot toggle */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: selectedConv.bot_active ? 'var(--accent-soft)' : 'var(--bg-deep)', borderRadius: '8px', border: '1px solid ' + (selectedConv.bot_active ? 'var(--accent-border)' : 'var(--border)') }}>
                  <span style={{ fontSize: '11px', color: selectedConv.bot_active ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 600 }}>
                    🤖 Claudia
                  </span>
                  <button
                    onClick={() => toggleBot(!selectedConv.bot_active)}
                    style={{
                      width: '32px', height: '18px', borderRadius: '9px', border: 'none', cursor: 'pointer',
                      background: selectedConv.bot_active ? 'var(--accent)' : 'var(--border)', position: 'relative',
                      transition: 'background 0.2s',
                    }}
                  >
                    <div style={{
                      position: 'absolute', top: '2px', left: selectedConv.bot_active ? '14px' : '2px',
                      width: '14px', height: '14px', borderRadius: '50%', background: '#fff',
                      transition: 'left 0.2s',
                    }} />
                  </button>
                </div>

                {/* View lead — deep-link al detalle en el pipeline (?lead=<id>) */}
                {selectedConv.lead_id && (
                  <button
                    onClick={() => window.location.href = '/crm?lead=' + selectedConv.lead_id}
                    style={{ padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: '8px', color: '#fff', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    Ver Lead
                  </button>
                )}

                {/* Resolve */}
                {selectedConv.status !== 'resolved' && (
                  <button
                    onClick={resolveConversation}
                    style={{ padding: '6px 12px', background: 'var(--accent-soft)', border: '1px solid var(--accent-border)', borderRadius: '8px', color: 'var(--accent)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    ✓ Resolver
                  </button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--bg-page)' }}>
              {msgLoading ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '20px' }}>Cargando mensajes...</div>
              ) : messages.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '40px' }}>
                  Sin mensajes aún. Envía el primero 👇
                </div>
              ) : (
                messages.map((msg, idx) => {
                  const isOut = msg.direction === 'out'
                  const showDate = idx === 0 || new Date(msg.created_at).toDateString() !== new Date(messages[idx-1].created_at).toDateString()
                  return (
                    <div key={msg.id}>
                      {showDate && (
                        <div style={{ textAlign: 'center', margin: '12px 0' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'var(--bg-card)', padding: '4px 12px', borderRadius: '10px', border: '1px solid var(--border)' }}>
                            {new Date(msg.created_at).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' })}
                          </span>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: isOut ? 'flex-end' : 'flex-start', alignItems: 'flex-end', gap: '6px' }}>
                        {!isOut && (
                          <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'var(--accent-soft)', border: '1px solid var(--accent-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <span style={{ fontSize: '12px' }}>👤</span>
                          </div>
                        )}
                        <div style={{ maxWidth: '65%' }}>
                          {isOut && msg.sent_by_nombre && (
                            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px', textAlign: 'right' }}>
                              {msg.is_bot ? '🤖 Claudia' : msg.sent_by_nombre}
                            </div>
                          )}
                          <div style={{
                            padding: '10px 14px', borderRadius: isOut ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
                            background: isOut ? (msg.is_bot ? 'var(--accent-soft)' : 'var(--accent-solid)') : 'var(--bg-card)',
                            color: isOut ? (msg.is_bot ? 'var(--text-primary)' : '#fff') : 'var(--text-primary)',
                            border: isOut ? (msg.is_bot ? '1px solid var(--accent-border)' : 'none') : '1px solid var(--border)',
                            fontSize: '13px', lineHeight: 1.5,
                            boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                          }}>
                            {msg.media_url ? (
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: msg.content ? '6px' : 0 }}>
                                  <span style={{ fontSize: '13px' }}>🎙</span>
                                  <audio controls src={msg.media_url} style={{ height: '32px', maxWidth: '210px' }} />
                                </div>
                                {msg.content && (
                                  <div style={{
                                    paddingTop: '6px',
                                    borderTop: '1px dashed ' + (isOut ? (msg.is_bot ? 'var(--accent-border)' : 'rgba(255,255,255,0.35)') : 'var(--border)'),
                                    fontSize: '12px', fontStyle: 'italic',
                                    opacity: isOut ? 0.92 : 0.85,
                                  }}>
                                    {msg.content}
                                  </div>
                                )}
                              </div>
                            ) : (
                              msg.content
                            )}
                          </div>
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '3px', textAlign: isOut ? 'right' : 'left', display: 'flex', alignItems: 'center', gap: '4px', justifyContent: isOut ? 'flex-end' : 'flex-start' }}>
                            {fmtFull(msg.created_at)}
                            {isOut && (
                              <span style={{ color: msg.status === 'read' ? 'var(--accent)' : msg.status === 'delivered' ? 'var(--heat-cold)' : 'var(--text-muted)' }}>
                                {msg.status === 'read' ? '✓✓' : msg.status === 'delivered' ? '✓✓' : '✓'}
                              </span>
                            )}
                          </div>
                        </div>
                        {isOut && (
                          <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: msg.is_bot ? 'var(--accent-soft)' : 'var(--accent-soft)', border: '1px solid ' + (msg.is_bot ? 'var(--accent-border)' : 'var(--accent-border)'), display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <span style={{ fontSize: '12px' }}>{msg.is_bot ? '🤖' : '👤'}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg-card)' }}>
              {selectedConv.bot_active && (
                <div style={{ fontSize: '11px', color: 'var(--accent)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  🤖 Claudia está activa — tus mensajes también se enviarán junto a los del bot
                </div>
              )}
              {selectedConv.status === 'resolved' && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', textAlign: 'center' }}>
                  Conversación cerrada · <button onClick={() => { supabase.from('crm_conversations').update({ status: 'open' }).eq('id', selectedConv.id); setSelectedConv(p => p ? { ...p, status: 'open' } : null); loadConversations({ silent: true, preserveOrder: true }) }} style={{ color: 'var(--accent-solid)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 600 }}>Reabrir</button>
                </div>
              )}
              <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                <textarea
                  style={{ flex: 1, padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '12px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', resize: 'none', minHeight: '44px', maxHeight: '120px', lineHeight: 1.5, fontFamily: 'inherit' }}
                  placeholder="Escribe un mensaje..."
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
                  rows={1}
                  disabled={selectedConv.status === 'resolved'}
                />
                <button
                  onClick={sendMessage}
                  disabled={!inputText.trim() || sending || selectedConv.status === 'resolved'}
                  style={{ width: '44px', height: '44px', borderRadius: '50%', background: inputText.trim() ? 'var(--accent-solid)' : 'var(--border)', border: 'none', cursor: inputText.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 0.2s' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="chx-main" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-page)' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '48px', marginBottom: '16px' }}>💬</div>
              <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>WhatsApp CRM</div>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Selecciona una conversación para comenzar</div>
            </div>
          </div>
        )}

        {/* ── RIGHT PANEL: Lead Info ─────────────────────────────────────── */}
        {selectedConv && lead && (
          <div className="chx-lead" style={{ width: '260px', flexShrink: 0, borderLeft: '1px solid var(--border)', background: 'var(--bg-card)', overflowY: 'auto', padding: '16px' }}>
            <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '16px' }}>Info del Lead</div>

            {/* Heat */}
            <div style={{ textAlign: 'center', marginBottom: '16px', padding: '14px 12px', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '10px' }}>
              <div style={{ fontSize: '34px', fontWeight: 600, lineHeight: 1, color: lead.heat_score >= 75 ? 'var(--heat-hot)' : lead.heat_score >= 50 ? 'var(--heat-warm)' : 'var(--heat-cold)' }}>{lead.heat_score}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>Heat score · {lead.heat_score >= 75 ? 'caliente' : lead.heat_score >= 50 ? 'tibio' : 'frío'}</div>
            </div>

            {[
              ['Nombre', lead.nombre + ' ' + lead.apellidos],
              ['Teléfono', lead.telefono],
              ['Modelo', lead.modelo_interes || '—'],
              ['Etapa', lead.etapa],
              ['Fuente', fuenteLabel(lead.fuente)],
              ['Asignado', lead.asignado_nombre || '—'],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: 'var(--font-inter), Inter, sans-serif', fontWeight: 600 }}>{k}</span>
                <span style={{ fontSize: '11px', color: 'var(--text-primary)', textAlign: 'right', maxWidth: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
              </div>
            ))}

            {/* Bot status */}
            <div style={{ marginTop: '16px', padding: '12px', background: selectedConv.bot_active ? 'var(--accent-soft)' : 'var(--bg-deep)', borderRadius: '8px', border: '1px solid ' + (selectedConv.bot_active ? 'var(--accent-soft)' : 'var(--border)') }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: selectedConv.bot_active ? 'var(--accent)' : 'var(--text-muted)', marginBottom: '4px' }}>
                🤖 {selectedConv.bot_active ? 'Bot Activo' : 'Bot Inactivo'}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                {selectedConv.bot_active ? 'Claudia responde automáticamente' : 'Control manual del agente'}
              </div>
              <button
                onClick={() => toggleBot(!selectedConv.bot_active)}
                style={{ marginTop: '8px', width: '100%', padding: '6px', borderRadius: '6px', border: 'none', cursor: 'pointer', background: selectedConv.bot_active ? 'rgba(240,85,106,0.14)' : 'var(--accent-soft)', color: selectedConv.bot_active ? 'var(--heat-hot)' : 'var(--accent)', fontSize: '11px', fontWeight: 600 }}
              >
                {selectedConv.bot_active ? 'Desactivar Bot' : 'Activar Bot'}
              </button>
            </div>

            {/* Quick actions */}
            <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '4px' }}>Acciones Rápidas</div>
              {['📅 Agendar cita', '📋 Ver historial CRM', '🔄 Cambiar etapa'].map(action => (
                <button key={action} style={{ padding: '8px 10px', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-secondary)', fontSize: '11px', cursor: 'pointer', textAlign: 'left' }}>
                  {action}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </CrmShell>
  )
}