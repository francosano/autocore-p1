// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/supabase.ts
// Supabase browser client.
//
// auth config:
//   persistSession     — keep the session in localStorage across reloads.
//   autoRefreshToken   — refresh the JWT before it expires.
//   detectSessionInUrl — pick up the session from the magic-link/OAuth hash.
//   lock               — ★ THE multi-tab freeze fix. supabase-js defaults to a
//                        navigator.locks-based lock to serialize token refresh
//                        across tabs. A backgrounded/throttled tab can hold that
//                        lock and stall getSession() and every query in the
//                        ACTIVE tab indefinitely — the "freezes until you reopen
//                        the tab / Tu sesión expiró" bug. This pass-through lock
//                        skips cross-tab coordination entirely. Trade-off: two
//                        tabs may refresh the token at the same time, which
//                        Supabase's refresh-token grace window tolerates.
//
// The watchdog + per-call timeouts in components/useNPAPermissions.ts remain as
// the safety net so the gate can never hang even if a single query stalls.
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://xwyiatmeyonodgncobps.supabase.co'
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || ''

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Pass-through lock — no cross-tab serialization. See header note.
    lock: async (_name: string, _acquireTimeout: number, fn: () => Promise<any>) => fn(),
  },
})