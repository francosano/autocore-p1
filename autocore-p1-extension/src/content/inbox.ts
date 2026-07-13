// TARGET: autocore-p1-extension/src/content/inbox.ts
// Content script — inbox reader. READ-ONLY, fully automatic. Scrapes the
// Marketplace thread list and the currently-open thread's messages from the
// DOM and hands them to the background for upsert into crm_conversations /
// crm_mensajes (canal='fb_marketplace'). Never sends or clicks anything.
import { pick, pickAll, text, reportOk, reportFailure, isPaused, hashId, sleep, jitter } from '../lib/dom';
import { getSettings } from '../lib/storage';
import { SEL } from '../selectors';
import type { ScrapedThread, ScrapedMessage } from '../types';

const SCRIPT = 'inbox' as const;

function threadIdFromHref(href: string): string | null {
  const m = href.match(/\/(?:marketplace\/t|messages\/t|t)\/([\w.-]+)/);
  return m ? m[1] : null;
}

function currentThreadId(): string | null {
  return threadIdFromHref(location.pathname);
}

// Nearest ancestor row for a thread anchor, used to scope name/preview lookups.
function rowOf(anchor: HTMLElement): HTMLElement {
  return (anchor.closest('[role="row"], [role="listitem"], li') as HTMLElement) || anchor;
}

function scrapeThreadList(): ScrapedThread[] {
  const anchors = pickAll(document, 'threadRow');
  const out: ScrapedThread[] = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const id = threadIdFromHref(href);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = rowOf(a);
    const nameEl = pick(row, 'threadName');
    const previewEl = pick(row, 'threadPreview');
    out.push({
      fbThreadId: id,
      buyerName: text(nameEl) || null,
      listingTitle: null, // only known reliably inside an open thread header
      listingId: null,
      lastMessagePreview: text(previewEl) || null,
      lastMessageAt: null, // list rows rarely expose a parseable timestamp
    });
  }
  return out;
}

// Best-effort outbound detection: FB labels your own messages ("You sent" /
// "Enviaste") somewhere on the row's aria-label / title.
function isOutbound(row: HTMLElement): boolean {
  const hay = (
    (row.getAttribute('aria-label') || '') + ' ' +
    (row.getAttribute('title') || '') + ' ' +
    (row.querySelector('[aria-label]')?.getAttribute('aria-label') || '')
  ).toLowerCase();
  return SEL.outboundAriaHints.some((h) => hay.includes(h));
}

// Timestamps are inconsistent in the FB DOM; try title/datetime, else bucket
// to the current 5-minute window so the synthetic id is stable across scrapes.
function messageTimestamp(row: HTMLElement): string {
  const t =
    row.querySelector('time')?.getAttribute('datetime') ||
    row.querySelector('[data-timestamp]')?.getAttribute('data-timestamp') ||
    '';
  const parsed = t ? Date.parse(t) : NaN;
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const bucket = Math.floor(Date.now() / 300000) * 300000;
  return new Date(bucket).toISOString();
}

function scrapeOpenThread(): { thread: ScrapedThread | null; messages: ScrapedMessage[] } {
  const threadId = currentThreadId();
  if (!threadId) return { thread: null, messages: [] };

  const scroller = pick(document, 'messageScroller');
  if (!scroller) return { thread: null, messages: [] };

  const listingEl = pick(document, 'threadListingTitle');
  const listingHref = listingEl?.getAttribute('href') || '';
  const listingId = listingHref.match(/\/marketplace\/item\/(\d+)/)?.[1] || null;

  const rows = pickAll(scroller, 'messageRow');
  const messages: ScrapedMessage[] = [];
  let lastText: string | null = null;
  for (const row of rows) {
    const bodyEl = pick(row, 'messageText');
    const content = text(bodyEl);
    if (!content) continue;
    const direction = isOutbound(row) ? 'out' : 'in';
    const createdAt = messageTimestamp(row);
    const realId = row.getAttribute('data-message-id') || row.querySelector('[data-message-id]')?.getAttribute('data-message-id') || '';
    const fbMessageId = realId || hashId(threadId, direction, content, createdAt);
    messages.push({ fbThreadId: threadId, fbMessageId, direction, content, createdAt });
    lastText = content;
  }

  const thread: ScrapedThread = {
    fbThreadId: threadId,
    buyerName: null, // header name varies; the list scrape usually fills this
    listingTitle: text(listingEl) || null,
    listingId,
    lastMessagePreview: lastText,
    lastMessageAt: messages.length ? messages[messages.length - 1].createdAt : null,
  };
  return { thread, messages };
}

async function syncOnce(): Promise<void> {
  const settings = await getSettings();
  if (settings.killSwitch || !settings.masterEnabled || isPaused(SCRIPT)) return;

  const listThreads = scrapeThreadList();
  const open = scrapeOpenThread();

  // If neither the thread list nor an open thread resolved, the selectors are
  // probably stale — feed the backoff tracker.
  if (listThreads.length === 0 && !open.thread) {
    if (reportFailure(SCRIPT)) {
      console.warn('[AutoCore P1] inbox: selectors failing — paused');
    }
    return;
  }
  reportOk(SCRIPT);

  // Merge: prefer open-thread detail (listing title) over the list stub.
  const threadMap = new Map<string, ScrapedThread>();
  for (const t of listThreads) threadMap.set(t.fbThreadId, t);
  if (open.thread) {
    const existing = threadMap.get(open.thread.fbThreadId);
    threadMap.set(open.thread.fbThreadId, {
      ...(existing || open.thread),
      ...open.thread,
      buyerName: open.thread.buyerName || existing?.buyerName || null,
    });
  }

  const threads = [...threadMap.values()];
  const messages = open.messages;
  if (threads.length === 0 && messages.length === 0) return;

  try {
    await chrome.runtime.sendMessage({ type: 'INBOX_SYNC', threads, messages });
  } catch {
    /* background asleep / navigating — next tick retries */
  }
}

// Debounced observer + slow interval. Marketplace is a SPA, so we also react
// to DOM mutations, but throttle to avoid hammering.
let pending = false;
function schedule(): void {
  if (pending) return;
  pending = true;
  setTimeout(async () => {
    pending = false;
    await syncOnce();
  }, jitter(2500));
}

function start(): void {
  const obs = new MutationObserver(() => schedule());
  obs.observe(document.body, { childList: true, subtree: true });
  // Kick once on load and then on a slow heartbeat as a backstop.
  void syncOnce();
  setInterval(() => { void syncOnce(); }, 30000);
}

// Wait for body, then start.
(async () => {
  if (!document.body) await sleep(1000);
  start();
})();
