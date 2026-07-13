// TARGET: autocore-p1-extension/src/lib/ratelimit.ts
// Hard rate limit + business-hours gate for reply auto-send. Send timestamps
// are kept in chrome.storage.local so limits survive service-worker restarts.
import { K_SENDLOG, Settings } from '../config';
import { getLocal, setLocal } from './storage';

async function loadLog(): Promise<number[]> {
  const raw = (await getLocal<number[]>(K_SENDLOG)) || [];
  const cutoff = Date.now() - 3600_000;
  return raw.filter((t) => t >= cutoff);
}

export async function sendsLastHour(): Promise<number> {
  return (await loadLog()).length;
}

export async function recordSend(now = Date.now()): Promise<void> {
  const log = await loadLog();
  log.push(now);
  await setLocal(K_SENDLOG, log);
}

export function withinBusinessHours(s: Settings, d = new Date()): boolean {
  const h = d.getHours();
  // Supports windows that do not cross midnight (start < end), the common case.
  if (s.businessStartHour <= s.businessEndHour) {
    return h >= s.businessStartHour && h < s.businessEndHour;
  }
  // Overnight window (e.g. 20 → 6): active outside the [end, start) gap.
  return h >= s.businessStartHour || h < s.businessEndHour;
}

// Whether an auto-send is allowed right now. Returns a reason when blocked.
export async function canAutoSend(s: Settings): Promise<{ ok: boolean; reason?: string }> {
  if (s.killSwitch) return { ok: false, reason: 'kill_switch' };
  if (!s.masterEnabled) return { ok: false, reason: 'master_off' };
  if (!s.autoSend) return { ok: false, reason: 'autosend_off' };
  if (!withinBusinessHours(s)) return { ok: false, reason: 'outside_hours' };
  const count = await sendsLastHour();
  if (count >= s.maxSendsPerHour) return { ok: false, reason: 'rate_limit' };
  return { ok: true };
}
