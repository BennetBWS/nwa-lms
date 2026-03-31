// @ts-nocheck
"use client";

import { useState, useEffect, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, GraduationCap, BarChart3 } from "lucide-react";

const sora = "var(--font-sora), 'Sora', sans-serif";
const zen = "var(--font-zen), 'Zen Kaku Gothic New', sans-serif";
const neon = "#60A5FA";
const neonVivid = "#93C5FD";
const noise = `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")`;

const FadeIn = ({ children, delay = 0, style = {} }) => {
  const [v, setV] = useState(false);
  useEffect(() => { const t = setTimeout(() => setV(true), 50 + delay); return () => clearTimeout(t); }, [delay]);
  return (
    <div style={{ opacity: v ? 1 : 0, transform: v ? "translateY(0)" : "translateY(20px)", transition: `opacity 0.6s cubic-bezier(0.16,1,0.3,1), transform 0.6s cubic-bezier(0.16,1,0.3,1)`, transitionDelay: `${delay}ms`, ...style }}>
      {children}
    </div>
  );
};

const steps = [
  { num: "01", name: "ITリテラシー", color: "#6366F1" },
  { num: "02", name: "HTML・CSS", color: "#EF4444" },
  { num: "03", name: "JavaScript", color: "#3B82F6" },
  { num: "04", name: "AI（AG・Claude）", color: "#A78BFA" },
  { num: "05", name: "模擬案件", color: "#F59E0B" },
  { num: "06", name: "ポートフォリオ", color: "#22C55E" },
  { num: "07", name: "案件獲得", color: "#EC4899" },
];

export default function LoginPageWrapper() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#060D1B" }} />}>
      <LoginPage />
    </Suspense>
  );
}

