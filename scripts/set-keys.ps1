# TARGET: autocore-p1/scripts/set-keys.ps1
# ============================================================================
# AutoCore P1 - interactive key setup + build + deploy.
# Run from the repo (any folder):
#   powershell -ExecutionPolicy Bypass -File scripts\set-keys.ps1
#
# The keys go ONLY to their proper destinations, never to the git history:
#   - publishable/anon key -> .env.local + autocore-p1-extension\.anon-key
#     (both gitignored; this key is PUBLIC - RLS is the security boundary)
#   - service role key     -> Cloudflare Worker secret via wrangler stdin
#     (server-only; never in the repo, the web app, or the extension)
#
# Get both keys from: Supabase dashboard -> project mrxpvutodyomldnjokau ->
# Project Settings -> API keys.
# ============================================================================

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

Write-Host ''
Write-Host '=== AutoCore P1 - configuracion de claves ===' -ForegroundColor Cyan
Write-Host ''

# ── 1) Publishable/anon key ─────────────────────────────────────────────────
$pub = Read-Host '1/2 Pega la PUBLISHABLE/ANON key (sb_publishable_... o eyJ...). Enter para saltar'
$pub = ($pub | ForEach-Object { $_.Trim() })
if ($pub) {
    $envPath = Join-Path $repo '.env.local'
    @(
        'NEXT_PUBLIC_SUPABASE_URL=https://mrxpvutodyomldnjokau.supabase.co'
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$pub"
    ) | Out-File -FilePath $envPath -Encoding ascii
    Write-Host '  OK  .env.local escrito' -ForegroundColor Green

    $pub | Out-File -FilePath (Join-Path $repo 'autocore-p1-extension\.anon-key') -Encoding ascii
    Write-Host '  OK  autocore-p1-extension\.anon-key escrito' -ForegroundColor Green
} else {
    Write-Host '  (saltado)' -ForegroundColor Yellow
}

# ── 2) Service role key -> Worker secret ────────────────────────────────────
$svc = Read-Host '2/2 Pega la SERVICE ROLE key (para el Worker p1-site-sync). Enter para saltar'
$svc = ($svc | ForEach-Object { $_.Trim() })
if ($svc) {
    Push-Location (Join-Path $repo 'workers\p1-site-sync')
    try {
        $svc | npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
        if ($LASTEXITCODE -ne 0) { throw 'wrangler secret put fallo' }
        Write-Host '  OK  secreto SUPABASE_SERVICE_ROLE_KEY configurado en el Worker' -ForegroundColor Green
    } finally {
        Pop-Location
        $svc = $null
    }
} else {
    Write-Host '  (saltado)' -ForegroundColor Yellow
}

if (-not $pub) {
    Write-Host ''
    Write-Host 'Sin publishable key no hay build/deploy. Vuelve a ejecutar el script cuando la tengas.' -ForegroundColor Yellow
    exit 0
}

# ── 3) Rebuild (la clave NEXT_PUBLIC_* se embebe en el build) ───────────────
Write-Host ''
Write-Host '=== Build de la app ===' -ForegroundColor Cyan
Push-Location $repo
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'next build fallo' }

    Write-Host ''
    Write-Host '=== Build de la extension ===' -ForegroundColor Cyan
    npm run build:ext
    if ($LASTEXITCODE -ne 0) { throw 'build de la extension fallo' }

    # ── 4) Deploy a Cloudflare Pages (direct upload de /out) ───────────────
    Write-Host ''
    Write-Host '=== Deploy a Cloudflare Pages ===' -ForegroundColor Cyan
    npx wrangler pages deploy out --project-name autocore-p1 --commit-dirty=true
    if ($LASTEXITCODE -ne 0) { throw 'wrangler pages deploy fallo' }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Listo.' -ForegroundColor Green
Write-Host '  App:       https://autocore-p1.pages.dev'
Write-Host '  Extension: autocore-p1-extension\dist  (chrome://extensions -> Load unpacked)'
Write-Host ''
Write-Host 'Pendiente manual: migraciones 001-005 en el editor SQL de Supabase.'
