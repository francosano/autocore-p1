# p1autosales.com — site structure recon (Phase 2.5)

Recon date: 2026-07-11. Done before writing any parser, per the brief.

## TL;DR — importer is viable via a Worker

The site is **server-rendered HTML** (WordPress + Yoast SEO on the
**DealerCenter** dealer-website platform, "DWS"). Every listing detail page
carries complete schema.org JSON-LD **plus** a redundant HTML fields table.
No JS rendering, no login, no API key needed. A Cloudflare Worker can fetch
the sitemap, walk the detail pages, and parse fields reliably. The Chrome-
extension fallback is **not** needed.

## ⚠️ Scope flag for Franco (please confirm)

The live site identifies as **"Prime One Auto Sales LLC", 8391 NW 64th St,
Miami, FL 33166**, phone 786-536-7833 — a **US** dealer whose stock is
**commercial trucks and vans** (Ford Transit, Freightliner M106, Hino 268/338,
RAM Promaster, Mercedes Sprinter) plus some SUVs. Prices are in **USD**,
mileage in **miles**, VINs are US 17-char.

This does not match the `tenant.config.ts` placeholders (Maracay / Aragua,
Venezuela). Nothing here depends on resolving it — the importer ingests
whatever the site publishes — but it affects assumptions elsewhere
(currency, `marca`/`modelo` values, VIN format). **I did not change
tenant.config.** Flagging so you can reconcile the two "Prime One" identities.

## Access behavior (matters for the Worker)

- `https://www.p1autosales.com/` (homepage) → **HTTP 403** Cloudflare
  "Just a moment..." bot challenge, even with an honest User-Agent.
- `robots.txt`, `sitemap_index.xml`, the per-type sitemaps, and the
  **listing detail pages** → **HTTP 200** with an honest User-Agent.

**Conclusion:** crawl from the **sitemap**, never scrape the homepage. This
is also the politest path. Detail-page URLs are `Allow`ed by robots.txt (the
long `Disallow` list only targets faceted-search query-string URLs like
`?make=`, `?sort_by=`, `?page_no=` — we never hit those).

## Sitemaps

`sitemap_index.xml` lists (with lastmod timestamps):

| Sitemap | Meaning | Notes |
|---|---|---|
| `inventory_usedcars-sitemap.xml` | live used-car inventory | **50 URLs**, lastmod today. This is the feed to sync. |
| `inventory_soldcars-sitemap.xml` | sold archive | present; used to detect `removed_from_site` if desired |
| `page-sitemap.xml`, `post-sitemap.xml` | CMS pages/blog | ignore |

`robots.txt` also names `inventory_newcars-sitemap.xml`, but it is absent
from the index (empty — this dealer carries used stock only).

### Detail-page URL pattern

```
https://www.p1autosales.com/inventory/{make}/{model-slug}/{stockid}/
e.g. /inventory/chevrolet/equinox/d254753/
     /inventory/ford/f150-supercrew-cab/dd57022/
```

The final path segment is the DealerCenter **stock id** (`d254753` →
"Stock No. D254753"). It is stable per listing, but we key the staging table
on the **full `source_url`** (the migration's UNIQUE column) — cleaner and
already unique.

## Per-listing fields available

Two redundant sources on every detail page; parse **JSON-LD first, fall back
to the HTML fields table**.

### 1. schema.org JSON-LD (inline `<script type="application/ld+json">`)

The Car object is **nested**, not top-level:
`AutoDealer` → `makesOffer` (Offer) → `itemOffered` (Car). Real example:

```json
{ "@type":"AutoDealer",
  "makesOffer":{ "@type":"Offer",
    "priceSpecification":{ "@type":"UnitPriceSpecification", "priceCurrency":"USD", "price":12500 },
    "itemOffered":{ "@type":"Car",
      "name":"2022 CHEVROLET EQUINOX",
      "bodyType":"SUV", "fuelType":"GASOLINE", "modelDate":2022, "numberOfDoors":"4",
      "vehicleEngine":"4-CYL, TURBO, 1.5 LITER",
      "vehicleIdentificationNumber":"3GNAXKEVXNL254753",
      "vehicleInteriorColor":"BLACK", "vehicleTransmission":"AUTOMATIC", "color":"SILVER",
      "image":"https://imagescf.dealercenter.net/640/480/202603-....jpg",
      "url":"https://www.p1autosales.com/inventory/chevrolet/equinox/d254753/" } } }
```

Gives: `name` (→ split into year / make / model), `price`, `priceCurrency`,
`vehicleIdentificationNumber` (**VIN**), `modelDate` (year), `bodyType`,
`fuelType`, `color`, `vehicleTransmission`, `vehicleEngine`, one `image`.
**Mileage is NOT in the JSON-LD.**

### 2. HTML fields table (`dws-vehicle-fields-label` / `-value` spans)

```
VIN            => 3GNAXKEVXNL254753
Mileage        => 48,000          <-- only source for mileage
Engine         => 4-CYL, TURBO, 1.5 LITER
Drivetrain     => FWD
Stock No.      => D254753
Transmission   => AUTOMATIC
Trim           => LT SPORT UTILITY 4D
Doors          => 4
Exterior Color => SILVER
Interior Color => BLACK
```

### 3. Photo gallery

DealerCenter image CDN `imagescf.dealercenter.net`. Each photo is emitted at
multiple resolutions (`/640/480/` and `/1920/1080/`) sharing one base id;
**15 distinct photos** on the sample listing. Store the 1920×1080 variant
URLs (dedupe by base id).

## Field → staging-column mapping (`site_inventory_staging`)

| staging column | source |
|---|---|
| `source_url` | sitemap `<loc>` / canonical detail URL (UNIQUE key) |
| `titulo` | JSON-LD `name` (e.g. "2022 CHEVROLET EQUINOX") |
| `marca` | make: from `name` token / URL `{make}` segment |
| `modelo` | model: from `name` / URL `{model-slug}` |
| `anio` | JSON-LD `modelDate` (int) |
| `precio_usd` | JSON-LD `makesOffer.priceSpecification.price` (numeric, USD) |
| `millas` | HTML "Mileage" value, commas stripped → int |
| `vin` | JSON-LD `vehicleIdentificationNumber` / HTML "VIN" |
| `fotos` | jsonb array of 1920×1080 `imagescf.dealercenter.net` URLs |
| `raw` | jsonb: full parsed JSON-LD Car + the fields table (audit/debug) |

## Change detection (Worker upsert logic)

- Row keyed on `source_url`. First sighting → `status='new'`.
- Re-seen with a changed `precio_usd` / `millas` / core field → `status='updated'`, bump `last_seen`.
- Re-seen unchanged → just bump `last_seen`.
- In staging but absent from the latest sitemap crawl → `status='removed_from_site'`
  (candidate to mark the corresponding P1 inventory unit sold).

## Politeness / safety

- Crawl sequentially from the sitemap with a small delay (≈1–2 s) between
  detail fetches; honest `User-Agent` identifying the app + a contact.
- Read-only against the website. All writes go to Supabase `site_inventory_staging`.
- Scraped data is **untrusted**: nothing auto-imports. Staging → human review
  (the `/inventario/importar` UI) → P1 inventory.
