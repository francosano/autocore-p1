-- TARGET: autocore-npa/supabase/migrations/003_indexes_inventory_pedidos.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Inventario pipeline — indexes for the common access paths.
-- (placa already has a unique index from its UNIQUE constraint.)
-- ═══════════════════════════════════════════════════════════════════════════

create index inventory_pedidos_proforma_id_idx on public.inventory_pedidos (proforma_id);

create index inventory_pedidos_estado_venta_idx on public.inventory_pedidos (estado_venta);

create index inventory_pedidos_deal_id_idx on public.inventory_pedidos (deal_id);
