# p1-site-sync

Cloudflare Worker that crawls the Prime One public website's used-car
inventory and upserts each listing into Supabase `site_inventory_staging`.
Staff then review and promote rows in AutoCore P1 → Inventario → Importar.

> **STATUS 2026-07-13 — Worker fetches are blocked; use the local runner.**
> www.p1autosales.com's Cloudflare bot protection returns **403** to fetches
> coming from Workers IP space (residential connections are served fine, which
> is why the recon worked). The deployed Worker's `/sync` therefore fails at
> the sitemap fetch. Until the dealer allowlists the crawler, run the SAME
> sync locally from Franco's machine:
>
> ```
> powershell -ExecutionPolicy Bypass -File scripts\site-sync-local.ps1        # real run
> powershell -ExecutionPolicy Bypass -File scripts\site-sync-local.ps1 -Dry   # parse-only test
> ```
>
> (`scripts/site-sync-local.mjs` imports and runs the Worker's own `runSync`,
> so parser fixes apply to both paths.) **Clean long-term fix:** ask Prime One
> to allowlist the `AutoCoreP1-SiteSync` User-Agent — or to provide an
> inventory feed — in their Cloudflare/DealerCenter settings; they are a
> business partner, so this is a reasonable ask. Do NOT attempt to evade the
> bot protection.

**Nothing auto-imports.** The Worker only writes to the staging table.
Scraped data is untrusted input; promotion to `inventory_units` is a human
action in the review UI.

See `docs/p1-site-structure.md` (repo root) for the full recon: the site is
WordPress + DealerCenter, server-rendered, crawled from the sitemap (the
homepage is Cloudflare-challenged; the sitemap and detail pages are not).

## Prerequisites

- `migrations/004_site_inventory.sql` applied in the P1 Supabase project.
- Node + `npx wrangler` (Franco runs deploys; nothing is auto-deployed).

## Secrets — set these before first deploy

Run from `workers/p1-site-sync/`:

```
npx wrangler secret put SUPABASE_URL
#   → https://mrxpvutodyomldnjokau.supabase.co

npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
#   → the P1 project's service_role key (Supabase dashboard → Project
#     Settings → API → service_role). SERVER-ONLY. Never put this in the
#     web app, tenant.config.ts, or any browser-reachable place.

npx wrangler secret put SYNC_SECRET
#   → any long random string; required on the manual /sync trigger.
```

Non-secret config (site URLs, crawl delay, User-Agent, cron) lives in
`wrangler.toml` and can be edited there.

## Deploy

```
cd workers/p1-site-sync
npx wrangler deploy
```

The cron in `wrangler.toml` runs a full crawl daily at 07:30 UTC.

## Manual trigger

```
curl -X POST https://p1-site-sync.<your-subdomain>.workers.dev/sync \
  -H "x-sync-secret: <SYNC_SECRET>"
```

Response (also logged for the cron run):

```json
{ "ok": true, "total": 50, "created": 3, "updated": 1,
  "unchanged": 46, "failed": 0, "removed": 0 }
```

`GET /health` → `{ "ok": true, "service": "p1-site-sync" }` (no auth).

## What it does each run

1. Fetch `inventory_usedcars-sitemap.xml`, collect the `/inventory/...` detail URLs.
2. For each (sequential, ~1.5 s apart, honest User-Agent): fetch the detail
   page, parse the schema.org JSON-LD `Car` (VIN, price, year, make/model,
   color, transmission, fuel) and the `dws-vehicle-fields` HTML table
   (mileage), collect the gallery photos.
3. Upsert into `site_inventory_staging` keyed on `source_url`:
   new → `status='new'`; changed price/mileage/VIN/title → `'updated'`;
   otherwise just bump `last_seen`.
4. Rows whose `source_url` was not seen this crawl → `'removed_from_site'`
   (candidates to mark sold), **except** rows a human already set to
   `imported` or `ignored` — those decisions are never overwritten.

## Maintenance note

Parsing depends on DealerCenter markup: the JSON-LD `Car` shape and the
`dws-vehicle-fields-label/-value` spans. If the platform changes its HTML,
`created/updated` will drop and `failed` may rise — re-run the recon and
adjust `parseListing()` in `src/worker.js`. The JSON-LD path is the primary
source; the HTML table is only used for mileage.
