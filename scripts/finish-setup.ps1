# TARGET: autocore-p1/scripts/finish-setup.ps1
# ============================================================================
# Final DB setup for P1, AFTER clone-schema.ps1 succeeded. Runs, in order:
#   migrations 001-005  (FB channel, fb_listings, fb_outbox, site staging,
#                        comisiones)  then  seed-admin.sql (grants your staff
#                        account full admin).
# You paste ONLY the P1 (DESTINO) connection string. Idempotent-ish: the
# migrations assume a fresh clone; re-running may report "already exists".
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\finish-setup.ps1
# ============================================================================
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = Split-Path -Parent $here
$psql = Join-Path $here 'pgtools\pgsql\bin\psql.exe'
if (-not (Test-Path $psql)) { throw "No se encontro $psql. Corre primero clone-schema (necesita pgtools)." }

function Read-Conn([string]$label) {
    while ($true) {
        $v = (Read-Host $label).Trim()
        if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        if ($v -match '^postgres(ql)?://') { return $v }
        Write-Host '  Debe empezar con postgresql:// (Session pooler de P1).' -ForegroundColor Yellow
    }
}

# Run one .sql file; stream output to a temp log; return the ERROR lines.
function Run-Sql([string]$conn, [string]$file, [string]$tag) {
    $log = Join-Path $here "_$tag.log"
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $psql --set ON_ERROR_STOP=off -v ON_ERROR_STOP=0 -f $file $conn *>$log }
    finally { $ErrorActionPreference = $prev }
    $errs = @(Select-String -Path $log -Pattern 'ERROR:' -ErrorAction SilentlyContinue)
    Remove-Item $log -ErrorAction SilentlyContinue
    return $errs
}

Write-Host ''
Write-Host '=== P1: migraciones 001-005 + admin ===' -ForegroundColor Cyan
$dst = Read-Conn 'DESTINO (P1: mrxpvutodyomldnjokau) connection string'
if ($dst -notmatch 'mrxpvutodyomldnjokau') {
    $ok = Read-Host 'El destino no menciona mrxpvutodyomldnjokau. Escribe SI para continuar'
    if ($ok -ne 'SI') { throw 'Cancelado.' }
}

$steps = @(
    @{ tag='001'; file=(Join-Path $repo 'migrations\001_channel_columns.sql'); name='canal + columnas FB' },
    @{ tag='002'; file=(Join-Path $repo 'migrations\002_fb_listings.sql');     name='fb_listings' },
    @{ tag='003'; file=(Join-Path $repo 'migrations\003_fb_outbox.sql');       name='fb_outbox' },
    @{ tag='004'; file=(Join-Path $repo 'migrations\004_site_inventory.sql');  name='site_inventory_staging' },
    @{ tag='005'; file=(Join-Path $repo 'migrations\005_comisiones.sql');      name='comisiones' },
    @{ tag='seed'; file=(Join-Path $repo 'scripts\seed-admin.sql');            name='admin (franco@p1autosales.com)' }
)

$totalErr = 0
foreach ($s in $steps) {
    if (-not (Test-Path $s.file)) { Write-Host "  SALTADO (no existe): $($s.file)" -ForegroundColor Yellow; continue }
    Write-Host ("  -> {0}  {1}" -f $s.tag, $s.name) -ForegroundColor Cyan
    $errs = Run-Sql $dst $s.file $s.tag
    if ($errs.Count -gt 0) {
        $totalErr += $errs.Count
        Write-Host "     $($errs.Count) ERROR:" -ForegroundColor Yellow
        $errs | Select-Object -First 8 | ForEach-Object { Write-Host "       $($_.Line.Trim())" -ForegroundColor Yellow }
    } else {
        Write-Host '     OK' -ForegroundColor Green
    }
}

# Verify the key P1 objects + the admin rows landed.
$checkSql = Join-Path $here '_check2.sql'
$checkLog = Join-Path $here '_check2.log'
@"
SELECT 'comisiones=' || count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='comisiones';
SELECT 'fb_listings=' || count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='fb_listings';
SELECT 'canal_col=' || count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_conversations' AND column_name='canal';
SELECT 'admin_role=' || count(*) FROM public.user_roles r JOIN auth.users u ON u.id=r.user_id WHERE u.email='franco@p1autosales.com' AND r.role='admin';
SELECT 'admin_perms=' || count(*) FROM public.user_permissions p JOIN auth.users u ON u.id=p.user_id WHERE u.email='franco@p1autosales.com' AND p.npa_can_admin;
"@ | Out-File -FilePath $checkSql -Encoding ascii
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& $psql --set ON_ERROR_STOP=off -f $checkSql $dst *>$checkLog
$ErrorActionPreference = $prev

Write-Host ''
Write-Host '=== Verificacion ===' -ForegroundColor Green
Get-Content $checkLog | Where-Object { $_ -match '=' -and $_ -notmatch 'row|---|SELECT' } | ForEach-Object { Write-Host "  $($_.Trim())" }
Remove-Item $checkSql,$checkLog -ErrorAction SilentlyContinue

Write-Host ''
if ($totalErr -eq 0) {
    Write-Host 'Todo aplicado sin errores.' -ForegroundColor Green
} else {
    Write-Host "Terminado con $totalErr lineas de ERROR (revisa arriba; muchas pueden ser inofensivas)." -ForegroundColor Yellow
}
Write-Host 'Espera ~30s (cache de PostgREST) y recarga https://autocore-p1.pages.dev'
Write-Host 'Deberias entrar como admin con franco@p1autosales.com.'
