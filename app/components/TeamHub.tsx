// TARGET: autocore-npa/app/components/TeamHub.tsx
// ═══════════════════════════════════════════════════════════════════════════
// TeamHub — two staff-only surfaces in one drop-in component:
//   1. Novedades  : an updates modal that auto-pops on load with any unread
//                   active updates; each is acknowledged ("Entendido") which
//                   writes a per-user read row. Managers can publish new ones.
//   2. Equipo     : a single-room realtime team chat with an unread badge.
//
// Backend: app_updates / app_update_reads / chat_messages / chat_reads
// (shared Supabase project; staff-only RLS via public.is_staff()).
//
// Anchored BOTTOM-LEFT so it never collides with AIAssistantBubble (which owns
// bottom-right). Visual language matches that bubble: brand red #BB0000, dark
// header #18181B, light panels, #e5e5e5 borders, 60px round FABs.
//
// Clients never render this (returns null unless role is staff). The `app`
// prop drives target_app filtering so an NPA-only update never shows in Portal.
// ═══════════════════════════════════════════════════════════════════════════
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../supabase";
import { useNPAPermissions } from "./useNPAPermissions";

// Race any thenable against a timeout so a stalled supabase-js call (multi-tab
// Web-Lock contention) can never leave a button stuck. Mirrors the guard in
// useNPAPermissions.
function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// ── Design tokens (mirrored from AIAssistantBubble) ────────────────────────
const RED = "#BB0000";
const DARK = "#18181B";
const BORDER = "#e5e5e5";
const PANEL_BG = "#fafafa";
const MUTED = "#71717a";

type AppName = "npa" | "portal";

interface AppUpdate {
  id: string;
  title: string;
  body: string;
  category: string | null;
  target_app: string;
  published_at: string;
  published_by_nombre: string | null;
}

interface ChatMsg {
  id: string;
  sender_id: string;
  sender_nombre: string;
  body: string;
  created_at: string;
}

