// TARGET: autocore-npa/workers/autocore-admin-users/src/worker.js
// ─────────────────────────────────────────────────────────────────────────────
// ADMIN USERS WORKER — user provisioning & permission management
//
// user_roles / user_permissions have NO browser-facing RLS (fail closed), so
// every admin mutation and the admin user list go through this worker with
// the service-role key. The browser NEVER touches those tables directly for
// admin operations.
//
// Security model (every endpoint):
//   1. Verify caller identity via Authorization: Bearer <supabase user JWT>
//      (GET /auth/v1/user).
//   2. With the service client, require caller has npa_can_admin=true in
//      user_permissions AND is_active=true in user_roles.
//   3. Self-edit is rejected on all mutations (set-role / set-active /
//      set-permissions where target === caller). The UI renders the caller's
//      own row read-only to match.
//   4. Every successful mutation writes an activity_log row
//      (action, target_type='user', target_id, details jsonb).
//
// Endpoints:
//   GET  /users            → user_roles joined with user_permissions
//   POST /invite           → { email, full_name, role, telefono_wa }
//   POST /set-active       → { user_id, is_active }
//   POST /set-role         → { user_id, role }  (resets perms to role template)
//   POST /set-permissions  → { user_id, permissions: { flag: bool, ... } }
//   GET  /                 → health check
//
// /invite is transactional-by-cleanup: auth invite → user_roles insert →
// user_permissions insert (prefilled from role_templates[role].permissions).
// If ANY step fails, everything already created is deleted — half-provisioned
// users (auth user with no role row) have bitten us before.
//
// Required env secrets:
//   SUPABASE_URL               https://xwyiatmeyonodgncobps.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service role key
// ─────────────────────────────────────────────────────────────────────────────

// ─── CORS — locked to the app origin (plus CF Pages previews + local dev) ───
const APP_ORIGIN = "https://autocore-npa.pages.dev";

function allowedOrigin(origin) {
  if (!origin) return null;
  if (origin === APP_ORIGIN) return origin;
  // Cloudflare Pages preview deploys: https://<hash>.autocore-npa.pages.dev
  if (/^https:\/\/[a-z0-9-]+\.autocore-npa\.pages\.dev$/.test(origin)) return origin;
  if (origin === "http://localhost:3000") return origin;
  return null;
}

