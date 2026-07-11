-- TARGET: autocore-npa/supabase/migrations/004_view_mezcla_inventario.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Inventario pipeline — "Mezcla de Inventario" capital dashboard view.
--
-- security_invoker = on is REQUIRED: without it the view executes with the
-- owner's privileges and would bypass RLS on inventory_pedidos, leaking costs
-- to any authenticated user. With it, the caller's own RLS applies.
-- ═══════════════════════════════════════════════════════════════════════════

create view public.mezcla_inventario
with (security_invoker = on) as
select modelo,
       count(*) filter (where estado_venta = 'DISPONIBLE') as disponibles,
       count(*) filter (where estado_venta = 'RESERVADO')  as reservados,
       count(*) filter (where estado_venta = 'PIPELINE')   as en_tubo,
       max(coalesce(costo_factura, costo_proforma))        as costo_ref,
       count(*) filter (where estado_venta = 'DISPONIBLE')
         * max(coalesce(costo_factura, costo_proforma))    as capital_disponible
from public.inventory_pedidos
where estado_venta <> 'VENDIDO'
group by modelo;

NOTIFY pgrst, 'reload schema';
