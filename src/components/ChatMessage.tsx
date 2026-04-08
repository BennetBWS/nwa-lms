"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ChatMessageProps {
  message: ChatMsg;
  theme: any;
}

export default function ChatMessage({ message, theme: T }: ChatMessageProps) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, []);

  const isUser = message.role === "user";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 12,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(12px)",
        transition: "opacity 0.4s cubic-bezier(0.16,1,0.3,1), transform 0.4s cubic-bezier(0.16,1,0.3,1)",
      }}
    >
      {!isUser && (
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #3B82F6, #8B5CF6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            marginRight: 8,
            marginTop: 2,
            boxShadow: "0 0 12px rgba(59,130,246,0.3)",
          }}
        >
          <Sparkles size={14} color="#fff" />
        </div>
      )}
      <div
        style={{
          maxWidth: "80%",
          padding: "10px 14px",
          borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
          background: isUser
            ? "linear-gradient(135deg, #3B82F6, #2563EB)"
            : T.mode === "dark"
              ? "rgba(255,255,255,0.06)"
              : "rgba(0,0,0,0.04)",
          border: isUser ? "none" : `1px solid ${T.glassBorder}`,
          color: isUser ? "#fff" : T.textPrimary,
          fontSize: 13.5,
          lineHeight: 1.6,
          backdropFilter: isUser ? "none" : "blur(12px)",
        }}
      >
        {message.content}
      </div>
    </div>
  );
}

export function TypingIndicator({ theme: T }: { theme: any }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: "50%",
          background: "linear-gradient(135deg, #3B82F6, #8B5CF6)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          boxShadow: "0 0 12px rgba(59,130,246,0.3)",
        }}
      >
        <Sparkles size={14} color="#fff" />
      </div>
      <div
        style={{
          padding: "10px 18px",
          borderRadius: "16px 16px 16px 4px",
          background: T.mode === "dark" ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
          border: `1px solid ${T.glassBorder}`,
          backdropFilter: "blur(12px)",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: T.accent,
              display: "inline-block",
              animation: `nwa-bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
            }}
          />
        ))}
        <style>{`
          @keyframes nwa-bounce {
            0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
            30% { transform: translateY(-6px); opacity: 1; }
          }
        `}</style>
      </div>
    </div>
  );
}
