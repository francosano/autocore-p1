// TARGET: autocore-p1-extension/src/content/reply.ts
// Content script — reply assist. On an open Marketplace thread, shows a small
// overlay listing queued fb_outbox replies for THIS thread. Default: the human
// clicks "Insertar", the extension fills the composer, and the HUMAN clicks
// send, then confirms the outcome. Optional auto-send (off by default) types
// with human-like delays and respects the rate limit + business hours.
import { pick, reportOk, reportFailure, isPaused, sleep, jitter } from '../lib/dom';
import { getSettings } from '../lib/storage';
import type { OutboxItem } from '../types';

const SCRIPT = 'reply' as const;
const PANEL_ID = 'acp1-reply-panel';

function threadId(): string | null {
  const m = location.pathname.match(/\/(?:marketplace\/t|messages\/t|t)\/([\w.-]+)/);
  return m ? m[1] : null;
}

// ── Composer interaction ─────────────────────────────────────────────────────
// Fill the FB contenteditable composer. execCommand('insertText') triggers the
// same input events React listens for, so the send button enables correctly.
function fillComposer(body: string): boolean {
  const box = pick(document, 'composer') as HTMLElement | null;
  if (!box) {
    reportFailure(SCRIPT);
    return false;
  }
  box.focus();
  try {
    const sel = window.getSelection();
    if (sel) {
      sel.selectAllChildren(box);
      document.execCommand('insertText', false, body);
    }
  } catch {
    box.textContent = body;
    box.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
  reportOk(SCRIPT);
  return true;
}

function clickSend(): boolean {
  const btn = pick(document, 'sendButton') as HTMLElement | null;
  if (!btn) {
    reportFailure(SCRIPT);
    return false;
  }
  btn.click();
  return true;
}

// ── Overlay ──────────────────────────────────────────────────────────────────
function ensurePanel(): HTMLElement {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = PANEL_ID;
  Object.assign(panel.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
    width: '300px', maxHeight: '60vh', overflowY: 'auto',
    background: '#11151D', color: '#EAEDF2', border: '1px solid #1E4FA3',
    borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
    font: '12px system-ui, sans-serif', padding: '10px',
  } as CSSStyleDeclaration);
  document.body.appendChild(panel);
  return panel;
}

function row(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

async function render(): Promise<void> {
  const settings = await getSettings();
  const panel = ensurePanel();

  const header =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
    '<strong style="color:#3D6BC4">AutoCore P1 — Respuestas</strong>' +
    `<span style="font-size:10px;color:#7B8694">${settings.autoSend ? 'auto-send ON' : 'manual'}</span></div>`;

  if (settings.killSwitch || !settings.masterEnabled) {
    panel.innerHTML = header + '<div style="color:#E0A23C">Extensión pausada (master/kill switch).</div>';
    return;
  }
  if (isPaused(SCRIPT)) {
    panel.innerHTML = header + '<div style="color:#F0556A">Facebook cambió su interfaz — reply-assist pausado.</div>';
    return;
  }
  const tid = threadId();
  if (!tid) {
    panel.innerHTML = header + '<div style="color:#7B8694">Abre una conversación para ver sus respuestas en cola.</div>';
    return;
  }

  let resp: any;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'GET_OUTBOX', fbThreadId: tid });
  } catch {
    panel.innerHTML = header + '<div style="color:#7B8694">Reconectando…</div>';
    return;
  }
  if (!resp?.ok) {
    const msg = resp?.error === 'not_logged_in' ? 'Inicia sesión en el popup.' : (resp?.error || 'Error');
    panel.innerHTML = header + `<div style="color:#E0A23C">${msg}</div>`;
    return;
  }
  const items: OutboxItem[] = resp.items || [];
  panel.innerHTML = header;
  if (items.length === 0) {
    panel.appendChild(row('<div style="color:#7B8694">Sin respuestas en cola para esta conversación.</div>'));
    return;
  }
  for (const it of items) {
    const card = row(
      `<div style="border:1px solid #232A37;border-radius:8px;padding:8px;margin-bottom:8px">
        <div style="white-space:pre-wrap;margin-bottom:6px">${escapeHtml(it.body)}</div>
        <div class="acp1-actions" style="display:flex;gap:6px;flex-wrap:wrap"></div>
      </div>`
    );
    const actions = card.querySelector('.acp1-actions') as HTMLElement;

    const insertBtn = mkBtn(settings.autoSend ? 'Insertar y enviar' : 'Insertar', '#1E4FA3');
    insertBtn.onclick = () => (settings.autoSend ? autoSend(it, card) : manualInsert(it, card));
    actions.appendChild(insertBtn);

    panel.appendChild(card);
  }
}

function manualInsert(it: OutboxItem, card: HTMLElement): void {
  if (!fillComposer(it.body)) return;
  const actions = card.querySelector('.acp1-actions') as HTMLElement;
  actions.innerHTML = '';
  const note = document.createElement('span');
  note.textContent = 'Insertado — envía en Facebook, luego:';
  note.style.cssText = 'font-size:10px;color:#7B8694;width:100%';
  actions.appendChild(note);

  const sent = mkBtn('Marcar enviado', '#10B981');
  sent.onclick = async () => { await mark(it.id, 'sent'); await render(); };
  const failed = mkBtn('Marcar fallido', '#F0556A');
  failed.onclick = async () => { await mark(it.id, 'failed', 'manual: no enviado'); await render(); };
  actions.appendChild(sent);
  actions.appendChild(failed);
}

async function autoSend(it: OutboxItem, card: HTMLElement): Promise<void> {
  const actions = card.querySelector('.acp1-actions') as HTMLElement;
  const gate = await chrome.runtime.sendMessage({ type: 'CAN_AUTOSEND' }).catch(() => null);
  if (!gate?.ok || !gate.allowed) {
    actions.innerHTML = `<span style="font-size:10px;color:#E0A23C">Auto-send bloqueado (${gate?.reason || 'error'}). Usa inserción manual.</span>`;
    return;
  }
  if (!fillComposer(it.body)) return;
  // Human-like pause before sending.
  await sleep(jitter(1200));
  if (!clickSend()) return;
  await chrome.runtime.sendMessage({ type: 'RECORD_SEND' }).catch(() => {});
  await mark(it.id, 'sent');
  await render();
}

async function mark(id: string, status: 'sent' | 'failed', error?: string): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'MARK_OUTBOX', id, status, error }).catch(() => {});
}

function mkBtn(label: string, color: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = `background:transparent;color:${color};border:1px solid ${color};border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer`;
  return b;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// Re-render on navigation + a slow poll; the panel is cheap.
(async () => {
  if (!document.body) await sleep(1000);
  await render();
  let lastPath = location.pathname;
  setInterval(async () => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; }
    await render();
  }, 15000);
})();
