-- TARGET: autocore-npa/supabase/migrations/006_rls_inventory_pedidos.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Inventario pipeline — RLS for inventory_pedidos.
--
-- Requires has_perm(text) (verified by 000_preflight_has_perm.sql).
-- Read: anyone who sees inventory today. Write: inventory managers + admin.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.inventory_pedidos enable row level security;

create policy inventory_pedidos_select on public.inventory_pedidos
  for select to authenticated
  using (
    has_perm('can_view_inventory')
    or has_perm('can_manage_inventory')
    or has_perm('npa_can_admin')
  );

create policy inventory_pedidos_insert on public.inventory_pedidos
  for insert to authenticated
  with check (
    has_perm('can_manage_inventory')
    or has_perm('npa_can_admin')
  );

create policy inventory_pedidos_update on public.inventory_pedidos
  for update to authenticated
  using (
    has_perm('can_manage_inventory')
    or has_perm('npa_can_admin')
  )
  with check (
    has_perm('can_manage_inventory')
    or has_perm('npa_can_admin')
  );

create policy inventory_pedidos_delete on public.inventory_pedidos
  for delete to authenticated
  using (
    has_perm('can_manage_inventory')
    or has_perm('npa_can_admin')
  );

NOTIFY pgrst, 'reload schema';
