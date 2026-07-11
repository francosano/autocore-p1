-- TARGET: autocore-npa/supabase/migrations/000_preflight_has_perm.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- PREFLIGHT (read-only, run FIRST) — Inventario pipeline migration batch.
--
-- Confirms the has_perm(text) helper used by existing RLS policies exists
-- before any other file in this batch is run. Expected result: one row with
-- three boolean columns (values depend on your user).
--
-- If this ERRORS with "function has_perm(text) does not exist":
--   STOP. Do not run 005/006 (the RLS files). Report back so the policies
--   can be rewritten against the real permission-check pattern.
-- ═══════════════════════════════════════════════════════════════════════════

select
  has_perm('can_view_inventory')   as can_view_inventory,
  has_perm('can_manage_inventory') as can_manage_inventory,
  has_perm('npa_can_admin')        as npa_can_admin;
