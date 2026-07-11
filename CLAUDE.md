# AutoCore P1 — Claude Code rules

CRM-ONLY fork of AutoCore NPA for Prime One Auto Sales (multi-brand used
cars, Maracay). Next.js STATIC EXPORT for Cloudflare Pages. Backend:
Supabase project mrxpvutodyomldnjokau — NEVER the Motocentro project
(xwyiatmeyonodgncobps); nothing here may touch the Motocentro repo,
database, or Workers. Anon key in the browser — RLS is the ENTIRE
security boundary. UI text and data are Spanish; talk to me (Franco) in
English. No emojis in product UI.

Scope: CRM (leads, multi-channel chats), inventario, clientes, settings
(user/role admin), sesiones. ALL financial modules were deleted in Phase
1a — do not reintroduce them.

Tenant config lives in app/tenant.config.ts. Worker URLs come ONLY from
TENANT.workers.*; an empty URL means the feature is disabled and the UI
must degrade gracefully (hide the action / "función no disponible") —
never call a Motocentro Worker.

## Commands
- Build/type-check: `npm run build` — MUST be green before any commit.
  esbuild passing alone is NOT sufficient.

## Hard rules
- NEVER `git add .` — stage specific files only. Never glob patterns.
- NEVER write TS/UTF-8 source with PowerShell Set-Content/WriteAllText.
- Static export constraints: no dynamic routes — use query-string routing;
  navigate with `window.location.href`, not router.push; wrap useSearchParams
  in <Suspense>.
- Supabase JS TypeScript bug on Unicode columns (e.g. inventory_units.año):
  wrap the query as `(supabase...) as any` + Array.isArray() guard.
- Never invent Supabase column names — schema is in docs/schema.sql; check it
  before writing any query.
- SQL migrations: WRITE files under /migrations/ (numbered .sql, one logical
  change each, comment with expected result); NEVER execute them — Franco
  runs them manually in the Supabase SQL editor.
- Keep `// TARGET: autocore-p1/<path>` as line 1 of each source file. CRLF.
- Read the actual current file before editing; never reconstruct from memory.
- Schema-touching changes: show Franco the plan before editing.
- Permission gates use useNPAPermissions / useAuthGate — never remove or
  weaken an existing gate.
- Only Tailwind core utility classes; brand colors via CSS variables in
  globals.css (--brand-primary blue / --brand-accent silver).

## Deploy flow
build green → git add <specific files> → commit. Do NOT push without
Franco's explicit go-ahead.
