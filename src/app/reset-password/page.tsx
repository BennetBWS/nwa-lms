// @ts-nocheck
"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Lock } from "lucide-react";

const sora = "var(--font-sora), 'Sora', sans-serif";
const zen = "var(--font-zen), 'Zen Kaku Gothic New', sans-serif";
const neon = "#60A5FA";
const noise = `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")`;

export default function ResetPasswordPageWrapper() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#060D1B" }} />}>
      <ResetPasswordPage />
    </Suspense>
  );
}

function ResetPasswordPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [status, setStatus] = useState<"loading" | "invalid" | "form" | "success">("loading");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [focusedField, setFocusedField] = useState(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus("invalid");
      return;
    }
    fetch(`/api/auth/verify-reset-token?token=${token}`)
      .then(r => r.json())
      .then(data => setStatus(data.valid ? "form" : "invalid"))
      .catch(() => setStatus("invalid"));
  }, [token]);

  const handleSubmit = async () => {
    setError("");
    if (newPassword.length < 8) {
      setError("パスワードは8文字以上で入力してください");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("パスワードが一致しません");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "エラーが発生しました");
      setStatus("success");
    } catch (e: any) {
      setError(e.message || "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && newPassword && confirmPassword) handleSubmit();
  };

  const canSubmit = newPassword.length >= 8 && newPassword === confirmPassword;

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

          {status === "loading" && (
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <div style={{ width: 32, height: 32, border: `2px solid ${neon}30`, borderTopColor: neon, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 16px" }} />
              <p style={{ color: "#64748B", fontSize: 14 }}>確認中...</p>
            </div>
          )}

          {status === "invalid" && (
            <div style={{ textAlign: "center" }}>
              <div style={{ width: 56, height: 56, borderRadius: "50%", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#F87171" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </div>
              <h2 style={{ fontFamily: sora, fontSize: 22, fontWeight: 800, color: "#F1F5F9", margin: "0 0 12px" }}>
                リンクが無効です
              </h2>
              <p style={{ fontSize: 14, color: "#64748B", lineHeight: 1.7, margin: "0 0 32px" }}>
                このリンクは期限切れか、すでに使用済みです。<br />
                再度リセットを申請してください。
              </p>
              <Link href="/forgot-password" style={{
                display: "inline-block", fontSize: 13, color: neon, textDecoration: "none",
                fontFamily: sora, fontWeight: 600, padding: "10px 20px",
                border: `1px solid ${neon}30`, borderRadius: 10,
                marginBottom: 16,
              }}>
                再送信する
              </Link>
              <div>
                <Link href="/login" style={{ fontSize: 12, color: "#475569", textDecoration: "none", fontFamily: sora }}>
                  ← ログインに戻る
                </Link>
              </div>
            </div>
          )}

          {status === "form" && (
            <>
              <div style={{ marginBottom: 32 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: neon, boxShadow: `0 0 8px ${neon}80`, animation: "neonPulse 2s ease-in-out infinite" }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: neon, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: sora }}>New Password</span>
                </div>
                <h2 style={{ fontFamily: sora, fontSize: 24, fontWeight: 800, color: "#F1F5F9", margin: "0 0 10px", letterSpacing: "-0.03em" }}>
                  新しいパスワードを設定
                </h2>
                <p style={{ fontSize: 13, color: "#4B5E7A", lineHeight: 1.6, margin: 0 }}>
                  8文字以上のパスワードを入力してください
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

              {/* New password */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", fontFamily: sora, display: "block", marginBottom: 8, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                  新しいパスワード
                </label>
                <div style={{ position: "relative" }}>
                  <div style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: focusedField === "new" ? neon : "#334155", transition: "color 0.2s" }}>
                    <Lock size={16} />
                  </div>
                  <input
                    className="neon-input"
                    type={showNew ? "text" : "password"}
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="••••••••"
                    onFocus={() => setFocusedField("new")}
                    onBlur={() => setFocusedField(null)}
                    style={{
                      width: "100%", padding: "14px 48px 14px 44px", borderRadius: 14, fontSize: 14,
                      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
                      color: "#F1F5F9", outline: "none", fontFamily: sora,
                      transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)", boxSizing: "border-box",
                    }}
                  />
                  <button onClick={() => setShowNew(!showNew)} style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#475569", padding: 4, display: "flex", alignItems: "center" }}
                    onMouseEnter={e => e.currentTarget.style.color = neon}
                    onMouseLeave={e => e.currentTarget.style.color = "#475569"}
                  >
                    {showNew
                      ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    }
                  </button>
                </div>
              </div>

              {/* Confirm password */}
              <div style={{ marginBottom: 32 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", fontFamily: sora, display: "block", marginBottom: 8, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                  パスワード確認
                </label>
                <div style={{ position: "relative" }}>
                  <div style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: focusedField === "confirm" ? neon : "#334155", transition: "color 0.2s" }}>
                    <Lock size={16} />
                  </div>
                  <input
                    className="neon-input"
                    type={showConfirm ? "text" : "password"}
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="••••••••"
                    onFocus={() => setFocusedField("confirm")}
                    onBlur={() => setFocusedField(null)}
                    style={{
                      width: "100%", padding: "14px 48px 14px 44px", borderRadius: 14, fontSize: 14,
                      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
                      color: "#F1F5F9", outline: "none", fontFamily: sora,
                      transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)", boxSizing: "border-box",
                    }}
                  />
                  <button onClick={() => setShowConfirm(!showConfirm)} style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#475569", padding: 4, display: "flex", alignItems: "center" }}
                    onMouseEnter={e => e.currentTarget.style.color = neon}
                    onMouseLeave={e => e.currentTarget.style.color = "#475569"}
                  >
                    {showConfirm
                      ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    }
                  </button>
                </div>
              </div>

              <button
                onClick={handleSubmit}
                disabled={loading || !canSubmit}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                style={{
                  width: "100%", padding: "15px 0", borderRadius: 14, border: "none", fontSize: 15, fontWeight: 700,
                  cursor: (loading || !canSubmit) ? "not-allowed" : "pointer", fontFamily: sora, letterSpacing: "-0.01em",
                  background: !canSubmit ? "rgba(96,165,250,0.3)" : hovered ? "linear-gradient(135deg, #3B82F6, #2563EB)" : "linear-gradient(135deg, #60A5FA, #3B82F6)",
                  color: "#fff",
                  opacity: !canSubmit ? 0.5 : 1,
                  boxShadow: hovered && canSubmit ? `0 0 0 1px ${neon}40, 0 4px 20px ${neon}40` : `0 4px 16px ${neon}25`,
                  transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)",
                  transform: hovered && canSubmit ? "translateY(-2px)" : "none",
                  marginBottom: 24,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
                  {loading && <div style={{ width: 18, height: 18, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />}
                  {loading ? "変更中..." : "パスワードを変更"}
                </span>
              </button>

              <div style={{ textAlign: "center" }}>
                <Link href="/login" style={{ fontSize: 12, color: "#475569", textDecoration: "none", fontFamily: sora, fontWeight: 500 }}
                  onMouseEnter={e => { e.currentTarget.style.color = neon; }}
                  onMouseLeave={e => { e.currentTarget.style.color = "#475569"; }}
                >
                  ← ログインに戻る
                </Link>
              </div>
            </>
          )}

          {status === "success" && (
            <div style={{ textAlign: "center" }}>
              <div style={{ width: 56, height: 56, borderRadius: "50%", background: "rgba(96,165,250,0.1)", border: `1px solid ${neon}30`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={neon} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h2 style={{ fontFamily: sora, fontSize: 22, fontWeight: 800, color: "#F1F5F9", margin: "0 0 12px" }}>
                パスワードを変更しました！
              </h2>
              <p style={{ fontSize: 14, color: "#64748B", lineHeight: 1.7, margin: "0 0 32px" }}>
                新しいパスワードでログインしてください。
              </p>
              <Link href="/login" style={{
                display: "inline-block", fontSize: 14, color: "#fff", textDecoration: "none",
                fontFamily: sora, fontWeight: 700, padding: "13px 28px",
                background: "linear-gradient(135deg, #60A5FA, #3B82F6)", borderRadius: 12,
                boxShadow: `0 4px 16px ${neon}25`,
              }}>
                ログイン画面へ
              </Link>
            </div>
          )}

          <div style={{ position: "absolute", bottom: 0, left: "15%", right: "15%", height: 1, background: `linear-gradient(90deg, transparent, ${neon}30, transparent)` }} />
        </div>
      </div>
    </div>
  );
}
