// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/components/useNPAPermissions.ts
// v6 (2026-05-19) — browser-back freeze fix (Layer 1 of 3).
//
// THE BUG: on browser-back the page remounts from Next's router cache while
// auth is mid-rehydration. There was a render window where `loading` had
// flipped to false but `permissions` was still ALL_OFF — because setLoading
// and setPermissions are separate setState calls. Page gates evaluated the
// gate against ALL_OFF, fired router.replace(...), the destination gate did
// the same → redirect loop → frozen tab.
//
// THE FIX: a single explicit `ready` flag. `ready` is true ONLY when we have
// a real, settled answer (perms+role loaded, OR confirmed no session, OR a
// hard session error). Gates must key off `ready` — never off `!loading`
// alone — so they can never redirect on the transient ALL_OFF window.
//
// `loading` is kept for backwards-compat (still consumed by older pages) but
// is now strictly the inverse of `ready`.
//
// v5 — adds the 9 tesoreria_* permission flags (Treasury module Phase 1)
// ═══════════════════════════════════════════════════════════════════════════
'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '../supabase'

export interface NPAPermissions {
  npa_can_view_dashboard: boolean
  npa_can_view_clientes:  boolean
  npa_can_view_deals:     boolean
  npa_can_audit_deals:    boolean
  npa_can_view_cobranza:  boolean
  npa_can_register_pagos: boolean
  npa_can_approve_deals:  boolean
  npa_can_ajuste_cuadre:  boolean
  npa_can_nota_entrega:   boolean
  npa_can_admin:          boolean
  npa_can_view_crm:       boolean
  // Gobernanza: quién puede marcar un lead como Perdido (candado en DB)
  npa_can_mark_lost:      boolean
  // ── Inventory module (Phase 1) ─────────────────────────────────────────────
  can_view_inventory:               boolean
  can_manage_inventory:             boolean
  npa_can_view_inventory_finance:   boolean
  // ── Management P&L module (/reportes) ──────────────────────────────────────
  npa_can_view_management_pnl: boolean
  // ── Tesoreria module (NEW — Phase 1) ───────────────────────────────────────
  // Mirror the SQL flags in user_permissions
  tesoreria_can_pickup:            boolean
  tesoreria_can_dispatch:          boolean
  tesoreria_can_view_balance:      boolean
  tesoreria_can_replenish_cc:      boolean
  tesoreria_can_confirm_fx:        boolean
  tesoreria_can_request_salida:    boolean
  tesoreria_can_approve_salida:    boolean
  tesoreria_can_register_cc_gasto: boolean
  tesoreria_admin:                 boolean
  // ── Caja Chica arqueo (cash count + adjust) — granular capability so an
  // auditor (e.g. Coraly) can arquear Caja Chica WITHOUT full tesoreria_admin.
  tesoreria_can_arqueo:            boolean
  // ── Caja Chica replenishment REQUEST (petty-cash only; not the general egreso flow)
  tesoreria_can_request_cc_repo:   boolean
  // ── Tesoreria "Register Ingreso" only (NEW — 2026-05-25) ──────────────────
  // Granted to auditoría + asistente roles that just need to log incoming
  // USDT / USD-cash, with no visibility into balances, NPA, or any other module.
  tesoreria_can_register_ingreso:  boolean
  // ── USDT channel (NEW — 2026-05-19) ────────────────────────────────────────
  // Gates the USDT_WALLET source option in the egreso form. Granted to
  // gerencia/admin/manager; never to tesorería.
  can_manage_usdt:                 boolean
}

const ALL_OFF: NPAPermissions = {
  npa_can_view_dashboard: false,
  npa_can_view_clientes:  false,
  npa_can_view_deals:     false,
  npa_can_audit_deals:    false,
  npa_can_view_cobranza:  false,
  npa_can_register_pagos: false,
  npa_can_approve_deals:  false,
  npa_can_ajuste_cuadre:  false,
  npa_can_nota_entrega:   false,
  npa_can_admin:          false,
  npa_can_view_crm:       false,
  npa_can_mark_lost:      false,
  can_view_inventory:             false,
  can_manage_inventory:           false,
  npa_can_view_inventory_finance: false,
  npa_can_view_management_pnl:    false,
  tesoreria_can_pickup:            false,
  tesoreria_can_dispatch:          false,
  tesoreria_can_view_balance:      false,
  tesoreria_can_replenish_cc:      false,
  tesoreria_can_confirm_fx:        false,
  tesoreria_can_request_salida:    false,
  tesoreria_can_approve_salida:    false,
  tesoreria_can_register_cc_gasto: false,
  tesoreria_admin:                 false,
  tesoreria_can_arqueo:            false,
  tesoreria_can_request_cc_repo:   false,
  tesoreria_can_register_ingreso:  false,
  can_manage_usdt:                 false,
}

