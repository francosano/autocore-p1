# AutoCore NPA — Claude Code rules

Next.js STATIC EXPORT deployed to Cloudflare Pages (auto-deploy from master,
~2 min). Backend: Supabase (project xwyiatmeyonodgncobps), anon key in the
browser — RLS is the ENTIRE security boundary. UI text and data are Spanish;
talk to me (Franco) in English. No emojis in product UI.

## Commands
- Build/type-check: `npm run build` — MUST be green before any commit.
  esbuild passing alone is NOT sufficient.

## Hard rules
- NEVER `git add .` — stage specific files only (stray .bak files exist in
  app/reportes/). Never glob patterns.
- NEVER write TS/UTF-8 source with PowerShell Set-Content/WriteAllText.
- Static export constraints: no dynamic routes — use query-string routing;
  navigate with `window.location.href`, not router.push; wrap useSearchParams
  in <Suspense>.
- Supabase JS TypeScript bug on Unicode columns (e.g. inventory_units.año):
  wrap the query as `(supabase...) as any` + Array.isArray() guard.
- Never invent Supabase column names — schema is in docs/schema.sql; check it
  before writing any query.
- Keep `// TARGET: autocore-npa/<path>` as line 1 of each source file. CRLF.
- Read the actual current file before editing; never reconstruct from memory.
- Money-touching or schema-touching changes: show Franco the plan before editing.
- Permission gates use useNPAPermissions / useAuthGate — never remove or
  weaken an existing gate.
- comunicaciones_log.enviado_por is UUID — isUUID()-guard before insert.

## Data conventions
- BCV rate is artificial; Binance/parallel rate is used for real financial math.
- CRM analytics exclude the Apr-8/9 mass import by default
  (origen_carga='organico' filter, with a toggle to include).
- campana / meta_ad_id are only populated on Meta Click-to-WhatsApp leads.

## Deploy flow
build green → git add <specific files> → commit → push → Cloudflare Pages
auto-deploys from master (~2 min) → confirm on autocore-npa.pages.dev.
Do NOT push without Franco's explicit go-ahead.
