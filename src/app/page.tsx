// @ts-nocheck
"use client";

import { useState, useEffect, createContext, useContext } from "react";
import {
  AreaChart, Area, BarChart, Bar, RadialBarChart, RadialBar, PolarAngleAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Home, BookOpen, Play, Bell, MessageSquare, Settings, Users, BarChart3,
  ChevronRight, Clock, FileText, HelpCircle, Lock, Search, Send, ArrowLeft,
  Plus, TrendingUp, Award, Flame, CheckCircle2, PlayCircle, GraduationCap,
  LogOut, Target, Zap, Sparkles, ArrowUpRight
} from "lucide-react";

// ═══════════════════════════════════════════
// COURSE ICONS — Tech logos as SVG components
// ═══════════════════════════════════════════
const CourseIcons = {
  it: ({ size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M7 8.5l2.5 2L7 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <line x1="11" y1="12.5" x2="15" y2="12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  ),
  html: ({ size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 3l1.78 17.1L12 22l6.22-1.9L20 3H4z" fill="currentColor" opacity="0.12"/>
      <path d="M4 3l1.78 17.1L12 22l6.22-1.9L20 3H4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <text x="12" y="15" textAnchor="middle" fill="currentColor" fontSize="7" fontWeight="800" fontFamily="'Sora', sans-serif">5</text>
    </svg>
  ),
  css: ({ size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 3l1.78 17.1L12 22l6.22-1.9L20 3H4z" fill="currentColor" opacity="0.12"/>
      <path d="M4 3l1.78 17.1L12 22l6.22-1.9L20 3H4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <text x="12" y="15" textAnchor="middle" fill="currentColor" fontSize="6" fontWeight="800" fontFamily="'Sora', sans-serif">{ }</text>
    </svg>
  ),
  ag: ({ size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" opacity="0.3"/>
      <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M12 7V3M12 21v-4M17 12h4M3 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
      <path d="M8 4l1 2M16 4l-1 2M8 20l1-2M16 20l-1-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.5"/>
    </svg>
  ),
  mock: ({ size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M3 9h18" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="6" cy="6" r="1" fill="currentColor"/>
      <circle cx="9" cy="6" r="1" fill="currentColor"/>
      <rect x="6" y="12" width="5" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="6" y="17" width="8" height="1" rx="0.5" fill="currentColor" opacity="0.4"/>
      <rect x="13" y="12" width="5" height="6" rx="0.5" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  ),
  portfolio: ({ size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M2 8h20" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="5" cy="6" r="0.8" fill="currentColor"/>
      <circle cx="7.5" cy="6" r="0.8" fill="currentColor"/>
      <circle cx="10" cy="6" r="0.8" fill="currentColor"/>
      <rect x="5" y="11" width="6" height="6" rx="1" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="1"/>
      <line x1="14" y1="11" x2="19" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="14" y1="13.5" x2="18" y2="13.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.5"/>
      <line x1="14" y1="16" x2="17" y2="16" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.3"/>
    </svg>
  ),
  sales: ({ size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" fill="currentColor" opacity="0.1"/>
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
};

/* ═══════════════════════════════════════════
   DESIGN SYSTEM — "Refined Tech-Editorial"
   
   Aesthetic: Dark navy dominance with glassmorphic cards,
   subtle noise texture overlays, bold Outfit display type,
   and generous whitespace. Think: premium tech magazine
   meets Notion's clarity.
   ═══════════════════════════════════════════ */

// Theme generator — light/dark
const createTheme = (isDark) => isDark ? {
  primary: "#60A5FA",
  accent: "#60A5FA",
  accentVivid: "#93C5FD",
  dark: "#F1F5F9",
  darkSoft: "#E2E8F0",
  bg: "#0B1120",
  surface: "#111827",
  surfaceElevated: "rgba(17,24,39,0.85)",
  border: "#1E293B",
  borderSubtle: "#1A2332",
  textPrimary: "#F1F5F9",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",
  success: "#34D399",
  warning: "#FBBF24",
  danger: "#F87171",
  purple: "#C4B5FD",
  emerald: "#6EE7B7",
  glass: "rgba(17,24,39,0.7)",
  glassBorder: "rgba(255,255,255,0.08)",
  noise: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")`,
  sidebarBg: "#060D1B",
  sidebarText: "rgba(255,255,255,0.45)",
  sidebarTextActive: "#fff",
  sidebarActiveBar: "#60A5FA",
  sidebarActiveBg: "rgba(96,165,250,0.12)",
  sidebarHover: "rgba(255,255,255,0.04)",
  sidebarRoleBg: "rgba(255,255,255,0.04)",
  sidebarRoleBorder: "rgba(255,255,255,0.04)",
  sidebarRoleActive: "rgba(255,255,255,0.08)",
  gradientDark: "linear-gradient(135deg, #0F172A 0%, #0B1120 100%)",
  cardHover: "rgba(96,165,250,0.04)",
  chartBarFill: "#60A5FA",
  mode: "dark",
} : {
  primary: "#213F85",
  accent: "#3B82F6",
  accentVivid: "#60A5FA",
  dark: "#0A1628",
  darkSoft: "#0F2040",
  bg: "#F4F7FB",
  surface: "#FFFFFF",
  surfaceElevated: "rgba(255,255,255,0.82)",
  border: "#E1E7F0",
  borderSubtle: "#EDF1F7",
  textPrimary: "#0A1628",
  textSecondary: "#3D5278",
  textMuted: "#8899B4",
  success: "#22C55E",
  warning: "#F59E0B",
  danger: "#EF4444",
  purple: "#A78BFA",
  emerald: "#34D399",
  glass: "rgba(255,255,255,0.6)",
  glassBorder: "rgba(255,255,255,0.25)",
  noise: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E")`,
  sidebarBg: "#0A1628",
  sidebarText: "rgba(255,255,255,0.45)",
  sidebarTextActive: "#fff",
  sidebarActiveBar: "#3B82F6",
  sidebarActiveBg: "rgba(59,130,246,0.15)",
  sidebarHover: "rgba(255,255,255,0.04)",
  sidebarRoleBg: "rgba(255,255,255,0.06)",
  sidebarRoleBorder: "rgba(255,255,255,0.06)",
  sidebarRoleActive: "rgba(255,255,255,0.1)",
  gradientDark: "linear-gradient(135deg, #0F2A55 0%, #1a1a3e 100%)",
  cardHover: "rgba(59,130,246,0.02)",
  chartBarFill: "#3B82F6",
  mode: "light",
};

// Default T for backward compat — will be overridden by context
let T = createTheme(false);

const ThemeContext = createContext(null);
const useTheme = () => useContext(ThemeContext) || T;

// ═══════════════════════════════════════════
// ANIMATIONS
// ═══════════════════════════════════════════
const FadeIn = ({ children, delay = 0, direction = "up", style = {} }) => {
  const [v, setV] = useState(false);
  useEffect(() => { const t = setTimeout(() => setV(true), 50 + delay); return () => clearTimeout(t); }, [delay]);
  const dir = { up: "translateY(20px)", down: "translateY(-12px)", left: "translateX(20px)", right: "translateX(-20px)", scale: "scale(0.96)" };
  return (
    <div style={{ opacity: v ? 1 : 0, transform: v ? "translateY(0) scale(1)" : dir[direction], transition: `opacity 0.6s cubic-bezier(0.16,1,0.3,1), transform 0.6s cubic-bezier(0.16,1,0.3,1)`, transitionDelay: `${delay}ms`, willChange: "opacity, transform", ...style }}>
      {children}
    </div>
  );
};

const AnimNum = ({ value, duration = 1400 }) => {
  const [d, setD] = useState(0);
  useEffect(() => {
    const end = parseFloat(value), st = Date.now();
    const tick = () => {
      const p = Math.min((Date.now() - st) / duration, 1);
      setD(Math.floor((1 - Math.pow(1 - p, 4)) * end));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [value, duration]);
  return <>{d}</>;
};

// Glass card style helper — uses current T
const glassStyle = (blur = 16) => ({
  background: T.surfaceElevated,
  backdropFilter: `blur(${blur}px)`,
  WebkitBackdropFilter: `blur(${blur}px)`,
  border: `1px solid ${T.glassBorder}`,
  boxShadow: T.mode === "dark"
    ? "0 1px 3px rgba(0,0,0,0.2), 0 8px 32px rgba(0,0,0,0.15)"
    : "0 1px 3px rgba(10,22,40,0.04), 0 8px 32px rgba(10,22,40,0.03)",
});

// ═══════════════════════════════════════════
// THEME TOGGLE BUTTON
// ═══════════════════════════════════════════
const ThemeToggle = ({ isDark, onToggle }) => {
  const [animating, setAnimating] = useState(false);

  const handleClick = () => {
    setAnimating(true);
    onToggle();
    setTimeout(() => setAnimating(false), 600);
  };

  return (
    <button
      onClick={handleClick}
      style={{
        position: "relative",
        width: 44, height: 44, borderRadius: 13,
        border: `1px solid ${isDark ? "rgba(255,255,255,0.08)" : T.border}`,
        background: isDark ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.7)",
        backdropFilter: "blur(12px)",
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "all 0.4s cubic-bezier(0.16,1,0.3,1)",
        overflow: "hidden",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = "scale(1.08)";
        e.currentTarget.style.borderColor = T.accent;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = "scale(1)";
        e.currentTarget.style.borderColor = isDark ? "rgba(255,255,255,0.08)" : T.border;
      }}
    >
      {/* Sun */}
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={isDark ? "#FBBF24" : "#F59E0B"} strokeWidth="2" strokeLinecap="round"
        style={{
          position: "absolute",
          opacity: isDark ? 0 : 1,
          transform: isDark ? "rotate(90deg) scale(0.5)" : "rotate(0) scale(1)",
          transition: "all 0.5s cubic-bezier(0.16,1,0.3,1)",
        }}
      >
        <circle cx="12" cy="12" r="5" fill={isDark ? "none" : "#FDE68A"} />
        <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
        <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
      {/* Moon */}
      <svg width="18" height="18" viewBox="0 0 24 24" fill={isDark ? "#C4B5FD" : "none"} stroke={isDark ? "#C4B5FD" : "#8899B4"} strokeWidth="2" strokeLinecap="round"
        style={{
          position: "absolute",
          opacity: isDark ? 1 : 0,
          transform: isDark ? "rotate(0) scale(1)" : "rotate(-90deg) scale(0.5)",
          transition: "all 0.5s cubic-bezier(0.16,1,0.3,1)",
        }}
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
      {/* Ripple on click */}
      {animating && (
        <div style={{
          position: "absolute", inset: 0, borderRadius: 13,
          background: isDark ? "rgba(196,181,253,0.15)" : "rgba(251,191,36,0.15)",
          animation: "ripple 0.6s ease-out forwards",
        }} />
      )}
      <style>{`
        @keyframes ripple {
          0% { transform: scale(0); opacity: 1; }
          100% { transform: scale(2.5); opacity: 0; }
        }
      `}</style>
    </button>
  );
};

// ═══════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════
const Sidebar = ({ currentPage, setCurrentPage, isAdmin, onLogout }) => {
  const studentNav = [
    { id: "dashboard", icon: Home, label: "ダッシュボード" },
    { id: "courses", icon: BookOpen, label: "コース一覧" },
    { id: "lesson", icon: Play, label: "レッスン" },
    { id: "quiz", icon: HelpCircle, label: "確認テスト受講" },
    { id: "notifications", icon: Bell, label: "通知", badge: 2 },
    { id: "questions", icon: MessageSquare, label: "質問" },
  ];
  const adminNav = [
    { id: "admin-dashboard", icon: BarChart3, label: "管理ダッシュボード" },
    { id: "admin-students", icon: Users, label: "生徒管理" },
    { id: "admin-courses", icon: BookOpen, label: "コース管理" },
    { id: "admin-lessons", icon: Play, label: "レッスン管理" },
    { id: "admin-quiz", icon: HelpCircle, label: "クイズ管理" },
  ];
  const nav = isAdmin ? adminNav : studentNav;

  return (
    <div style={{
      width: 260, height: "100%", background: T.sidebarBg, display: "flex", flexDirection: "column", flexShrink: 0,
      position: "relative", overflow: "hidden",
    }}>
      {/* Noise overlay */}
      <div style={{ position: "absolute", inset: 0, backgroundImage: T.noise, backgroundRepeat: "repeat", backgroundSize: "256px", pointerEvents: "none", zIndex: 1 }} />
      {/* Gradient glow */}
      <div style={{ position: "absolute", top: -80, left: -60, width: 240, height: 240, borderRadius: "50%", background: "radial-gradient(circle, rgba(59,130,246,0.12) 0%, transparent 70%)", pointerEvents: "none" }} />

      {/* Logo */}
      <div style={{ padding: "22px 28px 24px", position: "relative", zIndex: 2 }}>
        <img src="https://bennet.global/wp-content/uploads/2026/03/NWA.png" alt="NWA" style={{ height: 48, width: "auto", objectFit: "contain", filter: "brightness(0) invert(1)", opacity: 0.92 }} />
      </div>

      <Separator style={{ background: "rgba(255,255,255,0.06)", margin: "0 16px" }} />

      {/* Nav */}
      <nav style={{ flex: 1, padding: "12px 12px", display: "flex", flexDirection: "column", gap: 2, position: "relative", zIndex: 2 }}>
        {nav.map((item) => {
          const active = currentPage === item.id;
          const Icon = item.icon;
          return (
            <button key={item.id} onClick={() => setCurrentPage(item.id)}
              style={{
                display: "flex", alignItems: "center", gap: 11, padding: "11px 14px",
                borderRadius: 10, border: "none", cursor: "pointer", fontSize: 13.5,
                fontWeight: active ? 600 : 450, fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif",
                color: active ? "#fff" : "rgba(255,255,255,0.45)",
                background: active ? "rgba(59,130,246,0.15)" : "transparent",
                transition: "all 0.2s ease", textAlign: "left", width: "100%", position: "relative",
              }}
              onMouseEnter={e => { if (!active) { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.color = "rgba(255,255,255,0.7)"; }}}
              onMouseLeave={e => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(255,255,255,0.45)"; }}}
            >
              {active && <div style={{ position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)", width: 3, height: 22, borderRadius: "0 6px 6px 0", background: T.accent, boxShadow: `0 0 12px ${T.accent}60` }} />}
              <Icon size={18} strokeWidth={active ? 2 : 1.6} />
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.badge && (
                <span style={{ minWidth: 20, height: 20, borderRadius: 99, background: T.danger, color: "#fff", fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 6px", boxShadow: `0 0 8px ${T.danger}40` }}>
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* User */}
      <div style={{ padding: "12px 14px", borderTop: "1px solid rgba(255,255,255,0.06)", position: "relative", zIndex: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, cursor: "pointer", transition: "background 0.2s" }}
          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.04)"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
        >
          <Avatar style={{ width: 34, height: 34, boxShadow: "0 0 0 2px rgba(59,130,246,0.3)" }}>
            <AvatarFallback style={{ background: `linear-gradient(135deg, ${T.accent}, ${T.purple})`, color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>T</AvatarFallback>
          </Avatar>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Tec</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>{isAdmin ? "講師" : "在校生"}</div>
          </div>
          <LogOut size={15} style={{ color: "rgba(255,255,255,0.25)", cursor: "pointer" }} onClick={onLogout} />
        </div>
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════
// STUDENT DASHBOARD — Bento Grid Layout
// ═══════════════════════════════════════════
const StudentDashboard = ({ setCurrentPage }) => {
  const [calEvents, setCalEvents] = useState([]);
  const [calLoading, setCalLoading] = useState(true);

  // Google Calendar MCP
  useEffect(() => {
    const fetchCal = async () => {
      try {
        const now = new Date(), later = new Date(now); later.setDate(later.getDate() + 7);
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514", max_tokens: 1000,
            messages: [{ role: "user", content: `List my calendar events from ${now.toISOString()} to ${later.toISOString()}. Return ONLY a JSON array with fields: title, start (ISO), end (ISO). No other text.` }],
            mcp_servers: [{ type: "url", url: "https://gcal.mcp.claude.com/mcp", name: "gcal" }],
          }),
        });
        const data = await res.json();
        let events = [];
        const tr = data.content?.find(b => b.type === "mcp_tool_result");
        const tx = data.content?.find(b => b.type === "text");
        try {
          if (tr?.content?.[0]?.text) events = JSON.parse(tr.content[0].text);
          else if (tx?.text) events = JSON.parse(tx.text.replace(/```json|```/g, "").trim());
        } catch {}
        if (Array.isArray(events)) setCalEvents(events.slice(0, 5));
      } catch {
        setCalEvents([
          { title: "Antigravity L16 視聴", start: new Date(Date.now() + 3600000).toISOString() },
          { title: "CSS ミニテスト再受験", start: new Date(Date.now() + 7200000).toISOString() },
          { title: "山田先生 1on1", start: new Date(Date.now() + 86400000).toISOString() },
          { title: "模擬案件 課題2 締切", start: new Date(Date.now() + 172800000).toISOString() },
        ]);
      }
      setCalLoading(false);
    };
    fetchCal();
  }, []);

  const fmtTime = (iso) => {
    try {
      const d = new Date(iso), h = Math.round((d - new Date()) / 3600000);
      if (h < 1) return "まもなく";
      if (h < 24) return `${h}h later`;
      return `${Math.round(h / 24)}日後`;
    } catch { return ""; }
  };

  const weekly = [
    { day: "M", h: 1.5 }, { day: "T", h: 2.0 }, { day: "W", h: 0.5 },
    { day: "T", h: 3.0 }, { day: "F", h: 1.0 }, { day: "S", h: 2.5 }, { day: "S", h: 0 },
  ];
  const courses = [
    { name: "STEP1 ITリテラシー", progress: 100, lessons: 12, icon: "it", color: "#6366F1" },
    { name: "STEP2 HTML", progress: 100, lessons: 18, icon: "html", color: "#EF4444" },
    { name: "STEP3 CSS", progress: 100, lessons: 20, icon: "css", color: "#3B82F6" },
    { name: "STEP4 Antigravity", progress: 65, lessons: 24, icon: "ag", color: "#A78BFA" },
    { name: "STEP5 模擬案件", progress: 20, lessons: 15, icon: "mock", color: "#F59E0B" },
    { name: "STEP6 ポートフォリオ作成", progress: 0, lessons: 10, icon: "portfolio", color: "#22C55E" },
    { name: "STEP7 案件獲得", progress: 0, lessons: 8, icon: "sales", color: "#EC4899" },
  ];
  const cur = courses[3];
  const radial = [{ value: cur.progress, fill: T.accentVivid, max: 100 }];

  const stats = [
    { label: "受講中", value: "4", sub: "/ 7", icon: BookOpen, accent: T.accent, gradient: "linear-gradient(135deg, #3B82F6, #1D4ED8)" },
    { label: "完了", value: "56", sub: "lessons", icon: CheckCircle2, accent: T.success, gradient: "linear-gradient(135deg, #22C55E, #16A34A)" },
    { label: "学習時間", value: "8", sub: "h/w", icon: Flame, accent: T.purple, gradient: "linear-gradient(135deg, #A78BFA, #7C3AED)" },
    { label: "全体進度", value: "55", sub: "%", icon: Target, accent: T.warning, gradient: "linear-gradient(135deg, #FBBF24, #D97706)" },
  ];

  const todos = [
    { text: "Antigravity L16 を視聴", icon: PlayCircle, color: T.accent, hi: true },
    { text: "CSS Flexbox ミニテスト再受験", icon: HelpCircle, color: T.warning, hi: true },
    { text: "質問への返信を確認", icon: MessageSquare, color: T.success },
    { text: "STEP3 修了テスト受験", icon: Award, color: T.purple },
  ];

  const assigns = [
    { title: "課題1: カフェLP", st: "approved", dl: "3/1", fb: "合格！" },
    { title: "課題2: 美容サロン", st: "review", dl: "3/8" },
    { title: "課題3: IT企業", st: "working", dl: "3/15" },
    { title: "課題4: レストラン", st: "locked", dl: "3/22" },
    { title: "課題5: アパレルEC", st: "locked", dl: "3/29" },
  ];
  const stCfg = {
    approved: { l: "合格", c: T.success, i: CheckCircle2 },
    review: { l: "レビュー中", c: T.warning, i: Clock },
    working: { l: "作業中", c: T.accent, i: PlayCircle },
    locked: { l: "未開放", c: T.textMuted, i: Lock },
  };

  const news = [
    { from: "山田先生", msg: "STEP4の課題フィードバックを送りました", time: "1h", av: "山", imp: true },
    { from: "運営事務局", msg: "3/15 メンテナンス 8:00〜10:00", time: "3h", av: "N" },
    { from: "佐々木先生", msg: "模擬案件の新ブリーフを追加しました！", time: "1d", av: "佐" },
  ];

  const calColors = [T.accent, T.warning, T.purple, T.success, T.danger];

  return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "32px 36px 48px", maxWidth: 1200 }}>
        {/* Header */}
        <FadeIn>
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <Sparkles size={14} style={{ color: T.accent }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Dashboard</span>
            </div>
            <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 30, fontWeight: 800, color: T.dark, margin: 0, letterSpacing: "-0.04em" }}>おかえりなさい、Tec さん</h1>
          </div>
        </FadeIn>

        {/* ═══ BENTO GRID ═══ */}
        <div className="nwa-bento" style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 18, gridAutoRows: "minmax(0, auto)" }}>

          {/* ── Row 1: Stats (3 cols each × 4) ── */}
          {stats.map((s, i) => {
            const Icon = s.icon;
            return (
              <FadeIn key={`s${i}`} delay={40 * i} direction="scale" style={{ gridColumn: "span 3" }}>
                <div style={{ ...glassStyle(), borderRadius: 16, padding: "18px 20px", position: "relative", overflow: "hidden", transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)", cursor: "default" }}
                  onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 12px 36px rgba(10,22,40,0.08)"; }}
                  onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = glassStyle().boxShadow; }}>
                  <div style={{ position: "absolute", top: -16, right: -16, width: 60, height: 60, borderRadius: "50%", background: s.gradient, opacity: 0.06, filter: "blur(16px)" }} />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative", zIndex: 1 }}>
                    <div>
                      <span style={{ fontSize: 10, fontWeight: 600, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{s.label}</span>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 3, marginTop: 6 }}>
                        <span style={{ fontSize: 30, fontWeight: 800, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.04em", lineHeight: 1 }}><AnimNum value={s.value} /></span>
                        <span style={{ fontSize: 11, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{s.sub}</span>
                      </div>
                    </div>
                    <div style={{ width: 36, height: 36, borderRadius: 11, background: s.gradient, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 3px 10px ${s.accent}20` }}>
                      <Icon size={16} style={{ color: "#fff" }} />
                    </div>
                  </div>
                </div>
              </FadeIn>
            );
          })}

          {/* ── Row 2: CTA (8) + ToDo (4) ── */}
          <FadeIn delay={80} style={{ gridColumn: "span 8" }}>
            <div onClick={() => setCurrentPage("lesson")} style={{
              background: T.mode === "dark" ? "linear-gradient(135deg, #0F172A, #1E293B)" : T.gradientDark,
              borderRadius: 20, cursor: "pointer", overflow: "hidden", position: "relative",
              transition: "transform 0.4s cubic-bezier(0.16,1,0.3,1), box-shadow 0.4s", height: "100%", minHeight: 150,
            }}
              onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 16px 48px rgba(10,22,40,0.18)"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
              <div style={{ position: "absolute", inset: 0, backgroundImage: T.noise, backgroundRepeat: "repeat", backgroundSize: "256px", opacity: 0.5, pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 0, right: 0, width: "50%", height: "100%", background: "radial-gradient(ellipse at 80% 50%, rgba(59,130,246,0.1) 0%, transparent 65%)", pointerEvents: "none" }} />
              <div style={{ padding: "26px 28px", position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", alignItems: "center", height: "100%" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: T.emerald, boxShadow: `0 0 8px ${T.emerald}` }} />
                    <span style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Continue Learning</span>
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#fff", fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.02em" }}>Antigravity</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 2 }}>Lesson 16: レスポンシブ実装</div>
                  <Button size="sm" style={{ marginTop: 14, background: T.accent, color: "#fff", border: "none", borderRadius: 10, fontWeight: 600, gap: 5, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, boxShadow: `0 4px 16px ${T.accent}40`, padding: "7px 16px" }}>
                    <PlayCircle size={14} /> 開く
                  </Button>
                </div>
                <div style={{ width: 96, height: 96, flexShrink: 0 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <RadialBarChart innerRadius={30} outerRadius={46} data={radial} startAngle={90} endAngle={-270}>
                      <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                      <RadialBar background={{ fill: "rgba(255,255,255,0.06)" }} dataKey="value" cornerRadius={12} fill={T.accentVivid} angleAxisId={0} />
                      <text x="50%" y="46%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 17, fontWeight: 800, fill: "#fff", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{cur.progress}</text>
                      <text x="50%" y="64%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 9, fill: "rgba(255,255,255,0.35)", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>%</text>
                    </RadialBarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={120} style={{ gridColumn: "span 4" }}>
            <div style={{ ...glassStyle(), borderRadius: 20, height: "100%", display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "16px 20px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Next Up</h3>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: T.danger, boxShadow: `0 0 6px ${T.danger}40` }} />
              </div>
              <div style={{ padding: "0 20px 16px", flex: 1 }}>
                {todos.map((t, i) => {
                  const Icon = t.icon;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderTop: i > 0 ? `1px solid ${T.borderSubtle}` : "none", cursor: "pointer", transition: "opacity 0.15s" }}
                      onMouseEnter={e => e.currentTarget.style.opacity = "0.6"} onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
                      <div style={{ width: 26, height: 26, borderRadius: 7, background: `${t.color}0C`, border: `1px solid ${t.color}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <Icon size={12} style={{ color: t.color }} />
                      </div>
                      <span style={{ flex: 1, fontSize: 12, color: T.textPrimary, lineHeight: 1.3 }}>{t.text}</span>
                      {t.hi && <div style={{ width: 5, height: 5, borderRadius: "50%", background: T.danger, flexShrink: 0 }} />}
                    </div>
                  );
                })}
              </div>
            </div>
          </FadeIn>

          {/* ── Row 3: Curriculum (8) + Calendar (4) ── */}
          <FadeIn delay={160} style={{ gridColumn: "span 8" }}>
            <div style={{ ...glassStyle(), borderRadius: 20, padding: "20px 24px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h2 style={{ fontSize: 14, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>カリキュラム進度</h2>
                <Button variant="ghost" size="sm" onClick={() => setCurrentPage("courses")} style={{ color: T.accent, fontWeight: 600, fontSize: 11, fontFamily: "var(--font-sora), 'Sora', sans-serif", gap: 3, padding: "4px 8px" }}>
                  詳細 <ArrowUpRight size={12} />
                </Button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {courses.map((c, i) => {
                  const Icon = CourseIcons[c.icon] || null;
                  const isAct = c.progress > 0 && c.progress < 100;
                  const isDone = c.progress === 100;
                  const isLock = c.progress === 0 && i > 4;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 11, opacity: isLock ? 0.35 : 1 }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                        background: isDone ? `${T.success}12` : isAct ? `${c.color}0C` : `${T.textMuted}08`,
                        border: `1.5px solid ${isDone ? T.success + "30" : isAct ? c.color + "25" : "transparent"}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: isDone ? T.success : isAct ? c.color : T.textMuted,
                      }}>
                        {isDone ? <CheckCircle2 size={14} /> : Icon ? <Icon size={14} /> : <Lock size={11} />}
                      </div>
                      <div style={{ width: 90, flexShrink: 0, fontSize: 11.5, fontWeight: isAct ? 650 : 500, color: isAct ? T.dark : isDone ? T.textSecondary : T.textMuted, lineHeight: 1.2 }}>
                        {c.name.replace(/STEP\d\s/, "")}
                      </div>
                      <div style={{ flex: 1, height: 6, borderRadius: 99, background: T.borderSubtle, overflow: "hidden" }}>
                        <div style={{
                          width: `${c.progress}%`, height: "100%", borderRadius: 99,
                          background: isDone ? T.success : `linear-gradient(90deg, ${c.color}, ${c.color}B0)`,
                          transition: "width 1.2s cubic-bezier(0.16,1,0.3,1)", position: "relative",
                        }}>
                          {isAct && <div style={{ position: "absolute", right: -1, top: "50%", transform: "translateY(-50%)", width: 10, height: 10, borderRadius: "50%", background: c.color, border: `2px solid ${T.mode === "dark" ? T.surface : "white"}`, boxShadow: `0 0 8px ${c.color}50` }} />}
                        </div>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 800, minWidth: 34, textAlign: "right", fontFamily: "var(--font-sora), 'Sora', sans-serif", color: isDone ? T.success : isAct ? T.dark : T.textMuted }}>{c.progress}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={200} style={{ gridColumn: "span 4" }}>
            <div style={{ ...glassStyle(), borderRadius: 20, height: "100%", display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "16px 20px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>📅 Schedule</h3>
                <span style={{ fontSize: 9, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 500 }}>Google Cal</span>
              </div>
              <div style={{ padding: "0 20px 16px", flex: 1 }}>
                {calLoading ? (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 100 }}>
                    <div style={{ width: 18, height: 18, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                  </div>
                ) : calEvents.map((evt, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 0", borderTop: i > 0 ? `1px solid ${T.borderSubtle}` : "none" }}>
                    <div style={{ width: 3, height: 26, borderRadius: 3, flexShrink: 0, marginTop: 1, background: calColors[i % calColors.length] }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 550, color: T.textPrimary, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{evt.title}</div>
                      <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{fmtTime(evt.start)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>

          {/* ── Row 4: Weekly (4) + Announcements (4) + Activity (4) ── */}
          <FadeIn delay={240} style={{ gridColumn: "span 4" }}>
            <div style={{ ...glassStyle(), borderRadius: 20 }}>
              <div style={{ padding: "16px 20px 6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Weekly</h3>
                <Badge variant="secondary" style={{ fontSize: 9, fontWeight: 700, background: `${T.purple}12`, color: T.purple, border: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
                  <Flame size={10} style={{ marginRight: 2 }} />4日
                </Badge>
              </div>
              <div style={{ padding: "2px 8px 12px" }}>
                <ResponsiveContainer width="100%" height={130}>
                  <BarChart data={weekly} barCategoryGap="24%">
                    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={T.borderSubtle} />
                    <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }} />
                    <YAxis hide />
                    <Tooltip cursor={{ fill: `${T.accent}06`, radius: 6 }} contentStyle={{ borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 11, fontFamily: "var(--font-sora), 'Sora', sans-serif" }} formatter={v => [`${v}h`]} />
                    <Bar dataKey="h" radius={[6, 6, 0, 0]}>
                      {weekly.map((_, i) => <Cell key={i} fill={weekly[i].h > 0 ? T.accent : T.borderSubtle} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={280} style={{ gridColumn: "span 4" }}>
            <div style={{ ...glassStyle(), borderRadius: 20, height: "100%" }}>
              <div style={{ padding: "16px 20px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>お知らせ</h3>
                <Bell size={13} style={{ color: T.textMuted }} />
              </div>
              <div style={{ padding: "0 20px 16px" }}>
                {news.map((n, i) => (
                  <div key={i} style={{ display: "flex", gap: 9, padding: "9px 0", borderTop: i > 0 ? `1px solid ${T.borderSubtle}` : "none", cursor: "pointer", transition: "opacity 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.opacity = "0.6"} onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
                    <Avatar style={{ width: 28, height: 28, flexShrink: 0 }}>
                      <AvatarFallback style={{
                        background: n.imp ? `linear-gradient(135deg, ${T.accent}, ${T.purple})` : T.mode === "dark" ? "rgba(255,255,255,0.06)" : "#E8EDF4",
                        color: n.imp ? "#fff" : T.textMuted, fontSize: 10, fontWeight: 700, fontFamily: "var(--font-sora), 'Sora', sans-serif",
                      }}>{n.av}</AvatarFallback>
                    </Avatar>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: T.textPrimary, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{n.from}</span>
                        {n.imp && <div style={{ width: 4, height: 4, borderRadius: "50%", background: T.accent }} />}
                        <span style={{ fontSize: 9, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif", marginLeft: "auto" }}>{n.time}</span>
                      </div>
                      <div style={{ fontSize: 11, color: T.textSecondary, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.msg}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={320} style={{ gridColumn: "span 4" }}>
            <div style={{ ...glassStyle(), borderRadius: 20, height: "100%" }}>
              <div style={{ padding: "16px 20px 10px" }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Activity</h3>
              </div>
              <div style={{ padding: "0 20px 16px" }}>
                {[
                  { icon: PlayCircle, color: T.accent, text: "AG - レスポンシブ #15", time: "2h" },
                  { icon: Award, color: T.warning, text: "CSS クイズ — 90点", time: "1d" },
                  { icon: MessageSquare, color: T.success, text: "山田先生が回答", time: "2d" },
                ].map((a, i) => {
                  const Icon = a.icon;
                  return (
                    <div key={i} style={{ display: "flex", gap: 9, padding: "9px 0", borderTop: i > 0 ? `1px solid ${T.borderSubtle}` : "none", cursor: "pointer", transition: "opacity 0.15s" }}
                      onMouseEnter={e => e.currentTarget.style.opacity = "0.6"} onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
                      <div style={{ width: 26, height: 26, borderRadius: 7, background: `${a.color}0C`, border: `1px solid ${a.color}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <Icon size={12} style={{ color: a.color }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: T.textPrimary, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.text}</div>
                        <div style={{ fontSize: 9, color: T.textMuted, marginTop: 2, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{a.time}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </FadeIn>

          {/* ── Row 5: Assignment Status (full width) ── */}
          <FadeIn delay={360} style={{ gridColumn: "span 12" }}>
            <div style={{ ...glassStyle(), borderRadius: 20 }}>
              <div style={{ padding: "18px 24px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>課題の提出状況</h3>
                <span style={{ fontSize: 11, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>STEP5 模擬案件</span>
              </div>
              <div className="nwa-assign-grid" style={{ padding: "0 24px 18px", display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 14 }}>
                {assigns.map((a, i) => {
                  const sc = stCfg[a.st]; const Icon = sc.i;
                  return (
                    <div key={i} style={{
                      borderRadius: 14, padding: "16px 14px", textAlign: "center",
                      background: T.mode === "dark" ? "rgba(255,255,255,0.02)" : "#FAFBFD",
                      border: `1px solid ${a.st === "working" ? T.accent + "30" : T.borderSubtle}`,
                      opacity: a.st === "locked" ? 0.4 : 1,
                      transition: "all 0.2s",
                    }}
                      onMouseEnter={e => { if (a.st !== "locked") e.currentTarget.style.transform = "translateY(-2px)"; }}
                      onMouseLeave={e => e.currentTarget.style.transform = "none"}
                    >
                      <div style={{ width: 36, height: 36, borderRadius: 10, background: `${sc.c}0C`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px" }}>
                        <Icon size={16} style={{ color: sc.c }} />
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.textPrimary, marginBottom: 6 }}>{a.title}</div>
                      <Badge variant="secondary" style={{ fontSize: 9, fontWeight: 700, background: `${sc.c}12`, color: sc.c, border: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{sc.l}</Badge>
                      <div style={{ fontSize: 9, color: T.textMuted, marginTop: 6, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>〆 {a.dl}</div>
                      {a.fb && <div style={{ fontSize: 10, color: T.success, marginTop: 4, fontWeight: 600 }}>{a.fb}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          </FadeIn>

        </div>
      </div>
    </ScrollArea>
  );
};

// ═══════════════════════════════════════════
// COURSE LIST
// ═══════════════════════════════════════════
const CourseList = ({ setCurrentPage }) => {
  const courses = [
    { name: "STEP1 ITリテラシー", desc: "PC基礎操作・ネットリテラシー・ツール活用", lessons: 12, hours: 6, progress: 100, icon: "it", color: "#6366F1", level: "STEP1", students: 24 },
    { name: "STEP2 HTML", desc: "Webページの骨格となるHTMLを基礎から学ぶ", lessons: 18, hours: 10, progress: 100, icon: "html", color: "#EF4444", level: "STEP2", students: 24 },
    { name: "STEP3 CSS", desc: "デザインを実現するCSS・レイアウト手法を習得", lessons: 20, hours: 12, progress: 100, icon: "css", color: "#3B82F6", level: "STEP3", students: 22 },
    { name: "STEP4 Antigravity", desc: "AIツールを活用した次世代Web制作を実践", lessons: 24, hours: 14, progress: 65, icon: "ag", color: "#A78BFA", level: "STEP4", students: 18 },
    { name: "STEP5 模擬案件", desc: "模擬案件で実務フロー・納品までをシミュレーション", lessons: 15, hours: 20, progress: 20, icon: "mock", color: "#F59E0B", level: "STEP5", students: 10 },
    { name: "STEP6 ポートフォリオ作成", desc: "案件獲得に向けたポートフォリオサイトを構築", lessons: 10, hours: 8, progress: 0, icon: "portfolio", color: "#22C55E", level: "STEP6", students: 6, locked: true },
    { name: "STEP7 案件獲得", desc: "営業・提案・契約など案件獲得の実践ノウハウ", lessons: 8, hours: 6, progress: 0, icon: "sales", color: "#EC4899", level: "STEP7", students: 0, locked: true },
  ];

  return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "36px 40px 48px", maxWidth: 1160 }}>
        <FadeIn>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 32 }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Courses</span>
              <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 34, fontWeight: 800, color: T.dark, margin: "4px 0 0", letterSpacing: "-0.04em" }}>コース一覧</h1>
            </div>
            <div style={{ ...glassStyle(12), borderRadius: 12, padding: "9px 16px", display: "flex", alignItems: "center", gap: 8 }}>
              <Search size={15} style={{ color: T.textMuted }} />
              <input placeholder="Search courses..." style={{ border: "none", outline: "none", fontSize: 13, width: 170, background: "transparent", color: T.textPrimary, fontFamily: "var(--font-sora), 'Sora', sans-serif" }} />
            </div>
          </div>
        </FadeIn>

        <div className="nwa-course-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 20 }}>
          {courses.map((c, i) => (
            <FadeIn key={i} delay={70 * i}>
              <div
                onClick={() => !c.locked && setCurrentPage("lesson")}
                style={{
                  ...glassStyle(), borderRadius: 20, overflow: "hidden",
                  cursor: c.locked ? "default" : "pointer", opacity: c.locked ? 0.45 : 1,
                  transition: "all 0.35s cubic-bezier(0.16,1,0.3,1)", position: "relative",
                }}
                onMouseEnter={e => { if (!c.locked) { e.currentTarget.style.transform = "translateY(-4px)"; e.currentTarget.style.boxShadow = "0 16px 48px rgba(10,22,40,0.1)"; }}}
                onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 1px 3px rgba(10,22,40,0.04), 0 8px 32px rgba(10,22,40,0.03)"; }}
              >
                {/* Top color accent */}
                <div style={{ height: 3, background: c.locked ? T.border : `linear-gradient(90deg, ${c.color}, ${c.color}80)` }} />
                <div style={{ padding: 24 }}>
                  <div style={{ display: "flex", gap: 16, marginBottom: 18 }}>
                    <div style={{ width: 54, height: 54, borderRadius: 16, background: `${c.color}08`, border: `1.5px solid ${c.color}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: c.color }}>{CourseIcons[c.icon] ? CourseIcons[c.icon]({ size: 26 }) : c.icon}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                        <h3 style={{ fontSize: 17, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.02em" }}>{c.name}</h3>
                        {c.locked && <Lock size={14} style={{ color: T.textMuted }} />}
                      </div>
                      <p style={{ fontSize: 13, color: T.textMuted, margin: 0, lineHeight: 1.4 }}>{c.desc}</p>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 14, marginBottom: 18, fontSize: 11, color: T.textSecondary, alignItems: "center", fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 500 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>📚 {c.lessons}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Clock size={12} /> {c.hours}h</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Users size={12} /> {c.students}</span>
                    <Badge variant="secondary" style={{ fontSize: 10, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "0.02em" }}>{c.level}</Badge>
                  </div>
                  {!c.locked && (
                    <div>
                      <div style={{ height: 5, borderRadius: 99, background: T.borderSubtle, overflow: "hidden" }}>
                        <div style={{ width: `${c.progress}%`, height: "100%", borderRadius: 99, background: c.progress === 100 ? T.success : `linear-gradient(90deg, ${c.color}, ${c.color}90)`, transition: "width 1s cubic-bezier(0.16,1,0.3,1)" }} />
                      </div>
                      <div style={{ textAlign: "right", marginTop: 8, fontSize: 13, fontWeight: 800, color: c.progress === 100 ? T.success : T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{c.progress}%</div>
                    </div>
                  )}
                  {c.locked && <div style={{ fontSize: 12, color: T.textMuted, fontStyle: "italic", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Coming soon</div>}
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
};

// ═══════════════════════════════════════════
// LESSON VIEW
// ═══════════════════════════════════════════
const LessonView = ({ setCurrentPage }) => {
  const [expanded, setExpanded] = useState(1);
  const sections = [
    { title: "AG基礎", lessons: [
      { title: "Antigravityとは", dur: "8:30", done: true, type: "video" },
      { title: "環境セットアップ", dur: "12:45", done: true, type: "video" },
      { title: "プロンプトの基本", dur: "10:20", done: true, type: "video" },
      { title: "確認クイズ", dur: "5問", done: true, type: "quiz" },
    ]},
    { title: "実践サイト制作", lessons: [
      { title: "LP構成の設計", dur: "15:00", done: true, type: "video" },
      { title: "ヘッダー・ナビ作成", dur: "18:30", done: true, type: "video" },
      { title: "レスポンシブ実装", dur: "22:15", done: false, type: "video", active: true },
      { title: "フォーム実装", dur: "14:00", done: false, type: "video" },
      { title: "AG制作フロー PDF", dur: "3P", done: false, type: "pdf" },
      { title: "確認クイズ", dur: "8問", done: false, type: "quiz" },
    ]},
    { title: "応用テクニック", lessons: [
      { title: "アニメーション指示", dur: "11:00", done: false, type: "video" },
      { title: "複数ページサイト", dur: "16:30", done: false, type: "video" },
      { title: "デバッグ・修正依頼", dur: "14:20", done: false, type: "video" },
    ]},
  ];
  const icons = { video: PlayCircle, quiz: HelpCircle, pdf: FileText };

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 28px", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
          <Button variant="ghost" size="sm" onClick={() => setCurrentPage("courses")} style={{ gap: 4, color: T.textSecondary, fontSize: 13, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
            <ArrowLeft size={16} /> Back
          </Button>
          <Separator orientation="vertical" style={{ height: 20 }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Antigravity</span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, width: 180 }}>
            <div style={{ flex: 1, height: 4, borderRadius: 99, background: T.borderSubtle, overflow: "hidden" }}>
              <div style={{ width: "68%", height: "100%", borderRadius: 99, background: `linear-gradient(90deg, ${T.accent}, ${T.accentVivid})` }} />
            </div>
            <span style={{ fontSize: 13, fontWeight: 800, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>68%</span>
          </div>
        </div>

        {/* Video */}
        <div style={{ aspectRatio: "16/9", maxHeight: 440, background: T.mode === "dark" ? "linear-gradient(135deg, #0F172A, #1E293B)" : T.gradientDark, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, backgroundImage: T.noise, backgroundRepeat: "repeat", backgroundSize: "256px", opacity: 0.4, pointerEvents: "none" }} />
          <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at center, rgba(59,130,246,0.08) 0%, transparent 60%)" }} />
          <div style={{ textAlign: "center", color: "#fff", position: "relative", zIndex: 1 }}>
            <div style={{
              width: 80, height: 80, borderRadius: "50%", background: "rgba(255,255,255,0.06)",
              display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px",
              cursor: "pointer", backdropFilter: "blur(16px)", border: "1.5px solid rgba(255,255,255,0.1)",
              transition: "all 0.35s cubic-bezier(0.16,1,0.3,1)",
            }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(59,130,246,0.2)"; e.currentTarget.style.transform = "scale(1.1)"; e.currentTarget.style.boxShadow = `0 0 40px ${T.accent}30`; }}
              onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "none"; }}
            >
              <Play size={34} fill="white" style={{ color: "white", marginLeft: 4 }} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, opacity: 0.85, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>レスポンシブ実装</div>
            <div style={{ fontSize: 12, opacity: 0.35, marginTop: 5, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>22:15</div>
          </div>
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 3, background: "rgba(255,255,255,0.06)" }}>
            <div style={{ width: "35%", height: "100%", background: T.accent, boxShadow: `0 0 12px ${T.accent}60` }} />
          </div>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="content" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <TabsList style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, borderRadius: 0, padding: "0 28px", height: "auto", justifyContent: "flex-start" }}>
            {[{ v: "content", l: "概要" }, { v: "resources", l: "教材" }, { v: "comments", l: "質問 (3)" }].map(t => (
              <TabsTrigger key={t.v} value={t.v} style={{ borderRadius: 0, padding: "13px 20px", fontSize: 13, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{t.l}</TabsTrigger>
            ))}
          </TabsList>
          <div style={{ flex: 1, overflow: "auto" }}>
            <TabsContent value="content" style={{ padding: 28 }}>
              <h2 style={{ fontSize: 22, fontWeight: 800, color: T.dark, margin: "0 0 12px", fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.03em" }}>レスポンシブ実装</h2>
              <p style={{ fontSize: 14, color: T.textSecondary, lineHeight: 1.8, margin: "0 0 24px" }}>
                Antigravityを使ってレスポンシブ対応のサイトを実装します。モバイルファーストの考え方とブレイクポイントの設定方法を実践的に学びます。
              </p>
              <div style={{ display: "flex", gap: 10, marginBottom: 28 }}>
                <Badge variant="outline" style={{ gap: 4, padding: "5px 14px", fontSize: 12, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}><Clock size={13} /> 22:15</Badge>
                <Badge variant="outline" style={{ gap: 4, padding: "5px 14px", fontSize: 12, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}><FileText size={13} /> PDF付き</Badge>
              </div>
              <Button style={{ background: T.accent, borderRadius: 12, fontWeight: 600, gap: 6, fontFamily: "var(--font-sora), 'Sora', sans-serif", boxShadow: `0 4px 16px ${T.accent}30` }}>
                <CheckCircle2 size={16} /> レッスン完了にする
              </Button>
            </TabsContent>
            <TabsContent value="resources" style={{ padding: 28 }}>
              {[{ name: "レスポンシブ実装ガイド.pdf", size: "2.4 MB" }, { name: "サンプルコード.zip", size: "156 KB" }].map((f, i) => (
                <div key={i} style={{ ...glassStyle(8), borderRadius: 14, padding: "14px 18px", display: "flex", alignItems: "center", gap: 14, marginBottom: 10, cursor: "pointer", transition: "border-color 0.2s" }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = T.accent + "40"} onMouseLeave={e => e.currentTarget.style.borderColor = T.glassBorder}>
                  <div style={{ width: 42, height: 42, borderRadius: 12, background: `${T.accent}08`, border: `1px solid ${T.accent}12`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <FileText size={18} style={{ color: T.accent }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: T.textPrimary }}>{f.name}</div>
                    <div style={{ fontSize: 11, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{f.size}</div>
                  </div>
                  <Button variant="ghost" size="sm" style={{ color: T.accent, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12 }}>Download</Button>
                </div>
              ))}
            </TabsContent>
            <TabsContent value="comments" style={{ padding: 28 }}>
              <div style={{ display: "flex", gap: 12, marginBottom: 22 }}>
                <Avatar style={{ width: 34, height: 34 }}><AvatarFallback style={{ background: "linear-gradient(135deg, #22C55E, #16A34A)", color: "#fff", fontSize: 12, fontWeight: 700 }}>佐</AvatarFallback></Avatar>
                <div style={{ flex: 1 }}>
                  <div style={{ ...glassStyle(8), borderRadius: 14, padding: "14px 18px" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, marginBottom: 5, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>佐藤 太郎</div>
                    <div style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.55 }}>レスポンシブのブレイクポイントを768pxに設定したのですが、タブレットでレイアウトが崩れます。原因は何でしょうか？</div>
                  </div>
                  <span style={{ fontSize: 10, color: T.textMuted, paddingLeft: 4, marginTop: 4, display: "block", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>3h ago</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <Avatar style={{ width: 34, height: 34 }}><AvatarFallback style={{ background: `linear-gradient(135deg, ${T.accent}, ${T.purple})`, color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>T</AvatarFallback></Avatar>
                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, ...glassStyle(8), borderRadius: 14, padding: "9px 16px" }}>
                  <input placeholder="Write a question..." style={{ flex: 1, border: "none", outline: "none", fontSize: 13, background: "transparent", color: T.textPrimary, fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif" }} />
                  <Button size="sm" style={{ background: T.accent, borderRadius: 10, padding: "7px 10px", boxShadow: `0 2px 8px ${T.accent}30` }}><Send size={15} /></Button>
                </div>
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </div>

      {/* Sidebar */}
      <ScrollArea className="nwa-lesson-sidebar" style={{ width: 340, borderLeft: `1px solid ${T.border}`, background: T.surface, flexShrink: 0 }}>
        <div style={{ padding: "18px 20px", borderBottom: `1px solid ${T.border}` }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Course Content</h3>
        </div>
        {sections.map((sec, si) => (
          <div key={si}>
            <button onClick={() => setExpanded(expanded === si ? -1 : si)}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "14px 20px", background: expanded === si ? `${T.accent}04` : "transparent", border: "none", borderBottom: `1px solid ${T.borderSubtle}`, cursor: "pointer", textAlign: "left", transition: "background 0.2s" }}>
              <ChevronRight size={13} style={{ color: T.textMuted, transform: expanded === si ? "rotate(90deg)" : "none", transition: "transform 0.3s cubic-bezier(0.16,1,0.3,1)" }} />
              <span style={{ fontSize: 13, fontWeight: 650, color: T.dark, flex: 1, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{sec.title}</span>
              <span style={{ fontSize: 10, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 600 }}>{sec.lessons.filter(l => l.done).length}/{sec.lessons.length}</span>
            </button>
            <div style={{ maxHeight: expanded === si ? 500 : 0, overflow: "hidden", transition: "max-height 0.45s cubic-bezier(0.16,1,0.3,1)" }}>
              {sec.lessons.map((l, li) => {
                const Icon = icons[l.type] || PlayCircle;
                return (
                  <div key={li} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 20px 10px 46px", borderBottom: `1px solid ${T.borderSubtle}`, background: l.active ? `${T.accent}06` : "transparent", cursor: "pointer", transition: "background 0.15s" }}
                    onMouseEnter={e => { if (!l.active) e.currentTarget.style.background = `${T.accent}03`; }}
                    onMouseLeave={e => { if (!l.active) e.currentTarget.style.background = "transparent"; }}
                  >
                    {l.done ? <CheckCircle2 size={17} style={{ color: T.success, flexShrink: 0 }} /> : <Icon size={17} style={{ color: l.active ? T.accent : "#C1CDE0", flexShrink: 0 }} />}
                    <span style={{ flex: 1, fontSize: 13, fontWeight: l.active ? 600 : 400, color: l.active ? T.accent : T.textPrimary }}>{l.title}</span>
                    <span style={{ fontSize: 10, color: T.textMuted, flexShrink: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 500 }}>{l.dur}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </ScrollArea>
    </div>
  );
};

// ═══════════════════════════════════════════
// ADMIN DASHBOARD
// ═══════════════════════════════════════════
const AdminDashboard = () => {
  const monthly = [{ m: "Jan", a: 18, c: 6 }, { m: "Feb", a: 20, c: 8 }, { m: "Mar", a: 22, c: 10 }, { m: "Apr", a: 24, c: 12 }];
  const dist = [{ name: "IT基礎", value: 24, color: "#6366F1" }, { name: "HTML", value: 24, color: "#EF4444" }, { name: "CSS", value: 22, color: "#3B82F6" }, { name: "AG", value: 18, color: "#A78BFA" }, { name: "模擬案件", value: 10, color: "#F59E0B" }, { name: "PF", value: 6, color: "#22C55E" }];
  const students = [
    { name: "佐藤 太郎", course: "Antigravity", progress: 82, last: "3h ago", status: "good" },
    { name: "鈴木 花子", course: "CSS", progress: 95, last: "1d ago", status: "good" },
    { name: "田中 次郎", course: "Antigravity", progress: 23, last: "5d ago", status: "warn" },
    { name: "高橋 美咲", course: "模擬案件", progress: 60, last: "2h ago", status: "good" },
    { name: "渡辺 健一", course: "ポートフォリオ", progress: 10, last: "2w ago", status: "alert" },
  ];
  const st = { good: { l: "良好", c: T.success }, warn: { l: "注意", c: T.warning }, alert: { l: "要対応", c: T.danger } };

  return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "36px 40px 48px", maxWidth: 1160 }}>
        <FadeIn>
          <div style={{ marginBottom: 32 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Admin</span>
            <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 34, fontWeight: 800, color: T.dark, margin: "4px 0 0", letterSpacing: "-0.04em" }}>管理者ダッシュボード</h1>
          </div>
        </FadeIn>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 32 }}>
          {[
            { label: "Active Students", value: "24", sub: "", icon: Users, gradient: "linear-gradient(135deg, #3B82F6, #1D4ED8)", change: "+3" },
            { label: "Avg Progress", value: "62", sub: "%", icon: Target, gradient: "linear-gradient(135deg, #22C55E, #16A34A)", change: "+5%" },
            { label: "Open Questions", value: "7", sub: "", icon: MessageSquare, gradient: "linear-gradient(135deg, #F59E0B, #D97706)" },
            { label: "Completions", value: "12", sub: "", icon: Award, gradient: "linear-gradient(135deg, #A78BFA, #7C3AED)", change: "+4" },
          ].map((s, i) => {
            const Icon = s.icon;
            return (
              <FadeIn key={i} delay={60 * i} direction="scale">
                <div style={{ ...glassStyle(), borderRadius: 18, padding: 22, position: "relative", overflow: "hidden", transition: "all 0.35s cubic-bezier(0.16,1,0.3,1)" }}
                  onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-3px)"; e.currentTarget.style.boxShadow = "0 12px 40px rgba(10,22,40,0.08)"; }}
                  onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 1px 3px rgba(10,22,40,0.04), 0 8px 32px rgba(10,22,40,0.03)"; }}
                >
                  <div style={{ position: "absolute", top: -20, right: -20, width: 80, height: 80, borderRadius: "50%", background: s.gradient, opacity: 0.06, filter: "blur(20px)" }} />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative", zIndex: 1 }}>
                    <div>
                      <span style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{s.label}</span>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 3, marginTop: 10 }}>
                        <span style={{ fontSize: 36, fontWeight: 800, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.04em", lineHeight: 1 }}><AnimNum value={s.value} /></span>
                        {s.sub && <span style={{ fontSize: 14, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{s.sub}</span>}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                      <div style={{ width: 42, height: 42, borderRadius: 13, background: s.gradient, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Icon size={20} style={{ color: "#fff" }} />
                      </div>
                      {s.change && <span style={{ fontSize: 10, fontWeight: 700, color: T.success, fontFamily: "var(--font-sora), 'Sora', sans-serif", display: "flex", alignItems: "center", gap: 2 }}><TrendingUp size={10} />{s.change}</span>}
                    </div>
                  </div>
                </div>
              </FadeIn>
            );
          })}
        </div>

        {/* Charts */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 24, marginBottom: 32 }}>
          <FadeIn delay={180}>
            <div style={{ ...glassStyle(), borderRadius: 20 }}>
              <div style={{ padding: "20px 24px 8px" }}>
                <h3 style={{ fontSize: 15, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Monthly Trends</h3>
              </div>
              <div style={{ padding: "4px 14px 16px" }}>
                <ResponsiveContainer width="100%" height={230}>
                  <AreaChart data={monthly}>
                    <defs>
                      <linearGradient id="ga2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.accent} stopOpacity={0.15} /><stop offset="100%" stopColor={T.accent} stopOpacity={0} /></linearGradient>
                      <linearGradient id="gc2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.success} stopOpacity={0.15} /><stop offset="100%" stopColor={T.success} stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={T.borderSubtle} />
                    <XAxis dataKey="m" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: T.textMuted }} />
                    <Tooltip contentStyle={{ borderRadius: 12, border: `1px solid ${T.border}`, boxShadow: "0 8px 32px rgba(0,0,0,0.08)", fontSize: 12, fontFamily: "var(--font-sora), 'Sora', sans-serif" }} />
                    <Area type="monotone" dataKey="a" stroke={T.accent} strokeWidth={2.5} fill="url(#ga2)" name="Active" />
                    <Area type="monotone" dataKey="c" stroke={T.success} strokeWidth={2.5} fill="url(#gc2)" name="Completed" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </FadeIn>
          <FadeIn delay={260}>
            <div style={{ ...glassStyle(), borderRadius: 20 }}>
              <div style={{ padding: "20px 24px 0" }}>
                <h3 style={{ fontSize: 15, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Distribution</h3>
              </div>
              <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                <ResponsiveContainer width="100%" height={170}>
                  <PieChart>
                    <Pie data={dist} cx="50%" cy="50%" innerRadius={44} outerRadius={70} paddingAngle={4} dataKey="value" strokeWidth={0}>
                      {dist.map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Pie>
                    <Tooltip contentStyle={{ borderRadius: 10, fontSize: 12, fontFamily: "var(--font-sora), 'Sora', sans-serif" }} formatter={(v) => [`${v}名`]} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center" }}>
                  {dist.map((c, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: T.textSecondary, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 500 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 3, background: c.color }} />{c.name}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </FadeIn>
        </div>

        {/* Students Table */}
        <FadeIn delay={320}>
          <div style={{ ...glassStyle(), borderRadius: 20, overflow: "hidden" }}>
            <div style={{ padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Students</h3>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, border: `1px solid ${T.border}`, borderRadius: 10, padding: "7px 14px", background: "rgba(255,255,255,0.5)" }}>
                  <Search size={14} style={{ color: T.textMuted }} />
                  <input placeholder="Search..." style={{ border: "none", outline: "none", fontSize: 12, width: 110, background: "transparent", fontFamily: "var(--font-sora), 'Sora', sans-serif" }} />
                </div>
                <Button size="sm" style={{ background: T.accent, borderRadius: 10, fontWeight: 600, gap: 4, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, boxShadow: `0 2px 8px ${T.accent}25` }}>
                  <Plus size={14} /> Invite
                </Button>
              </div>
            </div>
            <div className="nwa-admin-table-grid" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1.3fr 0.8fr 0.6fr", padding: "10px 24px", borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
              <div>Name</div><div>Course</div><div>Progress</div><div>Last Seen</div><div>Status</div>
            </div>
            {students.map((s, i) => (
              <div key={i} className="nwa-admin-table-grid" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1.3fr 0.8fr 0.6fr", padding: "14px 24px", borderBottom: i < students.length - 1 ? `1px solid ${T.borderSubtle}` : "none", alignItems: "center", cursor: "pointer", transition: "background 0.2s" }}
                onMouseEnter={e => e.currentTarget.style.background = `${T.accent}03`} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Avatar style={{ width: 32, height: 32 }}><AvatarFallback style={{ background: `linear-gradient(135deg, ${T.accent}, ${T.purple})`, color: "#fff", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{s.name.charAt(0)}</AvatarFallback></Avatar>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: T.textPrimary }}>{s.name}</span>
                </div>
                <span style={{ fontSize: 13, color: T.textSecondary }}>{s.course}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, height: 4, borderRadius: 99, background: T.borderSubtle, overflow: "hidden" }}>
                    <div style={{ width: `${s.progress}%`, height: "100%", borderRadius: 99, background: `linear-gradient(90deg, ${T.accent}, ${T.accentVivid})` }} />
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, minWidth: 34, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{s.progress}%</span>
                </div>
                <span style={{ fontSize: 12, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{s.last}</span>
                <Badge variant="secondary" style={{ fontSize: 10, fontWeight: 700, background: `${st[s.status]?.c}12`, color: st[s.status]?.c, border: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
                  {st[s.status]?.l}
                </Badge>
              </div>
            ))}
          </div>
        </FadeIn>
      </div>
    </ScrollArea>
  );
};

// ═══════════════════════════════════════════
// QUIZ PAGE — 確認テスト受講
// ═══════════════════════════════════════════
const QuizPage = () => {
  const [activeQuiz, setActiveQuiz] = useState(null);
  const [selectedAnswer, setSelectedAnswer] = useState(null);
  const [showResult, setShowResult] = useState(false);
  const [currentQ, setCurrentQ] = useState(0);
  const [score, setScore] = useState(0);

  const steps = [
    {
      name: "STEP1 ITリテラシー", color: "#6366F1", icon: "it",
      stepQuiz: { title: "STEP1 修了テスト", questions: 10, time: "15分", passed: true, score: 90 },
      miniQuizzes: [
        { title: "L1: PC基本操作", passed: true, score: 100 },
        { title: "L4: ファイル管理", passed: true, score: 80 },
        { title: "L8: ネットリテラシー", passed: true, score: 90 },
        { title: "L12: ツール活用", passed: true, score: 85 },
      ],
    },
    {
      name: "STEP2 HTML", color: "#EF4444", icon: "html",
      stepQuiz: { title: "STEP2 修了テスト", questions: 15, time: "20分", passed: true, score: 85 },
      miniQuizzes: [
        { title: "L3: HTML基本構造", passed: true, score: 90 },
        { title: "L7: テキスト・リスト", passed: true, score: 95 },
        { title: "L12: フォーム要素", passed: true, score: 80 },
        { title: "L16: セマンティックHTML", passed: true, score: 85 },
      ],
    },
    {
      name: "STEP3 CSS", color: "#3B82F6", icon: "css",
      stepQuiz: { title: "STEP3 修了テスト", questions: 15, time: "20分", passed: false, score: null },
      miniQuizzes: [
        { title: "L4: セレクター・プロパティ", passed: true, score: 85 },
        { title: "L9: ボックスモデル", passed: true, score: 90 },
        { title: "L14: Flexbox", passed: false, score: 60 },
        { title: "L18: レスポンシブ", passed: null, score: null },
      ],
    },
  ];

  // Demo quiz questions for active quiz
  const demoQuestions = [
    { q: "Flexboxで主軸方向を変更するプロパティは？", options: ["flex-direction", "justify-content", "align-items", "flex-wrap"], correct: 0 },
    { q: "flex-grow: 1 の意味は？", options: ["固定サイズ", "余白を均等に分配", "縮小を許可", "折り返しを有効化"], correct: 1 },
    { q: "align-items: center の効果は？", options: ["主軸方向の中央揃え", "交差軸方向の中央揃え", "テキストの中央揃え", "マージンの自動調整"], correct: 1 },
    { q: "gap プロパティの役割は？", options: ["要素の外側の余白", "Flex/Grid子要素間の余白", "テキストの行間", "ボーダーの太さ"], correct: 1 },
    { q: "flex-shrink: 0 を設定すると？", options: ["要素が拡大される", "要素が縮小されなくなる", "要素が非表示になる", "要素が折り返される"], correct: 1 },
  ];

  if (activeQuiz) {
    const q = demoQuestions[currentQ];
    return (
      <ScrollArea style={{ height: "100%" }}>
        <div className="nwa-page-content" style={{ padding: "36px 40px 48px", maxWidth: 760 }}>
          <FadeIn>
            <Button variant="ghost" size="sm" onClick={() => { setActiveQuiz(null); setCurrentQ(0); setScore(0); setShowResult(false); setSelectedAnswer(null); }}
              style={{ gap: 4, color: T.textSecondary, fontSize: 13, fontFamily: "var(--font-sora), 'Sora', sans-serif", marginBottom: 20 }}>
              <ArrowLeft size={16} /> テスト一覧に戻る
            </Button>
          </FadeIn>

          {!showResult ? (
            <FadeIn>
              <div style={{ ...glassStyle(), borderRadius: 22, overflow: "hidden" }}>
                {/* Progress header */}
                <div style={{ padding: "20px 28px", borderBottom: `1px solid ${T.borderSubtle}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{activeQuiz}</span>
                    <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Question {currentQ + 1} / {demoQuestions.length}</div>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {demoQuestions.map((_, i) => (
                      <div key={i} style={{ width: 28, height: 4, borderRadius: 99, background: i <= currentQ ? T.accent : T.borderSubtle, transition: "background 0.3s" }} />
                    ))}
                  </div>
                </div>

                {/* Question */}
                <div style={{ padding: "32px 28px" }}>
                  <h2 style={{ fontSize: 20, fontWeight: 700, color: T.dark, margin: "0 0 28px", fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif", lineHeight: 1.5 }}>{q.q}</h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {q.options.map((opt, oi) => {
                      const selected = selectedAnswer === oi;
                      return (
                        <button key={oi} onClick={() => setSelectedAnswer(oi)}
                          style={{
                            display: "flex", alignItems: "center", gap: 14, padding: "16px 20px",
                            borderRadius: 14, border: `2px solid ${selected ? T.accent : T.borderSubtle}`,
                            background: selected ? `${T.accent}08` : "transparent",
                            cursor: "pointer", transition: "all 0.2s", textAlign: "left", width: "100%",
                          }}
                          onMouseEnter={e => { if (!selected) e.currentTarget.style.borderColor = `${T.accent}40`; }}
                          onMouseLeave={e => { if (!selected) e.currentTarget.style.borderColor = T.borderSubtle; }}
                        >
                          <div style={{
                            width: 24, height: 24, borderRadius: "50%", border: `2px solid ${selected ? T.accent : T.textMuted}`,
                            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                            background: selected ? T.accent : "transparent", transition: "all 0.2s",
                          }}>
                            {selected && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff" }} />}
                          </div>
                          <span style={{ fontSize: 14, fontWeight: selected ? 600 : 450, color: selected ? T.dark : T.textSecondary }}>{opt}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 32, display: "flex", justifyContent: "flex-end" }}>
                    <Button
                      disabled={selectedAnswer === null}
                      onClick={() => {
                        const newScore = score + (selectedAnswer === q.correct ? 1 : 0);
                        setScore(newScore);
                        if (currentQ < demoQuestions.length - 1) {
                          setCurrentQ(currentQ + 1);
                          setSelectedAnswer(null);
                        } else {
                          setShowResult(true);
                        }
                      }}
                      style={{
                        background: selectedAnswer !== null ? T.accent : T.border,
                        borderRadius: 12, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 14,
                        padding: "10px 28px", gap: 6,
                        boxShadow: selectedAnswer !== null ? `0 4px 16px ${T.accent}30` : "none",
                      }}
                    >
                      {currentQ < demoQuestions.length - 1 ? "次へ" : "結果を見る"} <ChevronRight size={16} />
                    </Button>
                  </div>
                </div>
              </div>
            </FadeIn>
          ) : (
            <FadeIn>
              <div style={{ ...glassStyle(), borderRadius: 22, textAlign: "center", padding: "48px 32px" }}>
                <div style={{ width: 100, height: 100, margin: "0 auto 24px" }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <RadialBarChart innerRadius={32} outerRadius={48} data={[{ value: Math.round(score / demoQuestions.length * 100), fill: score / demoQuestions.length >= 0.7 ? T.success : T.danger }]} startAngle={90} endAngle={-270}>
                      <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                      <RadialBar background={{ fill: T.borderSubtle }} dataKey="value" cornerRadius={14} angleAxisId={0} />
                      <text x="50%" y="46%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 20, fontWeight: 800, fill: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{Math.round(score / demoQuestions.length * 100)}</text>
                      <text x="50%" y="63%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 10, fill: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>%</text>
                    </RadialBarChart>
                  </ResponsiveContainer>
                </div>
                <h2 style={{ fontSize: 22, fontWeight: 800, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif", margin: "0 0 8px" }}>
                  {score / demoQuestions.length >= 0.7 ? "合格！🎉" : "不合格…"}
                </h2>
                <p style={{ fontSize: 14, color: T.textMuted, margin: "0 0 8px" }}>{score} / {demoQuestions.length} 正解</p>
                <p style={{ fontSize: 13, color: T.textSecondary, margin: "0 0 28px" }}>
                  {score / demoQuestions.length >= 0.7 ? "素晴らしい結果です！次のステップに進みましょう。" : "70%以上で合格です。もう一度チャレンジしてみましょう。"}
                </p>
                <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                  <Button variant="outline" onClick={() => { setCurrentQ(0); setScore(0); setShowResult(false); setSelectedAnswer(null); }}
                    style={{ borderRadius: 12, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 600 }}>もう一度受ける</Button>
                  <Button onClick={() => { setActiveQuiz(null); setCurrentQ(0); setScore(0); setShowResult(false); setSelectedAnswer(null); }}
                    style={{ background: T.accent, borderRadius: 12, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 600, boxShadow: `0 4px 16px ${T.accent}30` }}>テスト一覧に戻る</Button>
                </div>
              </div>
            </FadeIn>
          )}
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "36px 40px 48px", maxWidth: 960 }}>
        <FadeIn>
          <div style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Assessment</span>
            <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 34, fontWeight: 800, color: T.dark, margin: "4px 0 0", letterSpacing: "-0.04em" }}>確認テスト受講</h1>
          </div>
          <p style={{ fontSize: 14, color: T.textMuted, margin: "0 0 32px" }}>各STEPの修了テストとレッスンごとのミニテストを受けられます。STEP1〜3のみテストが用意されています。</p>
        </FadeIn>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {steps.map((step, si) => (
            <FadeIn key={si} delay={80 * si}>
              <div style={{ ...glassStyle(), borderRadius: 20, overflow: "hidden" }}>
                {/* Step Header */}
                <div style={{ padding: "22px 26px", display: "flex", alignItems: "center", gap: 16, borderBottom: `1px solid ${T.borderSubtle}` }}>
                  <div style={{ width: 46, height: 46, borderRadius: 14, background: `${step.color}0A`, border: `1.5px solid ${step.color}18`, display: "flex", alignItems: "center", justifyContent: "center", color: step.color, flexShrink: 0 }}>
                    {CourseIcons[step.icon] ? CourseIcons[step.icon]({ size: 22 }) : null}
                  </div>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.02em" }}>{step.name}</h3>
                    <span style={{ fontSize: 12, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>修了テスト + ミニテスト {step.miniQuizzes.length}件</span>
                  </div>
                  {step.stepQuiz.passed && (
                    <Badge variant="secondary" style={{ fontSize: 11, fontWeight: 700, background: `${T.success}12`, color: T.success, border: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
                      <CheckCircle2 size={12} style={{ marginRight: 4 }} /> STEP完了
                    </Badge>
                  )}
                </div>

                {/* Step Final Quiz */}
                <div
                  onClick={() => setActiveQuiz(`${step.name} 修了テスト`)}
                  style={{
                    padding: "18px 26px", display: "flex", alignItems: "center", gap: 14,
                    background: step.stepQuiz.passed ? `${T.success}04` : step.stepQuiz.score !== null ? `${T.danger}04` : "transparent",
                    borderBottom: `1px solid ${T.borderSubtle}`, cursor: "pointer", transition: "background 0.15s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = `${T.accent}06`}
                  onMouseLeave={e => e.currentTarget.style.background = step.stepQuiz.passed ? `${T.success}04` : step.stepQuiz.score !== null ? `${T.danger}04` : "transparent"}
                >
                  <div style={{
                    width: 36, height: 36, borderRadius: 10,
                    background: step.stepQuiz.passed ? `${T.success}12` : `${step.color}0C`,
                    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  }}>
                    {step.stepQuiz.passed ? <CheckCircle2 size={18} style={{ color: T.success }} /> : <Award size={18} style={{ color: step.color }} />}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: T.textPrimary, fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif" }}>{step.stepQuiz.title}</div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{step.stepQuiz.questions}問 · {step.stepQuiz.time}</div>
                  </div>
                  {step.stepQuiz.score !== null && (
                    <span style={{ fontSize: 16, fontWeight: 800, color: step.stepQuiz.passed ? T.success : T.danger, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{step.stepQuiz.score}点</span>
                  )}
                  {step.stepQuiz.score === null && (
                    <Button size="sm" style={{ background: step.color, color: "#fff", borderRadius: 10, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, boxShadow: `0 2px 8px ${step.color}30` }}>
                      受験する
                    </Button>
                  )}
                </div>

                {/* Mini Quizzes */}
                <div style={{ padding: "6px 0" }}>
                  {step.miniQuizzes.map((mq, mi) => (
                    <div key={mi}
                      onClick={() => setActiveQuiz(`${step.name} - ${mq.title}`)}
                      style={{
                        display: "flex", alignItems: "center", gap: 12, padding: "12px 26px 12px 42px",
                        cursor: "pointer", transition: "background 0.15s",
                        borderBottom: mi < step.miniQuizzes.length - 1 ? `1px solid ${T.borderSubtle}` : "none",
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = `${T.accent}03`}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                    >
                      {mq.passed === true ? (
                        <CheckCircle2 size={16} style={{ color: T.success, flexShrink: 0 }} />
                      ) : mq.passed === false ? (
                        <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${T.danger}`, flexShrink: 0 }} />
                      ) : (
                        <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${T.textMuted}`, flexShrink: 0, opacity: 0.4 }} />
                      )}
                      <span style={{ flex: 1, fontSize: 13, color: T.textPrimary, fontWeight: mq.passed === null ? 400 : 500 }}>ミニテスト: {mq.title}</span>
                      {mq.score !== null && (
                        <span style={{ fontSize: 13, fontWeight: 700, color: mq.passed ? T.success : T.danger, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{mq.score}点</span>
                      )}
                      {mq.score === null && (
                        <span style={{ fontSize: 11, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>未受験</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </FadeIn>
          ))}

          {/* STEP4以降の説明 */}
          <FadeIn delay={300}>
            <div style={{ ...glassStyle(), borderRadius: 18, padding: "24px 28px", textAlign: "center", opacity: 0.7 }}>
              <div style={{ fontSize: 20, marginBottom: 10 }}>📝</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.textSecondary, marginBottom: 4, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>STEP4〜7 はテストなし</div>
              <div style={{ fontSize: 13, color: T.textMuted }}>STEP4（Antigravity）以降は実践課題で評価されます。</div>
            </div>
          </FadeIn>
        </div>
      </div>
    </ScrollArea>
  );
};

// ═══════════════════════════════════════════
// NOTIFICATIONS / QUESTIONS / ADMIN COURSES
// ═══════════════════════════════════════════
const Notifications = () => {
  const n = [
    { icon: MessageSquare, color: T.accent, title: "山田先生が質問に回答", desc: "Antigravity - L16", time: "2h", unread: true },
    { icon: GraduationCap, color: T.purple, title: "STEP5「模擬案件」が開放されました", desc: "STEP4完了後に受講可能", time: "1d", unread: true },
    { icon: Award, color: T.warning, title: "CSS Flexboxクイズ — 90点", desc: "合格おめでとう！", time: "2d", unread: false },
    { icon: Settings, color: T.textMuted, title: "パスワード変更のお知らせ", desc: "定期変更を推奨", time: "1w", unread: false },
  ];
  return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "36px 40px 48px", maxWidth: 880 }}>
        <FadeIn><span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Notifications</span>
          <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 34, fontWeight: 800, color: T.dark, margin: "4px 0 28px", letterSpacing: "-0.04em" }}>通知</h1></FadeIn>
        <div style={{ ...glassStyle(), borderRadius: 20, overflow: "hidden" }}>
          {n.map((x, i) => { const Icon = x.icon; return (
            <FadeIn key={i} delay={50 * i}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "18px 24px", borderBottom: i < n.length - 1 ? `1px solid ${T.borderSubtle}` : "none", background: x.unread ? `${T.accent}03` : "transparent", cursor: "pointer", transition: "background 0.2s" }}
                onMouseEnter={e => e.currentTarget.style.background = `${T.accent}05`} onMouseLeave={e => e.currentTarget.style.background = x.unread ? `${T.accent}03` : "transparent"}>
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <div style={{ width: 42, height: 42, borderRadius: 13, background: `${x.color}0A`, border: `1px solid ${x.color}15`, display: "flex", alignItems: "center", justifyContent: "center" }}><Icon size={18} style={{ color: x.color }} /></div>
                  {x.unread && <div style={{ position: "absolute", top: -1, right: -1, width: 10, height: 10, borderRadius: "50%", background: T.accent, border: "2px solid white", boxShadow: `0 0 6px ${T.accent}40` }} />}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: x.unread ? 650 : 450, color: T.textPrimary }}>{x.title}</div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{x.desc}</div>
                </div>
                <span style={{ fontSize: 11, color: T.textMuted, flexShrink: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 500 }}>{x.time}</span>
              </div>
            </FadeIn>
          );})}
        </div>
      </div>
    </ScrollArea>
  );
};

const Questions = () => {
  const t = [
    { author: "佐藤", q: "レスポンシブでタブレット表示が崩れる", course: "AG", time: "3h", replies: 2, ok: false },
    { author: "鈴木", q: "Flexboxで縦中央揃えができない", course: "CSS", time: "1d", replies: 4, ok: true },
    { author: "田中", q: "模擬案件の納品形式について", course: "模擬案件", time: "2d", replies: 1, ok: false },
  ];
  return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "36px 40px 48px", maxWidth: 980 }}>
        <FadeIn><span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Support</span>
          <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 34, fontWeight: 800, color: T.dark, margin: "4px 0 28px", letterSpacing: "-0.04em" }}>質問スレッド</h1></FadeIn>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {t.map((x, i) => (
            <FadeIn key={i} delay={70 * i}>
              <div style={{ ...glassStyle(), borderRadius: 18, borderLeft: `4px solid ${x.ok ? T.success : T.warning}`, cursor: "pointer", transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)", padding: "20px 24px" }}
                onMouseEnter={e => { e.currentTarget.style.transform = "translateX(6px)"; e.currentTarget.style.boxShadow = "0 12px 40px rgba(10,22,40,0.07)"; }}
                onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 1px 3px rgba(10,22,40,0.04), 0 8px 32px rgba(10,22,40,0.03)"; }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar style={{ width: 28, height: 28 }}><AvatarFallback style={{ background: `linear-gradient(135deg, ${T.accent}, ${T.purple})`, color: "#fff", fontSize: 10, fontWeight: 700, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{x.author.charAt(0)}</AvatarFallback></Avatar>
                    <span style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{x.author}</span>
                    <Badge variant="secondary" style={{ fontSize: 10, fontWeight: 700, background: x.ok ? `${T.success}12` : `${T.warning}12`, color: x.ok ? T.success : T.warning, border: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{x.ok ? "Resolved" : "Open"}</Badge>
                  </div>
                  <span style={{ fontSize: 11, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{x.time}</span>
                </div>
                <div style={{ fontSize: 15, fontWeight: 650, color: T.dark, marginBottom: 10, fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif" }}>{x.q}</div>
                <div style={{ display: "flex", gap: 16, fontSize: 11, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
                  <span><BookOpen size={12} style={{ verticalAlign: "middle" }} /> {x.course}</span>
                  <span><MessageSquare size={12} style={{ verticalAlign: "middle" }} /> {x.replies} replies</span>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
};

const AdminCourses = () => {
  const c = [
    { name: "STEP1 ITリテラシー", s: 24, l: 12, st: "Live", icon: "it", color: "#6366F1" },
    { name: "STEP2 HTML", s: 24, l: 18, st: "Live", icon: "html", color: "#EF4444" },
    { name: "STEP3 CSS", s: 22, l: 20, st: "Live", icon: "css", color: "#3B82F6" },
    { name: "STEP4 Antigravity", s: 18, l: 24, st: "Live", icon: "ag", color: "#A78BFA" },
    { name: "STEP5 模擬案件", s: 10, l: 15, st: "Live", icon: "mock", color: "#F59E0B" },
    { name: "STEP6 ポートフォリオ作成", s: 6, l: 10, st: "Live", icon: "portfolio", color: "#22C55E" },
    { name: "STEP7 案件獲得", s: 0, l: 8, st: "Draft", icon: "sales", color: "#EC4899" },
  ];
  return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "36px 40px 48px", maxWidth: 1160 }}>
        <FadeIn>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 32 }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Manage</span>
              <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 34, fontWeight: 800, color: T.dark, margin: "4px 0 0", letterSpacing: "-0.04em" }}>コース管理</h1>
            </div>
            <Button style={{ background: T.accent, borderRadius: 12, fontWeight: 600, gap: 6, fontFamily: "var(--font-sora), 'Sora', sans-serif", boxShadow: `0 4px 16px ${T.accent}25` }}><Plus size={18} /> New Course</Button>
          </div>
        </FadeIn>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {c.map((x, i) => (
            <FadeIn key={i} delay={50 * i}>
              <div style={{ ...glassStyle(), borderRadius: 16, display: "flex", alignItems: "center", gap: 18, padding: "18px 24px", cursor: "pointer", transition: "all 0.25s" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = `${T.accent}40`; e.currentTarget.style.boxShadow = `0 8px 28px ${T.accent}08`; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = T.glassBorder; e.currentTarget.style.boxShadow = "0 1px 3px rgba(10,22,40,0.04), 0 8px 32px rgba(10,22,40,0.03)"; }}
              >
                <div style={{ width: 50, height: 50, borderRadius: 15, background: `${x.color}08`, border: `1.5px solid ${x.color}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: x.color }}>{CourseIcons[x.icon] ? CourseIcons[x.icon]({ size: 24 }) : x.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: T.dark, marginBottom: 4, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{x.name}</div>
                  <div style={{ display: "flex", gap: 16, fontSize: 11, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 500 }}>
                    <span>👥 {x.s}</span><span>📚 {x.l}</span>
                  </div>
                </div>
                <Badge variant="secondary" style={{ fontSize: 10, fontWeight: 700, background: x.st === "Live" ? `${T.success}12` : `${T.textMuted}12`, color: x.st === "Live" ? T.success : T.textMuted, border: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{x.st}</Badge>
                <Button variant="outline" size="sm" style={{ borderRadius: 10, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 600, fontSize: 12 }}>Edit</Button>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
};

const Placeholder = ({ title, desc }) => (
  <div style={{ padding: "36px 40px", maxWidth: 1160 }}>
    <FadeIn><span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Coming Soon</span>
      <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 34, fontWeight: 800, color: T.dark, margin: "4px 0 8px", letterSpacing: "-0.04em" }}>{title}</h1>
      <p style={{ color: T.textMuted, fontSize: 14 }}>{desc}</p></FadeIn>
    <FadeIn delay={100}>
      <div style={{ ...glassStyle(), marginTop: 40, borderRadius: 20, textAlign: "center", padding: 56 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🚧</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Under construction</div>
      </div>
    </FadeIn>
  </div>
);

// ═══════════════════════════════════════════
// LOGIN SCREEN
// ═══════════════════════════════════════════
const LoginScreen = ({ onLogin }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [hoveredBtn, setHoveredBtn] = useState(null);

  const T = createTheme(true); // Login always uses dark theme

  const handleSubmit = (role) => {
    onLogin(role);
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0B1120", position: "relative", overflow: "hidden",
      fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif",
    }}>
      {/* Noise texture */}
      <div style={{ position: "absolute", inset: 0, backgroundImage: T.noise, backgroundRepeat: "repeat", backgroundSize: "256px", pointerEvents: "none", zIndex: 1 }} />
      {/* Decorative circles */}
      <div style={{ position: "absolute", top: -120, right: -120, width: 400, height: 400, borderRadius: "50%", background: "radial-gradient(circle, rgba(59,130,246,0.12) 0%, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", bottom: -100, left: -100, width: 350, height: 350, borderRadius: "50%", background: "radial-gradient(circle, rgba(167,139,250,0.1) 0%, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", top: "40%", left: "60%", width: 250, height: 250, borderRadius: "50%", background: "radial-gradient(circle, rgba(52,211,153,0.06) 0%, transparent 70%)", pointerEvents: "none" }} />

      <FadeIn>
        <div style={{
          position: "relative", zIndex: 2, width: 420, padding: "44px 40px",
          background: "rgba(17,24,39,0.7)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 24,
          boxShadow: "0 1px 3px rgba(0,0,0,0.2), 0 8px 32px rgba(0,0,0,0.15), 0 32px 64px rgba(0,0,0,0.1)",
        }}>
          {/* Logo */}
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <img src="https://bennet.global/wp-content/uploads/2026/03/NWA.png" alt="NWA" style={{ height: 56, width: "auto", objectFit: "contain", filter: "brightness(0) invert(1)", opacity: 0.92, margin: "0 auto" }} />
            <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 20, fontWeight: 700, color: "#F1F5F9", margin: "20px 0 0", letterSpacing: "-0.02em" }}>
              Next World Academy へようこそ
            </h1>
            <p style={{ fontSize: 13, color: "#64748B", marginTop: 6 }}>ログインして学習を始めましょう</p>
          </div>

          {/* Email */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#94A3B8", fontFamily: "var(--font-sora), 'Sora', sans-serif", display: "block", marginBottom: 6 }}>メールアドレス</label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{
                width: "100%", padding: "12px 16px", borderRadius: 12, fontSize: 14,
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                color: "#F1F5F9", outline: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif",
                transition: "border-color 0.2s",
                boxSizing: "border-box",
              }}
              onFocus={e => e.currentTarget.style.borderColor = "#60A5FA"}
              onBlur={e => e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"}
            />
          </div>

          {/* Password */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#94A3B8", fontFamily: "var(--font-sora), 'Sora', sans-serif", display: "block", marginBottom: 6 }}>パスワード</label>
            <div style={{ position: "relative" }}>
              <input
                type={showPassword ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                style={{
                  width: "100%", padding: "12px 44px 12px 16px", borderRadius: 12, fontSize: 14,
                  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                  color: "#F1F5F9", outline: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif",
                  transition: "border-color 0.2s",
                  boxSizing: "border-box",
                }}
                onFocus={e => e.currentTarget.style.borderColor = "#60A5FA"}
                onBlur={e => e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"}
              />
              <button onClick={() => setShowPassword(!showPassword)} style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer", color: "#64748B", padding: 4,
                display: "flex", alignItems: "center",
              }}>
                {showPassword ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
          </div>

          {/* Role login buttons */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
            <button
              onClick={() => handleSubmit("student")}
              onMouseEnter={() => setHoveredBtn("student")}
              onMouseLeave={() => setHoveredBtn(null)}
              style={{
                width: "100%", padding: "13px 0", borderRadius: 12, border: "none", fontSize: 15, fontWeight: 700,
                cursor: "pointer", fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.01em",
                background: hoveredBtn === "student" ? "#3B82F6" : "#60A5FA",
                color: "#fff",
                boxShadow: "0 4px 16px rgba(96,165,250,0.35)",
                transition: "all 0.25s cubic-bezier(0.16,1,0.3,1)",
                transform: hoveredBtn === "student" ? "translateY(-1px)" : "none",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <GraduationCap size={18} /> 生徒としてログイン
              </span>
            </button>
            <button
              onClick={() => handleSubmit("admin")}
              onMouseEnter={() => setHoveredBtn("admin")}
              onMouseLeave={() => setHoveredBtn(null)}
              style={{
                width: "100%", padding: "13px 0", borderRadius: 12, fontSize: 15, fontWeight: 700,
                cursor: "pointer", fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.01em",
                background: hoveredBtn === "admin" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "#E2E8F0",
                transition: "all 0.25s cubic-bezier(0.16,1,0.3,1)",
                transform: hoveredBtn === "admin" ? "translateY(-1px)" : "none",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <BarChart3 size={18} /> 講師としてログイン
              </span>
            </button>
          </div>

          {/* Forgot password */}
          <div style={{ textAlign: "center" }}>
            <a href="#" onClick={e => e.preventDefault()} style={{
              fontSize: 12, color: "#60A5FA", textDecoration: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 500,
              transition: "opacity 0.2s",
            }}
              onMouseEnter={e => e.currentTarget.style.opacity = "0.7"}
              onMouseLeave={e => e.currentTarget.style.opacity = "1"}
            >パスワードを忘れた方</a>
          </div>
        </div>
      </FadeIn>
    </div>
  );
};

// ═══════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════
export default function NWALearningPlatform() {
  const [page, setPage] = useState("dashboard");
  const [admin, setAdmin] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  // Check localStorage on mount
  useEffect(() => {
    const role = localStorage.getItem("nwa-role");
    if (role) {
      setAdmin(role === "admin");
      setPage(role === "admin" ? "admin-dashboard" : "dashboard");
      setLoggedIn(true);
    }
    setAuthChecked(true);
  }, []);

  const handleLogin = (role) => {
    localStorage.setItem("nwa-role", role);
    setAdmin(role === "admin");
    setPage(role === "admin" ? "admin-dashboard" : "dashboard");
    setLoggedIn(true);
  };

  const handleLogout = () => {
    localStorage.removeItem("nwa-role");
    setLoggedIn(false);
    setAdmin(false);
  };

  const handlePageChange = (p) => { setPage(p); setMobileMenu(false); };

  // Update global T when theme changes
  T = createTheme(isDark);

  const handleThemeToggle = () => {
    setTransitioning(true);
    setTimeout(() => {
      setIsDark(!isDark);
      setTimeout(() => setTransitioning(false), 400);
    }, 150);
  };

  const pages = {
    "dashboard": <StudentDashboard setCurrentPage={handlePageChange} />,
    "courses": <CourseList setCurrentPage={handlePageChange} />,
    "lesson": <LessonView setCurrentPage={handlePageChange} />,
    "quiz": <QuizPage />,
    "notifications": <Notifications />,
    "questions": <Questions />,
    "admin-dashboard": <AdminDashboard />,
    "admin-students": <Placeholder title="生徒管理" desc="生徒の招待・詳細確認・アカウント管理" />,
    "admin-courses": <AdminCourses />,
    "admin-lessons": <Placeholder title="レッスン管理" desc="レッスンの作成・編集・並び替え" />,
    "admin-quiz": <Placeholder title="クイズ管理" desc="クイズの作成・編集・採点設定" />,
  };

  // Show nothing until auth check completes (prevents flash)
  if (!authChecked) return null;

  // Show login screen if not logged in
  if (!loggedIn) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <ThemeContext.Provider value={T}>
      <div style={{
        display: "flex", height: "100vh", width: "100%",
        fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif",
        backgroundColor: T.bg, color: T.textPrimary, overflow: "hidden",
        transition: "background-color 0.5s cubic-bezier(0.16,1,0.3,1), color 0.5s cubic-bezier(0.16,1,0.3,1)",
      }}>
        {/* Transition overlay */}
        {transitioning && (
          <div style={{
            position: "fixed", inset: 0, zIndex: 9999, pointerEvents: "none",
            background: isDark ? "rgba(11,17,32,0.4)" : "rgba(244,247,251,0.4)",
            animation: "themeFlash 0.55s ease-out forwards",
          }} />
        )}
        <style>{`
          @keyframes themeFlash {
            0% { opacity: 1; }
            100% { opacity: 0; }
          }
          * {
            transition-property: background-color, border-color, color, fill, stroke, box-shadow;
            transition-duration: 0.35s;
            transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
          }
          [style*="animation"], .recharts-surface *, svg * {
            transition: none !important;
          }

          /* ── Responsive ── */
          .nwa-sidebar { transition: transform 0.35s cubic-bezier(0.16,1,0.3,1), opacity 0.35s; }
          .nwa-sidebar-overlay { display: none; }
          .nwa-mobile-header { display: none !important; }
          .nwa-bento { grid-template-columns: repeat(12, 1fr) !important; }
          .nwa-lesson-sidebar { width: 340px !important; display: flex !important; }
          .nwa-admin-table-grid { grid-template-columns: 1.5fr 1fr 1.3fr 0.8fr 0.6fr !important; }

          @media (max-width: 1024px) {
            .nwa-bento { grid-template-columns: repeat(6, 1fr) !important; }
            .nwa-bento > [style*="span 3"] { grid-column: span 3 !important; }
            .nwa-bento > [style*="span 8"] { grid-column: span 6 !important; }
            .nwa-bento > [style*="span 4"] { grid-column: span 6 !important; }
            .nwa-bento > [style*="span 5"] { grid-column: span 6 !important; }
            .nwa-bento > [style*="span 12"] { grid-column: span 6 !important; }
            .nwa-lesson-sidebar { width: 280px !important; }
            .nwa-admin-table-grid { grid-template-columns: 1.5fr 1fr 1.2fr 0.7fr !important; }
            .nwa-admin-table-grid > div:nth-child(5n) { display: none; }
          }

          @media (max-width: 768px) {
            .nwa-sidebar { position: fixed !important; left: 0; top: 0; z-index: 200; height: 100vh !important; transform: translateX(-100%); opacity: 0; }
            .nwa-sidebar.open { transform: translateX(0); opacity: 1; }
            .nwa-sidebar-overlay { display: block; position: fixed; inset: 0; z-index: 199; background: rgba(0,0,0,0.4); backdrop-filter: blur(4px); }
            .nwa-mobile-header { display: flex !important; }
            .nwa-desktop-toggle { display: none !important; }
            .nwa-bento { grid-template-columns: 1fr !important; gap: 14px !important; }
            .nwa-bento > * { grid-column: span 1 !important; }
            .nwa-lesson-sidebar { display: none !important; }
            .nwa-lesson-main { min-width: 0 !important; }
            .nwa-admin-table-grid { grid-template-columns: 1.5fr 1.2fr 0.8fr !important; }
            .nwa-admin-table-grid > div:nth-child(5n),
            .nwa-admin-table-grid > div:nth-child(5n-1) { display: none; }
            .nwa-course-grid { grid-template-columns: 1fr !important; }
            .nwa-assign-grid { grid-template-columns: repeat(2, 1fr) !important; }
            .nwa-page-content { padding: 20px 16px 32px !important; }
          }

          @media (max-width: 480px) {
            .nwa-bento { gap: 12px !important; }
            .nwa-assign-grid { grid-template-columns: 1fr !important; }
          }
        `}</style>

        {/* Mobile menu overlay */}
        {mobileMenu && <div className="nwa-sidebar-overlay" onClick={() => setMobileMenu(false)} />}

        <div className={`nwa-sidebar ${mobileMenu ? "open" : ""}`}>
          <Sidebar currentPage={page} setCurrentPage={handlePageChange} isAdmin={admin} onLogout={handleLogout} />
        </div>
        <main style={{ flex: 1, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
          {/* Mobile header */}
          <div className="nwa-mobile-header" style={{
            display: "none", alignItems: "center", justifyContent: "space-between",
            padding: "10px 16px", borderBottom: `1px solid ${T.border}`, background: T.surface,
            position: "relative", zIndex: 10, flexShrink: 0,
          }}>
            <button onClick={() => setMobileMenu(true)} style={{
              background: "none", border: "none", cursor: "pointer", padding: 6, display: "flex",
              color: T.textPrimary,
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            <img src="https://bennet.global/wp-content/uploads/2026/03/NWA.png" alt="NWA" style={{ height: 36, objectFit: "contain", position: "absolute", left: "50%", transform: "translateX(-50%)", filter: isDark ? "brightness(0) invert(1)" : "none" }} />
            <ThemeToggle isDark={isDark} onToggle={handleThemeToggle} />
          </div>

          {/* Desktop theme toggle */}
          <div style={{ position: "absolute", top: 14, right: 20, zIndex: 50 }} className="nwa-desktop-toggle">
            <ThemeToggle isDark={isDark} onToggle={handleThemeToggle} />
          </div>
          {/* Background noise */}
          <div style={{
            position: "absolute", inset: 0,
            backgroundImage: T.noise, backgroundRepeat: "repeat", backgroundSize: "256px",
            pointerEvents: "none", zIndex: 0,
          }} />
          <div style={{ position: "relative", zIndex: 1, flex: 1, overflow: "hidden" }}>
            {pages[page] || pages["dashboard"]}
          </div>
        </main>
      </div>
    </ThemeContext.Provider>
  );
}
