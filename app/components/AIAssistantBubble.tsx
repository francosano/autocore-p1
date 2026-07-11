"use client";

import { useState, useEffect, useRef } from "react";
import { supabase } from "../supabase";

const WORKER_URL = "https://autocore-ai-assistant.sano-franco.workers.dev";

// Lightweight markdown renderer — handles bold, bullets, headers, code
// Intentionally strips pipe tables (they look terrible in narrow chat)
function renderMarkdown(text: string): string {
  if (!text) return "";

  // Escape HTML first to prevent injection
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Strip markdown table syntax (keep content, drop pipes)
  html = html.replace(/^\|.*\|$/gm, (line) => {
    // Skip separator rows like |---|---|
    if (/^\|[\s|:-]+\|$/.test(line)) return "";
    // Convert remaining pipe rows to bullet-style
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    return "• " + cells.join(" — ");
  });

  // Headers → bold (avoid visual noise from big headers in chat)
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<strong style="display:block;margin:8px 0 4px;color:#18181B">$1</strong>');

  // Bold **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italic *text* (but not standalone *)
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");

  // Inline code `text`
  html = html.replace(/`([^`]+)`/g, '<code style="background:#f4f4f5;padding:1px 5px;border-radius:3px;font-size:12px;font-family:monospace">$1</code>');

  // Bullets: lines starting with - or • or *
  html = html.replace(/^[\s]*[-•*]\s+(.+)$/gm, '<div style="padding-left:12px;position:relative"><span style="position:absolute;left:0;color:#BB0000">•</span> $1</div>');

  // Clean up multiple blank lines
  html = html.replace(/\n{3,}/g, "\n\n");

  // Convert line breaks to <br>, but only single ones (preserve paragraphs)
  html = html.replace(/\n/g, "<br>");

  return html;
}


interface Message {
  role: "user" | "assistant";
  content: string;
  tool_calls?: any[];
  created_at?: string;
}

interface Conversation {
  id: string;
  titulo: string;
  created_at: string;
  updated_at: string;
}

export default function AIAssistantBubble() {
  const [isAllowed, setIsAllowed] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Check user role on mount
  useEffect(() => {
    checkUserRole();
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function checkUserRole() {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.email) return;

      const { data, error } = await supabase
        .from("user_roles")
        .select("role, email")
        .eq("email", user.email)
        .single();

      if (error || !data) return;

      setUserEmail(user.email);
      setUserRole(data.role);

      // Only admin and manager can use the assistant
      if (data.role === "admin" || data.role === "manager") {
        setIsAllowed(true);
      }
    } catch (err) {
      console.error("Role check failed:", err);
    }
  }

  async function loadConversations() {
    if (!userEmail) return;
    try {
      const res = await fetch(
        `${WORKER_URL}/conversations?user_email=${encodeURIComponent(userEmail)}`
      );
      const data = await res.json();
      setConversations(data.conversations || []);
    } catch (err) {
      console.error("Failed to load conversations:", err);
    }
  }

  async function loadMessages(convId: string) {
    try {
      const res = await fetch(`${WORKER_URL}/messages?conversation_id=${convId}`);
      const data = await res.json();
      const loaded = (data.messages || []).map((m: any) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls,
        created_at: m.created_at,
      }));
      setMessages(loaded);
      setCurrentConvId(convId);
      setShowHistory(false);
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }

  async function sendMessage() {
    if (!input.trim() || isLoading || !userEmail || !userRole) return;

    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setIsLoading(true);

    try {
      const res = await fetch(`${WORKER_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: currentConvId,
          user_message: userMsg,
          user_email: userEmail,
          user_role: userRole,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Error desconocido");
      }

      const data = await res.json();
      setCurrentConvId(data.conversation_id);

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.response,
          tool_calls: data.tool_calls,
        },
      ]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${err.message}`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  function startNewConversation() {
    setCurrentConvId(null);
    setMessages([]);
    setShowHistory(false);
  }

  async function deleteConversation(convId: string) {
    if (!confirm("¿Eliminar esta conversación?")) return;
    try {
      await fetch(`${WORKER_URL}/conversations/${convId}`, { method: "DELETE" });
      await loadConversations();
      if (convId === currentConvId) {
        startNewConversation();
      }
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // Don't render anything if user isn't allowed
  if (!isAllowed) return null;

  return (
    <>
      {/* Floating button */}
      {!isOpen && (
        <button
          onClick={() => {
            setIsOpen(true);
            loadConversations();
          }}
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            width: "60px",
            height: "60px",
            borderRadius: "50%",
            background: "#BB0000",
            color: "white",
            border: "none",
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            cursor: "pointer",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "24px",
            transition: "transform 0.2s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.1)")}
          onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
          aria-label="Abrir Asistente IA"
          title="Asistente IA"
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            <circle cx="8.5" cy="10" r="1" fill="currentColor"/>
            <circle cx="12" cy="10" r="1" fill="currentColor"/>
            <circle cx="15.5" cy="10" r="1" fill="currentColor"/>
          </svg>
        </button>
      )}

      {/* Chat panel */}
      {isOpen && (
        <div
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            width: "min(440px, calc(100vw - 48px))",
            height: "min(640px, calc(100vh - 48px))",
            background: "white",
            borderRadius: "16px",
            boxShadow: "0 16px 48px rgba(0,0,0,0.25)",
            display: "flex",
            flexDirection: "column",
            zIndex: 9999,
            overflow: "hidden",
            border: "1px solid #e5e5e5",
          }}
        >
          {/* Header */}
          <div
            style={{
              background: "#18181B",
              color: "white",
              padding: "14px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "#BB0000",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "14px",
                  fontWeight: "bold",
                }}
              >
                IA
              </div>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>Asistente AutoCore</div>
                <div style={{ fontSize: "11px", opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  {userRole === "admin" ? "Admin" : "Manager"}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setShowHistory(!showHistory)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "white",
                  cursor: "pointer",
                  padding: "4px 8px",
                  fontSize: "12px",
                }}
                title="Historial"
              >
                📋
              </button>
              <button
                onClick={startNewConversation}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "white",
                  cursor: "pointer",
                  padding: "4px 8px",
                  fontSize: "12px",
                }}
                title="Nueva conversación"
              >
                ➕
              </button>
              <button
                onClick={() => setIsOpen(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "white",
                  cursor: "pointer",
                  padding: "4px 8px",
                  fontSize: "18px",
                  lineHeight: 1,
                }}
                title="Cerrar"
              >
                ×
              </button>
            </div>
          </div>

          {/* History panel (slides in from left) */}
          {showHistory && (
            <div
              style={{
                position: "absolute",
                top: "60px",
                left: 0,
                right: 0,
                bottom: 0,
                background: "#fafafa",
                padding: "12px",
                overflowY: "auto",
                zIndex: 10,
              }}
            >
              <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px", color: "#666", marginBottom: "8px" }}>
                Conversaciones
              </div>
              {conversations.length === 0 && (
                <div style={{ fontSize: "13px", color: "#999", padding: "20px", textAlign: "center" }}>
                  No hay conversaciones
                </div>
              )}
              {conversations.map((c) => (
                <div
                  key={c.id}
                  style={{
                    padding: "10px 12px",
                    background: c.id === currentConvId ? "#fee2e2" : "white",
                    borderRadius: "8px",
                    marginBottom: "6px",
                    cursor: "pointer",
                    border: "1px solid #e5e5e5",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                  onClick={() => loadMessages(c.id)}
                >
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    <div style={{ fontSize: "13px", fontWeight: 500, color: "#18181B", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {c.titulo}
                    </div>
                    <div style={{ fontSize: "11px", color: "#999", marginTop: "2px" }}>
                      {new Date(c.updated_at).toLocaleDateString("es-VE")}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(c.id);
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#999",
                      cursor: "pointer",
                      padding: "4px",
                      fontSize: "14px",
                    }}
                    title="Eliminar"
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Messages */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "16px",
              background: "#fafafa",
            }}
          >
            {messages.length === 0 && (
              <div style={{ color: "#666", fontSize: "13px", textAlign: "center", padding: "40px 20px" }}>
                <div style={{ fontSize: "36px", marginBottom: "12px" }}>💬</div>
                <div style={{ fontWeight: 600, color: "#18181B", marginBottom: "8px" }}>
                  Hola{userEmail ? `, ${userEmail.split("@")[0]}` : ""}
                </div>
                <div style={{ fontSize: "12px", lineHeight: 1.5 }}>
                  Pregúntame sobre ventas, clientes, préstamos, cobranza, CRM.
                  <br /><br />
                  <span style={{ color: "#BB0000", fontWeight: 500 }}>Ejemplos:</span>
                  <div style={{ textAlign: "left", marginTop: "8px", fontSize: "11px", background: "white", padding: "10px", borderRadius: "6px", border: "1px solid #e5e5e5" }}>
                    • "¿Cuántos vehículos vendimos este mes?"<br />
                    • "Dame el historial de pagos de Christian Suarez"<br />
                    • "Cuáles préstamos están vencidos"<br />
                    • "Envía reporte de ventas a beto@motocentro2.com"
                  </div>
                </div>
              </div>
            )}

            {messages.map((m, idx) => (
              <div
                key={idx}
                style={{
                  marginBottom: "12px",
                  display: "flex",
                  justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    maxWidth: "85%",
                    padding: "10px 14px",
                    borderRadius: "12px",
                    background: m.role === "user" ? "#BB0000" : "white",
                    color: m.role === "user" ? "white" : "#18181B",
                    fontSize: "13px",
                    lineHeight: 1.5,
                    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                    border: m.role === "assistant" ? "1px solid #e5e5e5" : "none",
                  }}
                >
                  {m.tool_calls && m.tool_calls.length > 0 && (
                    <div style={{ fontSize: "10px", color: "#666", marginBottom: "6px", fontStyle: "italic" }}>
                      {m.tool_calls.map((t: any, i: number) => (
                        <div key={i}>
                          {t.tool === "query_database" && "🔍 "}
                          {t.tool === "get_schema" && "📋 "}
                          {t.tool === "send_email_report" && "📧 "}
                          {t.tool === "get_current_context" && "🕐 "}
                          {t.input?.explanation || t.tool}
                        </div>
                      ))}
                    </div>
                  )}
                  <div
                    style={{ whiteSpace: "pre-wrap" }}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                  />
                </div>
              </div>
            ))}

            {isLoading && (
              <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: "12px" }}>
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "12px",
                    background: "white",
                    fontSize: "13px",
                    color: "#666",
                    border: "1px solid #e5e5e5",
                  }}
                >
                  <span style={{ display: "inline-block", animation: "pulse 1.4s infinite" }}>● ● ●</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div
            style={{
              padding: "12px",
              borderTop: "1px solid #e5e5e5",
              background: "white",
              display: "flex",
              gap: "8px",
              alignItems: "flex-end",
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Pregunta algo..."
              disabled={isLoading}
              style={{
                flex: 1,
                padding: "10px 12px",
                border: "1px solid #e5e5e5",
                borderRadius: "8px",
                fontSize: "13px",
                resize: "none",
                fontFamily: "inherit",
                minHeight: "40px",
                maxHeight: "120px",
                outline: "none",
              }}
              rows={1}
            />
            <button
              onClick={sendMessage}
              disabled={isLoading || !input.trim()}
              style={{
                background: isLoading || !input.trim() ? "#ccc" : "#BB0000",
                color: "white",
                border: "none",
                padding: "10px 16px",
                borderRadius: "8px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: isLoading || !input.trim() ? "not-allowed" : "pointer",
                height: "40px",
              }}
            >
              ➤
            </button>
          </div>
        </div>
      )}

      <style jsx>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }
      `}</style>
    </>
  );
}