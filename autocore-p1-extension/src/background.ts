// TARGET: autocore-p1-extension/src/background.ts
// MV3 service worker. Single owner of the Supabase session; every content
// script and the popup talk to it via chrome.runtime messages. Also runs the
// fb_outbox poll alarm (drives the popup's "replies pending" counter and,
// indirectly, the reply-assist overlay).
import {
  OUTBOX_ALARM,
  OUTBOX_POLL_MINUTES,
  K_STATE,
} from './config';
import { getSettings, setSettings, getLocal, setLocal } from './lib/storage';
import {
  passwordLogin,
  ensureSession,
  loadSession,
  logout,
  upsertConversation,
  upsertMessages,
  getQueuedOutboxByThread,
  countQueuedOutbox,
  markOutbox,
  getNextReadyListing,
  markListingPublished,
} from './lib/supabase';
import { canAutoSend, recordSend, sendsLastHour } from './lib/ratelimit';
import type { Msg, Resp, ScriptName, PopupState, ScrapedThread, ScrapedMessage } from './types';

// ── Persisted popup state ────────────────────────────────────────────────────
interface BgState {
  threadsSynced: number;
  messagesSynced: number;
  repliesPending: number;
  paused: Partial<Record<ScriptName, boolean>>;
  lastError: string | null;
  lastSyncAt: string | null;
}
const DEFAULT_STATE: BgState = {
  threadsSynced: 0,
  messagesSynced: 0,
  repliesPending: 0,
  paused: {},
  lastError: null,
  lastSyncAt: null,
};

async function getState(): Promise<BgState> {
  return { ...DEFAULT_STATE, ...((await getLocal<BgState>(K_STATE)) || {}) };
}
async function patchState(patch: Partial<BgState>): Promise<BgState> {
  const next = { ...(await getState()), ...patch };
  await setLocal(K_STATE, next);
  return next;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(OUTBOX_ALARM, { periodInMinutes: OUTBOX_POLL_MINUTES });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(OUTBOX_ALARM, { periodInMinutes: OUTBOX_POLL_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== OUTBOX_ALARM) return;
  // Jitter 0–15s so polling is not perfectly periodic.
  const delay = Math.floor(Math.random() * 15000);
  setTimeout(() => { void pollOutbox(); }, delay);
});

async function pollOutbox(): Promise<void> {
  const settings = await getSettings();
  if (settings.killSwitch || !settings.masterEnabled) return;
  const session = await ensureSession();
  if (!session) return;
  try {
    const pending = await countQueuedOutbox(session);
    await patchState({ repliesPending: pending, lastError: null });
    // Badge = pending replies awaiting a human send.
    await chrome.action.setBadgeText({ text: pending > 0 ? String(pending) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#1E4FA3' });
  } catch (e) {
    await patchState({ lastError: errMsg(e) });
  }
}

// ── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  handle(msg)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: errMsg(e) } as Resp));
  return true; // async response
});