const ROLE_DEFAULTS: Record<string, NPAPermissions> = {
  administrador: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true, npa_can_view_deals: true,
    npa_can_audit_deals: true, npa_can_view_cobranza: true, npa_can_register_pagos: true,
    npa_can_approve_deals: true, npa_can_ajuste_cuadre: true, npa_can_nota_entrega: true,
    npa_can_admin: true, npa_can_view_crm: true,
    can_view_inventory: true, can_manage_inventory: true, npa_can_view_inventory_finance: true,
    npa_can_view_management_pnl: true,
    tesoreria_can_view_balance: true, tesoreria_can_request_salida: true,
    tesoreria_can_approve_salida: true, tesoreria_can_confirm_fx: true,
    tesoreria_admin: true,
  },
  admin: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true, npa_can_view_deals: true,
    npa_can_audit_deals: true, npa_can_view_cobranza: true, npa_can_register_pagos: true,
    npa_can_approve_deals: true, npa_can_ajuste_cuadre: true, npa_can_nota_entrega: true,
    npa_can_admin: true, npa_can_view_crm: true,
    can_view_inventory: true, can_manage_inventory: true, npa_can_view_inventory_finance: true,
    npa_can_view_management_pnl: true,
    tesoreria_can_view_balance: true, tesoreria_can_request_salida: true,
    tesoreria_can_approve_salida: true, tesoreria_can_confirm_fx: true,
    tesoreria_admin: true,
  },
  manager: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true, npa_can_view_deals: true,
    npa_can_audit_deals: true, npa_can_view_cobranza: true, npa_can_register_pagos: true,
    npa_can_approve_deals: true, npa_can_ajuste_cuadre: true, npa_can_nota_entrega: true,
    npa_can_admin: true, npa_can_view_crm: true,
    can_view_inventory: true, can_manage_inventory: true, npa_can_view_inventory_finance: true,
    npa_can_view_management_pnl: true,
    tesoreria_can_view_balance: true, tesoreria_can_request_salida: true,
    tesoreria_can_approve_salida: true, tesoreria_can_confirm_fx: true,
    tesoreria_admin: true,
  },
  gerente: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true, npa_can_view_deals: true,
    npa_can_audit_deals: true, npa_can_view_cobranza: true, npa_can_register_pagos: true,
    npa_can_approve_deals: true, npa_can_ajuste_cuadre: true, npa_can_nota_entrega: true,
    npa_can_view_crm: true,
    can_view_inventory: true, can_manage_inventory: true, npa_can_view_inventory_finance: true,
    npa_can_view_management_pnl: true,
    tesoreria_can_view_balance: true, tesoreria_can_request_salida: true,
    tesoreria_can_approve_salida: true, tesoreria_can_confirm_fx: true,
    tesoreria_admin: true,
  },
  jefe_ventas: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true, npa_can_view_deals: true,
    npa_can_view_crm: true,
    npa_can_mark_lost: true,
    can_view_inventory: true,
  },
  vendedor: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true,
    npa_can_view_crm: true,
  },
  bdc: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true,
    npa_can_view_crm: true,
  },
  gte_cobranza: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true, npa_can_view_deals: true,
    npa_can_view_cobranza: true, npa_can_register_pagos: true,
    npa_can_ajuste_cuadre: true, npa_can_nota_entrega: true,
  },
  asist_cobranza: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true, npa_can_view_deals: true,
    npa_can_view_cobranza: true, npa_can_register_pagos: true, npa_can_nota_entrega: true,
  },
  asist_admin: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true, npa_can_view_deals: true,
    npa_can_register_pagos: true,
  },
  auditoria: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true, npa_can_view_deals: true,
    npa_can_audit_deals: true, npa_can_view_cobranza: true, npa_can_register_pagos: true,
    npa_can_nota_entrega: true,
    tesoreria_can_view_balance: true, // Deisi sees treasury balances (read-only)
    tesoreria_can_register_ingreso: true, // Deisi registers cash/USDT ingresos
  },
  Auditoria: {
    ...ALL_OFF,
    npa_can_view_dashboard: true, npa_can_view_clientes: true, npa_can_view_deals: true,
    npa_can_audit_deals: true, npa_can_view_cobranza: true, npa_can_register_pagos: true,
    npa_can_nota_entrega: true,
    tesoreria_can_view_balance: true,
    tesoreria_can_register_ingreso: true,
  },
  // Tesoreria-only role: can ONLY register ingresos (USDT + cash). No NPA
  // visibility, no balance, no nav. Lands on /tesoreria/home with a single tile.
  auditoria_ingresos: {
    ...ALL_OFF,
    tesoreria_can_register_ingreso: true,
  },
  inventario: {
    ...ALL_OFF,
    can_view_inventory: true, can_manage_inventory: true,
  },
  // ─── Tesoreria role (Viviana) ─────────────────────────────────────────────
  tesoreria: {
    ...ALL_OFF,
    tesoreria_can_pickup: true,
    tesoreria_can_dispatch: true,
    tesoreria_can_view_balance: true,
    tesoreria_can_replenish_cc: true,
    tesoreria_can_confirm_fx: true,
  },
  // ─── Facturacion role (Angeles — Caja Chica custodian) ────────────────────
  facturacion: {
    ...ALL_OFF,
    tesoreria_can_register_cc_gasto: true,
    tesoreria_can_view_balance: true,
  },
}

