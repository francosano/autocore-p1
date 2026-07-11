-- TARGET: autocore-npa/supabase/migrations/008_sync_vendidos_from_deals.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Inventario pipeline — MAINTENANCE statement, not a schema migration.
--
-- Marks pedidos VENDIDO (and sets deal_id) when a deal exists with a matching
-- vehiculo_placa. Deliberately a manual statement, NOT a trigger on deals —
-- triggers on deals are risky given the auditoría flows.
--
-- Expected behavior:
--   • IDEMPOTENT — safe to run and re-run at any time; already-synced rows
--     are skipped by the WHERE clause, so re-runs touch nothing new.
--   • Draft deals (status = 'borrador') are EXCLUDED so an unapproved
--     borrador never marks a unit as sold.
--   • If several non-draft deals share a placa, the most recent one
--     (highest id) wins.
--   • Only estado_venta and deal_id are written; estado_unidad and the
--     reservation fields are left untouched.
-- ═══════════════════════════════════════════════════════════════════════════

update public.inventory_pedidos p
set estado_venta = 'VENDIDO',
    deal_id      = d.id
from (
  select distinct on (vehiculo_placa) id, vehiculo_placa
  from public.deals
  where vehiculo_placa is not null
    and vehiculo_placa <> ''
    and status is distinct from 'borrador'
  order by vehiculo_placa, id desc
) d
where p.placa = d.vehiculo_placa
  and (p.estado_venta <> 'VENDIDO' or p.deal_id is distinct from d.id);
