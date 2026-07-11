-- TARGET: autocore-npa/supabase/migrations/001_create_proformas.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Inventario pipeline — proformas (one supplier order, groups N units).
--
-- fecha_pedido:       first day of month when only the month is known.
-- fecha_pedido_texto: raw source text ('Mayo 2025') kept for traceability.
-- abonado:            down payment accumulated against this proforma (USD).
-- total_proforma:     order total (USD); seeded as the sum of unit costs.
-- ═══════════════════════════════════════════════════════════════════════════

create table public.proformas (
  id                 bigint generated always as identity primary key,
  nro                text not null unique,
  canal              text not null check (canal in ('COREA','ECUADOR','NA')),
  fecha_pedido       date,
  fecha_pedido_texto text,
  total_proforma     numeric,
  abonado            numeric default 0,
  notas              text,
  created_at         timestamptz default now()
);

NOTIFY pgrst, 'reload schema';
