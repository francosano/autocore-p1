-- TARGET: autocore-p1/migrations/005_comisiones.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Broker commission ledger. Franco operates as an independent third-party
-- sales broker for Prime One Auto Sales (Miami FL) and earns a commission per
-- closed sale. One row per sale: what sold, for how much, the commission
-- owed, and its collection status (pendiente → facturada → pagada; anulada
-- for reversals). This is NEW, minimal broker accounting — it does NOT
-- resurrect the deleted NPA dealership financial modules.
--
-- Run each statement one at a time in the Supabase SQL editor.
-- Expected result: CREATE TABLE + trigger + 4 policies return "Success.
-- No rows returned"; table starts with 0 rows.
--
-- Requires has_perm(text) — same helper as the rest of the P1 RLS.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.comisiones (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid,                          -- won CRM lead, when the sale came from the pipeline
  inventory_vin text,                    -- unit sold, when it exists in P1 inventory
  vehiculo text NOT NULL,                -- free text: "2022 CHEVROLET EQUINOX"
  cliente text,                          -- buyer name (free text)
  precio_venta_usd numeric CHECK (precio_venta_usd IS NULL OR precio_venta_usd >= 0),
  comision_pct numeric CHECK (comision_pct IS NULL OR (comision_pct >= 0 AND comision_pct <= 100)),
  comision_usd numeric NOT NULL CHECK (comision_usd >= 0),
  estado text NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'facturada', 'pagada', 'anulada')),
  fecha_venta date NOT NULL DEFAULT CURRENT_DATE,
  fecha_pago date,
  notas text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT comisiones_pkey PRIMARY KEY (id),
  CONSTRAINT comisiones_lead_id_fkey FOREIGN KEY (lead_id)
    REFERENCES public.crm_leads(id),
  CONSTRAINT comisiones_inventory_vin_fkey FOREIGN KEY (inventory_vin)
    REFERENCES public.inventory_units(vin),
  CONSTRAINT comisiones_created_by_fkey FOREIGN KEY (created_by)
    REFERENCES auth.users(id)
);

-- updated_at maintenance (same touch-function pattern as fb_listings;
-- expected: "Success. No rows returned").
CREATE OR REPLACE FUNCTION public.comisiones_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  new.updated_at := now();
  RETURN new;
END;
$$;

CREATE TRIGGER comisiones_touch
  BEFORE UPDATE ON public.comisiones
  FOR EACH ROW
  EXECUTE FUNCTION public.comisiones_touch_updated_at();

-- ── RLS: compensation data — gerencia (npa_can_admin) only, all operations.
-- Widen later (e.g. per-seller rows) only if a real sales team needs it.
ALTER TABLE public.comisiones ENABLE ROW LEVEL SECURITY;

CREATE POLICY comisiones_select ON public.comisiones
  FOR SELECT TO authenticated
  USING (has_perm('npa_can_admin'));

CREATE POLICY comisiones_insert ON public.comisiones
  FOR INSERT TO authenticated
  WITH CHECK (has_perm('npa_can_admin'));

CREATE POLICY comisiones_update ON public.comisiones
  FOR UPDATE TO authenticated
  USING (has_perm('npa_can_admin'))
  WITH CHECK (has_perm('npa_can_admin'));

CREATE POLICY comisiones_delete ON public.comisiones
  FOR DELETE TO authenticated
  USING (has_perm('npa_can_admin'));

NOTIFY pgrst, 'reload schema';