export interface NPAAuthState {
  permissions:  NPAPermissions
  role:         string
  loading:      boolean
  /**
   * v6: true ONLY when auth has a real, settled answer — perms+role loaded,
   * OR confirmed no session, OR a hard session error. Page gates MUST key
   * off `ready` (not `!loading`) before any router.replace redirect, so a
   * redirect can never fire on the transient ALL_OFF rehydration window.
   * `loading` is kept as `!ready` for backwards-compat with older pages.
   */
  ready:        boolean
  userId:       string | null
  sessionError: boolean
}

// ── Race a thenable against a timeout. Supabase query builders and getSession
//    can hang indefinitely under multi-tab Web-Lock contention; this guarantees
//    every await either resolves, rejects, or trips the timeout — never hangs.
function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout:' + label)), ms)
    Promise.resolve(p).then(
      v => { clearTimeout(t); resolve(v) },
      e => { clearTimeout(t); reject(e) },
    )
  })
}

export function useNPAPermissions(): NPAAuthState {
  const [permissions,  setPermissions]  = useState<NPAPermissions>(ALL_OFF)
  const [role,         setRole]         = useState<string>('')
  const [ready,        setReady]        = useState(false)
  const [userId,       setUserId]       = useState<string | null>(null)
  const [sessionError, setSessionError] = useState(false)
  // `loading` is now strictly derived — never set independently.
  const loading = !ready

  const fetchTokenRef = useRef(0)
  // True once the gate has reached ANY settled answer at least once. Used to
  // disarm the watchdog and to stop the bootstrap path from overwriting a
  // good result with an error.
  const settledRef = useRef(false)

  useEffect(() => {
    let mounted = true
    const settle = () => { settledRef.current = true }

    // ── WATCHDOG (v7): the gate MUST reach a settled state within 8s, no
    //    matter what. If auth bootstrap hangs — multi-tab Web-Lock contention,
    //    a dead token, or a stalled network — we surface the recoverable
    //    SessionErrorScreen instead of an infinite "Cargando…". Disarmed the
    //    moment any real answer lands.
    const watchdog = setTimeout(() => {
      if (!mounted || settledRef.current) return
      setSessionError(true)
      setReady(true)
      settle()
    }, 8000)

    // ── PROACTIVE BOOTSTRAP (v7): do NOT wait only for the INITIAL_SESSION
    //    event. Under multi-tab lock contention that event can be delayed
    //    indefinitely, which is exactly the "freezes until you reopen the tab"
    //    failure. We read the session ourselves (time-boxed) and load perms
    //    from it. The onAuthStateChange listener below still handles later
    //    refreshes / login / logout, and self-heals this if the lock frees.
    ;(async () => {
      try {
        const { data, error } = await withTimeout(supabase.auth.getSession(), 6000, 'getSession')
        if (!mounted) return
        if (error) throw error
        let sess = data.session
        // getSession hands back a stale (or null) session WITHOUT refreshing
        // it — that's the "Tu sesión expiró" loop: an expired token is trusted,
        // queries 401, and nothing ever calls refresh. Force one refresh when
        // the stored session is missing or already past expiry.
        const expired = !!sess?.expires_at && sess.expires_at * 1000 < Date.now()
        if (!sess || expired) {
          try {
            const r = await withTimeout(supabase.auth.refreshSession(), 6000, 'refreshSession')
            if (r.data?.session) sess = r.data.session
          } catch { /* refresh failed — fall through to the no-session / error path */ }
          if (!mounted) return
        }
        const user = sess?.user ?? null
        if (user) {
          setUserId(user.id)
          await loadWithRetry(user.id, settle)
        } else {
          // Confirmed: no session even after a refresh attempt. Settled answer.
          setUserId(null); setRole(''); setPermissions(ALL_OFF)
          setReady(true); settle()
        }
      } catch {
        // getSession hung or failed. Settle into the recoverable error state
        // so the UI never hangs; the listener will recover when the lock frees.
        if (!mounted || settledRef.current) return
        setSessionError(true); setReady(true); settle()
      }
    })()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return
      const user = session?.user ?? null

      switch (event) {
        case 'INITIAL_SESSION':
        case 'SIGNED_IN': {
          if (user) {
            setUserId(user.id)
            loadWithRetry(user.id, settle)
          } else {
            // Confirmed: no session. This is a real, settled answer.
            setUserId(null)
            setRole('')
            setPermissions(ALL_OFF)
            setReady(true)
            settle()
          }
          break
        }
        case 'TOKEN_REFRESHED': {
          setSessionError(false)
          break
        }
        case 'SIGNED_OUT': {
          setUserId(null)
          setRole('')
          setPermissions(ALL_OFF)
          setReady(true)
          setSessionError(false)
          settle()
          break
        }
        case 'USER_UPDATED': {
          if (user) {
            setUserId(user.id)
            loadWithRetry(user.id, settle)
          }
          break
        }
        default:
          break
      }
    })

    return () => {
      mounted = false
      clearTimeout(watchdog)
      subscription.unsubscribe()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadWithRetry(uid: string, settle: () => void) {
    const myToken = ++fetchTokenRef.current

    const attempt = async (): Promise<boolean> => {
      try {
        const { data: roleRow, error: roleErr } = await withTimeout(
          supabase
            .from('user_roles')
            .select('role')
            .eq('user_id', uid)
            .single(),
          6000, 'user_roles',
        )

        if (myToken !== fetchTokenRef.current) return true
        if (roleErr && roleErr.code !== 'PGRST116') return false

        const userRole = roleRow?.role || 'cliente'

        const { data: perms, error: permErr } = await withTimeout(
          supabase
            .from('user_permissions')
            .select(`
              npa_can_view_dashboard, npa_can_view_clientes, npa_can_view_deals,
              npa_can_audit_deals, npa_can_view_cobranza, npa_can_register_pagos,
              npa_can_approve_deals, npa_can_ajuste_cuadre, npa_can_nota_entrega,
              npa_can_admin, npa_can_view_crm, npa_can_mark_lost,
              can_view_inventory, can_manage_inventory, npa_can_view_inventory_finance,
              npa_can_view_management_pnl,
              tesoreria_can_pickup, tesoreria_can_dispatch, tesoreria_can_view_balance,
              tesoreria_can_replenish_cc, tesoreria_can_confirm_fx,
              tesoreria_can_request_salida, tesoreria_can_approve_salida,
              tesoreria_can_register_cc_gasto, tesoreria_admin, tesoreria_can_arqueo,
              tesoreria_can_request_cc_repo,
              tesoreria_can_register_ingreso,
              can_manage_usdt
            `)
            .eq('user_id', uid)
            .single(),
          6000, 'user_permissions',
        )

        if (myToken !== fetchTokenRef.current) return true
        if (permErr && permErr.code !== 'PGRST116') return false

        setRole(userRole)
        setPermissions(perms ? (perms as NPAPermissions) : (ROLE_DEFAULTS[userRole] ?? ALL_OFF))
        setSessionError(false)
        // ready LAST — guarantees no render sees ready=true with stale perms.
        setReady(true)
        settle()
        return true
      } catch {
        return false
      }
    }

    const ok = await attempt()
    if (ok || myToken !== fetchTokenRef.current) return

    // First attempt failed — most likely an expired JWT (queries 401). Force an
    // explicit token refresh so the retry runs with a fresh token, then retry.
    try { await withTimeout(supabase.auth.refreshSession(), 6000, 'refreshSession') }
    catch { /* refresh failed; retry will fail too and we settle into error */ }
    if (myToken !== fetchTokenRef.current) return

    await new Promise(res => setTimeout(res, 800))
    if (myToken !== fetchTokenRef.current) return

    const ok2 = await attempt()
    if (!ok2 && myToken === fetchTokenRef.current) {
      // Hard failure after retry. This is still a settled answer — gates
      // must render the session-error screen, NOT loop on redirect.
      setSessionError(true)
      setReady(true)
      settle()
    }
  }

  return { permissions, role, loading, ready, userId, sessionError }
}