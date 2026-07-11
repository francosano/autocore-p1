-- TARGET: autocore-p1/migrations/001_channel_columns.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 — Multi-channel CRM: channel columns on crm_conversations /
-- crm_mensajes so conversations exist on 'whatsapp' AND 'fb_marketplace'.
--
-- Run each statement one at a time in the Supabase SQL editor.
-- Expected result: every ALTER returns "Success. No rows returned".
-- Existing rows are untouched (canal defaults to 'whatsapp'); row counts
-- of both tables must be identical before and after.
--
-- New columns inherit the tables' existing RLS policies automatically —
-- no policy changes are needed in this file.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Channel discriminator on conversations. Backfills existing rows to
--    'whatsapp' via the DEFAULT.
ALTER TABLE public.crm_conversations
  ADD COLUMN canal text NOT NULL DEFAULT 'whatsapp'
  CHECK (canal IN ('whatsapp', 'fb_marketplace'));

-- 2) Facebook thread identity + display fields (all NULL for whatsapp rows).
ALTER TABLE public.crm_conversations ADD COLUMN fb_thread_id text;

ALTER TABLE public.crm_conversations
  ADD CONSTRAINT crm_conversations_fb_thread_id_key UNIQUE (fb_thread_id);

ALTER TABLE public.crm_conversations ADD COLUMN fb_listing_id text;

ALTER TABLE public.crm_conversations ADD COLUMN fb_listing_title text;

ALTER TABLE public.crm_conversations ADD COLUMN fb_buyer_name text;

-- 3) wa_phone is WhatsApp-only: make it nullable, but REQUIRED whenever the
--    conversation is on the whatsapp channel. FB conversations leave it NULL
--    (no synthetic keys).
ALTER TABLE public.crm_conversations ALTER COLUMN wa_phone DROP NOT NULL;

ALTER TABLE public.crm_conversations
  ADD CONSTRAINT crm_conversations_wa_phone_required
  CHECK (canal <> 'whatsapp' OR wa_phone IS NOT NULL);

-- 4) Channel + FB dedup key on messages. fb_message_id is the extension's
--    dedup key for scraped messages (UNIQUE, nullable for whatsapp rows).
ALTER TABLE public.crm_mensajes
  ADD COLUMN canal text NOT NULL DEFAULT 'whatsapp';

ALTER TABLE public.crm_mensajes ADD COLUMN fb_message_id text UNIQUE;

-- 5) crm_leads.fuente is free text — no schema change needed. The canonical
--    value for Marketplace-origin leads is 'fb_marketplace' (labeled/colored
--    in app/crm/fuentes.ts; the Chrome extension writes this value verbatim).

-- 6) PostgREST schema-cache reload (run last).
NOTIFY pgrst, 'reload schema';
