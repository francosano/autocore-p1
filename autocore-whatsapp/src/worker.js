// autocore-whatsapp/src/worker.js
// ─────────────────────────────────────────────────────────────────────────────
// COBRANZA + TESORERÍA WHATSAPP WORKER — Production
//
// CHANGELOG
//   2026-05-07: Added isUUID() guard around enviado_por before logging.
//   2026-05-19: Added /notify-tesoreria endpoint (Tesorería notifications:
//               18 transactional templates + 1 reversal template, routed to
//               departmental subscribers in tesoreria_notify_subscribers).
//
// Endpoints:
//   POST /send              → Send cobranza WhatsApp via approved Meta templates
//   POST /send-template     → Direct template send (CRM/advanced use)
//   POST /notify-tesoreria  → Fan-out a Tesorería event to all active dept subscribers
//   GET  /                  → Health check
//
// Required env secrets:
//   WA_PHONE_NUMBER_ID        Production Kia Maracay phone number ID
//   WA_ACCESS_TOKEN           Permanent system user token
//   SUPABASE_URL              https://xwyiatmeyonodgncobps.supabase.co
//   SUPABASE_SERVICE_KEY      Service role key (for log inserts + subscriber reads)
// ─────────────────────────────────────────────────────────────────────────────

const GRAPH_API = "https://graph.facebook.com/v18.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ─── UUID validator ─────────────────────────────────────────────────────────
function isUUID(v) {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// ─── Phone normalization (Venezuela) ────────────────────────────────────────
// Converts local Venezuelan formats to E.164 (digits only, no '+').
// Examples:
//   04143450478   → 584143450478
//   +584143450478 → 584143450478
//   4143450478    → 584143450478
//   0424-3494018  → 584243494018
// Numbers that are already E.164 from any country pass through unchanged.
function normalizePhone(raw) {
  if (!raw) return "";
  let p = String(raw).replace(/\D/g, ""); // strip everything non-digit
  if (!p) return "";

  // Already E.164 Venezuela (12 digits, starts with 58)
  if (p.length === 12 && p.startsWith("58")) return p;

  // Local VE with leading 0 (11 digits: 04XX-XXXXXXX)
  if (p.length === 11 && p.startsWith("0")) return "58" + p.slice(1);

  // VE mobile/landline without leading 0 (10 digits, starts with 4 or 2)
  if (p.length === 10 && (p.startsWith("4") || p.startsWith("2"))) return "58" + p;

  // Pass through anything else (US, EU numbers, etc. — already E.164)
  return p;
}

// ─── Formatters ─────────────────────────────────────────────────────────────
function fmtFechaShort(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("T")[0].split("-");
  return `${d}/${m}/${y}`;
}

function fmtMonto(n) {
  if (n === null || n === undefined || n === "") return "0.00";
  const num = typeof n === "string" ? parseFloat(n) : Number(n);
  if (isNaN(num)) return "0.00";
  return num.toFixed(2);
}

// ─── Supabase REST helpers ──────────────────────────────────────────────────
function sb(env) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  const base = env.SUPABASE_URL + "/rest/v1";

  return {
    async getContrato(id) {
      try {
        const r = await fetch(
          `${base}/cobranza_contratos?id=eq.${id}&select=cliente_nombre,cliente_telefono,vehiculo_marca,modelo,nro_cuotas,cuota_mensual_usd`,
          { headers }
        );
        if (!r.ok) return null;
        const data = await r.json();
        return data?.[0] || null;
      } catch (e) {
        console.error("getContrato error:", e.message);
        return null;
      }
    },
    async getActiveTesoreriaSubscribers() {
      try {
        const r = await fetch(
          `${base}/tesoreria_notify_subscribers?activo=eq.true&notify_bancarizacion=eq.true&select=id,nombre,telefono`,
          { headers }
        );
        if (!r.ok) {
          console.error(`tesoreria_notify_subscribers query failed (${r.status}):`, await r.text());
          return [];
        }
        const data = await r.json();
        return Array.isArray(data) ? data : [];
      } catch (e) {
        console.error("getActiveTesoreriaSubscribers error:", e.message);
        return [];
      }
    },
    async insertLog(row) {
      try {
        const r = await fetch(`${base}/comunicaciones_log`, {
          method: "POST",
          headers,
          body: JSON.stringify([row]),
        });
        if (!r.ok) {
          const text = await r.text();
          console.error(`comunicaciones_log insert failed (${r.status}):`, text);
          return null;
        }
        return r.json();
      } catch (e) {
        console.error("comunicaciones_log insert threw:", e.message);
        return null;
      }
    },
  };
}

