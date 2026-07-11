// TARGET: autocore-npa/app/components/ServiceWorkerRegister.tsx
"use client";

import { useEffect } from "react";

// Registers the PWA service worker (/sw.js). Mounted once in the root layout,
// so it runs on every page. Idempotent — the browser ignores re-registration of
// the same script URL. PWA is progressive enhancement: any failure is silent and
// the app keeps working exactly as before.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* silent — no SW just means no offline shell / install prompt */
      });
    };

    // Register after full load so it never competes with first paint / hydration.
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}