function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [hoveredBtn, setHoveredBtn] = useState(null);
  const [focusedField, setFocusedField] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const callbackUrl = searchParams.get("callbackUrl") || "/";

  const handleLogin = async () => {
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("メールアドレスまたはパスワードが正しくありません");
    } else {
      router.push(callbackUrl);
      router.refresh();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && email && password) handleLogin();
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", background: "#060D1B",
      fontFamily: zen, overflow: "hidden",
    }}>
      <style>{`
        @keyframes neonPulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }
        @keyframes gridMove { 0% { transform: translateY(0); } 100% { transform: translateY(40px); } }
        @keyframes shake { 0%,100% { transform: translateX(0); } 20%,60% { transform: translateX(-6px); } 40%,80% { transform: translateX(6px); } }
        .neon-input:focus { border-color: ${neon} !important; box-shadow: 0 0 0 3px rgba(96,165,250,0.12), 0 0 20px rgba(96,165,250,0.08) !important; }
        .neon-input::placeholder { color: #334155; }
        .login-left { display: flex; }
        .login-right { flex: 1; }
        .login-card-wrap { padding: 0 48px; }
        .login-mobile-logo { display: none !important; }
        @media (max-width: 900px) {
          .login-left { display: none !important; }
          .login-right { min-height: 100vh; }
          .login-card-wrap { padding: 0 24px; }
          .login-mobile-logo { display: flex !important; }
        }
      `}</style>

      {/* ═══ LEFT: Brand Visual ═══ */}
      <div className="login-left" style={{
        width: "48%", minHeight: "100vh", position: "relative",
        background: "linear-gradient(165deg, #0A1628 0%, #0F1D35 40%, #0B1120 100%)",
        flexDirection: "column", justifyContent: "center", alignItems: "center",
        overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", inset: 0, opacity: 0.03,
          backgroundImage: `linear-gradient(rgba(96,165,250,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,0.5) 1px, transparent 1px)`,
          backgroundSize: "60px 60px",
          animation: "gridMove 8s linear infinite",
        }} />
        <div style={{ position: "absolute", inset: 0, backgroundImage: noise, backgroundRepeat: "repeat", backgroundSize: "256px", pointerEvents: "none" }} />
        <div style={{ position: "absolute", top: "10%", left: "15%", width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, rgba(96,165,250,0.08) 0%, transparent 70%)", filter: "blur(40px)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", bottom: "15%", right: "10%", width: 250, height: 250, borderRadius: "50%", background: "radial-gradient(circle, rgba(167,139,250,0.06) 0%, transparent 70%)", filter: "blur(30px)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", top: "20%", left: 0, width: "100%", height: 1, background: `linear-gradient(90deg, transparent, ${neon}15, transparent)` }} />
        <div style={{ position: "absolute", bottom: "25%", left: 0, width: "100%", height: 1, background: `linear-gradient(90deg, transparent, rgba(167,139,250,0.08), transparent)` }} />

        <div style={{ position: "relative", zIndex: 2, textAlign: "center", padding: "0 48px", maxWidth: 460 }}>
          <FadeIn delay={100}>
            <img src="https://bennet.global/wp-content/uploads/2026/03/NWA.png" alt="NWA" style={{
              height: 64, width: "auto", objectFit: "contain",
              filter: "brightness(0) invert(1)", opacity: 0.95, marginBottom: 32,
            }} />
          </FadeIn>
          <FadeIn delay={200}>
            <h1 style={{ fontFamily: sora, fontSize: 32, fontWeight: 800, color: "#F1F5F9", letterSpacing: "-0.04em", lineHeight: 1.3, margin: "0 0 12px" }}>
              未来のWeb制作を、<br />ここから。
            </h1>
          </FadeIn>
          <FadeIn delay={300}>
            <p style={{ fontSize: 14, color: "#64748B", lineHeight: 1.7, margin: "0 0 48px" }}>
              実践的なカリキュラムで、<br />未経験からプロのWeb制作者へ
            </p>
          </FadeIn>
          <FadeIn delay={400}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, textAlign: "left" }}>
              {steps.map((step, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 14, padding: "8px 14px",
                  borderRadius: 10, background: "rgba(255,255,255,0.02)",
                  border: "1px solid rgba(255,255,255,0.04)",
                }}>
                  <span style={{ fontFamily: sora, fontSize: 10, fontWeight: 700, color: step.color, letterSpacing: "0.06em", minWidth: 22, opacity: 0.8 }}>{step.num}</span>
                  <div style={{ width: 4, height: 4, borderRadius: "50%", background: step.color, opacity: 0.5, boxShadow: `0 0 6px ${step.color}40` }} />
                  <span style={{ fontSize: 12.5, color: "#94A3B8", fontWeight: 500 }}>{step.name}</span>
                </div>
              ))}
            </div>
          </FadeIn>
        </div>

        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, height: 2,
          background: `linear-gradient(90deg, transparent, ${neon}30, ${neon}60, ${neon}30, transparent)`,
          animation: "neonPulse 3s ease-in-out infinite",
        }} />
      </div>

      {/* ═══ RIGHT: Login Form ═══ */}
      <div className="login-right" style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        position: "relative", background: "#0B1120",
      }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: noise, backgroundRepeat: "repeat", backgroundSize: "256px", pointerEvents: "none", zIndex: 0 }} />
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 500, height: 500, borderRadius: "50%", background: `radial-gradient(circle, ${neon}06 0%, transparent 70%)`, filter: "blur(60px)", pointerEvents: "none" }} />

        <div className="login-card-wrap" style={{ position: "relative", zIndex: 2, width: "100%", maxWidth: 480 }}>
          <FadeIn delay={150}>
            <div style={{
              padding: "52px 48px",
              background: "rgba(15,23,42,0.65)",
              backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
              border: `1px solid ${neon}18`,
              borderRadius: 28,
              boxShadow: `0 0 1px ${neon}30, 0 0 40px ${neon}06, 0 8px 32px rgba(0,0,0,0.3), 0 32px 64px rgba(0,0,0,0.15)`,
              position: "relative", overflow: "hidden",
            }}>
              <div style={{ position: "absolute", top: 0, left: "10%", right: "10%", height: 1, background: `linear-gradient(90deg, transparent, ${neon}50, transparent)` }} />

              {/* Mobile logo */}
              <div className="login-mobile-logo" style={{ display: "none", justifyContent: "center", marginBottom: 28 }}>
                <img src="https://bennet.global/wp-content/uploads/2026/03/NWA.png" alt="NWA" style={{ height: 44, width: "auto", objectFit: "contain", filter: "brightness(0) invert(1)", opacity: 0.9 }} />
              </div>

              {/* Header */}
              <div style={{ marginBottom: 36 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: neon, boxShadow: `0 0 8px ${neon}80`, animation: "neonPulse 2s ease-in-out infinite" }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: neon, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: sora }}>Sign In</span>
                </div>
                <h2 style={{ fontFamily: sora, fontSize: 26, fontWeight: 800, color: "#F1F5F9", margin: 0, letterSpacing: "-0.03em" }}>
                  アカウントにログイン
                </h2>
                <p style={{ fontSize: 13, color: "#4B5E7A", marginTop: 8, lineHeight: 1.5 }}>
                  メールアドレスとパスワードを入力してください
                </p>
              </div>

              {/* Error */}
              {error && (
                <div style={{
                  marginBottom: 20, padding: "12px 16px", borderRadius: 12,
                  background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
                  color: "#F87171", fontSize: 13, fontWeight: 500,
                  animation: "shake 0.4s ease-in-out",
                }}>
                  {error}
                </div>
              )}

              {/* Email */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", fontFamily: sora, display: "block", marginBottom: 8, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                  メールアドレス
                </label>
                <div style={{ position: "relative" }}>
                  <div style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: focusedField === "email" ? neon : "#334155", transition: "color 0.2s" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/></svg>
                  </div>
                  <input
                    className="neon-input"
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
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

              {/* Password */}
              <div style={{ marginBottom: 32 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#64748B", fontFamily: sora, display: "block", marginBottom: 8, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                  パスワード
                </label>
                <div style={{ position: "relative" }}>
                  <div style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", color: focusedField === "password" ? neon : "#334155", transition: "color 0.2s" }}>
                    <Lock size={16} />
                  </div>
                  <input
                    className="neon-input"
                    type={showPassword ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="••••••••"
                    onFocus={() => setFocusedField("password")}
                    onBlur={() => setFocusedField(null)}
                    style={{
                      width: "100%", padding: "14px 48px 14px 44px", borderRadius: 14, fontSize: 14,
                      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
                      color: "#F1F5F9", outline: "none", fontFamily: sora,
                      transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)", boxSizing: "border-box",
                    }}
                  />
                  <button onClick={() => setShowPassword(!showPassword)} style={{
                    position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)",
                    background: "none", border: "none", cursor: "pointer", color: "#475569", padding: 4,
                    display: "flex", alignItems: "center", transition: "color 0.2s",
                  }}
                    onMouseEnter={e => e.currentTarget.style.color = neon}
                    onMouseLeave={e => e.currentTarget.style.color = "#475569"}
                  >
                    {showPassword ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    )}
                  </button>
                </div>
              </div>

              {/* Login button */}
              <div style={{ marginBottom: 24 }}>
                <button
                  onClick={handleLogin}
                  disabled={loading || !email || !password}
                  onMouseEnter={() => setHoveredBtn("login")}
                  onMouseLeave={() => setHoveredBtn(null)}
                  style={{
                    width: "100%", padding: "15px 0", borderRadius: 14, border: "none", fontSize: 15, fontWeight: 700,
                    cursor: loading ? "wait" : "pointer", fontFamily: sora, letterSpacing: "-0.01em",
                    background: (!email || !password) ? "rgba(96,165,250,0.3)"
                      : hoveredBtn === "login" ? `linear-gradient(135deg, #3B82F6, #2563EB)`
                      : `linear-gradient(135deg, #60A5FA, #3B82F6)`,
                    color: "#fff",
                    opacity: (!email || !password) ? 0.5 : 1,
                    boxShadow: hoveredBtn === "login" && email && password
                      ? `0 0 0 1px ${neon}40, 0 4px 20px ${neon}40, 0 0 40px ${neon}15`
                      : `0 4px 16px ${neon}25`,
                    transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)",
                    transform: hoveredBtn === "login" && email && password ? "translateY(-2px)" : "none",
                    position: "relative", overflow: "hidden",
                  }}
                >
                  {hoveredBtn === "login" && email && password && <div style={{ position: "absolute", inset: 0, background: `linear-gradient(135deg, transparent, ${neonVivid}15, transparent)` }} />}
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, position: "relative", zIndex: 1 }}>
                    {loading ? (
                      <div style={{ width: 18, height: 18, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />
                    ) : null}
                    {loading ? "ログイン中..." : "ログイン"}
                  </span>
                </button>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>

              {/* Test accounts hint (dev only) */}
              {process.env.NODE_ENV === "development" && (
              <div style={{ marginBottom: 20, padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#475569", fontFamily: sora, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>テストアカウント</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontSize: 12, color: "#64748B" }}>
                    <span style={{ color: "#94A3B8", fontWeight: 600 }}>生徒:</span> student@nwa.com / password123
                  </div>
                  <div style={{ fontSize: 12, color: "#64748B" }}>
                    <span style={{ color: "#94A3B8", fontWeight: 600 }}>講師:</span> instructor@nwa.com / password123
                  </div>
                </div>
              </div>
              )}

              {/* Forgot password */}
              <div style={{ textAlign: "center" }}>
                <a href="#" onClick={e => e.preventDefault()} style={{
                  fontSize: 12, color: "#475569", textDecoration: "none", fontFamily: sora, fontWeight: 500,
                  transition: "all 0.2s", borderBottom: "1px solid transparent",
                }}
                  onMouseEnter={e => { e.currentTarget.style.color = neon; e.currentTarget.style.borderBottomColor = neon + "40"; }}
                  onMouseLeave={e => { e.currentTarget.style.color = "#475569"; e.currentTarget.style.borderBottomColor = "transparent"; }}
                >パスワードを忘れた方</a>
              </div>

              <div style={{ position: "absolute", bottom: 0, left: "15%", right: "15%", height: 1, background: `linear-gradient(90deg, transparent, ${neon}30, transparent)` }} />
            </div>
          </FadeIn>
        </div>
      </div>
    </div>
  );
}