// ─── Cobranza template selector (existing) ──────────────────────────────────
function pickTemplate(tipo, fechaVencimiento) {
  const todayISO = new Date().toISOString().slice(0, 10);
  if (tipo === "vencida") return "cuota_vencida";
  if (tipo === "proxima_a_vencer") {
    if (fechaVencimiento && fechaVencimiento.slice(0, 10) <= todayISO) {
      return "recordatorio_vencimiento_hoy";
    }
    return "recordatorio_proximo_vencimiento";
  }
  if (tipo === "pago_confirmado") return "pago_confirmado";
  if (tipo === "bienvenida_portal" || tipo === "bienvenida") return "bienvenida_portal";
  return null;
}

function buildTemplateParams(templateName, ctx) {
  const nombre   = ctx.nombre || "Cliente";
  const xdeY     = ctx.cuotaXdeY || "";
  const vehiculo = ctx.vehiculo || "";
  const monto    = fmtMonto(ctx.monto);
  const fecha    = ctx.fecha || "";
  switch (templateName) {
    case "recordatorio_proximo_vencimiento":
      return [nombre, xdeY, vehiculo, monto, fecha];
    case "recordatorio_vencimiento_hoy":
      return [nombre, xdeY, vehiculo, monto];
    case "cuota_vencida":
      return [nombre, xdeY, vehiculo, monto, fecha];
    case "pago_confirmado":
      return [nombre, monto, xdeY, vehiculo];
    case "bienvenida_portal":
      return [nombre, vehiculo, String(ctx.n_cuotas || ""), monto, fecha];
    default:
      return [];
  }
}

