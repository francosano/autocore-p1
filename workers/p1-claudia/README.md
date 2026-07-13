# Claudia — Prime One Auto Sales AI assistant

Claudia answers buyer questions and drafts replies for the Prime One inventory.
She runs as one Cloudflare Worker with **two independent surfaces**, each gated
by its own secrets so you can ship — and pay for — them separately:

| Surface | What it does | Needs |
|---|---|---|
| `POST /draft` (the **brain**) | Takes a conversation, returns Claudia's reply. Powers the in-CRM "Suggest reply" button. | Anthropic key only |
| `GET`/`POST /webhook` | WhatsApp Cloud API: verifies Meta, logs inbound to the CRM, auto-replies. | Meta Business + number on Cloud API |

The brain works with just an Anthropic key — no Meta setup. Build and test that
first; wire WhatsApp when the Meta side is ready.

Claudia only ever quotes vehicles from `site_inventory_staging` (the public
catalog the site importer fills). She never reads the cost ledger, never
invents specs, prices, warranty or financing, and escalates negotiation /
paperwork / deposits to Franco.

---

## Part 1 — Ship the brain (do this first, ~15 min)

1. **Get an Anthropic API key.** https://console.anthropic.com → API Keys.
   Add a small amount of credit. Each buyer reply costs a fraction of a cent.
2. **Deploy the Worker:**
   ```
   cd workers/p1-claudia
   npx wrangler deploy
   ```
3. **Set the secrets** (paste when prompted — never commit these):
   ```
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put CLAUDIA_SECRET          # invent any long random string
   npx wrangler secret put SUPABASE_URL            # https://mrxpvutodyomldnjokau.supabase.co
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   ```
   (Supabase secrets are optional but let Claudia quote real live stock.)
4. **Test it** — replace the URL/secret and run:
   ```
   curl -s -X POST https://p1-claudia.<your-subdomain>.workers.dev/draft ^
     -H "x-claudia-secret: <CLAUDIA_SECRET>" -H "content-type: application/json" ^
     -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Hola, tienen algo tipo SUV por 15 mil?\"}]}"
   ```
   You should get back `{"reply":"..."}` in the buyer's language.
5. `GET /` returns a health check: whether the brain and WhatsApp are configured.

### Optional: sharpen her answers
Set these as plain vars in `wrangler.toml` (or `wrangler secret put`) so Claudia
stops saying "let me confirm" for facts you can lock in now:
`CLAUDIA_HOURS`, `CLAUDIA_FINANCING`, `CLAUDIA_WARRANTY`, `CLAUDIA_TRADEIN`,
`CLAUDIA_ADDRESS`. Until set, she honestly defers those to the team.

---

## Part 2 — WhatsApp (Franco's Meta onboarding, then me)

Moving 305-333-3438 to the Cloud API **disconnects it from the WhatsApp app on
the phone** — that's expected and already agreed. Steps only Franco can do:

1. **Meta Business account** — https://business.facebook.com. Business
   verification can take a few days; start it early.
2. **Create an app** at https://developers.facebook.com → add the
   **WhatsApp** product.
3. **Register the number** 305-333-3438 in WhatsApp → API Setup. Meta sends a
   code; entering it moves the number onto the Cloud API (this is the
   disconnect step).
4. **Collect four values** and hand them to me for `wrangler secret put`:
   - `WHATSAPP_PHONE_NUMBER_ID` (API Setup page)
   - `WHATSAPP_TOKEN` — a **permanent** access token (System User token), not
     the 24-hour temporary one
   - `WHATSAPP_APP_SECRET` — App → Settings → Basic
   - `WHATSAPP_VERIFY_TOKEN` — you invent this string; type the same value in
     Meta's webhook UI and into the secret
5. **Point the webhook** in Meta → WhatsApp → Configuration to
   `https://p1-claudia.<subdomain>.workers.dev/webhook`, subscribe to
   **messages**. Meta calls `GET /webhook`; the Worker answers the handshake.

Once those secrets are set, inbound texts land in **CRM → Chats** (canal
`whatsapp`) and Claudia auto-replies **only** on conversations whose `bot_mode`
is `full`. Set a conversation to `assist` (draft only) or `off` (human only)
from the CRM to take over.

### Cost & model
Default model is `claude-opus-4-8` (highest quality). To trade some quality for
lower per-message cost, set the `CLAUDIA_MODEL` var to `claude-sonnet-5` or
`claude-haiku-4-5` — no code change.

---

## Guardrails baked in
- Quotes only in-stock catalog vehicles; verifies with the team otherwise.
- Never invents warranty / financing / rates; never asks for card, bank, SSN.
- Never negotiates price or closes — escalates to Franco.
- Inbound is idempotent (`wa_message_id` UNIQUE), so Meta retries don't double-post.
- Meta signature (HMAC-SHA256) is verified on every inbound before anything runs.
