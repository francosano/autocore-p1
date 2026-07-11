-- TARGET: autocore-p1/migrations/002_fb_listings.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 — fb_listings: the Facebook Marketplace publishing queue.
-- CRM staff draft listings here (optionally from an inventory_units row);
-- the Chrome extension reads 'ready_to_publish' rows, prefills the FB form,
-- and after the human publishes it stores fb_listing_id / fb_url and flips
-- status to 'published'.
--
-- Run each statement one at a time in the Supabase SQL editor.
-- Expected result: CREATE TABLE + trigger + 4 policies all return
-- "Success. No rows returned"; table starts with 0 rows.
--
-- Requires has_perm(text) — same helper the existing CRM/inventory RLS uses.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.fb_listings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  inventory_vin text,                    -- nullable: listing may predate inventory
  titulo text NOT NULL,
  precio_usd numeric CHECK (precio_usd IS NULL OR precio_usd >= 0),
  descripcion text,
  fotos jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready_to_publish', 'published', 'paused', 'sold', 'removed')),
  fb_listing_id text,                    -- captured by the extension after publish
  fb_url text,
  published_at timestamp with time zone,
  last_synced_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT fb_listings_pkey PRIMARY KEY (id),
  CONSTRAINT fb_listings_inventory_vin_fkey FOREIGN KEY (inventory_vin)
    REFERENCES public.inventory_units(vin),
  CONSTRAINT fb_listings_created_by_fkey FOREIGN KEY (created_by)
    REFERENCES auth.users(id)
);

-- updated_at maintenance (same touch-function pattern as inventory_pedidos;
-- expected: "Success. No rows returned").
CREATE OR REPLACE FUNCTION public.fb_listings_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  new.updated_at := now();
  RETURN new;
END;
$$;

CREATE TRIGGER fb_listings_touch
  BEFORE UPDATE ON public.fb_listings
  FOR EACH ROW
  EXECUTE FUNCTION public.fb_listings_touch_updated_at();

-- ── RLS: CRM staff read/write; no USING(true) ──────────────────────────────
ALTER TABLE public.fb_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY fb_listings_select ON public.fb_listings
  FOR SELECT TO authenticated
  USING (
    has_perm('npa_can_view_crm')
    OR has_perm('npa_can_admin')
  );

CREATE POLICY fb_listings_insert ON public.fb_listings
  FOR INSERT TO authenticated
  WITH CHECK (
    has_perm('npa_can_view_crm')
    OR has_perm('npa_can_admin')
  );

CREATE POLICY fb_listings_update ON public.fb_listings
  FOR UPDATE TO authenticated
  USING (
    has_perm('npa_can_view_crm')
    OR has_perm('npa_can_admin')
  )
  WITH CHECK (
    has_perm('npa_can_view_crm')
    OR has_perm('npa_can_admin')
  );

CREATE POLICY fb_listings_delete ON public.fb_listings
  FOR DELETE TO authenticated
  USING (
    has_perm('npa_can_admin')
  );

NOTIFY pgrst, 'reload schema';
