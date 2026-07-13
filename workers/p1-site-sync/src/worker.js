// TARGET: autocore-p1/workers/p1-site-sync/src/worker.js
// ═══════════════════════════════════════════════════════════════════════════
// p1-site-sync — crawls the Prime One public website's used-car inventory and
// upserts each listing into Supabase `site_inventory_staging`. Nothing here
// touches P1 inventory directly: staff review + promote in /inventario/importar.
//
// Two entry points:
//   • scheduled (cron)  — daily full crawl
//   • fetch (HTTP POST /sync) — manual trigger, gated by the SYNC_SECRET header
//
// Data source (see docs/p1-site-structure.md): a WordPress/DealerCenter site.
// We crawl the SITEMAP (the homepage is Cloudflare-challenged; detail pages and
// the sitemap are not). Each detail page carries schema.org JSON-LD (nested
// AutoDealer → makesOffer → itemOffered Car) plus a dws-vehicle-fields HTML
// table. Parse JSON-LD first; fall back to the HTML table for mileage.
//
// Writes go through the Supabase REST API with the SERVICE ROLE key (a Worker
// secret) — never expose that key anywhere else.
// ═══════════════════════════════════════════════════════════════════════════

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runSync(env).then(r => console.log('[cron] sync done', JSON.stringify(r))));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/sync') {
      // trim() both sides: secrets set via Windows pipes can carry \r\n.
      const secret = (request.headers.get('x-sync-secret') || '').trim();
      const expected = (env.SYNC_SECRET || '').trim();
      if (!expected || secret !== expected) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      try {
        const result = await runSync(env);
        return json({ ok: true, ...result });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 500);
      }
    }
    if (url.pathname === '/health') return json({ ok: true, service: 'p1-site-sync' });
    return json({ ok: false, error: 'not found' }, 404);
  },
};

// ── Orchestration ────────────────────────────────────────────────────────────
// Exported so scripts/site-sync-local.mjs can run the SAME sync from Franco's
// machine (the dealer site's Cloudflare bot protection 403s fetches from
// Workers IP space, but serves residential IPs fine). DRY_RUN='1' parses
// without writing to Supabase.
export async function runSync(env) {
  const delay = parseInt(env.FETCH_DELAY_MS || '1500', 10);
  const ua = env.USER_AGENT || 'AutoCoreP1-SiteSync/1.0';
  const dry = String(env.DRY_RUN || '') === '1';

  const urls = await fetchSitemapUrls(env.SITEMAP_URL, ua);
  const seen = new Set();
  let created = 0, updated = 0, unchanged = 0, failed = 0, parsed = 0;

  for (const loc of urls) {
    try {
      const html = await fetchText(loc, ua);
      const listing = parseListing(loc, html);
      parsed++;
      if (!dry) {
        const outcome = await upsertStaging(env, listing);
        if (outcome === 'new') created++;
        else if (outcome === 'updated') updated++;
        else unchanged++;
      } else {
        console.log('[dry]', listing.titulo, '| $' + listing.precio_usd, '|', listing.millas, 'mi |', listing.vin, '|', listing.fotos.length, 'fotos');
      }
      seen.add(normalizeUrl(loc));
    } catch (e) {
      failed++;
      console.log('[sync] failed', loc, String(e && e.message || e));
    }
    if (delay > 0) await sleep(delay);
  }

  // Mark rows that vanished from the sitemap as removed_from_site (only those
  // not already imported/ignored — we don't resurrect human decisions).
  const removed = dry ? 0 : await markRemoved(env, [...seen]);

  return { total: urls.length, parsed, created, updated, unchanged, failed, removed, dry_run: dry };
}

