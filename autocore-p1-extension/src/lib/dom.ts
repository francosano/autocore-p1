// TARGET: autocore-p1-extension/src/lib/dom.ts
// Resilient DOM helpers + a per-script selector-failure tracker that drives
// the "Facebook cambió su interfaz" backoff. Content scripts route every DOM
// lookup through here so a markup change degrades to a clean pause instead of
// silent misfires.
import { SEL, SelectorGroup } from '../selectors';
import { SELECTOR_FAIL_LIMIT } from '../config';
import type { ScriptName } from '../types';

// Try each candidate selector in a group; return the first matching element.
export function pick(root: ParentNode, group: SelectorGroup): HTMLElement | null {
  const candidates = SEL[group] as readonly string[];
  for (const sel of candidates) {
    if (typeof sel !== 'string') continue;
    try {
      const el = root.querySelector(sel);
      if (el) return el as HTMLElement;
    } catch {
      /* invalid selector for this DOM — try next */
    }
  }
  return null;
}

// All matches across the group's candidate selectors (deduped, order-stable).
export function pickAll(root: ParentNode, group: SelectorGroup): HTMLElement[] {
  const out: HTMLElement[] = [];
  const seen = new Set<Element>();
  const candidates = SEL[group] as readonly string[];
  for (const sel of candidates) {
    if (typeof sel !== 'string') continue;
    let list: NodeListOf<Element>;
    try {
      list = root.querySelectorAll(sel);
    } catch {
      continue;
    }
    list.forEach((el) => {
      if (!seen.has(el)) {
        seen.add(el);
        out.push(el as HTMLElement);
      }
    });
    if (out.length) break; // first group that matches wins
  }
  return out;
}

export const text = (el: Element | null | undefined): string =>
  (el?.textContent || '').replace(/\s+/g, ' ').trim();

// ── Selector-failure backoff ─────────────────────────────────────────────────
// Consecutive failures per script; at the limit the script pauses and tells
// the background (popup surfaces it). Any success resets the counter.
const failCount: Record<ScriptName, number> = { inbox: 0, reply: 0, publisher: 0 };
const paused: Record<ScriptName, boolean> = { inbox: false, reply: false, publisher: false };

export function reportOk(script: ScriptName): void {
  if (failCount[script] !== 0 || paused[script]) {
    failCount[script] = 0;
    paused[script] = false;
    chrome.runtime.sendMessage({ type: 'SELECTOR_OK', script }).catch(() => {});
  }
}

// Returns true if the script has just crossed into the paused state.
export function reportFailure(script: ScriptName): boolean {
  if (paused[script]) return false;
  failCount[script] += 1;
  if (failCount[script] >= SELECTOR_FAIL_LIMIT) {
    paused[script] = true;
    chrome.runtime.sendMessage({ type: 'SELECTOR_FAILURE', script }).catch(() => {});
    return true;
  }
  return false;
}

export const isPaused = (script: ScriptName): boolean => paused[script];

// Exponential backoff schedule (ms) keyed on consecutive failures, capped.
export function backoffDelay(script: ScriptName, baseMs = 3000, capMs = 60000): number {
  const n = failCount[script];
  return Math.min(capMs, baseMs * Math.pow(2, n));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const jitter = (ms: number): number => Math.floor(ms * (0.7 + Math.random() * 0.6));

// A stable hash for synthetic message ids (content+ts dedup when FB gives no id).
export function hashId(...parts: string[]): string {
  const s = parts.join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'h' + (h >>> 0).toString(36);
}
