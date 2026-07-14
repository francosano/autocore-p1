// TARGET: autocore-p1/workers/p1-claudia/src/worker.js
// ═══════════════════════════════════════════════════════════════════════════
// Claudia — the Prime One Auto Sales AI assistant Worker.
//
// Two independent surfaces, each gated by its own secrets so you can ship the
// brain before the WhatsApp number is live:
//
//   POST /draft   — the BRAIN. Body {messages:[{role,content}], vehicle?}.
//                   Returns {reply}. Auth: header  x-claudia-secret.
//                   Needs only ANTHROPIC_API_KEY (+ optional Supabase for the
//                   live catalog). Powers the in-CRM "Suggest reply" button and
//                   is fully testable with curl — no Meta setup required.
//
//   GET  /webhook — WhatsApp Cloud API verification handshake (Meta calls this).
//   POST /webhook — WhatsApp inbound messages. Verifies Meta's HMAC signature,
//                   logs the message to the CRM, and (when the conversation's
//                   bot is on 'full') drafts + sends a reply via the Graph API.
//                   Dormant until WHATSAPP_* secrets are set → returns 503.
//
// Secrets (set with `wrangler secret put`, never commit):
//   ANTHROPIC_API_KEY           Claude API key
//   CLAUDIA_SECRET              shared secret required on POST /draft
//   SUPABASE_URL                https://mrxpvutodyomldnjokau.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   P1 service_role key (server only, never client)
//   WHATSAPP_TOKEN              Meta permanent access token
//   WHATSAPP_PHONE_NUMBER_ID    Cloud API phone-number id
//   WHATSAPP_VERIFY_TOKEN       any string you also type into Meta's webhook UI
//   WHATSAPP_APP_SECRET         Meta app secret (verifies inbound signatures)
// Optional business-fact vars (see prompt.js) can be plain [vars] in wrangler.
// ═══════════════════════════════════════════════════════════════════════════
import { buildSystemPrompt, catalogText } from './prompt.js'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const GRAPH_VERSION = 'v21.0'
const MAX_HISTORY = 24 // most recent messages sent to the model

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    try {
      if (path === '/' && request.method === 'GET') return health(env)
      if (path === '/draft' && request.method === 'POST') return handleDraft(request, env)
      if (path === '/webhook' && request.method === 'GET') return verifyWebhook(url, env)
      if (path === '/webhook' && request.method === 'POST') return handleInbound(request, env, ctx)
      return json({ error: 'not_found' }, 404)
    } catch (err) {
      return json({ error: 'internal', detail: String(err && err.message || err) }, 500)
    }
  },
}

function health(env) {
  return json({
    service: 'p1-claudia',
    brain: cfg(env, 'ANTHROPIC_API_KEY') ? 'ready' : 'missing ANTHROPIC_API_KEY',
    whatsapp: whatsappConfigured(env) ? 'ready' : 'not configured',
  })
}

function whatsappConfigured(env) {
  return !!(cfg(env, 'WHATSAPP_TOKEN') && cfg(env, 'WHATSAPP_PHONE_NUMBER_ID') && cfg(env, 'WHATSAPP_VERIFY_TOKEN') && cfg(env, 'WHATSAPP_APP_SECRET'))
}

// ── Helpers ────────────────────────────────────────────────────────────────
// Read a secret/var, trimmed. Secrets piped into `wrangler secret put` on
// Windows arrive with a trailing \r\n, which silently breaks URLs and
// Authorization headers (this exact bug bit p1-site-sync). Always read
// config through here, never off `env` directly.
function cfg(env, key) {
  return String(env[key] || '').trim()
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Constant-time-ish compare (both hex strings same length).
function safeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ── The brain: build the model call and return Claudia's reply text ─────────
async function draftReply(env, messages, vehicleHint) {
  const units = await fetchCatalog(env)
  let catalog = catalogText(units)
  if (vehicleHint) {
    // A specific listing was in focus (CRM modal / matched FB listing).
    catalog = `VEHÍCULO EN FOCO (el cliente pregunta por este):\n${vehicleHint}\n\nRESTO DEL CATÁLOGO:\n${catalog}`
  }
  const system = buildSystemPrompt(env, catalog)

  const trimmed = messages
    .filter((m) => m && m.content && (m.role === 'user' || m.role === 'assistant'))
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: String(m.content) }))
  if (trimmed.length === 0 || trimmed[0].role !== 'user') {
    // Messages API requires the first turn to be 'user'.
    trimmed.unshift({ role: 'user', content: '(el cliente inició la conversación)' })
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': cfg(env, 'ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg(env, 'CLAUDIA_MODEL') || 'claude-opus-4-8',
      max_tokens: 1024,
      system,
      messages: trimmed,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  if (data.stop_reason === 'refusal') return HANDOFF
  const textBlock = Array.isArray(data.content) ? data.content.find((b) => b.type === 'text') : null
  return (textBlock && textBlock.text && textBlock.text.trim()) || HANDOFF
}