function corsHeaders(origin) {
  const allowed = allowedOrigin(origin);
  return {
    "Access-Control-Allow-Origin": allowed || APP_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

// ─── Permission column whitelist ─────────────────────────────────────────────
// Mirrors the boolean columns of public.user_permissions (docs/schema.sql).
// /set-permissions and template prefills accept ONLY these keys — anything
// else in the payload (id, user_id, updated_by, unknown/new columns) is
// silently dropped so the service client can never be steered into arbitrary
// column writes.
const PERMISSION_COLUMNS = [
  // Cobranza / portal (legacy prestamos app)
  "can_view_prestamos", "can_create_prestamos", "can_edit_prestamos",
  "can_delete_prestamos", "can_register_pagos", "can_verify_pagos",
  "can_send_whatsapp", "can_view_whatsapp_log", "can_view_reportes",
  "can_view_crm", "can_manage_crm", "can_view_inventory",
  "can_manage_inventory", "can_manage_settings", "can_view_solicitudes",
  "can_create_solicitudes", "can_approve_solicitudes", "can_delete_solicitudes",
  "can_view_mensajes", "can_send_mensajes", "can_view_activity_log",
  "can_view_cobranza", "can_manage_usdt",
  "can_register_pagos_recibidos", "can_cancel_pagos_recibidos",
  // NPA
  "npa_can_view_dashboard", "npa_can_view_clientes", "npa_can_view_deals",
  "npa_can_audit_deals", "npa_can_view_cobranza", "npa_can_register_pagos",
  "npa_can_approve_deals", "npa_can_ajuste_cuadre", "npa_can_nota_entrega",
  "npa_can_admin", "npa_can_view_crm", "npa_can_view_inventory_finance",
  "npa_can_view_management_pnl", "npa_can_mark_lost",
  // Tesorería
  "tesoreria_can_pickup", "tesoreria_can_dispatch", "tesoreria_can_view_balance",
  "tesoreria_can_replenish_cc", "tesoreria_can_confirm_fx",
  "tesoreria_can_request_salida", "tesoreria_can_approve_salida",
  "tesoreria_can_register_cc_gasto", "tesoreria_admin", "tesoreria_can_arqueo",
  "tesoreria_can_request_cc_repo", "tesoreria_can_register_ingreso",
];
const PERMISSION_SET = new Set(PERMISSION_COLUMNS);

// Catálogo de roles válidos — DEBE reflejar el CHECK constraint de
// user_roles.role (docs/schema.sql). Crear tipos de rol nuevos es un cambio
// de esquema y queda fuera del worker.
const ROLE_CATALOG = new Set([
  "admin", "manager", "user", "auditoria", "auditoria_ingresos",
  "administrador", "gerente", "jefe_ventas", "asesor_ventas", "gte_cobranza",
  "asist_cobranza", "asist_admin", "bdc", "cliente", "tesoreria", "facturacion",
]);

// Keep only whitelisted keys with strictly-boolean values.
function filterPermissions(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (PERMISSION_SET.has(k) && typeof v === "boolean") out[k] = v;
  }
  return out;
}

// ─── Small helpers ───────────────────────────────────────────────────────────
function isUUID(v) {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function isEmail(v) {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

// ─── Supabase REST (service role) ────────────────────────────────────────────
function svcHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function sbSelect(env, pathAndQuery) {
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/" + pathAndQuery, {
    headers: svcHeaders(env),
  });
  if (!r.ok) throw new Error(`select ${pathAndQuery.split("?")[0]} failed (${r.status}): ${await r.text()}`);
  return r.json();
}

async function sbInsert(env, table, row) {
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST",
    headers: svcHeaders(env, { Prefer: "return=representation" }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`insert ${table} failed (${r.status}): ${await r.text()}`);
  const data = await r.json();
  return data?.[0] || null;
}

async function sbUpdate(env, table, filter, patch) {
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/" + table + "?" + filter, {
    method: "PATCH",
    headers: svcHeaders(env, { Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`update ${table} failed (${r.status}): ${await r.text()}`);
  return r.json(); // array of updated rows — caller checks length
}

async function sbDelete(env, table, filter) {
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/" + table + "?" + filter, {
    method: "DELETE",
    headers: svcHeaders(env),
  });
  return r.ok;
}

// ─── Auth: resolve + authorize the caller ────────────────────────────────────
// Returns { id, email } or null if the JWT is missing/invalid.
async function getCaller(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const r = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + m[1] },
  });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user?.id) return null;
  return { id: user.id, email: user.email || "" };
}

// Requires npa_can_admin=true (user_permissions) AND is_active=true (user_roles).
async function isAuthorizedAdmin(env, callerId) {
  const [perms, roles] = await Promise.all([
    sbSelect(env, `user_permissions?user_id=eq.${callerId}&select=npa_can_admin`),
    sbSelect(env, `user_roles?user_id=eq.${callerId}&select=is_active`),
  ]);
  return perms?.[0]?.npa_can_admin === true && roles?.[0]?.is_active === true;
}

// ─── Activity log (one row per successful mutation) ─────────────────────────
async function logActivity(env, caller, action, targetId, details) {
  try {
    await sbInsert(env, "activity_log", {
      user_id: isUUID(caller.id) ? caller.id : null,
      user_email: caller.email || null,
      action,
      target_type: "user",
      target_id: targetId != null ? String(targetId) : null,
      details: details || {},
    });
  } catch (e) {
    // Log failures must not fail the mutation itself — surface in worker logs.
    console.error("activity_log insert failed:", e.message);
  }
}

// ─── Role templates ──────────────────────────────────────────────────────────
async function getRoleTemplate(env, role) {
  if (typeof role !== "string" || !/^[a-z_]+$/i.test(role)) return null;
  const rows = await sbSelect(env, `role_templates?role=eq.${encodeURIComponent(role)}&select=role,label,permissions`);
  return rows?.[0] || null;
}

// Full reset object: every whitelisted flag false, then the template's trues.
function templateToFullFlags(template) {
  const flags = {};
  for (const col of PERMISSION_COLUMNS) flags[col] = false;
  Object.assign(flags, filterPermissions(template?.permissions));
  return flags;
}

