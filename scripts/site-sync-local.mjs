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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSync } from '../workers/p1-site-sync/src/worker.js';

const execFileP = promisify(execFile);

// The dealer site's Cloudflare rules serve our identified User-Agent via
// curl (verified 200) but challenge Node's HTTP stack (403). Route ONLY the
// dealer-site fetches through curl.exe — same honest UA, no spoofing.
// Supabase REST calls keep using the normal fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.includes('p1autosales.com')) return realFetch(url, init);
  const ua = (init && init.headers && init.headers['User-Agent']) || 'AutoCoreP1-SiteSync/1.0';
  try {
    const { stdout } = await execFileP(
      'curl.exe',
      ['-sS', '-L', '-A', ua, '-H', 'Accept: text/html,application/xml', '-w', '\n%{http_code}', u],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true }
    );
    const cut = stdout.lastIndexOf('\n');
    const body = stdout.slice(0, cut);
    const status = parseInt(stdout.slice(cut + 1).trim(), 10) || 0;
    return new Response(body, { status });
  } catch (e) {
    return new Response(String(e && e.message || e), { status: 599 });
  }
};

const dry = process.argv.includes('--dry');
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!dry && !serviceKey) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY (o usa --dry para probar sin escribir).');
  console.error('Recomendado: powershell -ExecutionPolicy Bypass -File scripts\\site-sync-local.ps1');
  process.exit(1);
}

const env = {
  SUPABASE_URL: (process.env.SUPABASE_URL || 'https://mrxpvutodyomldnjokau.supabase.co').trim(),
  SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  SITEMAP_URL: 'https://www.p1autosales.com/inventory_usedcars-sitemap.xml',
  FETCH_DELAY_MS: '1500',
  USER_AGENT: 'AutoCoreP1-SiteSync/1.0 (local; inventory sync; contact: franco.sano@cefinternational.com)',
  DRY_RUN: dry ? '1' : '',
};

// ── Preflight: confirm the service key actually authenticates before crawling.
if (!dry) {
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
    const r = await realFetch(`${env.SUPABASE_URL}/rest/v1/site_inventory_staging?select=id&limit=1`, {
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

console.log(dry ? 'Sync LOCAL (dry run — sin escrituras)...' : 'Sync LOCAL → site_inventory_staging...');
const result = await runSync(env);
console.log(JSON.stringify(result, null, 2));
if (result.failed > 0) process.exitCode = 2;
