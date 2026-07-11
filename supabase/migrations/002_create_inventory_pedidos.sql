-- TARGET: autocore-npa/supabase/migrations/002_create_inventory_pedidos.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Inventario pipeline — inventory_pedidos (one row = one ordered unit).
--
-- Upstream of inventory_units (which is NOT modified — auditoría and P&L
-- depend on it). The two link softly via placa once a unit is nationalized.
--
-- placa: NULL while in pipeline. When set it must match the real VE format
-- ^[A-Z]{2}[0-9]{3}[A-Z]{2}$ — this is the fix-forward for the 0/O swaps and
-- status text typed into placa fields found in deals.
--
-- fecha_recepcion: date the unit was marked RECIBIDO — needed by the UI for
-- "días en inventario" on the Disponibles tab (addition over the base spec).
--
-- estado_pedido is free text on purpose (source sheet has CONFIRMADO /
-- NO_CONFIRMADO / blank); estado_unidad and estado_venta are constrained.
-- ═══════════════════════════════════════════════════════════════════════════

create table public.inventory_pedidos (
  id                     bigint generated always as identity primary key,
  proforma_id            bigint references public.proformas(id),
  canal                  text not null check (canal in ('COREA','ECUADOR','NA')),
  modelo                 text not null,
  color                  text,
  placa                  text unique
                         check (placa is null or placa ~ '^[A-Z]{2}[0-9]{3}[A-Z]{2}$'),
  costo_proforma         numeric,
  costo_factura          numeric,
  mes_estimado_recepcion text,
  fecha_recepcion        date,
  estado_pedido          text not null default 'CONFIRMADO',
  estado_unidad          text not null default 'POR_RECIBIR'
                         check (estado_unidad in ('POR_RECIBIR','EN_TRANSITO','RECIBIDO')),
  estado_venta           text not null default 'PIPELINE'
                         check (estado_venta in ('PIPELINE','DISPONIBLE','RESERVADO','VENDIDO')),
  vendedor               text,
  cliente_reserva        text,
  fecha_reserva          date,
  deal_id                bigint references public.deals(id),
  notas                  text,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);

NOTIFY pgrst, 'reload schema';
