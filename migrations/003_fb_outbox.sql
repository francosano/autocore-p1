-- TARGET: autocore-p1/migrations/003_fb_outbox.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 — fb_outbox: outbound reply queue for Facebook Marketplace chats.
-- The CRM composer INSERTs here (status 'queued'); the Chrome extension
-- polls for queued rows, assists the human in sending on facebook.com, then
-- marks the row 'sent' (or 'failed' + error). Staff can cancel a queued row.
--
-- Run each statement one at a time in the Supabase SQL editor.
-- Expected result: CREATE TABLE + index + 4 policies all return
-- "Success. No rows returned"; table starts with 0 rows.
--
-- Requires has_perm(text) — same helper the existing CRM/inventory RLS uses.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.fb_outbox (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed', 'cancelled')),
  queued_by uuid,
  queued_at timestamp with time zone NOT NULL DEFAULT now(),
  sent_at timestamp with time zone,
  error text,
  CONSTRAINT fb_outbox_pkey PRIMARY KEY (id),
  CONSTRAINT fb_outbox_conversation_id_fkey FOREIGN KEY (conversation_id)
    REFERENCES public.crm_conversations(id),
  CONSTRAINT fb_outbox_queued_by_fkey FOREIGN KEY (queued_by)
    REFERENCES auth.users(id)
);

-- The extension polls "queued per conversation" every ~60s — index the hot path.
CREATE INDEX fb_outbox_conversation_status_idx
  ON public.fb_outbox (conversation_id, status);

-- ── RLS: CRM staff read/write; no USING(true) ──────────────────────────────
ALTER TABLE public.fb_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY fb_outbox_select ON public.fb_outbox
  FOR SELECT TO authenticated
  USING (
    has_perm('npa_can_view_crm')
    OR has_perm('npa_can_admin')
  );

CREATE POLICY fb_outbox_insert ON public.fb_outbox
  FOR INSERT TO authenticated
  WITH CHECK (
    has_perm('npa_can_view_crm')
    OR has_perm('npa_can_admin')
  );

CREATE POLICY fb_outbox_update ON public.fb_outbox
  FOR UPDATE TO authenticated
  USING (
    has_perm('npa_can_view_crm')
    OR has_perm('npa_can_admin')
  )
  WITH CHECK (
    has_perm('npa_can_view_crm')
    OR has_perm('npa_can_admin')
  );

CREATE POLICY fb_outbox_delete ON public.fb_outbox
  FOR DELETE TO authenticated
  USING (
    has_perm('npa_can_admin')
  );

NOTIFY pgrst, 'reload schema';
