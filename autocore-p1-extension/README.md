# AutoCore P1 — Facebook Marketplace extension (Chrome MV3)

Human-in-the-loop bridge between Facebook Marketplace and AutoCore P1's CRM.

- **Inbox reader** (read-only, automatic): scrapes Marketplace conversations
  and messages → `crm_conversations` / `crm_mensajes` (`canal='fb_marketplace'`).
- **Reply assist**: shows queued `fb_outbox` replies for the open thread. Default
  is fill-the-box, **the human clicks send**; an optional auto-send toggle
  (off by default) types with human-like delays under a rate limit + business
  hours.
- **Listing publisher**: on `marketplace/create/vehicle`, prefills title/price/
  description from the next `ready_to_publish` `fb_listings` row (photos are
  attached manually); the human reviews and clicks Publish, then "Marcar
  publicado" records the URL and flips status to `published`.

Franco accepts the Facebook ToS/ban risks; the design still minimizes them
(human-in-the-loop by default, kill switch, rate limits, business-hours gate,
selector-failure backoff).

## Data flow

```
FB Marketplace chat ─▶ inbox reader ─▶ Supabase (crm_conversations/crm_mensajes, canal=fb_marketplace)
                                          │
staff reply in AutoCore P1 CRM ─▶ fb_outbox ─▶ reply assist ─▶ human sends on Facebook
inventory_units ─▶ fb_listings (CRM) ─▶ publisher ─▶ live listing
```

## Prerequisites

- Migrations `001`–`003` applied in the P1 Supabase project (channel columns,
  `fb_listings`, `fb_outbox`).
- A P1 **staff Supabase account** (email/password) with `npa_can_view_crm`.
  The extension logs in as that user, so RLS is the same as the web app. The
  **service-role key is never used**.

## Configure + build

1. Edit `src/config.ts` → set `SUPABASE_ANON_KEY` to the P1 project's
   publishable/anon key (public; safe to embed). `SUPABASE_URL` is already the
   P1 project. If the project ref ever changes, also update the Supabase entry
   in `manifest.json` `host_permissions`.
2. Build:
   ```
   cd autocore-p1-extension
   npm install
   npm run build          # → dist/
   ```
   Or from the repo root: `npm run build:ext`.
3. Load: `chrome://extensions` → enable Developer mode → **Load unpacked** →
   select `autocore-p1-extension/dist`.
4. Click the toolbar icon → **Iniciar sesión** with the staff account.

## Using it

- Open Facebook Marketplace inbox / a conversation — the reader syncs
  automatically (read-only). Counters show in the popup.
- Reply in the AutoCore P1 CRM (CRM → Chats, FB conversation) → the reply is
  queued in `fb_outbox`. On the matching Facebook thread, the overlay lists it:
  **Insertar** fills the box (you click send in FB), then **Marcar enviado**.
- To publish: set a listing to "listo para publicar" in CRM → Marketplace,
  open `marketplace/create/vehicle`, click **Prellenar formulario**, attach
  photos, Publish, then **Marcar publicado**.

## Safety rails (in code)

- **Master switch** + **kill switch** in the popup (kill overrides everything).
- **Auto-send is OFF by default**; when on it enforces max-sends/hour and a
  business-hours window, and still types like a human.
- **Selector-failure backoff**: if a content script's selectors fail 3× in a
  row it pauses itself and the popup shows "Facebook cambió su interfaz —
  extensión pausada" instead of misfiring.

## Maintenance — selectors

Facebook's DOM changes often and its class names rotate, so **every selector
lives in `src/selectors.ts`** (ARIA roles / aria-labels / href patterns over
CSS classes). When sync/reply/publish stops finding elements, update that one
file and rebuild. The scrapers are intentionally conservative and treat FB as
untrusted, mutable markup.

## Layout

```
manifest.json          MV3 manifest (permissions: storage, alarms)
build.mjs              esbuild bundler → dist/
src/config.ts          Supabase URL + anon key + tunables
src/selectors.ts       ALL Facebook DOM selectors (the file you'll edit most)
src/types.ts           message protocol + shared types
src/lib/               supabase REST/auth, storage, dom+backoff, rate limit
src/background.ts       service worker: session, alarms, message router
src/content/inbox.ts    read-only conversation/message sync
src/content/reply.ts    reply-assist overlay
src/content/publisher.ts listing prefill overlay
src/popup/             popup UI (login, counters, settings, switches)
```
