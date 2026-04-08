// @ts-nocheck
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Sparkles, Send, X } from "lucide-react";
import ChatMessage, { ChatMsg, TypingIndicator } from "./ChatMessage";
import { sendChatMessage } from "@/lib/chat-mock";

const INITIAL_MESSAGE: ChatMsg = {
  id: "welcome",
  role: "assistant",
  content: "こんにちは！NWAの AI 学習アシスタントです 🚀\nWeb制作の質問やコードの相談、なんでも気軽に聞いてください！",
};

const SAMPLE_QUESTIONS = [
  "Flexboxの使い方を教えて",
  "JavaScriptのforループの書き方は？",
  "レスポンシブデザインのコツは？",
];

interface ChatMobileProps {
  theme: any;
}

export default function ChatMobile({ theme: T }: ChatMobileProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading, scrollToBottom]);

  // Prevent body scroll when modal open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const handleSend = useCallback(async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;

    const userMsg: ChatMsg = { id: Date.now().toString(), role: "user", content: msg };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const reply = await sendChatMessage(msg);
      const aiMsg: ChatMsg = { id: (Date.now() + 1).toString(), role: "assistant", content: reply };
      setMessages((prev) => [...prev, aiMsg]);
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const showSuggestions = messages.length === 1;

  return (
    <>
      {/* FAB button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="nwa-chat-fab"
          style={{
            position: "fixed",
            right: 20,
            bottom: 20,
            zIndex: 300,
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #3B82F6, #8B5CF6)",
            border: "none",
            cursor: "pointer",
            display: "none",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            boxShadow: "0 4px 24px rgba(59,130,246,0.45), 0 0 30px rgba(139,92,246,0.25)",
            transition: "transform 0.2s, box-shadow 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "scale(1.1)";
            e.currentTarget.style.boxShadow = "0 6px 32px rgba(59,130,246,0.55), 0 0 40px rgba(139,92,246,0.35)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
            e.currentTarget.style.boxShadow = "0 4px 24px rgba(59,130,246,0.45), 0 0 30px rgba(139,92,246,0.25)";
          }}
        >
          <Sparkles size={24} />
        </button>
      )}

      {/* Fullscreen modal */}
      {open && (
        <div
          className="nwa-chat-modal"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 310,
            display: "none",
            flexDirection: "column",
            background: T.mode === "dark"
              ? "rgba(11,17,32,0.97)"
              : "rgba(244,247,251,0.97)",
            backdropFilter: "blur(24px) saturate(1.4)",
            animation: "nwa-modal-in 0.3s cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "12px 16px",
              borderBottom: `1px solid ${T.glassBorder}`,
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                background: "linear-gradient(135deg, #3B82F6, #8B5CF6)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 0 16px rgba(59,130,246,0.35)",
              }}
            >
              <Sparkles size={17} color="#fff" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: T.textPrimary }}>
                AI 学習アシスタント
              </div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>
                なんでも聞いてね
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: T.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                border: "none",
                cursor: "pointer",
                color: T.textPrimary,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <X size={20} />
            </button>
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "16px 14px",
              scrollBehavior: "smooth",
            }}
          >
            {messages.map((m) => (
              <ChatMessage key={m.id} message={m} theme={T} />
            ))}
            {loading && <TypingIndicator theme={T} />}

            {showSuggestions && !loading && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                {SAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => handleSend(q)}
                    style={{
                      padding: "11px 14px",
                      borderRadius: 12,
                      background: T.mode === "dark" ? "rgba(59,130,246,0.1)" : "rgba(59,130,246,0.06)",
                      border: `1px solid ${T.mode === "dark" ? "rgba(59,130,246,0.2)" : "rgba(59,130,246,0.15)"}`,
                      color: T.accent,
                      fontSize: 14,
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "background 0.2s",
                    }}
                  >
                    💬 {q}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Input */}
          <div
            style={{
              padding: "12px 14px",
              paddingBottom: "max(12px, env(safe-area-inset-bottom))",
              borderTop: `1px solid ${T.glassBorder}`,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 8,
                background: T.mode === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
                borderRadius: 14,
                border: `1px solid ${T.glassBorder}`,
                padding: "8px 10px",
              }}
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="質問を入力..."
                rows={1}
                style={{
                  flex: 1,
                  background: "none",
                  border: "none",
                  outline: "none",
                  resize: "none",
                  color: T.textPrimary,
                  fontSize: 15,
                  lineHeight: 1.5,
                  maxHeight: 100,
                  fontFamily: "inherit",
                }}
              />
              <button
                onClick={() => handleSend()}
                disabled={!input.trim() || loading}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: input.trim() && !loading
                    ? "linear-gradient(135deg, #3B82F6, #2563EB)"
                    : T.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
                  border: "none",
                  cursor: input.trim() && !loading ? "pointer" : "default",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: input.trim() && !loading ? "#fff" : T.textMuted,
                  flexShrink: 0,
                }}
              >
                <Send size={17} />
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes nwa-modal-in {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (max-width: 768px) {
          .nwa-chat-fab {
            display: flex !important;
          }
          .nwa-chat-modal {
            display: flex !important;
          }
        }
      `}</style>
    </>
  );
}
