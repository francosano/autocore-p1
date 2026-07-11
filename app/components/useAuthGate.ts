// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/components/useAuthGate.ts
// v1 (2026-05-19) — browser-back freeze fix (Layer 2 of 3).
//
// Centralizes page-gate logic so no page can reintroduce the redirect-loop
// bug. Wraps useNPAPermissions and returns a single discriminated status:
//
//   'loading'   → auth not settled yet. Render a spinner. NEVER redirect.
//   'denied'    → auth settled, user lacks the permission. Safe to redirect.
//   'error'     → hard session failure. Render the SessionErrorScreen.
//   'ok'        → settled + permitted. Render the page.
//
// The freeze happened because pages redirected while status was effectively
// 'loading' (perms still ALL_OFF). By forcing every gate through this helper,
// a redirect can ONLY fire on a real 'denied' — never on the transient
// rehydration window after a browser-back.
//
// USAGE (in a page component):
//   const gate = useAuthGate(p => p.npa_can_view_crm)
//   useEffect(() => {
//     if (gate.status === 'denied') router.replace('/dashboard')
//   }, [gate.status])
//   if (gate.status === 'loading') return <GateLoading />
//   if (gate.status === 'error')   return <SessionErrorScreen />
//   if (gate.status !== 'ok')      return null   // denied → redirect in flight
//   // ... render the page, gate.permissions / gate.userId available
// ═══════════════════════════════════════════════════════════════════════════
'use client'

import { useNPAPermissions, type NPAPermissions } from './useNPAPermissions'

export type GateStatus = 'loading' | 'denied' | 'error' | 'ok'

export interface AuthGate {
  status:      GateStatus
  permissions: NPAPermissions
  role:        string
  userId:      string | null
}

/**
 * @param predicate  receives the permissions object, returns true if the
 *                   current user is allowed on this page. Pass `() => true`
 *                   for pages that only require *any* authenticated session.
 */
export function useAuthGate(
  predicate: (p: NPAPermissions, role: string) => boolean
): AuthGate {
  const { permissions, role, ready, sessionError, userId } = useNPAPermissions()

  let status: GateStatus
  if (!ready) {
    // Auth not settled. This is the window the back-button freeze lived in —
    // callers MUST treat this as 'loading' and never redirect.
    status = 'loading'
  } else if (sessionError) {
    // Retry exhausted — token dead or network down. Show the error screen,
    // do NOT redirect (redirecting just loops into another dead gate).
    status = 'error'
  } else if (!userId) {
    // Settled, but no session at all. Treat as denied — the caller redirects
    // to a public route (or login).
    status = 'denied'
  } else if (!predicate(permissions, role)) {
    // Settled, real session, but lacks the permission. A genuine denial.
    status = 'denied'
  } else {
    status = 'ok'
  }

  return { status, permissions, role, userId }
}