function renderTemplateBody(templateName, params) {
  // (kept identical — used for cobranza logging only)
  switch (templateName) {
    case "recordatorio_proximo_vencimiento":
      return `Hola ${params[0]}, le recordamos que su cuota ${params[1]} de ${params[2]} por *$${params[3]}* vence el *${params[4]}*.\n\nPara pagar o consultar su saldo ingrese a: portal.motocentro2.com\n\nMotocentro II C.A. | (0424) 349.40.18`;
    case "recordatorio_vencimiento_hoy":
      return `Hola ${params[0]}, hoy vence su cuota ${params[1]} de ${params[2]} por *$${params[3]}*.\n\nRealice su pago hoy para evitar mora: portal.motocentro2.com\n\nMotocentro II C.A. | (0424) 349.40.18`;
    case "cuota_vencida":
      return `Hola ${params[0]}, su cuota ${params[1]} de ${params[2]} por *$${params[3]}* venció el *${params[4]}* y está pendiente de pago.\n\nPor favor regularice su situación a la brevedad: portal.motocentro2.com\n\nMotocentro II C.A. | (0424) 349.40.18`;
    case "pago_confirmado":
      return `Hola ${params[0]}, confirmamos que su pago de *$${params[1]}* correspondiente a la cuota ${params[2]} de ${params[3]} ha sido verificado y aplicado exitosamente.\n\nGracias por su puntualidad.\n\nMotocentro II C.A. | (0424) 349.40.18`;
    case "bienvenida_portal":
      return `Hola ${params[0]}, bienvenido/a a Motocentro II C.A.\n\nSu financiamiento ha sido aprobado:\n- Vehículo: ${params[1]}\n- Cuotas: ${params[2]} de *$${params[3]}*\n- Primera cuota: ${params[4]}\n\nAcceda a su Portal de Cliente: portal.motocentro2.com\n\nMotocentro II C.A. | (0424) 349.40.18`;
    default:
      return "";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TESORERÍA TEMPLATE ROUTER
// ═══════════════════════════════════════════════════════════════════════════
//
// Given a treasury event (evento + tipo + egreso_tipo + bancarizacion_ruta),
// resolve which template to send and which order the variables go in.
//
// THE 19 TEMPLATE NAMES BELOW ARE PLACEHOLDERS — Meta sometimes forces a
// rename during approval (e.g. underscores, lowercase). Once Franco sends the
// approved names, ONLY this TESORERIA_TEMPLATES table needs updating. The
// rest of the worker is name-agnostic.
//
// Each entry says: which template name to send, AND how to assemble its
// {{1}}..{{N}} variable list FROM the body the page sent us.
// ═══════════════════════════════════════════════════════════════════════════

// Pretty-print labels (kept in the worker so the page doesn't need to send them)
const EGRESO_TIPO_LABEL = {
  BANCARIZACION:    "Bancarización",
  CAJA_CHICA_REPO:  "Reposición de Caja Chica",
  VENDOR_PAGO:      "Pago a proveedor",
  PAGO_FIJO:        "Pago fijo",
};

// Build the source-dependent action line for `banc_solicitada` (Option A).
// Worker writes the right action based on where the cash is coming from.
function bancActionFromSource(origenCodigo) {
  if (origenCodigo === "PC_MIRLA") {
    return "El efectivo ya está en Admon (Motocentro) — coordinar la entrega al bancarizador.";
  }
  // Default to CAJA_PPAL semantics
  return "Tesorería debe llevar el efectivo de Caja Principal a Admon (Motocentro).";
}

// Each builder receives the body object and returns the params array in
// {{1}}..{{N}} order, matching the template's variable layout.
const TESORERIA_TEMPLATES = {
  // ── INGRESO ────────────────────────────────────────────────────────────
  ingreso_pendiente: (b) => [
    b.concepto || "—",
    fmtMonto(b.monto_usd),
    b.ubicacion_destino || "Punto de Cobro",
    b.numero,
  ],
  ingreso_recogido: (b) => [
    b.concepto || "—",
    fmtMonto(b.monto_usd),
    b.numero,
  ],

  // ── BANCARIZACIÓN VÍA ADMON ────────────────────────────────────────────
  banc_solicitada: (b) => [
    b.solicitante || "—",                                       // {{1}}
    fmtMonto(b.monto_usd),                                      // {{2}}
    b.bancarizador || b.egreso_dirigido_a || "—",               // {{3}}
    bancActionFromSource(b.ubicacion_origen_codigo),            // {{4}} (Option A)
    b.numero,                                                   // {{5}}
  ],
  banc_en_mirla: (b) => [
    fmtMonto(b.monto_usd),
    b.bancarizador || b.egreso_dirigido_a || "—",
    b.numero,
  ],
  banc_entregada: (b) => [
    fmtMonto(b.monto_usd),
    b.bancarizador || "—",
    b.numero,
  ],
  banc_depositada: (b) => [
    fmtMonto(b.monto_usd),
    b.bancarizador || "—",
    b.numero,
  ],

  // ── BANCARIZACIÓN DIRECTA ──────────────────────────────────────────────
  banc_directa_solicitada: (b) => [
    b.solicitante || "—",
    fmtMonto(b.monto_usd),
    b.bancarizador || b.egreso_dirigido_a || "—",
    b.ubicacion_origen || "Caja Principal",
    b.numero,
  ],
  banc_directa_entregada: (b) => [
    fmtMonto(b.monto_usd),
    b.bancarizador || "—",
    b.numero,
  ],
  banc_directa_depositada: (b) => [
    fmtMonto(b.monto_usd),
    b.bancarizador || "—",
    b.numero,
  ],

  // ── USDT — ingreso (born already in wallet, no pickup) ─────────────────
  ingreso_usdt: (b) => [
    b.concepto || "—",
    fmtMonto(b.monto_usd),
    b.contraparte_nombre || b.solicitante || "—",
    b.numero,
  ],

  // ── USDT — bancarización (source = USDT wallet) ────────────────────────
  // Three states: SOLICITADO → ENTREGADO_BANCARIZADOR → DEPOSITADO.
  // No Mirla intermediary; the USDT moves digitally to the bancarizador.
  usdt_solicitada: (b) => [
    b.solicitante || "—",
    fmtMonto(b.monto_usd),
    b.bancarizador || b.egreso_dirigido_a || "—",
    b.numero,
  ],
  usdt_entregada: (b) => [
    fmtMonto(b.monto_usd),
    b.bancarizador || "—",
    b.numero,
  ],
  usdt_depositada: (b) => [
    fmtMonto(b.monto_usd),
    b.bancarizador || "—",
    b.numero,
  ],

  // ── CAJA CHICA REPOSICIÓN ──────────────────────────────────────────────
  caja_chica_solicitada: (b) => [
    fmtMonto(b.monto_usd),
    b.concepto || "—",
    b.numero,
  ],
  caja_chica_ejecutada: (b) => [
    fmtMonto(b.monto_usd),
    b.numero,
  ],

  // ── PAGO A PROVEEDOR ───────────────────────────────────────────────────
  vendor_solicitado: (b) => [
    b.egreso_dirigido_a || "—",
    fmtMonto(b.monto_usd),
    b.concepto || "—",
    b.numero,
  ],
  vendor_ejecutado: (b) => [
    b.egreso_dirigido_a || "—",
    fmtMonto(b.monto_usd),
    b.numero,
  ],
  vendor_factura_alerta: (b) => [
    b.egreso_dirigido_a || "—",
    fmtMonto(b.monto_usd),
    b.numero,
    b.factura_motivo || "Factura no pudo verificarse",
  ],

  // ── PAGO FIJO ──────────────────────────────────────────────────────────
  pago_fijo_ejecutado: (b) => [
    b.concepto || "—",
    fmtMonto(b.monto_usd),
    b.numero,
  ],

  // ── ANULACIÓN ──────────────────────────────────────────────────────────
  banc_anulada: (b) => [
    fmtMonto(b.monto_usd),
    b.numero,
    b.motivo || "—",
  ],
  egreso_anulado: (b) => [
    EGRESO_TIPO_LABEL[b.egreso_tipo] || b.egreso_tipo || "Egreso",
    fmtMonto(b.monto_usd),
    b.numero,
    b.motivo || "—",
  ],

  // ── PUNTO DE COBRO AFECTADO ────────────────────────────────────────────
  punto_cobro_afectado: (b) => [
    fmtMonto(b.monto_usd),                  // amount committed
    b.motivo || "Egreso solicitado",
    b.numero,
    fmtMonto(b.pc_saldo_restante),          // remaining balance
  ],

  // ── EGRESO REVERTIDO (template #19, pending Meta approval) ─────────────
  egreso_revertido: (b) => [
    EGRESO_TIPO_LABEL[b.egreso_tipo] || b.egreso_tipo || "Egreso",
    fmtMonto(b.monto_usd),
    b.numero,
    b.revertido_por || "Tesorería",
    b.motivo || "—",
  ],
};

// Resolve which template a treasury event maps to.
// Returns the template-name STRING or null if not handled.
function resolveTesoreriaTemplate(body) {
  const {
    evento,
    tipo,                   // 'INGRESO' | 'EGRESO'
    egreso_tipo,            // 'BANCARIZACION' | 'CAJA_CHICA_REPO' | 'VENDOR_PAGO' | 'PAGO_FIJO'
    bancarizacion_ruta,     // 'via_mirla' | 'directa'
    factura_match,          // boolean — only present for VENDOR_PAGO EJECUTADO
    force_template,         // optional override — used for co-fires like punto_cobro_afectado
    ubicacion_origen_codigo,  // 'CAJA_PPAL' | 'PC_MIRLA' | 'USDT_WALLET'
    ubicacion_destino_codigo, // same — used for INGRESO routing
  } = body;

  // Explicit override — caller already knows which template to send.
  if (force_template && TESORERIA_TEMPLATES[force_template]) {
    return force_template;
  }

  // INGRESO — destination determines template. USDT ingresos skip pickup
  // entirely, so they only fire one notification on creation.
  if (tipo === "INGRESO") {
    if (ubicacion_destino_codigo === "USDT_WALLET" && evento === "CREADO") {
      return "ingreso_usdt";
    }
    if (evento === "CREADO")             return "ingreso_pendiente";
    if (evento === "PICKUP_CONFIRMADO")  return "ingreso_recogido";
    return null;
  }

  // EGRESO ANULADO
  if (evento === "ANULADO") {
    if (egreso_tipo === "BANCARIZACION") return "banc_anulada";
    return "egreso_anulado";
  }

  // EGRESO REVERTIDO (any executed/deposited egreso reversed)
  if (evento === "REVERTIDO") return "egreso_revertido";

  // BANCARIZACIÓN — three routing branches:
  //  • USDT source → usdt_* templates (3 states, no Mirla intermediary)
  //  • directa     → banc_directa_*  (3 states, Tesorería to bancarizador)
  //  • via_mirla   → banc_*          (4 states, full chain through Mirla)
  if (egreso_tipo === "BANCARIZACION") {
    if (ubicacion_origen_codigo === "USDT_WALLET") {
      if (evento === "SOLICITADO")             return "usdt_solicitada";
      if (evento === "ENTREGADO_BANCARIZADOR") return "usdt_entregada";
      if (evento === "DEPOSITADO")             return "usdt_depositada";
      return null; // USDT route shouldn't hit EN_PODER_MIRLA
    }
    const directa = bancarizacion_ruta === "directa";
    if (evento === "SOLICITADO")             return directa ? "banc_directa_solicitada" : "banc_solicitada";
    if (evento === "EN_PODER_MIRLA")         return "banc_en_mirla";
    if (evento === "ENTREGADO_BANCARIZADOR") return directa ? "banc_directa_entregada" : "banc_entregada";
    if (evento === "DEPOSITADO")             return directa ? "banc_directa_depositada" : "banc_depositada";
    return null;
  }

  // CAJA CHICA REPOSICIÓN
  if (egreso_tipo === "CAJA_CHICA_REPO") {
    if (evento === "SOLICITADO") return "caja_chica_solicitada";
    if (evento === "EJECUTADO")  return "caja_chica_ejecutada";
    return null;
  }

  // VENDOR PAGO
  if (egreso_tipo === "VENDOR_PAGO") {
    if (evento === "SOLICITADO") return "vendor_solicitado";
    if (evento === "EJECUTADO")  return factura_match === false ? "vendor_factura_alerta" : "vendor_ejecutado";
    return null;
  }

  // PAGO FIJO
  if (egreso_tipo === "PAGO_FIJO") {
    if (evento === "EJECUTADO") return "pago_fijo_ejecutado";
    return null;
  }

  return null;
}

// URGENTE prefix: prepended into the variable that carries the most context.
// For bancarización templates that's {{1}} (Solicitante or Monto-context line).
// Implementation: walk the params and prepend on the FIRST non-numeric-looking
// param. Numeric-looking params are likely "Monto" — don't pollute those.
function applyUrgentePrefix(params) {
  if (!Array.isArray(params) || params.length === 0) return params;
  const out = [...params];
  for (let i = 0; i < out.length; i++) {
    const v = String(out[i] || "");
    // Heuristic: numeric-only strings (e.g. monto "15500.00", ref "EGR-0042")
    // are not great targets. Plain words are.
    const isMostlyNumeric = /^[\d.,\s$-]+$/.test(v);
    if (!isMostlyNumeric) {
      out[i] = "🔴 URGENTE — " + v;
      return out;
    }
  }
  // Fallback: prepend to {{1}} regardless
  out[0] = "🔴 URGENTE — " + String(out[0] || "");
  return out;
}

// ─── Send a single template message via Meta Cloud API ──────────────────────
async function sendTemplate(env, toNormalized, templateName, params) {
  const components = params.length > 0
    ? [{
        type: "body",
        parameters: params.map((text) => ({ type: "text", text: String(text) })),
      }]
    : [];

  const metaBody = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toNormalized,
    type: "template",
    template: {
      name: templateName,
      language: { code: "es" },
      ...(components.length > 0 && { components }),
    },
  };

  const r = await fetch(`${GRAPH_API}/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.WA_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metaBody),
  });

  let result;
  try {
    result = await r.json();
  } catch {
    const fallback = await r.text();
    return { ok: false, error: { message: "Meta returned non-JSON: " + fallback.substring(0, 200) } };
  }

  if (!r.ok) {
    console.error("Meta API error:", r.status, JSON.stringify(result));
    return { ok: false, error: result.error || { message: `HTTP ${r.status}` } };
  }

  return { ok: true, message_id: result?.messages?.[0]?.id || null };
}

// ─── Main fetch handler ─────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return jsonResponse({
        status: "ok",
        worker: "autocore-whatsapp",
        version: "2026-05-19-usdt",
        mode: "production-templates",
        endpoints: ["/send", "/send-template", "/notify-tesoreria"],
        approved_cobranza_templates: [
          "recordatorio_proximo_vencimiento",
          "recordatorio_vencimiento_hoy",
          "cuota_vencida",
          "pago_confirmado",
          "bienvenida_portal",
        ],
        tesoreria_templates_known: Object.keys(TESORERIA_TEMPLATES),
        timestamp: new Date().toISOString(),
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // POST /send — Portal cobranza send (template-based)  [UNCHANGED]
    // ═══════════════════════════════════════════════════════════════════════
    if (request.method === "POST" && path === "/send") {
      try {
        const body = await request.json();
        const {
          contrato_id, cuota_id, to, tipo,
          cliente_nombre, monto, cuota_numero,
          fecha_vencimiento, fecha_primera_cuota, enviado_por,
        } = body;

        if (!to)    return jsonResponse({ error: "Missing required field: to" }, 400);
        if (!tipo)  return jsonResponse({ error: "Missing required field: tipo" }, 400);
        if (tipo === "general") {
          return jsonResponse({
            error: "Mensaje general no soportado por plantillas. Use un tipo específico: proxima_a_vencer, vencida, pago_confirmado, bienvenida_portal.",
          }, 400);
        }

        const templateName = pickTemplate(tipo, fecha_vencimiento);
        if (!templateName) return jsonResponse({ error: `Unknown tipo: ${tipo}` }, 400);

        const toNormalized = normalizePhone(to);
        if (!toNormalized || toNormalized.length < 10) {
          return jsonResponse({ error: `Invalid phone number: ${to}` }, 400);
        }

        const db = sb(env);
        let contrato = null;
        if (contrato_id) contrato = await db.getContrato(contrato_id);

        const vehiculo = contrato
          ? `${contrato.vehiculo_marca || "KIA"} ${contrato.modelo || ""}`.trim()
          : "su vehículo";
        const nro_cuotas = contrato?.nro_cuotas || 0;
        const cuotaXdeY = cuota_numero && nro_cuotas
          ? `${cuota_numero}/${nro_cuotas}`
          : (cuota_numero ? String(cuota_numero) : "");

        let fechaParam = "";
        if (templateName === "bienvenida_portal") {
          fechaParam = fmtFechaShort(fecha_primera_cuota || "");
        } else {
          fechaParam = fmtFechaShort(fecha_vencimiento || "");
        }

        const params = buildTemplateParams(templateName, {
          nombre: cliente_nombre || contrato?.cliente_nombre || "Cliente",
          cuotaXdeY,
          vehiculo,
          monto: monto != null ? monto : (contrato?.cuota_mensual_usd || 0),
          fecha: fechaParam,
          n_cuotas: nro_cuotas,
        });

        const result = await sendTemplate(env, toNormalized, templateName, params);
        const mensajeTexto = renderTemplateBody(templateName, params);

        await db.insertLog({
          contrato_id: contrato_id || null,
          cuota_id: cuota_id || null,
          cliente_nombre: cliente_nombre || contrato?.cliente_nombre || null,
          telefono: toNormalized,
          mensaje_tipo: tipo,
          mensaje_texto: mensajeTexto,
          whatsapp_message_id: result.ok ? result.message_id : null,
          status: result.ok ? "sent" : "failed",
          error_detalle: result.ok ? null : (result.error?.message || "Error desconocido"),
          enviado_por: isUUID(enviado_por) ? enviado_por : null,
          enviado_at: new Date().toISOString(),
          canal: "whatsapp",
          asunto: null,
        });

        if (!result.ok) {
          return jsonResponse({
            error: result.error?.message || "WhatsApp send failed",
            meta_error: result.error,
            telefono_normalizado: toNormalized,
            template: templateName,
          }, 400);
        }

        return jsonResponse({
          success: true,
          whatsapp_message_id: result.message_id,
          telefono_normalizado: toNormalized,
          template: templateName,
          mensaje_texto: mensajeTexto,
        });
      } catch (e) {
        console.error("/send error:", e.message, e.stack);
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // POST /send-template — direct template send (CRM/advanced)  [UNCHANGED]
    // ═══════════════════════════════════════════════════════════════════════
    if (request.method === "POST" && path === "/send-template") {
      try {
        const body = await request.json();
        const { to, template_name, language = "es", parameters = [] } = body;
        if (!to || !template_name) {
          return jsonResponse({ error: "Missing required fields: to, template_name" }, 400);
        }
        const toNormalized = normalizePhone(to);
        const result = await sendTemplate(env, toNormalized, template_name, parameters);
        if (!result.ok) {
          return jsonResponse({
            error: result.error?.message || "Send failed",
            meta_error: result.error,
          }, 400);
        }
        return jsonResponse({
          success: true,
          whatsapp_message_id: result.message_id,
          telefono_normalizado: toNormalized,
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // POST /notify-tesoreria — Tesorería event fan-out  [NEW]
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The comprobante / ingreso page calls this after a successful state
    // transition. The worker decides which template to send (based on the
    // event + egreso_tipo + route), reads the active department subscribers,
    // sends to all of them, and logs every send.
    //
    // Non-fatal by design — if this returns an error, the page's transition
    // has ALREADY succeeded in the DB. We just record the notification
    // outcome.
    //
    // Expected body:
    //   {
    //     evento, tipo, egreso_tipo?, bancarizacion_ruta?, es_urgente?,
    //     numero, monto_usd, concepto, solicitante, bancarizador,
    //     egreso_dirigido_a, ubicacion_origen_codigo, ubicacion_origen,
    //     ubicacion_destino, pc_saldo_restante?, motivo?, factura_motivo?,
    //     factura_match?, revertido_por?, enviado_por
    //   }
    //
    // Response:
    //   { template, recipients_total, sends_ok, sends_failed, details: [...] }
    //   or { error: ... } on routing/validation failure
    if (request.method === "POST" && path === "/notify-tesoreria") {
      try {
        const body = await request.json();
        if (!body.evento) return jsonResponse({ error: "Missing required field: evento" }, 400);
        if (!body.tipo)   return jsonResponse({ error: "Missing required field: tipo" }, 400);
        if (!body.numero) return jsonResponse({ error: "Missing required field: numero" }, 400);

        // 1. Resolve which template this event maps to
        const templateName = resolveTesoreriaTemplate(body);
        if (!templateName) {
          return jsonResponse({
            error: "No template matches this event",
            evento: body.evento,
            tipo: body.tipo,
            egreso_tipo: body.egreso_tipo || null,
            bancarizacion_ruta: body.bancarizacion_ruta || null,
          }, 400);
        }

        const paramsBuilder = TESORERIA_TEMPLATES[templateName];
        if (!paramsBuilder) {
          return jsonResponse({
            error: `Template '${templateName}' resolved but no params builder defined`,
          }, 500);
        }

        // 2. Build the variable array, applying URGENTE prefix if applicable
        let params = paramsBuilder(body);
        if (body.es_urgente === true) {
          params = applyUrgentePrefix(params);
        }

        // 3. Load active subscribers
        const db = sb(env);
        const subscribers = await db.getActiveTesoreriaSubscribers();

        if (subscribers.length === 0) {
          return jsonResponse({
            template: templateName,
            recipients_total: 0,
            sends_ok: 0,
            sends_failed: 0,
            note: "No active subscribers — message not sent.",
          });
        }

        // 4. Fan out — send to each subscriber, log each send
        const details = [];
        let okCount = 0, failCount = 0;

        for (const sub of subscribers) {
          const toNormalized = normalizePhone(sub.telefono);
          if (!toNormalized || toNormalized.length < 10) {
            details.push({ subscriber: sub.nombre, telefono: sub.telefono, status: "skipped", reason: "invalid phone" });
            failCount++;
            continue;
          }

          const result = await sendTemplate(env, toNormalized, templateName, params);

          // Log the send. Using comunicaciones_log with mensaje_tipo identifying it
          // as a tesorería notification — keeps everything in one log table.
          await db.insertLog({
            contrato_id: null,
            cuota_id: null,
            cliente_nombre: sub.nombre,            // dept label, not a person
            telefono: toNormalized,
            mensaje_tipo: `tesoreria:${body.evento}`,
            mensaje_texto: `[${templateName}] ${body.numero} · ${fmtMonto(body.monto_usd)}`,
            whatsapp_message_id: result.ok ? result.message_id : null,
            status: result.ok ? "sent" : "failed",
            error_detalle: result.ok ? null : (result.error?.message || "Error desconocido"),
            enviado_por: isUUID(body.enviado_por) ? body.enviado_por : null,
            enviado_at: new Date().toISOString(),
            canal: "whatsapp",
            asunto: null,
          });

          details.push({
            subscriber: sub.nombre,
            telefono: toNormalized,
            status: result.ok ? "sent" : "failed",
            message_id: result.ok ? result.message_id : null,
            error: result.ok ? null : (result.error?.message || null),
          });
          if (result.ok) okCount++; else failCount++;
        }

        return jsonResponse({
          template: templateName,
          recipients_total: subscribers.length,
          sends_ok: okCount,
          sends_failed: failCount,
          details,
        });
      } catch (e) {
        console.error("/notify-tesoreria error:", e.message, e.stack);
        return jsonResponse({ error: e.message }, 500);
      }
    }

    return jsonResponse({ error: "Not found", path }, 404);
  },
};