// ── Sitemap ──────────────────────────────────────────────────────────────────
async function fetchSitemapUrls(sitemapUrl, ua) {
  const xml = await fetchText(sitemapUrl, ua);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
  // De-dupe, keep only detail pages under /inventory/.
  return [...new Set(locs)].filter(u => /\/inventory\//.test(u));
}

// ── Detail-page parsing ──────────────────────────────────────────────────────
// Returns a normalized listing object matching site_inventory_staging columns.
export function parseListing(sourceUrl, html) {
  const { car, price } = parseJsonLd(html);    // car may be null if markup changes
  const fields = extractFieldsTable(html);     // { VIN, Mileage, ... }

  const name = (car && car.name) || '';
  const { year: yFromName, make, model } = splitName(name);

  const vin = (car && car.vehicleIdentificationNumber) || fields['VIN'] || null;
  const anio = toInt(car && car.modelDate) ?? yFromName ?? null;
  // Price lives on the enclosing Offer (makesOffer.priceSpecification.price),
  // NOT on the nested Car — pull it from the JSON-LD document.
  const precio = price;
  const millas = toInt((fields['Mileage'] || '').replace(/,/g, '')) ?? null;
  const fotos = extractPhotos(html);

  // Fallbacks for make/model from the URL path when name is missing.
  const urlParts = urlMakeModel(sourceUrl);

  return {
    source_url: normalizeUrl(sourceUrl),
    titulo: name || null,
    marca: make || urlParts.make || null,
    modelo: model || urlParts.model || null,
    anio,
    precio_usd: precio,
    millas,
    vin: vin ? String(vin).toUpperCase().trim() : null,
    fotos,
    raw: { jsonld_car: car || null, fields },
  };
}

// Parse all application/ld+json blocks; return the nested Car object and the
// listing price (from the enclosing Offer / UnitPriceSpecification). Both are
// searched across every block so markup nesting changes stay tolerated.
function parseJsonLd(html) {
  const blocks = [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )].map(m => m[1].trim());
  let car = null, price = null;
  for (const b of blocks) {
    let data;
    try { data = JSON.parse(b); } catch { continue; }
    if (!car) car = findCar(data);
    if (price == null) price = findPrice(data);
    if (car && price != null) break;
  }
  return { car, price };
}

// DFS for a listing price: an Offer / (Unit)PriceSpecification with `price`,
// or a nested `priceSpecification.price`. Deliberately ignores AutoDealer
// `priceRange` (a different field).
function findPrice(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const it of node) { const p = findPrice(it); if (p != null) return p; }
    return null;
  }
  const t = node['@type'];
  if (t === 'Offer' || t === 'UnitPriceSpecification' || t === 'PriceSpecification') {
    if (node.price != null) { const n = toNum(node.price); if (n != null) return n; }
    if (node.priceSpecification && node.priceSpecification.price != null) {
      const n = toNum(node.priceSpecification.price); if (n != null) return n;
    }
  }
  for (const k of Object.keys(node)) {
    const p = findPrice(node[k]);
    if (p != null) return p;
  }
  return null;
}

// Depth-first search for an object whose @type is Car/Vehicle (handles the
// AutoDealer → makesOffer → itemOffered nesting, arrays, and @graph).
function findCar(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const it of node) { const f = findCar(it); if (f) return f; }
    return null;
  }
  const t = node['@type'];
  if (t === 'Car' || t === 'Vehicle') return node;
  for (const k of Object.keys(node)) {
    const f = findCar(node[k]);
    if (f) return f;
  }
  return null;
}

// Parse the DealerCenter "dws-vehicle-fields" label/value spans into a map.
function extractFieldsTable(html) {
  const out = {};
  const re = /dws-vehicle-fields-label">([\s\S]*?)<\/span>\s*<span class="dws-vehicle-fields-value">([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = re.exec(html))) {
    const label = stripTags(m[1]).replace(/\s+/g, ' ').trim().replace(/\.$/, '');
    const value = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    if (label) out[label] = value;
  }
  return out;
}

// Distinct 1920×1080 gallery photos from the DealerCenter CDN (dedupe by id).
function extractPhotos(html) {
  const seen = new Set();
  const out = [];
  const re = /https:\/\/imagescf\.dealercenter\.net\/\d+\/\d+\/([0-9A-Za-z\-]+)\.jpg/g;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(`https://imagescf.dealercenter.net/1920/1080/${id}.jpg`);
  }
  return out;
}

