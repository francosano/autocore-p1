# autocore-admin-users worker

Cloudflare Worker for admin user management (invite / activate / role /
permissions). `user_roles` and `user_permissions` have no browser-facing RLS,
so all admin reads and writes go through this worker with the service-role key.

## Endpoints

All endpoints (except `GET /` health check) require
`Authorization: Bearer <supabase user access_token>` from a caller with
`npa_can_admin=true` and `is_active=true`. Self-edit is rejected on all
mutations.

| Endpoint | Body | Effect |
|---|---|---|
| `GET /users` | — | user_roles ⋈ user_permissions list |
| `POST /invite` | `{ email, full_name, role, telefono_wa }` | auth invite + user_roles + user_permissions (from role_templates); full cleanup on any failure |
| `POST /set-active` | `{ user_id, is_active }` | toggle user_roles.is_active |
| `POST /set-role` | `{ user_id, role }` | update role + RESET permissions to the role template (old flags recorded in activity_log; role rolled back if the template write fails) |
| `POST /set-permissions` | `{ user_id, permissions: { flag: bool } }` | patch only the provided whitelisted flags |

Every successful mutation writes an `activity_log` row
(`action='admin_users.*'`, `target_type='user'`).

## Deploy

```
cd workers/autocore-admin-users
wrangler secret put SUPABASE_URL                # https://mrxpvutodyomldnjokau.supabase.co (P1 project)
wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # service role key
wrangler deploy
```

Deploy under a p1-* Worker name for this fork (edit wrangler.toml `name`
before deploying); then set the deployed URL in
`app/tenant.config.ts` → `TENANT.workers.adminUsers`.

Update the CORS allowlist in `src/worker.js` to the P1 Pages domain before
deploying (it still lists the NPA domains).

Notes:
- Invite emails land wherever the Supabase Auth `SITE_URL` / redirect
  allowlist points; no redirect override is passed here.
- The permission-flag whitelist in `src/worker.js` (`PERMISSION_COLUMNS`)
  mirrors the boolean columns of `public.user_permissions` — extend it when
  new flag columns are added.
