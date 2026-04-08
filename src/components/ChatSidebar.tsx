// @ts-nocheck
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Sparkles, Send, X, MessageSquare } from "lucide-react";
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

interface ChatSidebarProps {
  theme: any;
}

export default function ChatSidebar({ theme: T }: ChatSidebarProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading, scrollToBottom]);

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
      {/* FAB toggle button — desktop only, hidden when sidebar open */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="nwa-chat-toggle"
          style={{
            position: "fixed",
            right: 24,
            bottom: 24,
            zIndex: 160,
            width: 48,
            height: 48,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #3B82F6, #8B5CF6)",
            border: "none",
            cursor: "pointer",
            display: "flex",
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
          <MessageSquare size={20} />
        </button>
      )}

      {/* Sidebar panel */}
      <div
        className="nwa-chat-sidebar"
        style={{
          position: "fixed",
          right: 0,
          top: 0,
          bottom: 0,
          width: 360,
          zIndex: 155,
          display: "flex",
          flexDirection: "column",
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.35s cubic-bezier(0.16,1,0.3,1)",
          background: T.mode === "dark"
            ? "rgba(11,17,32,0.92)"
            : "rgba(244,247,251,0.92)",
          backdropFilter: "blur(24px) saturate(1.4)",
          borderLeft: `1px solid ${T.glassBorder}`,
          boxShadow: open ? "-8px 0 40px rgba(0,0,0,0.2)" : "none",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 18px",
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
            <div style={{ fontWeight: 700, fontSize: 14, color: T.textPrimary, letterSpacing: "-0.01em" }}>
              AI 学習アシスタント
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>
              なんでも聞いてね
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: T.textMuted,
              padding: 4,
              display: "flex",
              borderRadius: 6,
            }}
          >
            <X size={18} />
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

          {/* Sample questions */}
          {showSuggestions && !loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {SAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => handleSend(q)}
                  style={{
                    padding: "9px 14px",
                    borderRadius: 12,
                    background: T.mode === "dark" ? "rgba(59,130,246,0.1)" : "rgba(59,130,246,0.06)",
                    border: `1px solid ${T.mode === "dark" ? "rgba(59,130,246,0.2)" : "rgba(59,130,246,0.15)"}`,
                    color: T.accent,
                    fontSize: 13,
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 0.2s, transform 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = T.mode === "dark" ? "rgba(59,130,246,0.18)" : "rgba(59,130,246,0.12)";
                    e.currentTarget.style.transform = "translateX(4px)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = T.mode === "dark" ? "rgba(59,130,246,0.1)" : "rgba(59,130,246,0.06)";
                    e.currentTarget.style.transform = "translateX(0)";
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
              ref={inputRef}
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
                fontSize: 13.5,
                lineHeight: 1.5,
                maxHeight: 100,
                fontFamily: "inherit",
              }}
            />
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || loading}
              style={{
                width: 34,
                height: 34,
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
                transition: "background 0.2s, transform 0.15s",
              }}
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .nwa-chat-toggle,
          .nwa-chat-sidebar {
            display: none !important;
          }
        }
      `}</style>
    </>
  );
}
