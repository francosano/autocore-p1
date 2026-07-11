-- TARGET: autocore-p1/migrations/004_site_inventory.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2.5 — site_inventory_staging: landing table for the website importer.
-- The p1-site-sync Worker upserts rows here keyed on source_url; staff review
-- them in /inventario/importar and promote chosen rows into inventory_units.
-- NOTHING here auto-imports — scraped data is untrusted input.
--
-- Run each statement one at a time in the Supabase SQL editor.
-- Expected result: CREATE TABLE + 4 policies return "Success. No rows
-- returned"; table starts with 0 rows.
--
-- Requires has_perm(text) — same helper the existing inventory RLS uses.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.site_inventory_staging (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_url text NOT NULL UNIQUE,
  titulo text,
  marca text,
  modelo text,
  anio integer,
  precio_usd numeric,
  millas integer,
  vin text,
  fotos jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw jsonb,
  first_seen timestamp with time zone NOT NULL DEFAULT now(),
  last_seen timestamp with time zone NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'updated', 'imported', 'ignored', 'removed_from_site')),
  imported_inventory_ref text,     -- inventory_units.vin once promoted
  imported_at timestamp with time zone,
  imported_by uuid,
  CONSTRAINT site_inventory_staging_pkey PRIMARY KEY (id),
  CONSTRAINT site_inventory_staging_imported_by_fkey FOREIGN KEY (imported_by)
    REFERENCES auth.users(id)
);

-- The Worker writes via the service role key (bypasses RLS). These policies
-- govern the BROWSER (the review UI): inventory managers + admin.
-- Mirrors the inventory_pedidos policy pattern; no USING(true).
ALTER TABLE public.site_inventory_staging ENABLE ROW LEVEL SECURITY;

CREATE POLICY site_inventory_staging_select ON public.site_inventory_staging
  FOR SELECT TO authenticated
  USING (
    has_perm('can_view_inventory')
    OR has_perm('can_manage_inventory')
    OR has_perm('npa_can_admin')
  );

CREATE POLICY site_inventory_staging_insert ON public.site_inventory_staging
  FOR INSERT TO authenticated
  WITH CHECK (
    has_perm('can_manage_inventory')
    OR has_perm('npa_can_admin')
  );

CREATE POLICY site_inventory_staging_update ON public.site_inventory_staging
  FOR UPDATE TO authenticated
  USING (
    has_perm('can_manage_inventory')
    OR has_perm('npa_can_admin')
  )
  WITH CHECK (
    has_perm('can_manage_inventory')
    OR has_perm('npa_can_admin')
  );

CREATE POLICY site_inventory_staging_delete ON public.site_inventory_staging
  FOR DELETE TO authenticated
  USING (
    has_perm('npa_can_admin')
  );

NOTIFY pgrst, 'reload schema';
