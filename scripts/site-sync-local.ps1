# TARGET: autocore-p1/scripts/site-sync-local.ps1
# Runs the inventory sync locally (the dealer site 403s Cloudflare Workers,
# so the crawl runs from this machine). Prompts for the service-role key and
# passes it via the environment only for this process - never stored on disk.
#   powershell -ExecutionPolicy Bypass -File scripts\site-sync-local.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\site-sync-local.ps1 -Dry
param([switch]$Dry)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

if (-not $Dry) {
    $svc = Read-Host 'Pega la SERVICE ROLE key de Supabase (solo se usa en memoria)'
    $svc = ($svc | ForEach-Object { $_.Trim() })
    if (-not $svc) { Write-Host 'Sin key no se puede escribir. Usa -Dry para probar.' -ForegroundColor Yellow; exit 1 }
    $env:SUPABASE_SERVICE_ROLE_KEY = $svc
}

try {
    Push-Location $repo
    if ($Dry) { node scripts/site-sync-local.mjs --dry } else { node scripts/site-sync-local.mjs }
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 2) { throw "sync fallo (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
    $env:SUPABASE_SERVICE_ROLE_KEY = $null
    $svc = $null
}
