# TARGET: autocore-p1/scripts/sync-setup-auto.ps1
# ONE-TIME setup: turns the inventory sync into an automatic daily job.
#
#   powershell -ExecutionPolicy Bypass -File scripts\sync-setup-auto.ps1
#
# It does two things:
#   1) Asks for the Supabase service-role key ONCE and saves it encrypted with
#      Windows DPAPI to %LOCALAPPDATA%\AutoCoreP1\sync-key.dat. Only THIS
#      Windows user on THIS machine can decrypt it. It never enters the repo.
#      (Automation needs the key without a human to type it — this is the safe
#      way to store it. Delete the file any time to revoke.)
#   2) Registers a Windows Scheduled Task that runs site-sync-auto.ps1 daily.
#
# Undo everything:
#   Unregister-ScheduledTask -TaskName 'AutoCoreP1 Inventory Sync' -Confirm:$false
#   Remove-Item "$env:LOCALAPPDATA\AutoCoreP1\sync-key.dat"
param(
    [string]$Time = '07:30',                       # daily run time, 24h local
    [string]$TaskName = 'AutoCoreP1 Inventory Sync'
)
$ErrorActionPreference = 'Stop'

$repo    = Split-Path -Parent $PSScriptRoot
$runner  = Join-Path $repo 'scripts\site-sync-auto.ps1'
$dataDir = Join-Path $env:LOCALAPPDATA 'AutoCoreP1'
$keyFile = Join-Path $dataDir 'sync-key.dat'

if (-not (Test-Path $runner)) { throw "No se encontro $runner" }
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }

# ── 1) Save the key (encrypted) ────────────────────────────────────────────
if (Test-Path $keyFile) {
    Write-Host "Ya hay una clave guardada en $keyFile" -ForegroundColor Yellow
    $again = Read-Host 'Quieres reemplazarla? (s/N)'
    if ($again -notmatch '^[sS]') { Write-Host 'Se mantiene la clave actual.' }
    else { Remove-Item $keyFile -Force }
}
if (-not (Test-Path $keyFile)) {
    Write-Host ''
    Write-Host 'Pega la SERVICE ROLE key de Supabase (no se vera al escribir).' -ForegroundColor Cyan
    Write-Host 'Supabase -> Project Settings -> API -> service_role  (secret)' -ForegroundColor DarkGray
    $sec = Read-Host 'service_role key' -AsSecureString
    if ($sec.Length -eq 0) { throw 'No se ingreso ninguna clave.' }
    # ConvertFrom-SecureString without -Key uses DPAPI (user + machine bound).
    ConvertFrom-SecureString -SecureString $sec | Set-Content -Path $keyFile -Encoding utf8
    Write-Host "Clave guardada cifrada en: $keyFile" -ForegroundColor Green
}

# ── 2) Register the scheduled task ─────────────────────────────────────────
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
# StartWhenAvailable: if the PC was off at the scheduled time, run at next boot.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
# Interactive principal: no Windows password needed, and DPAPI can decrypt
# the key because the task runs as you.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'Revisa el sitio de Prime One y actualiza el inventario de AutoCore P1 (altas, cambios de precio y bajas).' | Out-Null

Write-Host ''
Write-Host "Tarea programada '$TaskName' creada: todos los dias a las $Time." -ForegroundColor Green
Write-Host "Log: $(Join-Path $dataDir 'sync.log')" -ForegroundColor DarkGray
Write-Host ''
$now = Read-Host 'Quieres correr una sincronizacion AHORA para probar? (S/n)'
if ($now -notmatch '^[nN]') {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host 'Lanzada. Revisa el log en unos minutos:' -ForegroundColor Cyan
    Write-Host "  Get-Content `"$(Join-Path $dataDir 'sync.log')`" -Tail 20" -ForegroundColor DarkGray
}
