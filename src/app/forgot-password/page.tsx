// @ts-nocheck
"use client";

import { useState } from "react";
import Link from "next/link";

const sora = "var(--font-sora), 'Sora', sans-serif";
const zen = "var(--font-zen), 'Zen Kaku Gothic New', sans-serif";
const neon = "#60A5FA";
const noise = `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")`;

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [focusedField, setFocusedField] = useState(null);
  const [hovered, setHovered] = useState(false);

  const handleSubmit = async () => {
    if (!email || loading) return;
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) throw new Error();
      setSent(true);
    } catch {
      setError("エラーが発生しました。もう一度お試しください。");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && email) handleSubmit();
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#060D1B", fontFamily: zen, position: "relative", overflow: "hidden",
    }}>
      <style>{`
        @keyframes neonPulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .neon-input:focus { border-color: ${neon} !important; box-shadow: 0 0 0 3px rgba(96,165,250,0.12), 0 0 20px rgba(96,165,250,0.08) !important; }
        .neon-input::placeholder { color: #334155; }
      `}</style>

      {/* Background */}
      <div style={{ position: "absolute", inset: 0, backgroundImage: noise, backgroundRepeat: "repeat", backgroundSize: "256px", pointerEvents: "none" }} />
      <div style={{ position: "absolute", inset: 0, opacity: 0.025, backgroundImage: `linear-gradient(rgba(96,165,250,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,0.5) 1px, transparent 1px)`, backgroundSize: "60px 60px" }} />
      <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 600, height: 600, borderRadius: "50%", background: `radial-gradient(circle, ${neon}06 0%, transparent 70%)`, filter: "blur(60px)", pointerEvents: "none" }} />

      <div style={{ position: "relative", zIndex: 2, width: "100%", maxWidth: 480, padding: "0 24px" }}>
        <div style={{
          padding: "52px 48px",
          background: "rgba(15,23,42,0.65)",
          backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
          border: `1px solid ${neon}18`,
          borderRadius: 28,
          boxShadow: `0 0 1px ${neon}30, 0 0 40px ${neon}06, 0 8px 32px rgba(0,0,0,0.3)`,
          position: "relative", overflow: "hidden",
          animation: "fadeUp 0.6s cubic-bezier(0.16,1,0.3,1)",
        }}>
          <div style={{ position: "absolute", top: 0, left: "10%", right: "10%", height: 1, background: `linear-gradient(90deg, transparent, ${neon}50, transparent)` }} />

          {/* Logo */}
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <img
              src="https://bennet.global/wp-content/uploads/2026/03/NWA.png"
              alt="NWA"
              style={{ height: 44, width: "auto", objectFit: "contain", filter: "brightness(0) invert(1)", opacity: 0.9 }}
            />
          </div>

          {sent ? (
            /* Success state */
            <div style={{ textAlign: "center" }}>
              <div style={{ width: 56, height: 56, borderRadius: "50%", background: "rgba(96,165,250,0.1)", border: `1px solid ${neon}30`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={neon} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h2 style={{ fontFamily: sora, fontSize: 22, fontWeight: 800, color: "#F1F5F9", margin: "0 0 12px", letterSpacing: "-0.03em" }}>
                メールを送信しました
              </h2>
              <p style={{ fontSize: 14, color: "#64748B", lineHeight: 1.7, margin: "0 0 32px" }}>
                受信トレイを確認してください。<br />
                リンクの有効期限は1時間です。
              </p>
              <Link href="/login" style={{
                display: "inline-block", fontSize: 13, color: neon, textDecoration: "none",
                fontFamily: sora, fontWeight: 600, padding: "10px 20px",
                border: `1px solid ${neon}30`, borderRadius: 10,
                transition: "all 0.2s",
              }}>
                ← ログインに戻る
              </Link>
            </div>
          ) : (
            /* Form state */
            <>
              <div style={{ marginBottom: 32 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: neon, boxShadow: `0 0 8px ${neon}80`, animation: "neonPulse 2s ease-in-out infinite" }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: neon, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: sora }}>Password Reset</span>
                </div>
                <h2 style={{ fontFamily: sora, fontSize: 24, fontWeight: 800, color: "#F1F5F9", margin: "0 0 10px", letterSpacing: "-0.03em" }}>
                  パスワードをリセット
                </h2>
                <p style={{ fontSize: 13, color: "#4B5E7A", lineHeight: 1.6, margin: 0 }}>
                  登録済みのメールアドレスを入力してください
                </p>
              </div>

              {error && (
                <div style={{
                  marginBottom: 20, padding: "12px 16px", borderRadius: 12,
                  background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
                  color: "#F87171", fontSize: 13, fontWeight: 500,
                }}>
                  {error}
                </div>
              )}

              <div style={{ marginBottom: 28 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", fontFamily: sora, display: "block", marginBottom: 8, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                  メールアドレス
                </label>
                <div style={{ position: "relative" }}>
                  <div style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: focusedField === "email" ? neon : "#334155", transition: "color 0.2s" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <rect x="2" y="4" width="20" height="16" rx="2" /><path d="M22 7l-10 6L2 7" />
                    </svg>
                  </div>
                  <input
                    className="neon-input"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="you@example.com"
                    onFocus={() => setFocusedField("email")}
                    onBlur={() => setFocusedField(null)}
                    style={{
                      width: "100%", padding: "14px 16px 14px 44px", borderRadius: 14, fontSize: 14,
                      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
                      color: "#F1F5F9", outline: "none", fontFamily: sora,
                      transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)", boxSizing: "border-box",
                    }}
                  />
                </div>
              </div>

              <button
                onClick={handleSubmit}
                disabled={loading || !email}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                style={{
                  width: "100%", padding: "15px 0", borderRadius: 14, border: "none", fontSize: 15, fontWeight: 700,
                  cursor: (loading || !email) ? "not-allowed" : "pointer", fontFamily: sora, letterSpacing: "-0.01em",
                  background: !email ? "rgba(96,165,250,0.3)" : hovered ? "linear-gradient(135deg, #3B82F6, #2563EB)" : "linear-gradient(135deg, #60A5FA, #3B82F6)",
                  color: "#fff",
                  opacity: !email ? 0.5 : 1,
                  boxShadow: hovered && email ? `0 0 0 1px ${neon}40, 0 4px 20px ${neon}40` : `0 4px 16px ${neon}25`,
                  transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)",
                  transform: hovered && email ? "translateY(-2px)" : "none",
                  marginBottom: 24,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
                  {loading && <div style={{ width: 18, height: 18, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />}
                  {loading ? "送信中..." : "リセットリンクを送信"}
                </span>
              </button>

              <div style={{ textAlign: "center" }}>
                <Link href="/login" style={{
                  fontSize: 12, color: "#475569", textDecoration: "none", fontFamily: sora, fontWeight: 500,
                  transition: "color 0.2s",
                }}
                  onMouseEnter={e => { e.currentTarget.style.color = neon; }}
                  onMouseLeave={e => { e.currentTarget.style.color = "#475569"; }}
                >
                  ← ログインに戻る
                </Link>
              </div>
            </>
          )}

          <div style={{ position: "absolute", bottom: 0, left: "15%", right: "15%", height: 1, background: `linear-gradient(90deg, transparent, ${neon}30, transparent)` }} />
        </div>
      </div>
    </div>
  );
}
