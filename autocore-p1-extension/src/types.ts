// TARGET: autocore-p1-extension/src/types.ts
// Shared types + the message protocol between content scripts and the
// background service worker. Content scripts NEVER touch Supabase directly —
// they message the background, which holds the session and does all REST.
import type { Settings } from './config';
export type { Settings };

export type ScriptName = 'inbox' | 'reply' | 'publisher';

// A scraped Marketplace thread (read-only sync).
export interface ScrapedThread {
  fbThreadId: string;
  buyerName: string | null;
  listingTitle: string | null;
  listingId: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null; // ISO
}

// A scraped message within a thread.
export interface ScrapedMessage {
  fbThreadId: string;
  fbMessageId: string; // real FB id if available, else a content+ts hash
  direction: 'in' | 'out';
  content: string;
  createdAt: string; // ISO
}

// A queued reply for the reply-assist overlay.
export interface OutboxItem {
  id: string;
  body: string;
  queuedAt: string;
}

// A listing to prefill on the create-vehicle page.
export interface ReadyListing {
  id: string;
  titulo: string;
  precioUsd: number | null;
  descripcion: string | null;
  fotos: string[];
}

export interface PopupState {
  loggedIn: boolean;
  email: string | null;
  settings: Settings;
  threadsSynced: number;
  messagesSynced: number;
  repliesPending: number;
  sendsLastHour: number;
  paused: Partial<Record<ScriptName, boolean>>;
  lastError: string | null;
  lastSyncAt: string | null;
}

// ── Messages (content/popup → background) ──────────────────────────────────
export type Msg =
  | { type: 'AUTH_STATUS' }
  | { type: 'LOGIN'; email: string; password: string }
  | { type: 'LOGOUT' }
  | { type: 'GET_STATE' }
  | { type: 'SET_SETTINGS'; patch: Partial<Settings> }
  | { type: 'INBOX_SYNC'; threads: ScrapedThread[]; messages: ScrapedMessage[] }
  | { type: 'GET_OUTBOX'; fbThreadId: string }
  | { type: 'MARK_OUTBOX'; id: string; status: 'sent' | 'failed'; error?: string }
  | { type: 'CAN_AUTOSEND' }
  | { type: 'RECORD_SEND' }
  | { type: 'GET_NEXT_LISTING' }
  | { type: 'MARK_LISTING_PUBLISHED'; id: string; fbUrl: string | null; fbListingId: string | null }
  | { type: 'SELECTOR_FAILURE'; script: ScriptName }
  | { type: 'SELECTOR_OK'; script: ScriptName };

export interface Resp {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}