async function handle(msg: Msg): Promise<Resp> {
  switch (msg.type) {
    case 'AUTH_STATUS': {
      const s = await loadSession();
      return { ok: true, loggedIn: !!s, email: s?.email || null };
    }
    case 'LOGIN': {
      const s = await passwordLogin(msg.email, msg.password);
      await patchState({ lastError: null });
      void pollOutbox();
      return { ok: true, email: s.email };
    }
    case 'LOGOUT': {
      await logout();
      await chrome.action.setBadgeText({ text: '' });
      return { ok: true };
    }
    case 'GET_STATE': {
      return { ok: true, state: await buildPopupState() };
    }
    case 'SET_SETTINGS': {
      const next = await setSettings(msg.patch);
      if (next.killSwitch || !next.masterEnabled) {
        await chrome.action.setBadgeText({ text: '' });
      }
      return { ok: true, settings: next };
    }
    case 'INBOX_SYNC':
      return syncInbox(msg.threads, msg.messages);
    case 'GET_OUTBOX': {
      const session = await ensureSession();
      if (!session) return { ok: false, error: 'not_logged_in' };
      const items = await getQueuedOutboxByThread(session, msg.fbThreadId);
      return { ok: true, items: items.map((i) => ({ id: i.id, body: i.body, queuedAt: i.queued_at })) };
    }
    case 'MARK_OUTBOX': {
      const session = await ensureSession();
      if (!session) return { ok: false, error: 'not_logged_in' };
      await markOutbox(session, msg.id, msg.status, msg.error);
      void pollOutbox();
      return { ok: true };
    }
    case 'CAN_AUTOSEND': {
      const settings = await getSettings();
      const res = await canAutoSend(settings);
      return { ok: true, allowed: res.ok, reason: res.reason };
    }
    case 'RECORD_SEND': {
      await recordSend();
      return { ok: true };
    }
    case 'GET_NEXT_LISTING': {
      const session = await ensureSession();
      if (!session) return { ok: false, error: 'not_logged_in' };
      const row = await getNextReadyListing(session);
      if (!row) return { ok: true, listing: null };
      return {
        ok: true,
        listing: {
          id: row.id,
          titulo: row.titulo,
          precioUsd: row.precio_usd,
          descripcion: row.descripcion,
          fotos: Array.isArray(row.fotos) ? row.fotos : [],
        },
      };
    }
    case 'MARK_LISTING_PUBLISHED': {
      const session = await ensureSession();
      if (!session) return { ok: false, error: 'not_logged_in' };
      await markListingPublished(session, msg.id, msg.fbUrl, msg.fbListingId);
      return { ok: true };
    }
    case 'SELECTOR_FAILURE': {
      const st = await getState();
      await patchState({
        paused: { ...st.paused, [msg.script]: true },
        lastError: `Facebook cambió su interfaz — script "${msg.script}" pausado`,
      });
      return { ok: true };
    }
    case 'SELECTOR_OK': {
      const st = await getState();
      const paused = { ...st.paused };
      delete paused[msg.script];
      await patchState({ paused });
      return { ok: true };
    }
    default:
      return { ok: false, error: 'unknown_message' };
  }
}

async function syncInbox(threads: ScrapedThread[], messages: ScrapedMessage[]): Promise<Resp> {
  const settings = await getSettings();
  if (settings.killSwitch || !settings.masterEnabled) return { ok: false, error: 'disabled' };
  const session = await ensureSession();
  if (!session) return { ok: false, error: 'not_logged_in' };

  let threadsSynced = 0;
  let messagesSynced = 0;
  // Map fbThreadId → conversation uuid as we upsert.
  const convIdByThread: Record<string, string> = {};

  for (const t of threads) {
    try {
      const id = await upsertConversation(session, t);
      if (id) {
        convIdByThread[t.fbThreadId] = id;
        threadsSynced++;
      }
    } catch (e) {
      await patchState({ lastError: errMsg(e) });
    }
  }

  // Group messages by thread; only insert for threads we resolved.
  const byThread: Record<string, any[]> = {};
  for (const m of messages) {
    (byThread[m.fbThreadId] ||= []).push(m);
  }
  for (const [threadId, msgs] of Object.entries(byThread)) {
    const convId = convIdByThread[threadId];
    if (!convId) continue;
    try {
      messagesSynced += await upsertMessages(session, convId, msgs);
    } catch (e) {
      await patchState({ lastError: errMsg(e) });
    }
  }

  const prev = await getState();
  await patchState({
    threadsSynced: prev.threadsSynced + threadsSynced,
    messagesSynced: prev.messagesSynced + messagesSynced,
    lastSyncAt: new Date().toISOString(),
    lastError: null,
  });
  return { ok: true, threadsSynced, messagesSynced };
}

async function buildPopupState(): Promise<PopupState> {
  const [session, settings, st, sends] = await Promise.all([
    loadSession(),
    getSettings(),
    getState(),
    sendsLastHour(),
  ]);
  return {
    loggedIn: !!session,
    email: session?.email || null,
    settings,
    threadsSynced: st.threadsSynced,
    messagesSynced: st.messagesSynced,
    repliesPending: st.repliesPending,
    sendsLastHour: sends,
    paused: st.paused,
    lastError: st.lastError,
    lastSyncAt: st.lastSyncAt,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
