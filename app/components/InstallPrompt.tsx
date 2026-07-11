// TARGET: autocore-npa/app/components/InstallPrompt.tsx
"use client";

import { useEffect, useState, type CSSProperties } from "react";

// Slim, dismissible "Instalar app" banner aimed at asesores on Android/Chrome.
// Shows only when the browser fires `beforeinstallprompt` (installable + not yet
// installed). iOS Safari has no such event — those users install via Share →
// "Añadir a inicio". A dismissal is remembered for 14 days so it never nags.
//
// Optional: if the floating UI ever feels crowded (AI bubble + TeamHub already
// live in the corner), it can be removed by deleting its import + tag in
// layout.tsx with zero other impact.

const DISMISS_KEY = "ac_install_dismissed_until";
const DISMISS_DAYS = 14;

type BIPEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Already installed (standalone display) → never show.
    const standalone =
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(display-mode: standalone)").matches) ||
      // iOS Safari legacy flag
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) return;

    // Respect a recent dismissal.
    try {
      const until = Number(localStorage.getItem(DISMISS_KEY) || 0);
      if (until && Date.now() < until) return;
    } catch {
      /* localStorage blocked — just proceed */
    }

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BIPEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* user closed the native prompt */
    }
    setVisible(false);
    setDeferred(null);
  };

  const dismiss = () => {
    try {
      localStorage.setItem(
        DISMISS_KEY,
        String(Date.now() + DISMISS_DAYS * 864e5)
      );
    } catch {
      /* ignore */
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div style={wrap} role="dialog" aria-label="Instalar AutoCore">
      <div style={textCol}>
        <div style={title}>Instala AutoCore en tu teléfono</div>
        <div style={sub}>Acceso directo, pantalla completa y carga más rápida.</div>
      </div>
      <div style={btnRow}>
        <button onClick={dismiss} style={btnGhost} type="button">
          Ahora no
        </button>
        <button onClick={install} style={btnPrimary} type="button">
          Instalar
        </button>
      </div>
    </div>
  );
}

const wrap: CSSProperties = {
  position: "fixed",
  left: "50%",
  transform: "translateX(-50%)",
  bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
  zIndex: 9999,
  width: "min(440px, calc(100vw - 24px))",
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 14px",
  background: "var(--bg-card, #11151D)",
  border: "1px solid var(--border, #232A37)",
  borderRadius: 14,
  boxShadow: "var(--shadow-card, 0 8px 24px rgba(0,0,0,0.45))",
  fontFamily: "var(--font-inter), system-ui, sans-serif",
};
const textCol: CSSProperties = { flex: 1, minWidth: 0 };
const title: CSSProperties = {
  color: "var(--text-primary, #EAEDF2)",
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.2,
};
const sub: CSSProperties = {
  color: "var(--text-muted, #7B8694)",
  fontSize: 12,
  marginTop: 2,
};
const btnRow: CSSProperties = { display: "flex", gap: 8, flexShrink: 0 };
const btnGhost: CSSProperties = {
  background: "transparent",
  color: "var(--text-secondary, #AEB6C2)",
  border: "1px solid var(--border, #232A37)",
  borderRadius: 9,
  padding: "8px 12px",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};
const btnPrimary: CSSProperties = {
  background: "var(--accent-solid, #3B6FE0)",
  color: "#fff",
  border: "1px solid var(--accent-solid, #3B6FE0)",
  borderRadius: 9,
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};