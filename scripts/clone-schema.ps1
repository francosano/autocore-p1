# TARGET: autocore-p1/scripts/clone-schema.ps1
# ============================================================================
# One-time: clone the production (Motocentro) PUBLIC schema into the P1
# Supabase project, so has_perm(), all tables, RLS policies, triggers and RPC
# functions exist before the P1 migrations run.
#
#   - SCHEMA ONLY: no rows are copied. Motocentro customer data never moves;
#     P1 starts empty. pg_dump is READ-ONLY against the source.
#   - You paste both connection strings; passwords never pass through the
#     assistant. Get them from Supabase -> Connect -> "Session pooler"
#     (or the direct connection) for EACH project.
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\clone-schema.ps1
#
# After this succeeds, run migrations 001-005 (SQL editor), then create your
# staff user (see scripts\seed-admin.sql).
# ============================================================================
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$pgDump = Join-Path $here 'pgtools\pgsql\bin\pg_dump.exe'
$psql   = Join-Path $here 'pgtools\pgsql\bin\psql.exe'
$dumpFile = Join-Path $here 'prod-public-schema.sql'

foreach ($exe in @($pgDump, $psql)) {
    if (-not (Test-Path $exe)) { throw "No se encontro $exe. Falta pgtools." }
}

Write-Host ''
Write-Host '=== Clonar schema de produccion -> P1 (solo estructura, sin datos) ===' -ForegroundColor Cyan
Write-Host 'Consigue cada cadena en Supabase -> boton Connect -> "Session pooler".' -ForegroundColor Gray
Write-Host 'Formato: postgresql://postgres.<ref>:<password>@aws-0-...pooler.supabase.com:5432/postgres' -ForegroundColor Gray
Write-Host ''

function Read-Conn([string]$label) {
    while ($true) {
        $v = (Read-Host $label).Trim()
        # Strip a wrapping pair of quotes if pasted with them.
        if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        if ($v -match '^postgres(ql)?://') { return $v }
        Write-Host '  Eso no es una cadena de conexion. Debe empezar con postgresql://' -ForegroundColor Yellow
        Write-Host '  Supabase -> proyecto -> boton Connect (arriba) -> pestana "Session pooler" -> Copy.' -ForegroundColor Gray
        Write-Host '  Reemplaza [YOUR-PASSWORD] por la contrasena real de la base de datos.' -ForegroundColor Gray
    }
}

$src = Read-Conn 'FUENTE (Motocentro / produccion) connection string'
$dst = Read-Conn 'DESTINO (P1: mrxpvutodyomldnjokau) connection string'

if ($dst -notmatch 'mrxpvutodyomldnjokau') {
    Write-Host ''
    Write-Host 'ADVERTENCIA: el DESTINO no menciona mrxpvutodyomldnjokau (el proyecto P1).' -ForegroundColor Yellow
    $ok = Read-Host 'Escribe SI para continuar de todos modos'
    if ($ok -ne 'SI') { throw 'Cancelado por seguridad.' }
}

# Runs psql against $dst with -f $file, capturing ALL output to a log file.
# ErrorActionPreference is forced to Continue so PowerShell does not treat
# psql's stderr (benign NOTICE/ERROR lines) as a fatal, script-aborting error.
function Invoke-PsqlFile([string]$file, [string]$log) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $psql --set ON_ERROR_STOP=off -v ON_ERROR_STOP=0 -f $file $dst *>$log
    } finally {
        $ErrorActionPreference = $prev
    }
}

# ── 1) Dump: public schema, structure only. NO --clean (target is empty; DROP
#       statements would just spew "does not exist"). Portable across Supabase.
Write-Host ''
Write-Host '1/3  pg_dump (solo lectura en la fuente)...' -ForegroundColor Cyan
$prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& $pgDump `
    --schema-only `
    --schema=public `
    --no-owner `
    --no-privileges `
    --no-comments `
    --quote-all-identifiers `
    --file $dumpFile `
    $src 2>$null
$dumpExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($dumpExit -ne 0 -or -not (Test-Path $dumpFile)) { throw "pg_dump fallo (exit $dumpExit). Revisa la cadena FUENTE / password." }
$lines = (Get-Content $dumpFile | Measure-Object -Line).Lines
Write-Host "     OK  volcado $lines lineas" -ForegroundColor Green

# ── 2) Reset P1's public schema to a clean slate, then restore. This makes the
#       clone repeatable and wipes any half-finished previous attempt. Dropping
#       public only affects USER objects — Supabase's managed objects live in
#       other schemas (auth, storage, ...).
Write-Host ''
Write-Host '2/3  Limpiando public en P1 y restaurando...' -ForegroundColor Cyan
$resetSql  = Join-Path $here '_reset.sql'
$resetLog  = Join-Path $here '_reset.log'
$restoreLog = Join-Path $here '_restore.log'
$grantLog  = Join-Path $here '_grant.log'
@'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres;
'@ | Out-File -FilePath $resetSql -Encoding ascii
Invoke-PsqlFile $resetSql $resetLog
Invoke-PsqlFile $dumpFile $restoreLog

$errLines = @(Select-String -Path $restoreLog -Pattern 'ERROR:' -ErrorAction SilentlyContinue)
Write-Host "     restore terminado ($($errLines.Count) lineas con ERROR)" -ForegroundColor Green
if ($errLines.Count -gt 0) {
    Write-Host '--- ERRORES (revisar; "already exists" seria raro tras el reset) ---' -ForegroundColor Yellow
    $errLines | Select-Object -First 30 | ForEach-Object { $_.Line.Trim() }
}

# ── 3) Base grants Supabase relies on (the dump omits privileges).
Write-Host ''
Write-Host '3/3  Aplicando grants base + reload...' -ForegroundColor Cyan
$grantSql = Join-Path $here '_grant.sql'
@'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
'@ | Out-File -FilePath $grantSql -Encoding ascii
Invoke-PsqlFile $grantSql $grantLog

# Quick sanity check: does has_perm exist now, and how many tables landed?
$checkSql = Join-Path $here '_check.sql'
$checkLog = Join-Path $here '_check.log'
@"
SELECT 'tables=' || count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';
SELECT 'has_perm=' || count(*) FROM pg_proc WHERE proname='has_perm';
"@ | Out-File -FilePath $checkSql -Encoding ascii
Invoke-PsqlFile $checkSql $checkLog

Remove-Item $resetSql,$grantSql,$checkSql,$resetLog,$restoreLog,$grantLog -ErrorAction SilentlyContinue
Write-Host ''
Write-Host '=== Resultado ===' -ForegroundColor Green
Get-Content $checkLog | Where-Object { $_ -match 'tables=|has_perm=' } | ForEach-Object { Write-Host "  $($_.Trim())" }
Remove-Item $checkLog,$dumpFile -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Si ves tables=~30 y has_perm=1, el clon funciono.' -ForegroundColor Green
Write-Host 'Siguiente: corre migrations 001-005, luego scripts\seed-admin.sql.'
