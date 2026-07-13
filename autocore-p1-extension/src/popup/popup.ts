// TARGET: autocore-p1-extension/src/popup/popup.ts
// Popup controller: login state, sync counters, rate-limit settings, and the
// master / kill switches. All data comes from the background via messages.
import type { PopupState, Settings } from '../types';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function send<T = any>(msg: unknown): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
}

async function refresh(): Promise<void> {
  const resp = await send<{ ok: boolean; state?: PopupState }>({ type: 'GET_STATE' });
  const st = resp.state;
  if (!st) return;

  $('login-card').hidden = st.loggedIn;
  $('session-card').hidden = !st.loggedIn;
  $('controls-card').hidden = !st.loggedIn;

  if (st.loggedIn) {
    $('who').textContent = st.email || '—';
    $('threads').textContent = String(st.threadsSynced);
    $('messages').textContent = String(st.messagesSynced);
    $('pending').textContent = String(st.repliesPending);
    $('sends').textContent = `${st.sendsLastHour}/${st.settings.maxSendsPerHour}`;
    $('lastsync').textContent = fmtTime(st.lastSyncAt);

    const errEl = $('status-err');
    const pausedScripts = Object.keys(st.paused || {}).filter((k) => (st.paused as any)[k]);
    if (pausedScripts.length) {
      errEl.className = 'err warn';
      errEl.textContent = `Facebook cambió su interfaz — pausado: ${pausedScripts.join(', ')}.`;
    } else if (st.lastError) {
      errEl.className = 'err';
      errEl.textContent = st.lastError;
    } else {
      errEl.textContent = '';
    }

    // Controls reflect current settings.
    ($('master') as HTMLInputElement).checked = st.settings.masterEnabled;
    ($('kill') as HTMLInputElement).checked = st.settings.killSwitch;
    ($('autosend') as HTMLInputElement).checked = st.settings.autoSend;
    ($('maxsends') as HTMLInputElement).value = String(st.settings.maxSendsPerHour);
    ($('hstart') as HTMLInputElement).value = String(st.settings.businessStartHour);
    ($('hend') as HTMLInputElement).value = String(st.settings.businessEndHour);
  }
}

async function patchSettings(patch: Partial<Settings>): Promise<void> {
  await send({ type: 'SET_SETTINGS', patch });
  await refresh();
}

function wire(): void {
  $('login-btn').addEventListener('click', async () => {
    const email = ($('email') as HTMLInputElement).value.trim();
    const password = ($('password') as HTMLInputElement).value;
    const errEl = $('login-err');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Ingresa correo y contraseña.'; return; }
    const resp = await send<{ ok: boolean; error?: string }>({ type: 'LOGIN', email, password });
    if (!resp.ok) { errEl.textContent = resp.error || 'No se pudo iniciar sesión.'; return; }
    ($('password') as HTMLInputElement).value = '';
    await refresh();
  });

  $('logout-btn').addEventListener('click', async () => {
    await send({ type: 'LOGOUT' });
    await refresh();
  });

  ($('master') as HTMLInputElement).addEventListener('change', (e) =>
    patchSettings({ masterEnabled: (e.target as HTMLInputElement).checked }));
  ($('kill') as HTMLInputElement).addEventListener('change', (e) =>
    patchSettings({ killSwitch: (e.target as HTMLInputElement).checked }));
  ($('autosend') as HTMLInputElement).addEventListener('change', (e) =>
    patchSettings({ autoSend: (e.target as HTMLInputElement).checked }));
  ($('maxsends') as HTMLInputElement).addEventListener('change', (e) =>
    patchSettings({ maxSendsPerHour: clampInt((e.target as HTMLInputElement).value, 1, 60, 10) }));
  ($('hstart') as HTMLInputElement).addEventListener('change', (e) =>
    patchSettings({ businessStartHour: clampInt((e.target as HTMLInputElement).value, 0, 23, 8) }));
  ($('hend') as HTMLInputElement).addEventListener('change', (e) =>
    patchSettings({ businessEndHour: clampInt((e.target as HTMLInputElement).value, 0, 23, 20) }));
}

function clampInt(v: string, min: number, max: number, dflt: number): number {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

wire();
void refresh();
setInterval(() => void refresh(), 5000);
