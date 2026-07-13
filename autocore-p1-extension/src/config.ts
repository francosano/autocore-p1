// TARGET: autocore-p1-extension/src/config.ts
// Build-time configuration. The anon/publishable key is PUBLIC (RLS is the
// security boundary) and is safe to embed in the bundle.
// The service-role key must NEVER appear here or anywhere in the extension.

export const SUPABASE_URL = 'https://mrxpvutodyomldnjokau.supabase.co';

// Injected by build.mjs (esbuild define) from the gitignored `.anon-key`
// file or the SUPABASE_ANON_KEY env var — write the key with
// scripts/set-keys.ps1 (repo root) and rebuild. Falls back to 'REPLACE_ME',
// which makes login fail loudly instead of silently.
declare const __SUPABASE_ANON_KEY__: string;
export const SUPABASE_ANON_KEY = __SUPABASE_ANON_KEY__;

// Poll cadence for fb_outbox. chrome.alarms enforces a 1-minute floor; the
// handler adds 0–15s of jitter so requests are not perfectly periodic.
export const OUTBOX_ALARM = 'fb-outbox-poll';
export const OUTBOX_POLL_MINUTES = 1;

// Consecutive selector failures (per content script) before that script
// pauses itself and surfaces "Facebook cambió su interfaz" in the popup.
export const SELECTOR_FAIL_LIMIT = 3;

// Storage keys (chrome.storage.local).
export const K_SESSION = 'ac_session';
export const K_SETTINGS = 'ac_settings';
export const K_STATE = 'ac_state';
export const K_SENDLOG = 'ac_sendlog';

export interface Settings {
  masterEnabled: boolean; // global on/off for all automation
  killSwitch: boolean; // hard stop — overrides everything
  autoSend: boolean; // reply-assist auto-send (default OFF)
  maxSendsPerHour: number; // hard rate limit for auto-send
  businessStartHour: number; // 0–23 local; auto-send only within [start, end)
  businessEndHour: number;
}

export const DEFAULT_SETTINGS: Settings = {
  masterEnabled: true,
  killSwitch: false,
  autoSend: false,
  maxSendsPerHour: 10,
  businessStartHour: 8,
  businessEndHour: 20,
};