// ─── Endpoint handlers ───────────────────────────────────────────────────────

// GET /users — user_roles joined with user_permissions (by user_id).
async function handleListUsers(env) {
  const [roles, perms] = await Promise.all([
    sbSelect(env, "user_roles?select=user_id,role,email,full_name,is_active,last_seen_at,telefono_wa,crm_role,created_at&order=full_name.asc.nullslast"),
    sbSelect(env, `user_permissions?select=user_id,${PERMISSION_COLUMNS.join(",")}`),
  ]);
  const permsByUser = new Map(perms.map(p => [p.user_id, p]));
  const users = roles
    .filter(r => isUUID(r.user_id))
    .map(r => {
      const p = permsByUser.get(r.user_id) || null;
      let permissions = null;
      if (p) {
        permissions = {};
        for (const col of PERMISSION_COLUMNS) permissions[col] = p[col] === true;
      }
      return { ...r, permissions };
    });
  return { users };
}

// POST /invite — auth invite → user_roles → user_permissions, cleanup on failure.
async function handleInvite(env, caller, body) {
  const email = String(body?.email || "").trim().toLowerCase();
  const fullName = String(body?.full_name || "").trim();
  const role = String(body?.role || "").trim();
  const telefonoWa = String(body?.telefono_wa || "").trim();

  if (!isEmail(email)) return { status: 400, error: "Email inválido." };
  if (!fullName) return { status: 400, error: "Nombre completo requerido." };

  const template = await getRoleTemplate(env, role);
  if (!template) return { status: 400, error: `Rol desconocido: ${role || "(vacío)"}.` };

  // 1) Auth invite (sends the invitation email).
  const inviteRes = await fetch(env.SUPABASE_URL + "/auth/v1/invite", {
    method: "POST",
    headers: svcHeaders(env),
    body: JSON.stringify({ email, data: { full_name: fullName } }),
  });
  if (!inviteRes.ok) {
    const txt = await inviteRes.text();
    if (inviteRes.status === 422 || /already/i.test(txt)) {
      return { status: 409, error: "Ya existe un usuario registrado con ese email." };
    }
    return { status: 502, error: "No se pudo enviar la invitación.", detail: txt };
  }
  const authUser = await inviteRes.json();
  const newUserId = authUser?.id;
  if (!isUUID(newUserId)) {
    return { status: 502, error: "La invitación no devolvió un usuario válido." };
  }

  // 2) user_roles + 3) user_permissions — cleanup EVERYTHING on any failure so
  //    we never leave a half-provisioned user (auth user without role/perms).
  let rolesCreated = false;
  try {
    await sbInsert(env, "user_roles", {
      user_id: newUserId,
      role,
      email,
      full_name: fullName,
      is_active: true,
      telefono_wa: telefonoWa || null,
    });
    rolesCreated = true;

    await sbInsert(env, "user_permissions", {
      user_id: newUserId,
      ...templateToFullFlags(template),
      updated_by: caller.id,
    });
  } catch (e) {
    if (rolesCreated) await sbDelete(env, "user_roles", `user_id=eq.${newUserId}`);
    await fetch(env.SUPABASE_URL + "/auth/v1/admin/users/" + newUserId, {
      method: "DELETE",
      headers: svcHeaders(env),
    });
    return { status: 502, error: "Falló el aprovisionamiento; se revirtió la invitación.", detail: e.message };
  }

  await logActivity(env, caller, "admin_users.invite", newUserId, {
    email, full_name: fullName, role, telefono_wa: telefonoWa || null,
  });

  return {
    status: 200,
    data: {
      user: {
        user_id: newUserId, email, full_name: fullName, role,
        role_label: template.label || role,
        telefono_wa: telefonoWa || null, is_active: true,
      },
    },
  };
}

// POST /set-active — { user_id, is_active }
async function handleSetActive(env, caller, body) {
  const targetId = body?.user_id;
  const isActive = body?.is_active;
  if (!isUUID(targetId)) return { status: 400, error: "user_id inválido." };
  if (typeof isActive !== "boolean") return { status: 400, error: "is_active debe ser booleano." };
  if (targetId === caller.id) return { status: 403, error: "No puedes editar tu propio acceso." };

  const updated = await sbUpdate(env, "user_roles", `user_id=eq.${targetId}`, { is_active: isActive });
  if (!updated.length) return { status: 404, error: "Usuario no encontrado." };

  await logActivity(env, caller, "admin_users.set_active", targetId, {
    is_active: isActive, email: updated[0].email || null,
  });
  return { status: 200, data: { user_id: targetId, is_active: isActive } };
}

