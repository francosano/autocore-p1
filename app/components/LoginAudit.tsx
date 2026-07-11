// TARGET: autocore-p1/app/components/LoginAudit.tsx
// Drop-in: logs one audit event per browser session after login.
// Integration: add <LoginAudit /> inside the root layout body (one line).
// Disabled (no-op) while TENANT.workers.loginAudit is empty.

'use client';

import { useEffect } from 'react';
import { supabase } from '../supabase';
import { TENANT } from '../tenant.config';

const AUDIT_URL = TENANT.workers.loginAudit;
const APP = 'p1';

export default function LoginAudit() {
  useEffect(() => {
    if (!AUDIT_URL) return; // feature disabled until the p1 Worker is deployed
    let cancelled = false;

    async function log() {
      try {
        if (sessionStorage.getItem('ac_login_logged') === '1') return;
        const { data } = await (supabase as any).auth.getSession();
        const token = data?.session?.access_token;
        if (!token || cancelled) return;
        const resp = await fetch(AUDIT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
          },
          body: JSON.stringify({ app: APP, event: 'login' }),
        });
        if (resp.ok) sessionStorage.setItem('ac_login_logged', '1');
      } catch {
        // never block the app on audit failures
      }
    }

    log();
    // Also catch the case where the user logs in after the app loaded.
    const { data: sub } = (supabase as any).auth.onAuthStateChange(
      (event: string) => {
        if (event === 'SIGNED_IN') {
          sessionStorage.removeItem('ac_login_logged');
          log();
        }
        if (event === 'SIGNED_OUT') {
          sessionStorage.removeItem('ac_login_logged');
        }
      }
    );

    return () => {
      cancelled = true;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  return null;
}