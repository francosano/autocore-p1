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

# ── 1) Dump: public schema, structure only, portable across Supabase projects.
Write-Host ''
Write-Host '1/2  pg_dump (solo lectura en la fuente)...' -ForegroundColor Cyan
& $pgDump `
    --schema-only `
    --schema=public `
    --no-owner `
    --no-privileges `
    --no-comments `
    --if-exists --clean `
    --quote-all-identifiers `
    --file $dumpFile `
    $src
if ($LASTEXITCODE -ne 0) { throw "pg_dump fallo (exit $LASTEXITCODE)." }
$lines = (Get-Content $dumpFile | Measure-Object -Line).Lines
Write-Host "     OK  volcado $lines lineas -> $dumpFile" -ForegroundColor Green

# ── 2) Restore into P1. ON_ERROR_STOP off: benign 'already exists' /
#       extension-owned lines are expected; real errors are printed to review.
Write-Host ''
Write-Host '2/2  psql restore -> P1...' -ForegroundColor Cyan
& $psql --set ON_ERROR_STOP=off --single-transaction=off -f $dumpFile $dst 2>&1 |
    Tee-Object -Variable restoreLog | Out-Null
$errCount = ($restoreLog | Select-String -Pattern '^psql:.*ERROR' ).Count
Write-Host "     restore terminado ($errCount lineas de ERROR; revisa abajo si hay)" -ForegroundColor Green
if ($errCount -gt 0) {
    Write-Host '--- ERRORES (algunos "already exists" son normales) ---' -ForegroundColor Yellow
    $restoreLog | Select-String -Pattern '^psql:.*ERROR' | Select-Object -First 40 | ForEach-Object { $_.Line }
}

# Grants that Supabase relies on but a public-only dump can miss.
Write-Host ''
Write-Host 'Aplicando grants base a anon/authenticated/service_role...' -ForegroundColor Cyan
$grants = @'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
'@
$grants | & $psql --set ON_ERROR_STOP=off -f - $dst 2>&1 | Out-Null

Remove-Item $dumpFile -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Listo. Verifica en el SQL editor de P1:' -ForegroundColor Green
Write-Host "  select has_perm('npa_can_admin');   -- debe devolver true/false, no error"
Write-Host ''
Write-Host 'Siguiente: corre migrations 001-005, luego scripts\seed-admin.sql.'
