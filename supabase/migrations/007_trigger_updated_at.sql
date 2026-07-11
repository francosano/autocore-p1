-- TARGET: autocore-npa/supabase/migrations/007_trigger_updated_at.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Inventario pipeline — auto-touch updated_at on every UPDATE.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.inventory_pedidos_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger inventory_pedidos_touch
  before update on public.inventory_pedidos
  for each row
  execute function public.inventory_pedidos_touch_updated_at();