const CAT_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  fix:     { bg: "#fef3c7", fg: "#92400e", label: "Corrección" },
  feature: { bg: "#dcfce7", fg: "#166534", label: "Novedad" },
  aviso:   { bg: "#e0e7ff", fg: "#3730a3", label: "Aviso" },
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-VE", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function TeamHub({ app = "npa" }: { app?: AppName }) {
  // ── identity ──────────────────────────────────────────────────────────────
  // Delegate session+role to the app's hardened auth hook (proactive bootstrap,
  // onAuthStateChange listener, watchdog, retries) so TeamHub appears right
  // after login without a manual refresh. The hook does NOT expose full_name,
  // so that one field is fetched separately once userId settles.
  const { role, userId, ready } = useNPAPermissions();
  const [fullName, setFullName] = useState<string>("");

  const isStaff = ready && !!role && role.toLowerCase() !== "cliente";
  const isManager = ["admin", "administrador", "manager", "gerente"].includes(role.toLowerCase());

  // ── updates ───────────────────────────────────────────────────────────────
  const [updates, setUpdates] = useState<AppUpdate[]>([]);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const autoOpened = useRef(false);

  // ── compose (manager only) ─────────────────────────────────────────────────
  const [composeOpen, setComposeOpen] = useState(false);
  const [cTitle, setCTitle] = useState("");
  const [cBody, setCBody] = useState("");
  const [cCat, setCCat] = useState("aviso");
  const [cTarget, setCTarget] = useState<"both" | "npa" | "portal">("both");
  const [publishing, setPublishing] = useState(false);

  // ── chat ────────────────────────────────────────────────────────────────--
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const unreadUpdates = updates.filter((u) => !readIds.has(u.id));
  const unreadChat = messages.filter(
    (m) => m.sender_id !== userId && (!lastReadAt || m.created_at > lastReadAt)
  ).length;

  // ── fetch full_name once the hook has settled userId ───────────────────────
  useEffect(() => {
    if (!userId || !isStaff || fullName) return;
    let alive = true;
    (async () => {
      try {
        const { data } = (await withTimeout(
          supabase.from("user_roles").select("full_name, email").eq("user_id", userId).single(),
          6000
        )) as any;
        if (!alive) return;
        const fn = data?.full_name as string | null;
        const email = data?.email as string | null;
        // Defensive: null or email-shaped full_name → fall back to email
        // local-part so a chat bubble is never blank or an address.
        setFullName(fn && !fn.includes("@") ? fn : (email ? email.split("@")[0] : "Usuario"));
      } catch {
        if (alive) setFullName("Usuario");
      }
    })();
    return () => { alive = false; };
  }, [userId, isStaff, fullName]);

  // ── load updates + my reads ──────────────────────────────────────────────-
  const refreshUpdates = useCallback(async (uid: string) => {
    const { data: ups } = await supabase
      .from("app_updates")
      .select("id,title,body,category,target_app,published_at,published_by_nombre")
      .eq("is_active", true)
      .in("target_app", [app, "both"])
      .order("published_at", { ascending: false });
    const { data: reads } = await supabase
      .from("app_update_reads")
      .select("update_id")
      .eq("user_id", uid);
    setUpdates(((ups as AppUpdate[]) || []));
    setReadIds(new Set(((reads as any[]) || []).map((r) => r.update_id)));
  }, [app]);

  useEffect(() => {
    if (userId && isStaff) refreshUpdates(userId);
  }, [userId, isStaff, refreshUpdates]);

  // Auto-open the modal once per mount when there is something unread.
  useEffect(() => {
    if (!autoOpened.current && isStaff && updates.some((u) => !readIds.has(u.id))) {
      setUpdatesOpen(true);
      autoOpened.current = true;
    }
  }, [updates, readIds, isStaff]);

  async function markRead(id: string) {
    if (!userId) return;
    setReadIds((prev) => new Set(prev).add(id)); // optimistic
    // insert-only (PK update_id,user_id); a duplicate just means already read.
    await supabase.from("app_update_reads").insert({ update_id: id, user_id: userId });
  }

  async function publishUpdate() {
    if (!cTitle.trim() || !cBody.trim() || !userId) return;
    setPublishing(true);
    try {
      const { error } = (await withTimeout(
        supabase.from("app_updates").insert({
          title: cTitle.trim(),
          body: cBody.trim(),
          category: cCat,
          target_app: cTarget,
          published_by: userId,
          published_by_nombre: fullName,
        }),
        8000
      )) as any;
      if (error) throw error;
      setCTitle(""); setCBody(""); setComposeOpen(false);
      refreshUpdates(userId);
    } catch (e: any) {
      alert("No se pudo publicar: " + (e?.message === "timeout" ? "tiempo de espera agotado, intenta de nuevo" : (e?.message || "error")));
    } finally {
      setPublishing(false); // never leaves the button stuck on "Publicando…"
    }
  }

  // ── chat: load + realtime ──────────────────────────────────────────────────
  const loadChat = useCallback(async (uid: string) => {
    const { data: msgs } = await supabase
      .from("chat_messages")
      .select("id,sender_id,sender_nombre,body,created_at")
      .order("created_at", { ascending: true })
      .limit(100);
    setMessages(((msgs as ChatMsg[]) || []));
    const { data: cr } = await supabase
      .from("chat_reads")
      .select("last_read_at")
      .eq("user_id", uid)
      .maybeSingle();
    setLastReadAt((cr as any)?.last_read_at ?? null);
  }, []);

  useEffect(() => {
    if (!(userId && isStaff)) return;
    loadChat(userId);
    const ch = supabase
      .channel("teamhub_chat")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload: any) => {
          const m = payload.new as ChatMsg;
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [userId, isStaff, loadChat]);

  useEffect(() => {
    if (chatOpen) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, chatOpen]);

  async function stampRead() {
    if (!userId) return;
    const now = new Date().toISOString();
    setLastReadAt(now); // optimistic — clears badge
    await supabase.from("chat_reads").upsert(
      { user_id: userId, last_read_at: now },
      { onConflict: "user_id" }
    );
  }

  function openChat() { setChatOpen(true); stampRead(); }

  async function send() {
    const body = input.trim();
    if (!body || !userId || sending) return;
    setSending(true);
    try {
      const { error } = (await withTimeout(
        supabase.from("chat_messages").insert({ sender_id: userId, sender_nombre: fullName, body }),
        8000
      )) as any;
      if (error) throw error;
      setInput(""); stampRead();
    } catch (e: any) {
      alert("No se pudo enviar: " + (e?.message === "timeout" ? "tiempo de espera agotado, intenta de nuevo" : (e?.message || "error")));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  // ── render gate: clients & logged-out never see anything ───────────────────
  if (!isStaff) return null;

  return (
    <>
      {/* ── Floating buttons (bottom-LEFT; AI bubble owns bottom-right) ──────── */}
      {!chatOpen && (
        <>
          <button
            onClick={() => setUpdatesOpen(true)}
            title="Novedades"
            aria-label="Novedades"
            style={{
              position: "fixed", bottom: "92px", left: "24px",
              width: "52px", height: "52px", borderRadius: "50%",
              background: DARK, color: "white", border: "none",
              boxShadow: "0 4px 16px rgba(0,0,0,0.25)", cursor: "pointer",
              zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {unreadUpdates.length > 0 && (
              <span style={{
                position: "absolute", top: "-2px", right: "-2px",
                minWidth: "18px", height: "18px", padding: "0 5px",
                borderRadius: "9px", background: RED, color: "white",
                fontSize: "11px", fontWeight: 700, display: "flex",
                alignItems: "center", justifyContent: "center", border: "2px solid white",
              }}>{unreadUpdates.length}</span>
            )}
          </button>

          <button
            onClick={openChat}
            title="Chat del equipo"
            aria-label="Chat del equipo"
            style={{
              position: "fixed", bottom: "24px", left: "24px",
              width: "60px", height: "60px", borderRadius: "50%",
              background: RED, color: "white", border: "none",
              boxShadow: "0 4px 16px rgba(0,0,0,0.25)", cursor: "pointer",
              zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center",
              transition: "transform 0.2s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.08)")}
            onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            {unreadChat > 0 && (
              <span style={{
                position: "absolute", top: "-2px", right: "-2px",
                minWidth: "20px", height: "20px", padding: "0 5px",
                borderRadius: "10px", background: DARK, color: "white",
                fontSize: "11px", fontWeight: 700, display: "flex",
                alignItems: "center", justifyContent: "center", border: "2px solid white",
              }}>{unreadChat > 99 ? "99+" : unreadChat}</span>
            )}
          </button>
        </>
      )}

      {/* ── Chat panel ─────────────────────────────────────────────────────── */}
      {chatOpen && (
        <div style={{
          position: "fixed", bottom: "24px", left: "24px",
          width: "min(420px, calc(100vw - 48px))",
          height: "min(620px, calc(100vh - 48px))",
          background: "white", borderRadius: "16px",
          boxShadow: "0 16px 48px rgba(0,0,0,0.25)", border: `1px solid ${BORDER}`,
          display: "flex", flexDirection: "column", zIndex: 9998, overflow: "hidden",
        }}>
          <div style={{
            background: DARK, color: "white", padding: "14px 16px",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{
                width: "32px", height: "32px", borderRadius: "50%", background: RED,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                </svg>
              </div>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>Chat del equipo</div>
                <div style={{ fontSize: "11px", opacity: 0.7 }}>{messages.length} mensajes</div>
              </div>
            </div>
            <button onClick={() => setChatOpen(false)} title="Cerrar"
              style={{ background: "transparent", border: "none", color: "white", cursor: "pointer", fontSize: "20px", lineHeight: 1, padding: "4px 8px" }}>
              ×
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "16px", background: PANEL_BG }}>
            {messages.length === 0 && (
              <div style={{ color: MUTED, fontSize: "13px", textAlign: "center", padding: "48px 20px" }}>
                Aún no hay mensajes. Escribe el primero.
              </div>
            )}
            {messages.map((m) => {
              const mine = m.sender_id === userId;
              return (
                <div key={m.id} style={{ marginBottom: "12px", display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start" }}>
                  {!mine && (
                    <div style={{ fontSize: "11px", fontWeight: 600, color: RED, marginBottom: "3px", paddingLeft: "4px" }}>
                      {m.sender_nombre}
                    </div>
                  )}
                  <div style={{
                    maxWidth: "78%", padding: "9px 12px", borderRadius: "12px",
                    background: mine ? RED : "white", color: mine ? "white" : DARK,
                    border: mine ? "none" : `1px solid ${BORDER}`,
                    fontSize: "13px", lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word",
                  }}>
                    {m.body}
                  </div>
                  <div style={{ fontSize: "10px", color: MUTED, marginTop: "3px", padding: "0 4px" }}>
                    {fmtDate(m.created_at)}
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>

          <div style={{ padding: "12px", borderTop: `1px solid ${BORDER}`, background: "white", display: "flex", gap: "8px", alignItems: "flex-end" }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Escribe un mensaje..."
              rows={1}
              style={{
                flex: 1, padding: "10px 12px", border: `1px solid ${BORDER}`,
                borderRadius: "8px", fontSize: "13px", resize: "none",
                fontFamily: "inherit", minHeight: "40px", maxHeight: "120px", outline: "none",
              }}
            />
            <button onClick={send} disabled={sending || !input.trim()}
              style={{
                background: sending || !input.trim() ? "#ccc" : RED, color: "white",
                border: "none", padding: "10px 16px", borderRadius: "8px",
                fontSize: "13px", fontWeight: 600, height: "40px",
                cursor: sending || !input.trim() ? "not-allowed" : "pointer",
              }}>
              ➤
            </button>
          </div>
        </div>
      )}

      {/* ── Updates modal (centered overlay) ────────────────────────────────── */}
      {updatesOpen && (
        <div
          onClick={() => setUpdatesOpen(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
            zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center",
            padding: "16px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, calc(100vw - 32px))", maxHeight: "calc(100vh - 64px)",
              background: "white", borderRadius: "16px", overflow: "hidden",
              display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{
              background: DARK, color: "white", padding: "16px 18px",
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div style={{ fontSize: "15px", fontWeight: 600 }}>Novedades del sistema</div>
              <button onClick={() => setUpdatesOpen(false)} title="Cerrar"
                style={{ background: "transparent", border: "none", color: "white", cursor: "pointer", fontSize: "20px", lineHeight: 1, padding: "4px 8px" }}>
                ×
              </button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "16px", background: PANEL_BG }}>
              {isManager && (
                <div style={{ marginBottom: "16px" }}>
                  {!composeOpen ? (
                    <button onClick={() => setComposeOpen(true)}
                      style={{
                        width: "100%", padding: "10px", borderRadius: "8px",
                        border: `1px dashed ${RED}`, background: "white", color: RED,
                        fontSize: "13px", fontWeight: 600, cursor: "pointer",
                      }}>
                      + Publicar actualización
                    </button>
                  ) : (
                    <div style={{ background: "white", border: `1px solid ${BORDER}`, borderRadius: "10px", padding: "14px" }}>
                      <input
                        value={cTitle} onChange={(e) => setCTitle(e.target.value)}
                        placeholder="Título"
                        style={{ width: "100%", padding: "9px 11px", border: `1px solid ${BORDER}`, borderRadius: "7px", fontSize: "13px", marginBottom: "8px", outline: "none", boxSizing: "border-box" }}
                      />
                      <textarea
                        value={cBody} onChange={(e) => setCBody(e.target.value)}
                        placeholder="Descripción del cambio..."
                        rows={4}
                        style={{ width: "100%", padding: "9px 11px", border: `1px solid ${BORDER}`, borderRadius: "7px", fontSize: "13px", marginBottom: "8px", outline: "none", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }}
                      />
                      <div style={{ display: "flex", gap: "8px", marginBottom: "10px", flexWrap: "wrap" }}>
                        <select value={cCat} onChange={(e) => setCCat(e.target.value)}
                          style={{ flex: 1, minWidth: "120px", padding: "8px", border: `1px solid ${BORDER}`, borderRadius: "7px", fontSize: "12px", background: "white" }}>
                          <option value="aviso">Aviso</option>
                          <option value="feature">Novedad</option>
                          <option value="fix">Corrección</option>
                        </select>
                        <select value={cTarget} onChange={(e) => setCTarget(e.target.value as any)}
                          style={{ flex: 1, minWidth: "120px", padding: "8px", border: `1px solid ${BORDER}`, borderRadius: "7px", fontSize: "12px", background: "white" }}>
                          <option value="both">Ambas apps</option>
                          <option value="npa">Solo NPA</option>
                          <option value="portal">Solo Portal</option>
                        </select>
                      </div>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button onClick={publishUpdate} disabled={publishing || !cTitle.trim() || !cBody.trim()}
                          style={{ flex: 1, padding: "9px", borderRadius: "7px", border: "none", background: publishing || !cTitle.trim() || !cBody.trim() ? "#ccc" : RED, color: "white", fontSize: "13px", fontWeight: 600, cursor: publishing ? "not-allowed" : "pointer" }}>
                          {publishing ? "Publicando..." : "Publicar"}
                        </button>
                        <button onClick={() => setComposeOpen(false)}
                          style={{ padding: "9px 14px", borderRadius: "7px", border: `1px solid ${BORDER}`, background: "white", color: MUTED, fontSize: "13px", cursor: "pointer" }}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {updates.length === 0 && (
                <div style={{ color: MUTED, fontSize: "13px", textAlign: "center", padding: "40px 20px" }}>
                  No hay novedades por ahora.
                </div>
              )}

              {updates.map((u) => {
                const read = readIds.has(u.id);
                const cat = CAT_STYLE[u.category || "aviso"] || CAT_STYLE.aviso;
                return (
                  <div key={u.id} style={{
                    background: "white", border: `1px solid ${read ? BORDER : RED}`,
                    borderRadius: "10px", padding: "14px", marginBottom: "10px",
                    opacity: read ? 0.7 : 1,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "10px", background: cat.bg, color: cat.fg, textTransform: "uppercase", letterSpacing: "0.4px" }}>
                        {cat.label}
                      </span>
                      <span style={{ fontSize: "11px", color: MUTED }}>{fmtDate(u.published_at)}</span>
                      {u.published_by_nombre && (
                        <span style={{ fontSize: "11px", color: MUTED }}>· {u.published_by_nombre}</span>
                      )}
                    </div>
                    <div style={{ fontSize: "14px", fontWeight: 700, color: DARK, marginBottom: "4px" }}>{u.title}</div>
                    <div style={{ fontSize: "13px", color: "#3f3f46", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{u.body}</div>
                    {!read ? (
                      <button onClick={() => markRead(u.id)}
                        style={{ marginTop: "10px", padding: "7px 16px", borderRadius: "7px", border: "none", background: RED, color: "white", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                        Entendido
                      </button>
                    ) : (
                      <div style={{ marginTop: "10px", fontSize: "12px", color: "#16a34a", fontWeight: 600 }}>✓ Leído</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}