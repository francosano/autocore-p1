// TARGET: autocore-p1-extension/src/lib/supabase.ts
// Minimal Supabase REST + GoTrue auth client for the background service
// worker. Uses the PUBLIC anon key + a logged-in staff user's JWT, so all
// reads/writes go through the same RLS policies as the web app. The
// service-role key is never used or present here.
import { SUPABASE_URL, SUPABASE_ANON_KEY, K_SESSION } from '../config';
import { getLocal, setLocal, removeLocal } from './storage';

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  email: string;
  user_id: string;
}

const AUTH = `${SUPABASE_URL}/auth/v1`;
const REST = `${SUPABASE_URL}/rest/v1`;

function sessionFromToken(json: any): Session {
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    email: json.user?.email || '',
    user_id: json.user?.id || '',
  };
}

export async function passwordLogin(email: string, password: string): Promise<Session> {
  const res = await fetch(`${AUTH}/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.msg || `login failed (${res.status})`);
  const session = sessionFromToken(json);
  await setLocal(K_SESSION, session);
  return session;
}

async function refresh(session: Session): Promise<Session> {
  const res = await fetch(`${AUTH}/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || 'refresh failed');
  const next = sessionFromToken(json);
  await setLocal(K_SESSION, next);
  return next;
}

export async function loadSession(): Promise<Session | null> {
  return (await getLocal<Session>(K_SESSION)) || null;
}

export async function logout(): Promise<void> {
  await removeLocal(K_SESSION);
}

// Returns a valid session, refreshing if it expires within 60s. Null if none.
export async function ensureSession(): Promise<Session | null> {
  let s = await loadSession();
  if (!s) return null;
  if (Date.now() > s.expires_at - 60_000) {
    try {
      s = await refresh(s);
    } catch {
      await logout();
      return null;
    }
  }
  return s;
}

// Authenticated PostgREST call. `path` starts after /rest/v1/ (e.g.
// "crm_conversations?on_conflict=fb_thread_id").
export async function rest(session: Session, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${REST}/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

async function restJson<T>(session: Session, path: string, init?: RequestInit): Promise<T> {
  const res = await rest(session, path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 200)}`);
  }
  const t = await res.text();
  return (t ? JSON.parse(t) : null) as T;
}

// ── Domain helpers ───────────────────────────────────────────────────────────

// Upsert an fb_marketplace conversation on fb_thread_id; return its uuid.
export async function upsertConversation(
  session: Session,
  t: { fbThreadId: string; buyerName: string | null; listingTitle: string | null; listingId: string | null; lastMessagePreview: string | null; lastMessageAt: string | null }
): Promise<string | null> {
  const row = {
    canal: 'fb_marketplace',
    fb_thread_id: t.fbThreadId,
    fb_buyer_name: t.buyerName,
    fb_listing_title: t.listingTitle,
    fb_listing_id: t.listingId,
    last_message_preview: t.lastMessagePreview,
    last_message_at: t.lastMessageAt || new Date().toISOString(),
    status: 'open',
  };
  const rows = await restJson<any[]>(
    session,
    'crm_conversations?on_conflict=fb_thread_id',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(row),
    }
  );
  return rows && rows[0] ? rows[0].id : null;
}

// Upsert scraped messages (dedup on fb_message_id UNIQUE).
export async function upsertMessages(
  session: Session,
  conversationId: string,
  msgs: { fbMessageId: string; direction: 'in' | 'out'; content: string; createdAt: string }[]
): Promise<number> {
  if (!msgs.length) return 0;
  const rows = msgs.map((m) => ({
    conversation_id: conversationId,
    canal: 'fb_marketplace',
    direction: m.direction,
    content: m.content,
    fb_message_id: m.fbMessageId,
    status: m.direction === 'out' ? 'sent' : 'received',
    sent_by: 'fb',
    is_bot: false,
    created_at: m.createdAt,
  }));
  await rest(session, 'crm_mensajes?on_conflict=fb_message_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  return rows.length;
}

export async function getQueuedOutboxByThread(
  session: Session,
  fbThreadId: string
): Promise<{ id: string; body: string; queued_at: string }[]> {
  const conv = await restJson<any[]>(
    session,
    `crm_conversations?fb_thread_id=eq.${encodeURIComponent(fbThreadId)}&select=id&limit=1`,
    { method: 'GET' }
  );
  if (!conv || !conv[0]) return [];
  return restJson<any[]>(
    session,
    `fb_outbox?conversation_id=eq.${conv[0].id}&status=eq.queued&select=id,body,queued_at&order=queued_at.asc`,
    { method: 'GET' }
  );
}

export async function countQueuedOutbox(session: Session): Promise<number> {
  const res = await rest(session, 'fb_outbox?status=eq.queued&select=id', {
    method: 'GET',
    headers: { Prefer: 'count=exact', Range: '0-0' },
  });
  const range = res.headers.get('content-range'); // e.g. "0-0/12"
  if (range && range.includes('/')) {
    const n = parseInt(range.split('/')[1], 10);
    if (Number.isFinite(n)) return n;
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

export async function markOutbox(
  session: Session,
  id: string,
  status: 'sent' | 'failed',
  error?: string
): Promise<void> {
  const patch: any = { status };
  if (status === 'sent') patch.sent_at = new Date().toISOString();
  if (status === 'failed') patch.error = error || 'send failed';
  await rest(session, `fb_outbox?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

export async function getNextReadyListing(session: Session): Promise<any | null> {
  const rows = await restJson<any[]>(
    session,
    'fb_listings?status=eq.ready_to_publish&select=id,titulo,precio_usd,descripcion,fotos&order=updated_at.asc&limit=1',
    { method: 'GET' }
  );
  return rows && rows[0] ? rows[0] : null;
}

export async function markListingPublished(
  session: Session,
  id: string,
  fbUrl: string | null,
  fbListingId: string | null
): Promise<void> {
  await rest(session, `fb_listings?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'published',
      fb_url: fbUrl,
      fb_listing_id: fbListingId,
      published_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
    }),
  });
}