// POST /set-role — { user_id, role } → update role + reset perms to template.
async function handleSetRole(env, caller, body) {
  const targetId = body?.user_id;
  const role = String(body?.role || "").trim();
  if (!isUUID(targetId)) return { status: 400, error: "user_id inválido." };
  if (targetId === caller.id) return { status: 403, error: "No puedes editar tu propio acceso." };

  const template = await getRoleTemplate(env, role);
  if (!template) return { status: 400, error: `Rol desconocido: ${role || "(vacío)"}.` };

  // Snapshot old state for the activity log BEFORE mutating.
  const [oldRoles, oldPermsRows] = await Promise.all([
    sbSelect(env, `user_roles?user_id=eq.${targetId}&select=role,email`),
    sbSelect(env, `user_permissions?user_id=eq.${targetId}&select=${PERMISSION_COLUMNS.join(",")}`),
  ]);
  if (!oldRoles.length) return { status: 404, error: "Usuario no encontrado." };
  const oldRole = oldRoles[0].role;
  const oldFlagsOn = oldPermsRows.length
    ? PERMISSION_COLUMNS.filter(c => oldPermsRows[0][c] === true)
    : [];

  const updated = await sbUpdate(env, "user_roles", `user_id=eq.${targetId}`, { role });
  if (!updated.length) return { status: 404, error: "Usuario no encontrado." };

  // Reset permissions to the new role's template. Upsert (on_conflict=user_id)
  // covers the edge case of a user_roles row without a user_permissions row.
  const fullFlags = templateToFullFlags(template);
  const upsertRes = await fetch(env.SUPABASE_URL + "/rest/v1/user_permissions?on_conflict=user_id", {
    method: "POST",
    headers: svcHeaders(env, { Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify({ user_id: targetId, ...fullFlags, updated_by: caller.id, updated_at: new Date().toISOString() }),
  });
  if (!upsertRes.ok) {
    // Roll the role back so we never leave role X with role Y's permissions.
    await sbUpdate(env, "user_roles", `user_id=eq.${targetId}`, { role: oldRole });
    return { status: 502, error: "No se pudo aplicar la plantilla de permisos; el rol no fue cambiado.", detail: await upsertRes.text() };
  }

  await logActivity(env, caller, "admin_users.set_role", targetId, {
    email: oldRoles[0].email || null,
    old_role: oldRole,
    new_role: role,
    old_flags_on: oldFlagsOn,
    new_flags_on: PERMISSION_COLUMNS.filter(c => fullFlags[c] === true),
  });
  return { status: 200, data: { user_id: targetId, role, permissions: fullFlags } };
}

// POST /set-template — { role, label, permissions } → upsert role_templates.
// MANAGER-GATED: además de npa_can_admin + is_active (chequeados en el router),
// el caller debe tener rol admin/manager/administrador. Editar plantillas
// redefine lo que reciben TODOS los futuros invitados/cambios de rol.
async function handleSetTemplate(env, caller, body) {
  const role = String(body?.role || "").trim();
  const label = String(body?.label || "").trim().slice(0, 60);
  if (!ROLE_CATALOG.has(role)) return { status: 400, error: `Rol fuera del catálogo: ${role || "(vacío)"}.` };
  if (!label) return { status: 400, error: "Indica una etiqueta (label) para el rol." };

  const callerRole = await sbSelect(env, `user_roles?user_id=eq.${caller.id}&select=role`);
  const r = (callerRole?.[0]?.role || "").toLowerCase();
  if (!["admin", "manager", "administrador"].includes(r)) {
    return { status: 403, error: "Solo gerencia (admin/manager) puede editar plantillas de rol." };
  }

  const flags = filterPermissions(body?.permissions);

  // Snapshot previo para el activity_log.
  const prevRows = await sbSelect(env, `role_templates?role=eq.${encodeURIComponent(role)}&select=label,permissions`);
  const prev = prevRows?.[0] || null;

  const upsertRes = await fetch(env.SUPABASE_URL + "/rest/v1/role_templates?on_conflict=role", {
    method: "POST",
    headers: svcHeaders(env, { Prefer: "resolution=merge-duplicates,return=representation" }),
    body: JSON.stringify({ role, label, permissions: flags }),
  });
  if (!upsertRes.ok) {
    return { status: 502, error: "No se pudo guardar la plantilla.", detail: await upsertRes.text() };
  }

  await logActivity(env, caller, "admin_users.set_template", role, {
    label,
    flags_on: Object.keys(flags).filter((k) => flags[k] === true),
    previo: prev ? { label: prev.label, flags_on: Object.keys(prev.permissions || {}).filter((k) => prev.permissions[k] === true) } : null,
  });

  return { status: 200, data: { role, label, permissions: flags, created: !prev } };
}

// POST /set-permissions — { user_id, permissions } → patch only provided keys.
async function handleSetPermissions(env, caller, body) {
  const targetId = body?.user_id;
  if (!isUUID(targetId)) return { status: 400, error: "user_id inválido." };
  if (targetId === caller.id) return { status: 403, error: "No puedes editar tu propio acceso." };

  const patch = filterPermissions(body?.permissions);
  if (!Object.keys(patch).length) {
    return { status: 400, error: "No se recibieron flags de permisos válidos." };
  }

  const updated = await sbUpdate(env, "user_permissions", `user_id=eq.${targetId}`, {
    ...patch, updated_by: caller.id, updated_at: new Date().toISOString(),
  });
  if (!updated.length) return { status: 404, error: "El usuario no tiene fila de permisos." };

  await logActivity(env, caller, "admin_users.set_permissions", targetId, { changed: patch });
  return { status: 200, data: { user_id: targetId, changed: patch } };
}

// ─── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin);
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" && request.method === "GET") {
      return json({ ok: true, service: "autocore-admin-users" });
    }

    // Browser requests must come from the app origin (server-to-server calls
    // send no Origin header and are still gated by the JWT + admin check).
    if (origin && !allowedOrigin(origin)) {
      return json({ error: "Origen no permitido." }, 403);
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: "Worker sin configurar (faltan secretos)." }, 500);
    }
    // Defensive: secrets set via piped stdin can carry a trailing newline,
    // which turns SUPABASE_URL into an invalid URL and every fetch throws.
    env = {
      ...env,
      SUPABASE_URL: String(env.SUPABASE_URL).trim().replace(/\/+$/, ""),
      SUPABASE_SERVICE_ROLE_KEY: String(env.SUPABASE_SERVICE_ROLE_KEY).trim(),
    };

    // ── Authn + authz (every endpoint) ──────────────────────────────────────
    let caller;
    try {
      caller = await getCaller(request, env);
    } catch (e) {
      console.error("getCaller error:", e.message);
      return json({ error: "No se pudo verificar la sesión." }, 502);
    }
    if (!caller) return json({ error: "Sesión inválida o expirada." }, 401);

    try {
      if (!(await isAuthorizedAdmin(env, caller.id))) {
        return json({ error: "No tienes permisos de administración." }, 403);
      }
    } catch (e) {
      console.error("isAuthorizedAdmin error:", e.message);
      return json({ error: "No se pudo verificar permisos." }, 502);
    }

    try {
      if (path === "/users" && request.method === "GET") {
        return json(await handleListUsers(env));
      }

      if (request.method === "POST") {
        let body;
        try { body = await request.json(); }
        catch { return json({ error: "Body JSON inválido." }, 400); }

        let result = null;
        if (path === "/invite") result = await handleInvite(env, caller, body);
        else if (path === "/set-active") result = await handleSetActive(env, caller, body);
        else if (path === "/set-role") result = await handleSetRole(env, caller, body);
        else if (path === "/set-permissions") result = await handleSetPermissions(env, caller, body);
        else if (path === "/set-template") result = await handleSetTemplate(env, caller, body);

        if (result) {
          if (result.error) return json({ error: result.error, detail: result.detail }, result.status);
          return json(result.data, result.status);
        }
      }

      return json({ error: "Ruta no encontrada." }, 404);
    } catch (e) {
      console.error(`handler ${path} error:`, e.message);
      return json({ error: "Error interno del worker.", detail: e.message }, 500);
    }
  },
};