const HANDOFF = 'Déjame confirmar eso con el equipo y te respondo enseguida. ¿Cuál es el mejor momento para que te contactemos?'

// ── POST /draft — CRM "Suggest reply" + any external caller ─────────────────
async function handleDraft(request, env) {
  if (!cfg(env, 'ANTHROPIC_API_KEY')) return json({ error: 'brain_not_configured' }, 503)
  if (!cfg(env, 'CLAUDIA_SECRET') || (request.headers.get('x-claudia-secret') || '').trim() !== cfg(env, 'CLAUDIA_SECRET')) {
    return json({ error: 'unauthorized' }, 401)
  }
  let body
  try { body = await request.json() } catch { return json({ error: 'bad_json' }, 400) }
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (messages.length === 0) return json({ error: 'no_messages' }, 400)
  const reply = await draftReply(env, messages, body.vehicle || null)
  return json({ reply })
}

// ── GET /webhook — Meta verification handshake ──────────────────────────────
function verifyWebhook(url, env) {
  if (!whatsappConfigured(env)) return json({ error: 'whatsapp_not_configured' }, 503)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  if (mode === 'subscribe' && token === cfg(env, 'WHATSAPP_VERIFY_TOKEN')) {
    return new Response(challenge || '', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  return new Response('forbidden', { status: 403 })
}

// ── POST /webhook — WhatsApp inbound ────────────────────────────────────────
async function handleInbound(request, env, ctx) {
  if (!whatsappConfigured(env)) return json({ error: 'whatsapp_not_configured' }, 503)
  const raw = await request.text()

  // Verify Meta's HMAC-SHA256 signature over the raw body.
  const sigHeader = request.headers.get('x-hub-signature-256') || ''
  const ok = await verifySignature(cfg(env, 'WHATSAPP_APP_SECRET'), raw, sigHeader)
  if (!ok) return new Response('bad signature', { status: 401 })

  let payload
  try { payload = JSON.parse(raw) } catch { return json({ error: 'bad_json' }, 400) }

  // Always ACK fast; do the model + send work after responding so Meta does
  // not retry on our latency.
  ctx.waitUntil(processInbound(env, payload).catch(() => {}))
  return new Response('EVENT_RECEIVED', { status: 200 })
}

async function verifySignature(appSecret, rawBody, header) {
  if (!header.startsWith('sha256=')) return false
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  return safeEqual('sha256=' + toHex(mac), header)
}

async function processInbound(env, payload) {
  const entries = payload.entry || []
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {}
      const contacts = value.contacts || []
      const profileName = contacts[0] && contacts[0].profile && contacts[0].profile.name
      for (const msg of value.messages || []) {
        if (msg.type !== 'text' || !msg.text) continue // handle text only for now
        await handleOneMessage(env, {
          waMessageId: msg.id,
          from: msg.from, // buyer's wa phone
          text: msg.text.body || '',
          name: profileName || null,
        })
      }
    }
  }
}

async function handleOneMessage(env, m) {
  // 1) Upsert the conversation by wa_phone.
  const convo = await upsertConversation(env, m.from)
  if (!convo) return

  // 2) Idempotent inbound insert (wa_message_id is UNIQUE — retries no-op).
  const inserted = await insertMessage(env, {
    conversation_id: convo.id,
    lead_id: convo.lead_id || null,
    direction: 'in',
    content: m.text,
    wa_message_id: m.waMessageId,
    status: 'received',
    sent_by: 'customer',
    is_bot: false,
  })
  if (!inserted) return // duplicate delivery — nothing else to do

  await touchConversation(env, convo.id, m.text)

  // 3) Only the 'full' bot mode auto-replies. 'assist'/'off' leave it to a human.
  if (convo.bot_active === false || convo.bot_mode !== 'full') return

  // 4) Build history from stored messages and draft a reply.
  const history = await recentMessages(env, convo.id)
  const reply = await draftReply(env, history, null)

  // 5) Send via the Graph API, then log the outbound message.
  const outId = await sendWhatsApp(env, m.from, reply)
  await insertMessage(env, {
    conversation_id: convo.id,
    lead_id: convo.lead_id || null,
    direction: 'out',
    content: reply,
    wa_message_id: outId || null,
    status: outId ? 'sent' : 'failed',
    sent_by: 'claudia',
    sent_by_nombre: 'Claudia',
    is_bot: true,
  })
  await touchConversation(env, convo.id, reply)
}