// "2022 CHEVROLET EQUINOX" → { year:2022, make:'CHEVROLET', model:'EQUINOX' }
function splitName(name) {
  const s = (name || '').trim();
  if (!s) return { year: null, make: null, model: null };
  const parts = s.split(/\s+/);
  let year = null, i = 0;
  if (/^\d{4}$/.test(parts[0])) { year = parseInt(parts[0], 10); i = 1; }
  const make = parts[i] || null;
  const model = parts.slice(i + 1).join(' ') || null;
  return { year, make, model };
}

// /inventory/ford/f150-supercrew-cab/dd57022/ → { make:'ford', model:'f150 supercrew cab' }
function urlMakeModel(u) {
  try {
    const path = new URL(u).pathname.split('/').filter(Boolean); // [inventory, make, model, stock]
    const idx = path.indexOf('inventory');
    if (idx >= 0 && path.length >= idx + 3) {
      return { make: path[idx + 1], model: path[idx + 2].replace(/-/g, ' ') };
    }
  } catch { /* ignore */ }
  return { make: null, model: null };
}

// ── Supabase REST (service role) ─────────────────────────────────────────────
async function upsertStaging(env, listing) {
  const existing = await sb(env, `site_inventory_staging?source_url=eq.${encodeURIComponent(listing.source_url)}&select=id,precio_usd,millas,vin,titulo,status`, { method: 'GET' });
  const now = new Date().toISOString();

  if (!existing.length) {
    await sb(env, 'site_inventory_staging', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ ...listing, status: 'new', first_seen: now, last_seen: now }),
    });
    return 'new';
  }

  const row = existing[0];
  const changed =
    toNum(row.precio_usd) !== toNum(listing.precio_usd) ||
    toInt(row.millas) !== toInt(listing.millas) ||
    (row.vin || null) !== (listing.vin || null) ||
    (row.titulo || null) !== (listing.titulo || null);

  // Never overwrite a human decision (imported/ignored) back to updated/new.
  const humanLocked = row.status === 'imported' || row.status === 'ignored';
  const patch = { ...listing, last_seen: now };
  if (!humanLocked) patch.status = changed ? 'updated' : (row.status === 'removed_from_site' ? 'updated' : row.status);

  await sb(env, `site_inventory_staging?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  return changed ? 'updated' : 'unchanged';
}

// Flag staging rows whose source_url was NOT seen in this crawl.
async function markRemoved(env, seenUrls) {
  const rows = await sb(env, 'site_inventory_staging?select=id,source_url,status', { method: 'GET' });
  const seen = new Set(seenUrls);
  let removed = 0;
  for (const r of rows) {
    if (seen.has(r.source_url)) continue;
    if (r.status === 'imported' || r.status === 'ignored' || r.status === 'removed_from_site') continue;
    await sb(env, `site_inventory_staging?id=eq.${r.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'removed_from_site', last_seen: new Date().toISOString() }),
    });
    removed++;
  }
  return removed;
}

async function sb(env, pathAndQuery, init) {
  // trim(): secrets set via Windows pipes can carry \r\n, which breaks URLs
  // and Authorization headers.
  const base = (env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY vacia — configura el secreto del Worker o la variable de entorno.');
  const res = await fetch(`${base}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init && init.headers),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 300)}`);
  }
  if (init && init.method === 'GET') return res.json();
  return null;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
// One polite retry after a long pause: Cloudflare's bot scoring throws
// sporadic 403/429s mid-crawl that clear on their own (seen ~3/50 pages).
async function fetchText(url, ua) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua, Accept: 'text/html,application/xml' },
      redirect: 'follow',
    });
    if (res.ok) return res.text();
    const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
    if (attempt === 0 && retryable) {
      await sleep(8000 + Math.floor(Math.random() * 4000));
      continue;
    }
    throw new Error(`GET ${url} → HTTP ${res.status}`);
  }
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    x.search = '';
    return x.toString();
  } catch { return u; }
}

const stripTags = (s) => String(s).replace(/<[^>]*>/g, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
function toInt(v) { if (v == null || v === '') return null; const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; }
function toNum(v) { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; }
