// TARGET: autocore-p1/scripts/site-sync-local.mjs
// ═══════════════════════════════════════════════════════════════════════════
// Runs the p1-site-sync inventory crawl LOCALLY (Node 18+), reusing the exact
// runSync() from the Worker. Needed because www.p1autosales.com sits behind
// Cloudflare bot protection that 403s fetches from Workers IP space, while
// residential connections are served normally.
//
// Usage (easiest): powershell -ExecutionPolicy Bypass -File scripts\site-sync-local.ps1
// Direct:          node scripts/site-sync-local.mjs            (needs env vars)
// Dry run:         node scripts/site-sync-local.mjs --dry      (no Supabase writes)
//
// Env: SUPABASE_SERVICE_ROLE_KEY (required unless --dry), SUPABASE_URL
// (defaults to the P1 project).
// ═══════════════════════════════════════════════════════════════════════════
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from '../workers/p1-site-sync/src/worker.js';

// Route ALL network through curl.exe. Two reasons:
//   1. The dealer site's Cloudflare serves our honest UA via curl (200) but
//      challenges Node's HTTP stack (403).
//   2. Node 25 + undici + spawning curl subprocesses is unstable on Windows
//      (intermittent dropped headers -> Supabase "No API key found", and even
//      libuv crashes). Using curl for the Supabase REST calls too removes
//      undici from the hot path entirely and is rock-solid.
// The deployed Cloudflare Worker never loads this file — it uses native fetch.
let tmpN = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  const headers = init.headers || {};
  const stamp = `${process.pid}-${Date.now()}-${tmpN++}`;
  const outFile = join(tmpdir(), `acp1-out-${stamp}.tmp`);
  const bodyFile = init.body != null ? join(tmpdir(), `acp1-body-${stamp}.tmp`) : null;

  const args = ['-sS', '-L', '--max-time', '90', '-X', method, '-o', outFile, '-w', '%{http_code}'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (bodyFile) {
    writeFileSync(bodyFile, String(init.body));
    args.push('--data-binary', `@${bodyFile}`);
  }
  args.push(u);

  try {
    const status = parseInt(
      String(execFileSync('curl.exe', args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true })).trim(),
      10
    ) || 0;
    const text = readFileSync(outFile, 'utf8');
    return new Response(text, { status });
  } catch (e) {
    return new Response(String((e && e.message) || e), { status: 599 });
  } finally {
    try { unlinkSync(outFile); } catch { /* ignore */ }
    if (bodyFile) { try { unlinkSync(bodyFile); } catch { /* ignore */ } }
  }
};

const dry = process.argv.includes('--dry');
const fotosMode = process.argv.includes('--fotos');
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

// ── --fotos: download every listing's photo gallery to .\fotos\<STOCK>_<vehiculo>\ ──
// Crawls the public site only (no Supabase, no keys needed). Skips photos
// already on disk, so re-runs are fast and only fetch what's new.
// Folders are named STOCK FIRST because the stock number is the dealer's
// unique key: titles collide (three "FORD TRANSIT 250 CARGO VAN"), stock
// numbers never do, and the folders sort by stock. The stock number is the
// last segment of the listing URL (…/inventory/ford/explorer/dc75018/ →
// DC75018). The title is kept after it so a folder is still readable at a
// glance when picking photos to upload.
const FOTOS_DIR = join(process.cwd(), 'fotos');
const safeName = (s) => String(s || 'vehiculo').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
const stockFromUrl = (u) => (String(u).replace(/\/+$/, '').split('/').pop() || 'sin-stock').toUpperCase();

function downloadPhoto(url, filePath) {
  // curl -o writes binary directly to disk (the fetch shim is text-only).
  execFileSync('curl.exe', ['-sS', '-L', '--max-time', '90', '-o', filePath, url], { windowsHide: true });
}

async function saveListingPhotos(listing) {
  const folderName = `${stockFromUrl(listing.source_url)}_${safeName(listing.titulo)}`;
  const dir = join(FOTOS_DIR, folderName);
  mkdirSync(dir, { recursive: true });
  const fotos = Array.isArray(listing.fotos) ? listing.fotos : [];
  let downloaded = 0;
  for (let i = 0; i < fotos.length; i++) {
    const file = join(dir, String(i + 1).padStart(2, '0') + '.jpg');
    if (existsSync(file)) continue;
    try { downloadPhoto(fotos[i], file); downloaded++; } catch { /* skip broken photo */ }
  }
  console.log(`[fotos] ${folderName}: ${fotos.length} fotos (${downloaded} nuevas)`);
}

if (!dry && !fotosMode && !serviceKey) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY (o usa --dry para probar sin escribir).');
  console.error('Recomendado: powershell -ExecutionPolicy Bypass -File scripts\\site-sync-local.ps1');
  process.exit(1);
}

const env = {
  SUPABASE_URL: (process.env.SUPABASE_URL || 'https://mrxpvutodyomldnjokau.supabase.co').trim(),
  SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  SITEMAP_URL: 'https://www.p1autosales.com/inventory_usedcars-sitemap.xml',
  FETCH_DELAY_MS: fotosMode ? '800' : '1500',
  USER_AGENT: 'AutoCoreP1-SiteSync/1.0 (local; inventory sync; contact: franco.sano@cefinternational.com)',
  // --fotos runs as a crawl-only pass (no Supabase writes) + photo download.
  DRY_RUN: (dry || fotosMode) ? '1' : '',
  ON_LISTING: fotosMode ? saveListingPhotos : undefined,
};

// ── Preflight: confirm the service key actually authenticates before crawling.
if (!dry && !fotosMode) {
  const masked = serviceKey.length > 12
    ? `${serviceKey.slice(0, 6)}…${serviceKey.slice(-4)} (len ${serviceKey.length})`
    : `(len ${serviceKey.length})`;
  console.log('Preflight → Supabase:', env.SUPABASE_URL);
  console.log('  service key:', masked);
  const looksAnon = /"role":"anon"/.test(Buffer.from((serviceKey.split('.')[1] || ''), 'base64').toString('utf8'));
  if (looksAnon) {
    console.error('  ERROR: esa es la clave ANON, no la SERVICE_ROLE. Copia la clave "service_role" (secret) en Project Settings → API Keys.');
    process.exit(1);
  }
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/site_inventory_staging?select=id&limit=1`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (r.status === 401 || r.status === 403) {
      const body = await r.text().catch(() => '');
      console.error(`  ERROR HTTP ${r.status}: la clave no autentica. ${body.slice(0, 160)}`);
      console.error('  Revisa que sea la service_role de mrxpvutodyomldnjokau (Project Settings → API Keys → service_role → Reveal/Copy).');
      process.exit(1);
    }
    console.log('  OK  autenticado (HTTP ' + r.status + ')');
  } catch (e) {
    console.error('  ERROR de red en preflight:', String(e && e.message || e));
    process.exit(1);
  }
}

console.log(
  fotosMode ? `Descargando fotos de todo el inventario → ${FOTOS_DIR}\\ ...`
    : dry ? 'Sync LOCAL (dry run — sin escrituras)...'
    : 'Sync LOCAL → site_inventory_staging...'
);
const result = await runSync(env);
console.log(JSON.stringify(result, null, 2));
if (fotosMode) console.log(`Fotos guardadas en: ${FOTOS_DIR}`);
if (result.failed > 0) process.exitCode = 2;