async function sendWhatsApp(env, toPhone, text) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg(env, 'WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg(env, 'WHATSAPP_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: toPhone, type: 'text', text: { body: text } }),
  })
  if (!res.ok) return null
  const data = await res.json().catch(() => ({}))
  return (data.messages && data.messages[0] && data.messages[0].id) || null
}

// ── Supabase REST helpers (service role) ────────────────────────────────────
// Base Supabase URL: trimmed, no trailing slash.
function sbBase(env) {
  return cfg(env, 'SUPABASE_URL').replace(/\/$/, '')
}

function sbHeaders(env, extra) {
  return Object.assign({
    apikey: cfg(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    authorization: `Bearer ${cfg(env, 'SUPABASE_SERVICE_ROLE_KEY')}`,
    'content-type': 'application/json',
  }, extra || {})
}

async function fetchCatalog(env) {
  if (!sbBase(env) || !cfg(env, 'SUPABASE_SERVICE_ROLE_KEY')) return []
  // Public listing data only — never inventory_units (cost ledger).
  const q = `${sbBase(env)}/rest/v1/site_inventory_staging` +
    `?select=titulo,marca,modelo,anio,precio_usd,millas,vin&status=neq.removed_from_site&order=last_seen.desc&limit=80`
  const res = await fetch(q, { headers: sbHeaders(env) })
  if (!res.ok) return []
  return res.json().catch(() => [])
}

async function upsertConversation(env, waPhone) {
  // Try to find an existing whatsapp conversation for this phone.
  const findUrl = `${sbBase(env)}/rest/v1/crm_conversations` +
    `?select=id,lead_id,bot_active,bot_mode&canal=eq.whatsapp&wa_phone=eq.${encodeURIComponent(waPhone)}&limit=1`
  const found = await fetch(findUrl, { headers: sbHeaders(env) }).then((r) => r.ok ? r.json() : []).catch(() => [])
  if (Array.isArray(found) && found.length) return found[0]

  const res = await fetch(`${sbBase(env)}/rest/v1/crm_conversations`, {
    method: 'POST',
    headers: sbHeaders(env, { prefer: 'return=representation' }),
    body: JSON.stringify({ wa_phone: waPhone, canal: 'whatsapp', status: 'open' }),
  })
  if (!res.ok) return null
  const rows = await res.json().catch(() => [])
  return Array.isArray(rows) ? rows[0] : null
}

// Returns true if a NEW row was inserted, false on unique-conflict (dup).
async function insertMessage(env, row) {
  const res = await fetch(`${sbBase(env)}/rest/v1/crm_mensajes`, {
    method: 'POST',
    headers: sbHeaders(env, { prefer: 'return=minimal,resolution=ignore-duplicates' }),
    body: JSON.stringify(Object.assign({ canal: 'whatsapp' }, row)),
  })
  // 201 = inserted. With ignore-duplicates a conflicting row yields 200 + no body.
  return res.status === 201
}

async function touchConversation(env, id, preview) {
  await fetch(`${sbBase(env)}/rest/v1/crm_conversations?id=eq.${id}`, {
    method: 'PATCH',
    headers: sbHeaders(env, { prefer: 'return=minimal' }),
    body: JSON.stringify({
      last_message_at: new Date().toISOString(),
      last_message_preview: String(preview).slice(0, 160),
    }),
  }).catch(() => {})
}

async function recentMessages(env, convoId) {
  const q = `${sbBase(env)}/rest/v1/crm_mensajes` +
    `?select=direction,content,created_at&conversation_id=eq.${convoId}&order=created_at.desc&limit=${MAX_HISTORY}`
  const rows = await fetch(q, { headers: sbHeaders(env) }).then((r) => r.ok ? r.json() : []).catch(() => [])
  return (Array.isArray(rows) ? rows : [])
    .reverse()
    .map((r) => ({ role: r.direction === 'in' ? 'user' : 'assistant', content: r.content || '' }))
    .filter((m) => m.content)
}
