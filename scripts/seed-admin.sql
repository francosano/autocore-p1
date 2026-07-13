-- TARGET: autocore-p1/scripts/seed-admin.sql
-- ============================================================================
-- Grant a P1 staff account full admin access. Run in the Supabase SQL editor
-- AFTER: (1) clone-schema.ps1, (2) migrations 001-005.
--
-- The user must already exist in Authentication -> Users. Edit the email
-- below, then run. Idempotent: safe to re-run (upserts on user_id).
-- ============================================================================

DO $$
DECLARE
  v_email text := 'franco@p1autosales.com';   -- <-- your staff email
  v_uid   uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No existe un usuario de Auth con email %. Crealo primero en Authentication -> Users.', v_email;
  END IF;

  -- Role row (admin) — user_roles.user_id is UNIQUE.
  INSERT INTO public.user_roles (user_id, role, email, full_name, is_active, npa_can_view_crm)
  VALUES (v_uid, 'admin', v_email, 'Franco Sano', true, true)
  ON CONFLICT (user_id) DO UPDATE
    SET role = 'admin', is_active = true, npa_can_view_crm = true, email = EXCLUDED.email;

  -- Permission flags — everything P1 uses.
  INSERT INTO public.user_permissions (
    user_id,
    npa_can_admin, npa_can_view_dashboard, npa_can_view_crm, npa_can_view_clientes,
    can_view_inventory, can_manage_inventory,
    can_view_crm, can_manage_crm, can_manage_settings, can_view_activity_log,
    can_view_whatsapp_log, can_send_whatsapp
  )
  VALUES (
    v_uid,
    true, true, true, true,
    true, true,
    true, true, true, true,
    true, true
  )
  ON CONFLICT (user_id) DO UPDATE SET
    npa_can_admin = true, npa_can_view_dashboard = true, npa_can_view_crm = true,
    npa_can_view_clientes = true, can_view_inventory = true, can_manage_inventory = true,
    can_view_crm = true, can_manage_crm = true, can_manage_settings = true,
    can_view_activity_log = true, can_view_whatsapp_log = true, can_send_whatsapp = true;

  RAISE NOTICE 'Admin configurado para % (uid %).', v_email, v_uid;
END $$;

NOTIFY pgrst, 'reload schema';
