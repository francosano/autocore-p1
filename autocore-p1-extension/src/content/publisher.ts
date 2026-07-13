// TARGET: autocore-p1-extension/src/content/publisher.ts
// Content script — listing publisher. On facebook.com/marketplace/create/vehicle
// it pulls the next fb_listings row with status 'ready_to_publish', prefills the
// title / price / description fields, and lets the HUMAN attach photos, review,
// and click Publish. After publishing, the human clicks "Marcar publicado" in
// the overlay → the extension records fb_url + flips status to 'published'.
import { pickAll, reportOk, reportFailure, isPaused, sleep } from '../lib/dom';
import { getSettings } from '../lib/storage';
import { SEL } from '../selectors';
import type { ReadyListing } from '../types';

const SCRIPT = 'publisher' as const;
const PANEL_ID = 'acp1-publish-panel';

// Find a form field whose label/aria-label/placeholder matches any hint word.
function findFieldByLabel(hints: readonly string[]): HTMLElement | null {
  const inputs = pickAll(document, 'publishTextInput');
  for (const el of inputs) {
    const meta = (
      (el.getAttribute('aria-label') || '') + ' ' +
      (el.getAttribute('placeholder') || '') + ' ' +
      (el.getAttribute('name') || '') + ' ' +
      labelTextFor(el)
    ).toLowerCase();
    if (hints.some((h) => meta.includes(h))) return el;
  }
  return null;
}

function labelTextFor(el: HTMLElement): string {
  const id = el.getAttribute('id');
  if (id) {
    const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (lab) return lab.textContent || '';
  }
  const wrap = el.closest('label');
  return wrap?.textContent || '';
}

function setFieldValue(el: HTMLElement, value: string): void {
  el.focus();
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(input, value) : (input.value = value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // contenteditable
    el.textContent = '';
    try {
      const sel = window.getSelection();
      if (sel) { sel.selectAllChildren(el); document.execCommand('insertText', false, value); }
    } catch {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }
}

function prefill(listing: ReadyListing): { filled: string[]; missing: string[] } {
  const filled: string[] = [];
  const missing: string[] = [];
  const title = findFieldByLabel(SEL.publishTitleLabels);
  if (title) { setFieldValue(title, listing.titulo); filled.push('título'); } else missing.push('título');

  if (listing.precioUsd != null) {
    const price = findFieldByLabel(SEL.publishPriceLabels);
    if (price) { setFieldValue(price, String(listing.precioUsd)); filled.push('precio'); } else missing.push('precio');
  }
  if (listing.descripcion) {
    const desc = findFieldByLabel(SEL.publishDescriptionLabels);
    if (desc) { setFieldValue(desc, listing.descripcion); filled.push('descripción'); } else missing.push('descripción');
  }
  if (filled.length === 0) reportFailure(SCRIPT); else reportOk(SCRIPT);
  return { filled, missing };
}

// ── Overlay ──────────────────────────────────────────────────────────────────
function ensurePanel(): HTMLElement {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = PANEL_ID;
  Object.assign(panel.style, {
    position: 'fixed', right: '16px', top: '80px', zIndex: '2147483647',
    width: '320px', background: '#11151D', color: '#EAEDF2',
    border: '1px solid #1E4FA3', borderRadius: '10px',
    boxShadow: '0 8px 30px rgba(0,0,0,0.5)', font: '12px system-ui, sans-serif', padding: '12px',
  } as CSSStyleDeclaration);
  document.body.appendChild(panel);
  return panel;
}

let current: ReadyListing | null = null;

async function render(): Promise<void> {
  const settings = await getSettings();
  const panel = ensurePanel();
  const header = '<div style="color:#3D6BC4;font-weight:700;margin-bottom:8px">AutoCore P1 — Publicar</div>';

  if (settings.killSwitch || !settings.masterEnabled) {
    panel.innerHTML = header + '<div style="color:#E0A23C">Extensión pausada (master/kill switch).</div>';
    return;
  }
  if (isPaused(SCRIPT)) {
    panel.innerHTML = header + '<div style="color:#F0556A">Facebook cambió su interfaz — publisher pausado.</div>';
    return;
  }

  if (!current) {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_NEXT_LISTING' }).catch(() => null);
    if (!resp?.ok) {
      const msg = resp?.error === 'not_logged_in' ? 'Inicia sesión en el popup.' : (resp?.error || 'Error');
      panel.innerHTML = header + `<div style="color:#E0A23C">${msg}</div>`;
      return;
    }
    current = resp.listing;
  }

  if (!current) {
    panel.innerHTML = header + '<div style="color:#7B8694">No hay publicaciones "listo para publicar" en la cola.</div>';
    return;
  }

  panel.innerHTML =
    header +
    `<div style="margin-bottom:8px">
       <div style="font-weight:600">${escapeHtml(current.titulo)}</div>
       <div style="color:#7B8694">${current.precioUsd != null ? '$' + current.precioUsd : 'sin precio'} · ${current.fotos.length} fotos</div>
     </div>
     <div style="font-size:11px;color:#E0A23C;margin-bottom:8px">Las fotos se adjuntan manualmente en Facebook (la extensión no puede subirlas).</div>
     <div class="acp1-pub-actions" style="display:flex;flex-direction:column;gap:6px"></div>
     <div class="acp1-pub-note" style="font-size:11px;color:#7B8694;margin-top:8px"></div>`;

  const actions = panel.querySelector('.acp1-pub-actions') as HTMLElement;
  const note = panel.querySelector('.acp1-pub-note') as HTMLElement;

  const fillBtn = mkBtn('Prellenar formulario', '#1E4FA3');
  fillBtn.onclick = () => {
    const r = prefill(current!);
    note.textContent = r.filled.length
      ? `Prellenado: ${r.filled.join(', ')}.` + (r.missing.length ? ` No encontrado: ${r.missing.join(', ')}.` : '')
      : 'No se encontraron campos del formulario. ¿Estás en la página de crear vehículo?';
  };
  actions.appendChild(fillBtn);

  const pubBtn = mkBtn('Marcar publicado', '#10B981');
  pubBtn.onclick = async () => {
    const fbUrl = window.prompt('Pega la URL de la publicación de Facebook (o deja vacío):', location.href) || null;
    const fbListingId = fbUrl?.match(/\/marketplace\/item\/(\d+)/)?.[1] || null;
    const resp = await chrome.runtime.sendMessage({
      type: 'MARK_LISTING_PUBLISHED', id: current!.id, fbUrl, fbListingId,
    }).catch(() => null);
    if (resp?.ok) { current = null; await render(); }
    else note.textContent = 'No se pudo marcar publicado: ' + (resp?.error || 'error');
  };
  actions.appendChild(pubBtn);

  const skipBtn = mkBtn('Saltar (siguiente)', '#7B8694');
  skipBtn.onclick = async () => { current = null; await render(); };
  actions.appendChild(skipBtn);
}

function mkBtn(label: string, color: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = `background:transparent;color:${color};border:1px solid ${color};border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;text-align:left`;
  return b;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

(async () => {
  if (!document.body) await sleep(1000);
  await render();
})();
