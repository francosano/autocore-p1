# TARGET: autocore-p1/scripts/site-sync-auto.ps1
# Unattended inventory sync - run by Windows Task Scheduler, no prompts.
# Detects vehicles that entered or left the dealer's site and updates the
# AutoCore P1 database (site_inventory_staging):
#   new on the site       -> status 'new'
#   price/miles changed   -> status 'updated'
#   gone from the sitemap -> status 'removed_from_site'
# Rows you already imported or ignored are never touched by the bot.
#
# The service-role key is read from a DPAPI-encrypted file created by
# scripts/sync-setup-auto.ps1. DPAPI ties it to THIS Windows user on THIS
# machine - another account (or another PC) cannot decrypt it, and the key
# never lands in the repo.
#
# Run by hand any time:  powershell -ExecutionPolicy Bypass -File scripts\site-sync-auto.ps1
$ErrorActionPreference = 'Stop'

$repo    = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $env:LOCALAPPDATA 'AutoCoreP1'
$keyFile = Join-Path $dataDir 'sync-key.dat'
$logFile = Join-Path $dataDir 'sync.log'

if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }

function Write-Log([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $logFile -Value $line -Encoding utf8
    Write-Host $line
}

# Keep the log from growing forever (rotate at ~1 MB, keep one old copy).
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1MB)) {
    Move-Item $logFile "$logFile.old" -Force
}

if (-not (Test-Path $keyFile)) {
    Write-Log 'ERROR: no hay clave guardada. Corre primero: scripts\sync-setup-auto.ps1'
    exit 1
}

# Resolve node (Task Scheduler may start with a thinner PATH than your shell).
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $p) { $node = $p; break }
    }
}
if (-not $node) { Write-Log 'ERROR: no se encontro node.exe en el PATH.'; exit 1 }

$plain = $null
try {
    # Decrypt the key into memory only, for this process.
    $sec  = Get-Content $keyFile | ConvertTo-SecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try   { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

    $env:SUPABASE_SERVICE_ROLE_KEY = $plain

    Write-Log 'sync: iniciando...'
    Push-Location $repo
    # Native stderr must not abort the run; the exit code is the real signal.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $node 'scripts/site-sync-local.mjs' 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    Pop-Location

    foreach ($l in ($out -split "`r?`n")) { if ($l.Trim()) { Write-Log $l.Trim() } }

    # Exit codes from site-sync-local.mjs: 0 healthy, 2 some pages blocked but
    # writes landed (routine - Cloudflare 403s), anything else = broken.
    # Never collapse these into "OK": a job that writes nothing must look
    # different from one that had no changes.
    if ($code -eq 0) {
        Write-Log 'sync: OK'
        exit 0
    }
    if ($code -eq 2) {
        Write-Log 'sync: OK con avisos - algunas paginas bloqueadas por Cloudflare; la proxima corrida las toma.'
        exit 0
    }
    Write-Log "sync: FALLO (exit $code) - la base de datos NO se actualizo. Revisa los errores de arriba."
    exit $code
}
catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    exit 1
}
finally {
    # Never leave the key in the environment.
    $env:SUPABASE_SERVICE_ROLE_KEY = $null
    $plain = $null
    [GC]::Collect()
}
