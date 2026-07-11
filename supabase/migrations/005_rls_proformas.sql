-- TARGET: autocore-npa/supabase/migrations/005_rls_proformas.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Inventario pipeline — RLS for proformas.
--
-- Requires has_perm(text) (verified by 000_preflight_has_perm.sql).
-- Read: anyone who sees inventory today. Write: inventory managers + admin.
-- abonado is treasury-relevant, but column-level gating is enforced in the UI
-- (edit control requires the finance permission); at the DB layer any
-- can_manage_inventory user may write, same as the rest of the row.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.proformas enable row level security;

create policy proformas_select on public.proformas
  for select to authenticated
  using (
    has_perm('can_view_inventory')
    or has_perm('can_manage_inventory')
    or has_perm('npa_can_admin')
  );

create policy proformas_insert on public.proformas
  for insert to authenticated
  with check (
    has_perm('can_manage_inventory')
    or has_perm('npa_can_admin')
  );

create policy proformas_update on public.proformas
  for update to authenticated
  using (
    has_perm('can_manage_inventory')
    or has_perm('npa_can_admin')
  )
  with check (
    has_perm('can_manage_inventory')
    or has_perm('npa_can_admin')
  );

create policy proformas_delete on public.proformas
  for delete to authenticated
  using (
    has_perm('can_manage_inventory')
    or has_perm('npa_can_admin')
  );

NOTIFY pgrst, 'reload schema';
