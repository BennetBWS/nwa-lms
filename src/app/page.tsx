// @ts-nocheck
"use client";

import { useState, useEffect, useRef, useMemo, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import useSWR, { preload } from "swr";
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
  ChevronRight, Clock, FileText, HelpCircle, Lock, Search, ArrowLeft,
  Plus, TrendingUp, Award, Flame, CheckCircle2, PlayCircle, GraduationCap,
  LogOut, Target, Zap, Sparkles, ArrowUpRight, User
} from "lucide-react";
import {
  DEFAULT_STUDENT_TAB,
  STUDENT_TABS,
  confirmMessage,
  countStudentsByTab,
  formatDeactivatedDate,
  interpretStatusActionResponse,
  inviteErrorView,
  statusActionErrorMessage,
  studentsForTab,
} from "@/lib/admin-student-view";
import {
  classifyAuthFailure,
  createSessionExpiryHandler,
  fetchSessionView,
  makeAuthFetch,
} from "@/lib/client-session";
import { avatarInitial, displayName, greetingTitle } from "@/lib/user-display";
import { isInProgress, nextUpEmptyMessage, pickActiveCourse, toActivityItems, toNewsItems } from "@/lib/student-dashboard";
import { countCourseLessons, isCourseLocked } from "@/lib/course-lock";
import { commentsTabLabel, lessonTypeLabel, safeExternalUrl, toCommentItems } from "@/lib/lesson-comments";
import { pickInitialLesson } from "@/lib/initial-lesson";
import { addedThreadCount, firstPageRowCount, QUESTION_TABS, readThreadPage, threadListUrl, threadRowDelay, threadsAddedMessage, threadsEmptyMessage, threadsMoreHint, toQuestionThreadItems } from "@/lib/question-threads";
import {
  PASSING_PERCENT,
  QUIZ_ATTEMPTS_ENABLED,
  buildSubmitBody,
  quizResultTitle,
  toQuizCourseItems,
  toQuizResultView,
  toQuizTakeView,
} from "@/lib/student-quizzes";

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
  js: ({ size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 3l1.78 17.1L12 22l6.22-1.9L20 3H4z" fill="currentColor" opacity="0.12"/>
      <path d="M4 3l1.78 17.1L12 22l6.22-1.9L20 3H4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <text x="12" y="15" textAnchor="middle" fill="currentColor" fontSize="6" fontWeight="800" fontFamily="'Sora', sans-serif">JS</text>
    </svg>
  ),
  css: ({ size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 3l1.78 17.1L12 22l6.22-1.9L20 3H4z" fill="currentColor" opacity="0.12"/>
      <path d="M4 3l1.78 17.1L12 22l6.22-1.9L20 3H4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <text x="12" y="15" textAnchor="middle" fill="currentColor" fontSize="5.5" fontWeight="800" fontFamily="'Sora', sans-serif">CSS</text>
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

// ── Session expiry (#30) ──
// The logic lives in src/lib/client-session.ts; this only wires it to the browser.
// window.fetch must be called with the window as `this`, hence the arrow wrappers.
const browserFetch = (input, init) => fetch(input, init);
const checkSession = () => fetchSessionView(browserFetch);

// Signs out once and goes to /login. If signOut (or loading next-auth/react) fails,
// clear the cookie through /api/auth/session and go to /login anyway.
const expireSession = createSessionExpiryHandler({
  signOut: async () => {
    const { signOut } = await import("next-auth/react");
    await signOut({ callbackUrl: "/login" });
  },
  fallback: () => {
    fetch("/api/auth/session", { cache: "no-store" })
      .catch(() => {})
      .finally(() => window.location.assign("/login"));
  },
});

// NWALearningPlatform registers here to switch to the loading screen as soon as
// any API call finds the session revoked (no empty data while signing out).
let sessionExpiredListener = null;
const handleSessionExpired = () => {
  if (sessionExpiredListener) sessionExpiredListener();
  return expireSession();
};

// fetch for the page's API calls: 401 / redirect to /login -> sign out;
// 403 -> ask /api/auth/session whether the session is revoked or it is a real "forbidden".
const authFetch = makeAuthFetch({ fetch: browserFetch, onExpired: handleSessionExpired, checkSession });

// SWR fetcher — module-level so the global cache is shared across all components.
// An expired session (401, or a redirect to /login) is handled by authFetch (sign out
// and go to /login; the page shows the loading screen meanwhile), so it is not shown
// as a network error. Any other non-OK response throws.
const swrFetcher = async (url) => {
  const res = await authFetch(url);
  if (classifyAuthFailure({ status: res.status, redirected: res.redirected, url: res.url }) === "expired") {
    throw new Error("Not authenticated");
  }
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return res.json();
};

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

// #44 モーダルを document.body 直下に描画する。
// FadeIn（transform）や backdrop-filter を持つ親の中だと position: fixed が画面ではなく親を基準にし、
// overflow: hidden のカードで切れてしまうため。SSR・初回描画では document がないので、マウント後だけ描画する。
// Portal でも React のイベント（onClick など）は元のコンポーネントの木に沿って伝わる。
const ModalPortal = ({ children }) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
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
const Sidebar = ({ currentPage, setCurrentPage, isAdmin, onLogout, userName }) => {
  const studentNav = [
    { id: "dashboard", icon: Home, label: "ダッシュボード" },
    { id: "courses", icon: BookOpen, label: "コース一覧" },
    { id: "lesson", icon: Play, label: "レッスン" },
    { id: "quiz", icon: HelpCircle, label: "確認テスト受講" },
    { id: "notifications", icon: Bell, label: "通知" },
    { id: "questions", icon: MessageSquare, label: "質問" },
    { id: "settings", icon: Settings, label: "設定" },
  ];
  const adminNav = [
    { id: "admin-dashboard", icon: BarChart3, label: "管理ダッシュボード" },
    { id: "admin-students", icon: Users, label: "生徒管理" },
    { id: "admin-courses", icon: BookOpen, label: "コース管理" },
    { id: "admin-lessons", icon: Play, label: "レッスン管理" },
    { id: "admin-quiz", icon: HelpCircle, label: "クイズ管理" },
  ];
  const nav = isAdmin ? adminNav : studentNav;
  const shownName = displayName(userName) ?? "ユーザー";
  const initial = avatarInitial(userName);

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
              {item.badge != null && item.badge !== 0 && (
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
          <Avatar aria-hidden="true" style={{ width: 34, height: 34, boxShadow: "0 0 0 2px rgba(59,130,246,0.3)" }}>
            <AvatarFallback style={{ background: `linear-gradient(135deg, ${T.accent}, ${T.purple})`, color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{initial ?? <User size={16} strokeWidth={2} aria-hidden="true" />}</AvatarFallback>
          </Avatar>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div title={shownName} style={{ fontSize: 13, fontWeight: 600, color: "#fff", fontFamily: "var(--font-sora), 'Sora', sans-serif", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shownName}</div>
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
const StudentDashboard = ({ setCurrentPage, userName }) => {
  const [dashData, setDashData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // Guards against a second request while one is in flight (reload button, double clicks).
  const dashInFlight = useRef(false);

  // Fetch dashboard data from API.
  // An expired session is handled by authFetch (sign out and go to /login) rather
  // than silently rendering an empty dashboard. Any other failure shows an error card
  // instead of a dashboard filled with zeros.
  const loadDashboard = () => {
    if (dashInFlight.current) return;
    dashInFlight.current = true;
    setLoading(true);
    setLoadFailed(false);
    // Session expired (redirected to /login, or 401), judged by the same rule as
    // authFetch, which is moving to /login: keep the loading screen instead of
    // flashing the error card, and do not fetch again. Any other redirect or
    // non-ok response is a failure (error card).
    let sessionExpired = false;
    authFetch("/api/dashboard").then(res => {
      if (classifyAuthFailure({ status: res.status, redirected: res.redirected, url: res.url }) === "expired") { sessionExpired = true; return null; }
      if (!res.ok || res.redirected) return null;
      return res.json();
    }).then(data => {
      if (sessionExpired) return;
      if (data && !data.error) setDashData(data);
      else setLoadFailed(true);
    }).catch(() => setLoadFailed(true)).finally(() => {
      if (sessionExpired) return;
      dashInFlight.current = false;
      setLoading(false);
    });
  };

  useEffect(() => { loadDashboard(); }, []);

  const now = new Date();

  const courses = dashData?.courses?.map(c => ({
    id: c.id, name: c.name, progress: c.progress, lessons: c.totalLessons, icon: c.icon, color: c.color,
    completedLessons: c.completedLessons, totalLessons: c.totalLessons,
  })) || [];

  // Same rule as nextLessons on the API (in progress, otherwise the first unfinished
  // course, otherwise the first course).
  const activeCourse = pickActiveCourse(courses);
  const radial = [{ value: activeCourse?.progress || 0, fill: T.accentVivid, max: 100 }];

  const stats = [
    { label: "受講中", value: String(dashData?.activeCourses || 0), sub: `/ ${courses.length}`, icon: BookOpen, accent: T.accent, gradient: "linear-gradient(135deg, #3B82F6, #1D4ED8)" },
    { label: "完了", value: String(dashData?.completedLessons || 0), sub: "lessons", icon: CheckCircle2, accent: T.success, gradient: "linear-gradient(135deg, #22C55E, #16A34A)" },
    { label: "直近7日", value: String(dashData?.completedLast7Days || 0), sub: "lessons", icon: Flame, accent: T.purple, gradient: "linear-gradient(135deg, #A78BFA, #7C3AED)" },
    { label: "全体進度", value: String(dashData?.overallProgress || 0), sub: "%", icon: Target, accent: T.warning, gradient: "linear-gradient(135deg, #FBBF24, #D97706)" },
  ];

  const nextLessons = Array.isArray(dashData?.nextLessons) ? dashData.nextLessons : [];
  const news = toNewsItems(dashData?.notifications, now);
  const activity = toActivityItems(dashData?.recentActivity, now);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: T.textMuted }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 24, height: 24, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
        <div style={{ fontSize: 13, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Loading...</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );

  const header = (
    <FadeIn>
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <Sparkles size={14} style={{ color: T.accent }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Dashboard</span>
        </div>
        <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 26, fontWeight: 800, color: T.dark, margin: 0, letterSpacing: "-0.04em", overflowWrap: "anywhere" }}>{greetingTitle(userName)}</h1>
      </div>
    </FadeIn>
  );

  if (loadFailed || !dashData) return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "20px 36px 24px", maxWidth: 1200 }}>
        {header}
        <FadeIn delay={40}>
          <div role="alert" style={{ ...glassStyle(), borderRadius: 20, padding: "28px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>ダッシュボードを読み込めませんでした</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>時間をおいて、もう一度お試しください。</div>
            <Button size="sm" onClick={loadDashboard} disabled={loading} style={{ marginTop: 14, background: T.accent, color: "#fff", border: "none", borderRadius: 10, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, padding: "6px 15px" }}>
              再読み込み
            </Button>
          </div>
        </FadeIn>
      </div>
    </ScrollArea>
  );

  const emptyText = (text) => (
    <div style={{ fontSize: 12, color: T.textMuted, padding: "6px 0" }}>{text}</div>
  );

  return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "20px 36px 24px", maxWidth: 1200 }}>
        {header}

        {/* ═══ BENTO GRID ═══ */}
        <div className="nwa-bento" style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 14, gridAutoRows: "minmax(0, auto)" }}>

          {/* ── Row 1: Stats (3 cols each × 4) ── */}
          {stats.map((s, i) => {
            const Icon = s.icon;
            return (
              <FadeIn key={`s${i}`} delay={40 * i} direction="scale" style={{ gridColumn: "span 3" }}>
                <div style={{ ...glassStyle(), borderRadius: 16, padding: "13px 18px", position: "relative", overflow: "hidden", transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)", cursor: "default" }}
                  onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 12px 36px rgba(10,22,40,0.08)"; }}
                  onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = glassStyle().boxShadow; }}>
                  <div style={{ position: "absolute", top: -16, right: -16, width: 60, height: 60, borderRadius: "50%", background: s.gradient, opacity: 0.06, filter: "blur(16px)" }} />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative", zIndex: 1 }}>
                    <div>
                      <span style={{ fontSize: 10, fontWeight: 600, color: T.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{s.label}</span>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 3, marginTop: 4 }}>
                        <span style={{ fontSize: 25, fontWeight: 800, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.04em", lineHeight: 1 }}><AnimNum value={s.value} /></span>
                        <span style={{ fontSize: 11, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{s.sub}</span>
                      </div>
                    </div>
                    <div style={{ width: 32, height: 32, borderRadius: 10, background: s.gradient, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 3px 10px ${s.accent}20` }}>
                      <Icon size={15} style={{ color: "#fff" }} />
                    </div>
                  </div>
                </div>
              </FadeIn>
            );
          })}

          {/* ── Row 2: CTA (8) + Next Up (4)。コースが 0 件なら CTA を出さず Next Up を全幅に ── */}
          {activeCourse && (
            <FadeIn delay={80} style={{ gridColumn: "span 8" }}>
              <div onClick={() => setCurrentPage("lesson", { courseId: activeCourse.id })} style={{
                background: T.mode === "dark" ? "linear-gradient(135deg, #0F172A, #1E293B)" : T.gradientDark,
                borderRadius: 20, cursor: "pointer", overflow: "hidden", position: "relative",
                transition: "transform 0.4s cubic-bezier(0.16,1,0.3,1), box-shadow 0.4s", height: "100%", minHeight: 118,
              }}
                onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 16px 48px rgba(10,22,40,0.18)"; }}
                onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
                <div style={{ position: "absolute", inset: 0, backgroundImage: T.noise, backgroundRepeat: "repeat", backgroundSize: "256px", opacity: 0.5, pointerEvents: "none" }} />
                <div style={{ position: "absolute", top: 0, right: 0, width: "50%", height: "100%", background: "radial-gradient(ellipse at 80% 50%, rgba(59,130,246,0.1) 0%, transparent 65%)", pointerEvents: "none" }} />
                <div style={{ padding: "18px 26px", position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", alignItems: "center", height: "100%" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: T.emerald, boxShadow: `0 0 8px ${T.emerald}` }} />
                      <span style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Continue Learning</span>
                    </div>
                    <div style={{ fontSize: 19, fontWeight: 700, color: "#fff", fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.02em" }}>{activeCourse.name}</div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 2 }}>進捗: {activeCourse.progress}%</div>
                    <Button size="sm" style={{ marginTop: 10, background: T.accent, color: "#fff", border: "none", borderRadius: 10, fontWeight: 600, gap: 5, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, boxShadow: `0 4px 16px ${T.accent}40`, padding: "6px 15px" }}>
                      <PlayCircle size={14} /> 開く
                    </Button>
                  </div>
                  <div style={{ width: 84, height: 84, flexShrink: 0 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <RadialBarChart innerRadius={30} outerRadius={46} data={radial} startAngle={90} endAngle={-270}>
                        <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                        <RadialBar background={{ fill: "rgba(255,255,255,0.06)" }} dataKey="value" cornerRadius={12} fill={T.accentVivid} angleAxisId={0} />
                        <text x="50%" y="46%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 17, fontWeight: 800, fill: "#fff", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{activeCourse.progress}</text>
                        <text x="50%" y="64%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 9, fill: "rgba(255,255,255,0.35)", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>%</text>
                      </RadialBarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </FadeIn>
          )}

          <FadeIn delay={120} style={{ gridColumn: activeCourse ? "span 4" : "span 12" }}>
            <div style={{ ...glassStyle(), borderRadius: 20, height: "100%", display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "13px 20px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Next Up</h3>
              </div>
              <div style={{ padding: "0 20px 12px", flex: 1 }}>
                {nextLessons.length === 0
                  ? emptyText(nextUpEmptyMessage({ courseCount: courses.length, completedLessons: dashData.completedLessons, totalLessons: dashData.totalLessons }))
                  : nextLessons.map((l, i) => (
                    <div key={l.lessonId} onClick={() => setCurrentPage("lesson", { courseId: l.courseId })} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0", borderTop: i > 0 ? `1px solid ${T.borderSubtle}` : "none", cursor: "pointer", transition: "opacity 0.15s" }}
                      onMouseEnter={e => e.currentTarget.style.opacity = "0.6"} onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
                      <div style={{ width: 26, height: 26, borderRadius: 7, background: `${T.accent}0C`, border: `1px solid ${T.accent}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <PlayCircle size={12} style={{ color: T.accent }} />
                      </div>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: T.textPrimary, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</span>
                    </div>
                  ))}
              </div>
            </div>
          </FadeIn>

          {/* ── Row 3: Curriculum (12) ── */}
          <FadeIn delay={160} style={{ gridColumn: "span 12" }}>
            <div style={{ ...glassStyle(), borderRadius: 20, padding: "14px 22px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h2 style={{ fontSize: 14, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>カリキュラム進度</h2>
                <Button variant="ghost" size="sm" onClick={() => setCurrentPage("courses")} style={{ color: T.accent, fontWeight: 600, fontSize: 11, fontFamily: "var(--font-sora), 'Sora', sans-serif", gap: 3, padding: "4px 8px" }}>
                  詳細 <ArrowUpRight size={12} />
                </Button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {courses.length === 0 && emptyText("コースはまだありません")}
                {courses.map((c, i) => {
                  const Icon = CourseIcons[c.icon] || null;
                  // Judge by lesson counts, not the rounded % (1/300 shows 0%, 299/300 shows 100%)
                  const isAct = isInProgress(c);
                  const isDone = c.totalLessons > 0 && c.completedLessons === c.totalLessons;
                  const isLock = isCourseLocked(i > 0 ? courses[i - 1] : null, c);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 11, opacity: isLock ? 0.35 : 1 }}>
                      <div style={{
                        width: 26, height: 26, borderRadius: 8, flexShrink: 0,
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

          {/* ── Row 4: Announcements (6) + Activity (6) ── */}
          <FadeIn delay={200} style={{ gridColumn: "span 6" }}>
            <div style={{ ...glassStyle(), borderRadius: 20, height: "100%" }}>
              <div style={{ padding: "13px 20px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>お知らせ</h3>
                <Bell size={13} style={{ color: T.textMuted }} />
              </div>
              <div style={{ padding: "0 20px 12px" }}>
                {news.length === 0 && emptyText("お知らせはありません")}
                {news.map((n, i) => (
                  <div key={n.id} style={{ display: "flex", gap: 9, padding: "6px 0", borderTop: i > 0 ? `1px solid ${T.borderSubtle}` : "none" }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                      background: n.unread ? `linear-gradient(135deg, ${T.accent}, ${T.purple})` : T.mode === "dark" ? "rgba(255,255,255,0.06)" : "#E8EDF4",
                      color: n.unread ? "#fff" : T.textMuted,
                    }}>
                      <Bell size={12} aria-hidden="true" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: T.textPrimary, fontFamily: "var(--font-sora), 'Sora', sans-serif", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
                        {n.unread && <div aria-label="未読" style={{ width: 4, height: 4, borderRadius: "50%", background: T.accent, flexShrink: 0 }} />}
                        <span style={{ fontSize: 9, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif", marginLeft: "auto", flexShrink: 0 }}>{n.time}</span>
                      </div>
                      <div style={{ fontSize: 11, color: T.textSecondary, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={240} style={{ gridColumn: "span 6" }}>
            <div style={{ ...glassStyle(), borderRadius: 20, height: "100%" }}>
              <div style={{ padding: "13px 20px 8px" }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Activity</h3>
              </div>
              <div style={{ padding: "0 20px 12px" }}>
                {activity.length === 0 && emptyText("まだ学習履歴はありません")}
                {activity.map((a, i) => (
                  <div key={i} style={{ display: "flex", gap: 9, padding: "6px 0", borderTop: i > 0 ? `1px solid ${T.borderSubtle}` : "none" }}>
                    <div style={{ width: 26, height: 26, borderRadius: 7, background: `${T.success}0C`, border: `1px solid ${T.success}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <CheckCircle2 size={12} style={{ color: T.success }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: T.textPrimary, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.text}</div>
                      <div style={{ fontSize: 9, color: T.textMuted, marginTop: 2, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{a.time}</div>
                    </div>
                  </div>
                ))}
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
  const [apiCourses, setApiCourses] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch("/api/courses").then(r => r.json()).then(data => {
      if (Array.isArray(data)) setApiCourses(data);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const courses = apiCourses.map((c, i) => {
    const totalLessons = c.sections?.reduce((s, sec) => s + (sec.lessons?.length || 0), 0) || 0;
    // Same lock rule as the dashboard curriculum, judged by lesson counts (not the rounded %)
    const locked = isCourseLocked(i > 0 ? countCourseLessons(apiCourses[i - 1]) : null, countCourseLessons(c));
    return {
      id: c.id, name: c.name, desc: c.description || "", lessons: totalLessons,
      hours: Math.round(totalLessons * 0.5), progress: c.progress || 0,
      icon: c.icon, color: c.color, level: `STEP${c.order}`, students: 0, locked,
    };
  });

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
                onClick={() => !c.locked && setCurrentPage("lesson", { courseId: c.id })}
                style={{
                  ...glassStyle(), borderRadius: 20, overflow: "hidden",
                  cursor: c.locked ? "default" : "pointer", opacity: c.locked ? 0.45 : 1,
                  transition: "all 0.35s cubic-bezier(0.16,1,0.3,1)", position: "relative",
                }}
                onMouseEnter={e => { if (!c.locked) { e.currentTarget.style.transform = "translateY(-4px)"; e.currentTarget.style.boxShadow = "0 16px 48px rgba(10,22,40,0.1)"; preload(`/api/courses/${c.id}`, swrFetcher); }}}
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
const LessonView = ({ setCurrentPage, courseId, isDark, onThemeToggle }) => {
  const [expanded, setExpanded] = useState(0);
  const [activeLesson, setActiveLesson] = useState(null);
  const [completing, setCompleting] = useState(false);
  const [completedIds, setCompletedIds] = useState(new Set());
  const [toast, setToast] = useState(null);
  const initialized = useRef(false);

  // The lesson page can be opened without an explicit course (the sidebar "レッスン"
  // link and the dashboard CTA navigate to "lesson" with no courseId). When that
  // happens, fall back to the active/first course from the course list so SWR always
  // has a fetch key — otherwise the key is null, no request is ever made, and neither
  // `courseData` nor `courseError` is set, leaving the page stuck on the skeleton.
  const swrOpts = { revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false };
  const { data: courseList, error: listError } = useSWR(
    courseId ? null : "/api/courses",
    swrFetcher,
    swrOpts
  );
  const resolvedCourseId = useMemo(() => {
    if (courseId) return courseId;
    const list = Array.isArray(courseList) ? courseList : [];
    const active = list.find(c => c.progress > 0 && c.progress < 100);
    return (active || list[0])?.id || null;
  }, [courseId, courseList]);
  // No course could be resolved (course list loaded but empty, or it failed to load).
  const cannotResolve = !resolvedCourseId && (!!listError || Array.isArray(courseList));

  // SWR: global cache shared across components, deduplicates concurrent requests
  const { data: courseData, error: courseError, mutate: revalidateCourse } = useSWR(
    resolvedCourseId ? `/api/courses/${resolvedCourseId}` : null,
    swrFetcher,
    swrOpts
  );

  // Reset initialization flag and lesson state when switching courses
  useEffect(() => {
    initialized.current = false;
    setActiveLesson(null);
    setCompletedIds(new Set());
  }, [resolvedCourseId]);

  // Initialize completedIds and activeLesson from courseData (first load only)
  useEffect(() => {
    if (!courseData || courseData.error || initialized.current) return;
    initialized.current = true;
    const ids = new Set(
      (courseData.sections || []).flatMap(s =>
        (s.lessons || []).filter(l => l.completed).map(l => l.id)
      )
    );
    setCompletedIds(ids);
    // First incomplete lesson, else the first lesson of any section (null only when the course has no lessons)
    const first = pickInitialLesson(courseData.sections, l => !!l.completed);
    if (first) setActiveLesson(first);
  }, [courseData]);

  const allLessons = useMemo(() =>
    (courseData?.sections || []).flatMap(s => s.lessons || []),
    [courseData]
  );

  // Questions tab (#32): display only, posting is #46.
  // comments is { lessonId, rows } for the lesson the rows were loaded for (or null), so rows
  // of the previous lesson are never shown on the first render after switching lessons.
  const [comments, setComments] = useState(null);
  const [commentsLoading, setCommentsLoading] = useState(true);
  // Id of the lesson whose load failed, or null. Like comments, it is tied to a lesson so a failure
  // of the previous lesson is not shown on the first render after switching lessons.
  const [commentsFailedLessonId, setCommentsFailedLessonId] = useState(null);
  // The request whose response is still awaited ({ lessonId }), or null. A second load for
  // the same lesson while it is in flight is ignored; a load for another lesson replaces it,
  // and a response whose request is no longer current (the user switched lessons) is dropped.
  const commentsInFlight = useRef(null);

  // Same approach as loadNotifications in Notifications: an expired session is handled by
  // authFetch (sign out and go to /login), so keep the loading state and do not fetch again.
  // Any other redirect, non-ok response or non-array body is a failure.
  const loadComments = (lessonId) => {
    if (!lessonId) {
      commentsInFlight.current = null;
      setComments(null);
      setCommentsLoading(false);
      setCommentsFailedLessonId(null);
      return;
    }
    if (commentsInFlight.current && commentsInFlight.current.lessonId === lessonId) return;
    const req = { lessonId };
    commentsInFlight.current = req;
    const isCurrent = () => commentsInFlight.current === req;
    setComments(null);
    setCommentsLoading(true);
    setCommentsFailedLessonId(null);
    let sessionExpired = false;
    authFetch(`/api/comments/${encodeURIComponent(lessonId)}`).then(res => {
      if (!isCurrent()) return null;
      if (classifyAuthFailure({ status: res.status, redirected: res.redirected, url: res.url }) === "expired") { sessionExpired = true; return null; }
      if (!res.ok || res.redirected) return null;
      return res.json();
    }).then(data => {
      if (sessionExpired || !isCurrent()) return;
      if (Array.isArray(data)) setComments({ lessonId, rows: data });
      else setCommentsFailedLessonId(lessonId);
    }).catch(() => { if (isCurrent()) setCommentsFailedLessonId(lessonId); }).finally(() => {
      if (sessionExpired || !isCurrent()) return;
      commentsInFlight.current = null;
      setCommentsLoading(false);
    });
  };

  useEffect(() => { loadComments(activeLesson?.id); }, [activeLesson?.id]);

  // Rows of another lesson (the effect for the new lesson has not run yet) count as not loaded.
  const commentRows = comments && activeLesson?.id && comments.lessonId === activeLesson.id ? comments.rows : null;
  // A failure of another lesson (the effect for the new lesson has not run yet) counts as still loading.
  const commentsFailed = !!activeLesson?.id && commentsFailedLessonId === activeLesson.id;
  const commentItems = toCommentItems(commentRows, new Date());
  const commentsReady = !!activeLesson?.id && !commentsLoading && !commentsFailed && Array.isArray(commentRows);
  // With a lesson: waiting until its rows are loaded (or it failed). Without one: waiting while the
  // course has lessons (the first lesson is not chosen yet); a course with no lessons shows the empty message.
  const commentsWaiting = activeLesson?.id ? !commentsFailed && !commentsReady : allLessons.length > 0;
  const commentsShowFailed = !!activeLesson?.id && commentsFailed;
  const lessonTypeText = lessonTypeLabel(activeLesson?.type);
  const lessonDocUrl = safeExternalUrl(activeLesson?.content);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500); };

  const handleComplete = async (lessonId) => {
    // Optimistic update
    setCompletedIds(prev => new Set([...prev, lessonId]));
    setCompleting(true);
    try {
      await authFetch("/api/progress", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId }),
      });
      // Auto-navigate to next lesson
      const idx = allLessons.findIndex(l => l.id === lessonId);
      const next = allLessons[idx + 1];
      if (next) {
        setActiveLesson(next);
        for (let si = 0; si < (courseData?.sections || []).length; si++) {
          if (courseData.sections[si].lessons.some(l => l.id === next.id)) { setExpanded(si); break; }
        }
      } else {
        showToast("コース完了！おめでとうございます！");
      }
      // Revalidate SWR cache in background
      revalidateCourse();
    } finally {
      setCompleting(false);
    }
  };

  const isCompleted = (id) => completedIds.has(id);

  const sections = (courseData?.sections || []).map(sec => ({
    title: sec.title,
    lessons: (sec.lessons || []).map(l => ({
      id: l.id, title: l.title, dur: l.duration || "", done: isCompleted(l.id),
      type: l.type?.toLowerCase() || "video", active: activeLesson?.id === l.id, raw: l,
    })),
  }));
  const icons = { video: PlayCircle, quiz: HelpCircle, pdf: FileText, text: FileText };

  const skel = (w, h, extra = {}) => ({
    width: w, height: h, borderRadius: 8, background: T.borderSubtle,
    animation: "skeletonPulse 1.6s ease-in-out infinite", ...extra,
  });

  // Surface fetch failures instead of showing the skeleton forever. An expired session
  // is already handled by authFetch (sign out, loading screen, /login); this covers other errors
  // (course fetch failed, or no course could be resolved when none was selected).
  if (courseError || cannotResolve) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 14, color: T.textSecondary, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: T.dark }}>レッスンを読み込めませんでした</div>
      <div style={{ fontSize: 13, color: T.textMuted }}>通信エラーが発生しました。再読み込みしてください。</div>
      <div style={{ display: "flex", gap: 10 }}>
        <Button size="sm" onClick={() => revalidateCourse()} style={{ background: T.accent, color: "#fff", borderRadius: 10, fontWeight: 600, gap: 6 }}>再試行</Button>
        <Button size="sm" variant="ghost" onClick={() => setCurrentPage("courses")} style={{ color: T.textSecondary, borderRadius: 10, fontWeight: 600 }}>コース一覧へ</Button>
      </div>
    </div>
  );

  if (!courseData) return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <style>{`@keyframes skeletonPulse { 0%,100%{opacity:1} 50%{opacity:0.45} }`}</style>
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{ height: 52, background: T.surface, borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", padding: "0 28px", gap: 12 }}>
          <div style={skel(60, 18)} /><div style={{ width: 1, height: 20, background: T.border }} /><div style={skel(140, 18)} />
        </div>
        <div style={{ aspectRatio: "16/9", maxHeight: 440, ...skel("100%", "auto", { borderRadius: 0 }) }} />
        <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={skel("55%", 26)} />
          <div style={skel("80%", 15)} />
          <div style={skel("65%", 15)} />
          <div style={skel(160, 38, { marginTop: 8, borderRadius: 12 })} />
        </div>
      </div>
      <div style={{ width: 340, borderLeft: `1px solid ${T.border}`, background: T.surface }}>
        <div style={{ padding: "18px 20px", borderBottom: `1px solid ${T.border}` }}><div style={skel(120, 18)} /></div>
        {[1,2,3,4,5,6].map(i => (
          <div key={i} style={{ padding: "13px 20px 13px 46px", borderBottom: `1px solid ${T.borderSubtle}`, display: "flex", gap: 10, alignItems: "center" }}>
            <div style={skel(16, 16, { borderRadius: "50%", flexShrink: 0 })} />
            <div style={skel("70%", 13)} />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden", position: "relative" }}>
      {toast && (
        <div style={{
          position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)",
          zIndex: 100, background: T.success, color: "#fff", borderRadius: 12,
          padding: "12px 24px", fontSize: 14, fontWeight: 600,
          fontFamily: "var(--font-sora), 'Sora', sans-serif",
          boxShadow: `0 8px 24px ${T.success}50`, whiteSpace: "nowrap",
          animation: "slideDown 0.3s cubic-bezier(0.16,1,0.3,1)",
        }}>
          🎉 {toast}
          <style>{`@keyframes slideDown { from { opacity:0; transform:translateX(-50%) translateY(-8px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`}</style>
        </div>
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 28px", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
          <Button variant="ghost" size="sm" onClick={() => setCurrentPage("courses")} style={{ gap: 4, color: T.textSecondary, fontSize: 13, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
            <ArrowLeft size={16} /> Back
          </Button>
          <Separator orientation="vertical" style={{ height: 20 }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{courseData?.name || "コース"}</span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, width: 180 }}>
            <div style={{ flex: 1, height: 4, borderRadius: 99, background: T.borderSubtle, overflow: "hidden" }}>
              <div style={{ width: `${courseData?.progress || 0}%`, height: "100%", borderRadius: 99, background: `linear-gradient(90deg, ${T.accent}, ${T.accentVivid})`, transition: "width 0.6s cubic-bezier(0.16,1,0.3,1)" }} />
            </div>
            <span style={{ fontSize: 13, fontWeight: 800, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{courseData?.progress || 0}%</span>
          </div>
        </div>

        {/* Lesson hero */}
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
              {activeLesson?.type === "TEXT" ? <FileText size={32} style={{ color: "white" }} /> : <Play size={34} fill="white" style={{ color: "white", marginLeft: 4 }} />}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, opacity: 0.85, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{activeLesson?.title || ""}</div>
            <div style={{ fontSize: 12, opacity: 0.35, marginTop: 5, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{activeLesson?.duration || ""}</div>
          </div>
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 3, background: "rgba(255,255,255,0.06)" }}>
            {isCompleted(activeLesson?.id) && <div style={{ width: "100%", height: "100%", background: T.success, boxShadow: `0 0 12px ${T.success}60` }} />}
          </div>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="content" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <TabsList style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, borderRadius: 0, padding: "0 28px", height: "auto", justifyContent: "flex-start" }}>
            {[{ v: "content", l: "概要" }, { v: "resources", l: "教材" }, { v: "comments", l: commentsTabLabel(commentsReady ? commentItems.length : null) }].map(t => (
              <TabsTrigger key={t.v} value={t.v} style={{ borderRadius: 0, padding: "13px 20px", fontSize: 13, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", color: T.textSecondary }}>{t.l}</TabsTrigger>
            ))}
          </TabsList>
          <div style={{ flex: 1, overflow: "auto", background: T.bg, color: T.textPrimary }}>
            <TabsContent value="content" style={{ padding: 28 }}>
              <h2 style={{ fontSize: 22, fontWeight: 800, color: T.dark, margin: "0 0 12px", fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.03em" }}>{activeLesson?.title || ""}</h2>
              {lessonDocUrl && (
                <a href={lessonDocUrl} target="_blank" rel="noopener noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: T.accent, fontWeight: 600, textDecoration: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif", marginBottom: 16 }}>
                  <FileText size={14} /> Google Docsで開く →
                </a>
              )}
              <p style={{ fontSize: 14, color: T.textSecondary, lineHeight: 1.8, margin: "0 0 24px" }}>
                {activeLesson?.type === "TEXT" && lessonDocUrl ? "テキストレッスンです。上のリンクからGoogle Docsを開いて学習してください。" : "レッスン内容をご確認ください。"}
              </p>
              <div style={{ display: "flex", gap: 10, marginBottom: 28 }}>
                {activeLesson?.duration && <Badge variant="outline" style={{ gap: 4, padding: "5px 14px", fontSize: 12, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}><Clock size={13} /> {activeLesson.duration}</Badge>}
                {lessonTypeText && <Badge variant="outline" style={{ gap: 4, padding: "5px 14px", fontSize: 12, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}><FileText size={13} /> {lessonTypeText}</Badge>}
              </div>
              <Button
                onClick={() => activeLesson && !isCompleted(activeLesson.id) && handleComplete(activeLesson.id)}
                disabled={completing || isCompleted(activeLesson?.id)}
                style={{
                  background: isCompleted(activeLesson?.id) ? T.success : T.accent,
                  borderRadius: 12, fontWeight: 600, gap: 6,
                  fontFamily: "var(--font-sora), 'Sora', sans-serif",
                  boxShadow: `0 4px 16px ${isCompleted(activeLesson?.id) ? T.success : T.accent}30`,
                  transition: "all 0.3s cubic-bezier(0.16,1,0.3,1)",
                  opacity: completing ? 0.7 : 1,
                }}>
                <CheckCircle2 size={16} />
                {completing ? "保存中..." : isCompleted(activeLesson?.id) ? "✓ 完了済み" : "レッスン完了にする"}
              </Button>
            </TabsContent>
            <TabsContent value="resources" style={{ padding: 28 }}>
              <div style={{ ...glassStyle(8), borderRadius: 14, padding: "28px 24px", textAlign: "center", fontSize: 13, color: T.textMuted }}>教材は準備中です</div>
            </TabsContent>
            <TabsContent value="comments" style={{ padding: 28 }}>
              {commentsWaiting ? (
                <div style={{ ...glassStyle(8), borderRadius: 14, padding: "28px 24px", textAlign: "center", color: T.textMuted }}>
                  <div style={{ width: 24, height: 24, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
                  <div style={{ fontSize: 13, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Loading...</div>
                  <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                </div>
              ) : commentsShowFailed ? (
                <div role="alert" style={{ ...glassStyle(8), borderRadius: 14, padding: "28px 24px", textAlign: "center" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>質問を読み込めませんでした</div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>時間をおいて、もう一度お試しください。</div>
                  <Button size="sm" onClick={() => loadComments(activeLesson?.id)} disabled={commentsLoading} style={{ marginTop: 14, background: T.accent, color: "#fff", border: "none", borderRadius: 10, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, padding: "6px 15px" }}>
                    再読み込み
                  </Button>
                </div>
              ) : commentItems.length === 0 ? (
                <div style={{ ...glassStyle(8), borderRadius: 14, padding: "28px 24px", textAlign: "center", fontSize: 13, color: T.textMuted }}>まだ質問はありません</div>
              ) : (
                commentItems.map(c => (
                  <div key={c.id} style={{ marginBottom: 22 }}>
                    {[c, ...c.replies].map((x, xi) => (
                      <div key={x.id} style={{ display: "flex", gap: 12, marginLeft: xi === 0 ? 0 : 46, marginTop: xi === 0 ? 0 : 12 }}>
                        <Avatar aria-hidden="true" style={{ width: xi === 0 ? 34 : 28, height: xi === 0 ? 34 : 28, flexShrink: 0 }}>
                          <AvatarFallback style={{ background: x.isInstructor ? `linear-gradient(135deg, ${T.accent}, ${T.purple})` : "linear-gradient(135deg, #22C55E, #16A34A)", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{x.initial ?? <User size={15} strokeWidth={2} aria-hidden="true" />}</AvatarFallback>
                        </Avatar>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ ...glassStyle(8), borderRadius: 14, padding: "14px 18px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, fontFamily: "var(--font-sora), 'Sora', sans-serif", overflowWrap: "anywhere" }}>{x.name}</span>
                              {x.isInstructor && <Badge variant="outline" style={{ padding: "1px 8px", fontSize: 10, color: T.accent, borderColor: `${T.accent}40` }}>講師</Badge>}
                            </div>
                            <div style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{x.content}</div>
                          </div>
                          <span style={{ fontSize: 10, color: T.textMuted, paddingLeft: 4, marginTop: 4, display: "block", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{x.time}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </TabsContent>
          </div>
        </Tabs>
      </div>

      {/* Sidebar */}
      <ScrollArea className="nwa-lesson-sidebar" style={{ width: 340, borderLeft: `1px solid ${T.border}`, background: T.surface, flexShrink: 0 }}>
        <div style={{ padding: "12px 16px 12px 20px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Course Content</h3>
          <ThemeToggle isDark={isDark} onToggle={onThemeToggle} />
        </div>
        {sections.map((sec, si) => (
          <div key={si}>
            <button onClick={() => setExpanded(expanded === si ? -1 : si)}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "14px 20px", background: expanded === si ? `${T.accent}04` : "transparent", border: "none", borderBottom: `1px solid ${T.borderSubtle}`, cursor: "pointer", textAlign: "left", transition: "background 0.2s" }}>
              <ChevronRight size={13} style={{ color: T.textMuted, transform: expanded === si ? "rotate(90deg)" : "none", transition: "transform 0.3s cubic-bezier(0.16,1,0.3,1)" }} />
              <span style={{ fontSize: 13, fontWeight: 650, color: T.dark, flex: 1, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{sec.title}</span>
              <span style={{ fontSize: 10, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 600 }}>{sec.lessons.filter(l => l.done).length}/{sec.lessons.length}</span>
            </button>
            <div style={{ maxHeight: expanded === si ? `${sec.lessons.length * 50 + 8}px` : 0, overflow: "hidden", transition: "max-height 0.45s cubic-bezier(0.16,1,0.3,1)" }}>
              {sec.lessons.map((l, li) => {
                const Icon = icons[l.type] || PlayCircle;
                return (
                  <div key={li}
                    onClick={() => setActiveLesson(l.raw)}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 20px 10px 46px", borderBottom: `1px solid ${T.borderSubtle}`, background: l.active ? `${T.accent}06` : "transparent", cursor: "pointer", transition: "background 0.15s" }}
                    onMouseEnter={e => { if (!l.active) e.currentTarget.style.background = `${T.accent}03`; }}
                    onMouseLeave={e => { if (!l.active) e.currentTarget.style.background = "transparent"; }}
                  >
                    {l.done
                      ? <CheckCircle2 size={17} style={{ color: T.success, flexShrink: 0 }} />
                      : <Icon size={17} style={{ color: l.active ? T.accent : T.textMuted, flexShrink: 0 }} />}
                    <span style={{ flex: 1, fontSize: 13, fontWeight: l.active ? 600 : 400, color: l.active ? T.accent : T.textPrimary, lineHeight: 1.3 }}>{l.title}</span>
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
  const [adminData, setAdminData] = useState(null);
  const [inviteModal, setInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  // { httpStatus: number | null（通信エラーは null）, body, redirected: boolean } | null（未送信）
  const [inviteResponse, setInviteResponse] = useState(null);
  const [inviting, setInviting] = useState(false);
  // #7: 一覧は ?status=all で取得し、タブで絞り込む
  const [studentTab, setStudentTab] = useState(DEFAULT_STUDENT_TAB);
  // { action: "deactivate" | "reactivate", id, name } | null
  const [statusDialog, setStatusDialog] = useState(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState("");
  // 確認ダイアログを開いたボタン。閉じたらここにフォーカスを戻す（招待モーダルから開いた場合は null）
  const statusDialogTriggerRef = useRef(null);

  useEffect(() => {
    Promise.all([
      authFetch("/api/admin/students?status=all").then(r => r.json()),
      authFetch("/api/admin/courses").then(r => r.json()),
    ]).then(([studentsData, coursesData]) => {
      setAdminData({ students: Array.isArray(studentsData) ? studentsData : [], courses: Array.isArray(coursesData) ? coursesData : [] });
    }).catch(() => {});
  }, []);

  // 受講生一覧を再取得する。失敗しても例外は投げず、現在の一覧を残す
  const reloadStudents = async () => {
    try {
      const s = await authFetch("/api/admin/students?status=all").then(r => r.json());
      if (Array.isArray(s)) setAdminData(prev => prev ? { ...prev, students: s } : prev);
    } catch {
      // 一覧の再取得に失敗しても操作自体は完了しているため、ここでは何もしない
    }
  };

  const handleInvite = async () => {
    setInviting(true);
    try {
      let res;
      try {
        res = await authFetch("/api/admin/students/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: inviteEmail, name: inviteName }) });
      } catch {
        setInviteResponse({ httpStatus: null, body: null, redirected: false });
        return;
      }
      // 本文が JSON でない（ゲートウェイのエラーページなど）ときは body を null とし、ステータスだけで文言を決める
      const data = await res.json().catch(() => null);
      // redirected: セッション切れで /login にリダイレクトされ、ログイン画面を 200 で受け取った場合
      setInviteResponse({ httpStatus: res.status, body: data, redirected: res.redirected });
      if (res.ok && !res.redirected) await reloadStudents();
    } finally {
      setInviting(false);
    }
  };

  // trigger: ダイアログを開いたボタン（閉じたときのフォーカスの戻り先）。なければ null
  const openStatusDialog = (action, student, trigger = null) => {
    statusDialogTriggerRef.current = trigger;
    setStatusError("");
    setStatusDialog({ action, id: student.id, name: student.name });
  };

  const closeStatusDialog = () => {
    if (statusSaving) return;
    setStatusDialog(null);
  };

  // 確認ダイアログが開いている間だけ Esc で閉じる（処理中は closeStatusDialog が閉じない）
  useEffect(() => {
    if (!statusDialog) return;
    const onKeyDown = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeStatusDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [statusDialog, statusSaving]);

  // 確認ダイアログが閉じたら、開いたボタンにフォーカスを戻す。
  // 成功してタブから行が消えた場合などボタンが画面にないときは何もしない
  const statusDialogOpen = statusDialog !== null;
  useEffect(() => {
    if (statusDialogOpen) return;
    const trigger = statusDialogTriggerRef.current;
    statusDialogTriggerRef.current = null;
    if (trigger && trigger.isConnected) trigger.focus();
  }, [statusDialogOpen]);

  const handleStatusAction = async () => {
    // 処理中の二重送信を防ぐ（ボタンの disabled が反映される前の連打に備える）
    if (statusSaving) return;
    if (!statusDialog) return;
    const { action, id } = statusDialog;
    setStatusSaving(true);
    setStatusError("");
    try {
      let res;
      try {
        res = await authFetch(`/api/admin/students/${encodeURIComponent(id)}/${action}`, { method: "PUT" });
      } catch {
        setStatusError(statusActionErrorMessage(null));
        return;
      }
      // セッション切れで /login にリダイレクトされると、ログイン画面の HTML を 200 で受け取る。
      // 成功は「ok・リダイレクトなし・本文が対象の受講生の状態」のときだけ（判定は interpretStatusActionResponse）
      const body = await res.json().catch(() => null);
      const outcome = interpretStatusActionResponse({ ok: res.ok, redirected: res.redirected, status: res.status, body, targetId: id });
      if (outcome.kind !== "success") {
        setStatusError(outcome.message);
        return;
      }
      // レスポンスの状態をまず反映し、そのあと一覧を取り直す
      const { updated } = outcome;
      setAdminData(prev => prev ? { ...prev, students: prev.students.map(s => s.id === id ? { ...s, status: updated.status, deactivatedAt: updated.deactivatedAt } : s) } : prev);
      await reloadStudents();
      setStatusDialog(null);
    } finally {
      setStatusSaving(false);
    }
  };

  const monthly = [{ m: "Jan", a: 18, c: 6 }, { m: "Feb", a: 20, c: 8 }, { m: "Mar", a: 22, c: 10 }, { m: "Apr", a: 24, c: 12 }];
  const courseColors = ["#6366F1", "#EF4444", "#3B82F6", "#A78BFA", "#F59E0B", "#22C55E", "#EC4899"];
  const dist = (adminData?.courses || []).map((c, i) => ({ name: c.name.replace(/STEP\d\s/, "").substring(0, 8), value: c._count?.sections || 0, color: courseColors[i % courseColors.length] }));

  const students = (adminData?.students || []).map(s => {
    const progress = s.totalLessons > 0 ? Math.round((s.completedLessons / s.totalLessons) * 100) : 0;
    const progressStatus = progress >= 50 ? "good" : progress >= 20 ? "warn" : "alert";
    // status はアカウントの状態（active / deactivated）。進捗の評価は progressStatus
    return { id: s.id, name: s.name, course: "", progress, last: s.lastActive ? new Date(s.lastActive).toLocaleDateString() : "N/A", progressStatus, status: s.status === "deactivated" ? "deactivated" : "active", deactivatedAt: s.deactivatedAt ?? null };
  });
  const st = { good: { l: "良好", c: T.success }, warn: { l: "注意", c: T.warning }, alert: { l: "要対応", c: T.danger } };
  const studentCounts = countStudentsByTab(students);
  const visibleStudents = studentsForTab(students, studentTab);
  const inviteError = inviteResponse ? inviteErrorView(inviteResponse.httpStatus, inviteResponse.body, inviteResponse.redirected) : null;
  // 成功（2xx・リダイレクトなし・本文に初期パスワードあり）のときだけ本文を表示に使う
  const inviteResult = inviteResponse && !inviteError ? inviteResponse.body : null;
  const inviteDeactivatedStudent = inviteError?.deactivatedUserId ? students.find(s => s.id === inviteError.deactivatedUserId && s.status === "deactivated") : null;
  const adminFont = "var(--font-sora), 'Sora', sans-serif";

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
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Students</h3>
                <div role="tablist" aria-label="受講生の状態" style={{ display: "flex", gap: 4, padding: 3, borderRadius: 10, background: T.borderSubtle }}>
                  {STUDENT_TABS.map(tab => {
                    const selected = studentTab === tab.key;
                    return (
                      <button key={tab.key} type="button" role="tab" aria-selected={selected} onClick={() => setStudentTab(tab.key)}
                        style={{ border: "none", cursor: "pointer", borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: selected ? 700 : 500, background: selected ? T.glass : "transparent", color: selected ? T.dark : T.textMuted, boxShadow: selected ? "0 1px 3px rgba(10,22,40,0.08)" : "none", fontFamily: adminFont, whiteSpace: "nowrap" }}>
                        {tab.label}（{studentCounts[tab.key]}）
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, border: `1px solid ${T.border}`, borderRadius: 10, padding: "7px 14px", background: T.glass }}>
                  <Search size={14} style={{ color: T.textMuted }} />
                  <input placeholder="Search..." style={{ border: "none", outline: "none", fontSize: 12, width: 110, background: "transparent", color: T.textPrimary, fontFamily: "var(--font-sora), 'Sora', sans-serif" }} />
                </div>
                <Button size="sm" onClick={() => { setInviteModal(true); setInviteResponse(null); setInviteEmail(""); setInviteName(""); }} style={{ background: T.accent, borderRadius: 10, fontWeight: 600, gap: 4, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, boxShadow: `0 2px 8px ${T.accent}25` }}>
                  <Plus size={14} /> 招待
                </Button>
              </div>
              {/* Invite Modal */}
              {inviteModal && (
                <ModalPortal>
                <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, overflowY: "auto", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)", fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif", color: T.textPrimary }} onClick={() => setInviteModal(false)}>
                  <div onClick={e => e.stopPropagation()} style={{ ...glassStyle(), borderRadius: 20, padding: 32, width: 400, maxWidth: "90vw", maxHeight: "calc(100dvh - 32px)", overflowY: "auto", margin: "auto" }}>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: T.dark, margin: "0 0 20px", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>生徒を招待</h3>
                    {inviteResult?.password ? (
                      <div>
                        <div style={{ padding: 16, borderRadius: 12, background: `${T.success}10`, border: `1px solid ${T.success}30`, marginBottom: 16 }}>
                          <div style={{ fontSize: 13, color: T.success, fontWeight: 600, marginBottom: 8 }}>アカウント作成完了</div>
                          <div style={{ fontSize: 13, color: T.textPrimary, marginBottom: 4 }}>メール: <strong>{inviteResult.email}</strong></div>
                          <div style={{ fontSize: 13, color: T.textPrimary }}>パスワード: <strong>{inviteResult.password}</strong></div>
                        </div>
                        <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 16 }}>この情報を生徒に共有してください。パスワードは後から変更できます。</div>
                        <Button onClick={() => setInviteModal(false)} style={{ width: "100%", background: T.accent, borderRadius: 10 }}>閉じる</Button>
                      </div>
                    ) : (
                      <div>
                        {inviteError && (
                          <div style={{ padding: 10, borderRadius: 8, background: `${T.danger}10`, color: T.danger, fontSize: 13, marginBottom: 12 }}>
                            {inviteError.message}
                            {inviteDeactivatedStudent && (
                              <div style={{ marginTop: 8 }}>
                                <Button size="sm" variant="outline" onClick={() => { setInviteModal(false); openStatusDialog("reactivate", inviteDeactivatedStudent); }} style={{ borderRadius: 8, fontSize: 12 }}>
                                  {inviteDeactivatedStudent.name} さんを再有効化する
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                        <div style={{ marginBottom: 12 }}>
                          <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 4 }}>名前</label>
                          <input value={inviteName} onChange={e => setInviteName(e.target.value)} placeholder="山田 花子" style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.bg, color: T.textPrimary, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
                        </div>
                        <div style={{ marginBottom: 20 }}>
                          <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 4 }}>メールアドレス</label>
                          <input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="student@example.com" style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.bg, color: T.textPrimary, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <Button variant="outline" onClick={() => setInviteModal(false)} style={{ flex: 1, borderRadius: 10 }}>キャンセル</Button>
                          <Button onClick={handleInvite} disabled={inviting || !inviteEmail || !inviteName} style={{ flex: 1, background: T.accent, borderRadius: 10 }}>{inviting ? "作成中..." : "招待する"}</Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                </ModalPortal>
              )}
              {/* Deactivate / Reactivate confirm dialog (#7) */}
              {statusDialog && (
                <ModalPortal>
                <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, overflowY: "auto", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)", fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif", color: T.textPrimary }} onClick={closeStatusDialog}>
                  <div role="dialog" aria-modal="true" aria-labelledby="nwa-status-dialog-title" onClick={e => e.stopPropagation()} style={{ ...glassStyle(), borderRadius: 20, padding: 32, width: 420, maxWidth: "90vw", maxHeight: "calc(100dvh - 32px)", overflowY: "auto", margin: "auto" }}>
                    <h3 id="nwa-status-dialog-title" style={{ fontSize: 18, fontWeight: 700, color: T.dark, margin: "0 0 16px", fontFamily: adminFont }}>
                      {statusDialog.action === "deactivate" ? "受講生を無効化" : "受講生を再有効化"}
                    </h3>
                    <p style={{ fontSize: 13.5, lineHeight: 1.7, color: T.textPrimary, margin: "0 0 20px", whiteSpace: "pre-wrap" }}>
                      {confirmMessage(statusDialog.action, statusDialog.name)}
                    </p>
                    {statusError && <div role="alert" style={{ padding: 10, borderRadius: 8, background: `${T.danger}10`, color: T.danger, fontSize: 13, marginBottom: 12 }}>{statusError}</div>}
                    <div style={{ display: "flex", gap: 8 }}>
                      <Button variant="outline" autoFocus onClick={closeStatusDialog} disabled={statusSaving} style={{ flex: 1, borderRadius: 10 }}>キャンセル</Button>
                      <Button onClick={handleStatusAction} disabled={statusSaving} style={{ flex: 1, background: statusDialog.action === "deactivate" ? T.danger : T.accent, borderRadius: 10 }}>
                        {statusSaving ? "処理中..." : statusDialog.action === "deactivate" ? "無効化する" : "再有効化する"}
                      </Button>
                    </div>
                  </div>
                </div>
                </ModalPortal>
              )}
            </div>
            <div className="nwa-admin-table-grid" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1.3fr 0.8fr 0.9fr 0.9fr", padding: "10px 24px", borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
              <div>Name</div><div className="nwa-admin-col-course">Course</div><div>Progress</div><div className="nwa-admin-col-last">Last Seen</div><div className="nwa-admin-col-status">Status</div><div style={{ textAlign: "right" }}>Actions</div>
            </div>
            {visibleStudents.length === 0 && (
              <div style={{ padding: "24px", textAlign: "center", fontSize: 13, color: T.textMuted }}>該当する受講生はいません</div>
            )}
            {visibleStudents.map((s, i) => {
              const deactivated = s.status === "deactivated";
              // 無効の行は値（名前・進捗など）だけ薄く表示する。「無効」バッジ・無効化日・操作ボタンは読みやすさのため薄くしない
              const dim = deactivated ? 0.5 : 1;
              return (
              <div key={s.id} className="nwa-admin-table-grid" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1.3fr 0.8fr 0.9fr 0.9fr", padding: "14px 24px", borderBottom: i < visibleStudents.length - 1 ? `1px solid ${T.borderSubtle}` : "none", alignItems: "center", transition: "background 0.2s" }}
                onMouseEnter={e => e.currentTarget.style.background = `${T.accent}03`} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <Avatar style={{ width: 32, height: 32, flexShrink: 0, opacity: dim }}><AvatarFallback style={{ background: deactivated ? T.textMuted : `linear-gradient(135deg, ${T.accent}, ${T.purple})`, color: "#fff", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{s.name.charAt(0)}</AvatarFallback></Avatar>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: T.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: dim }}>{s.name}</span>
                  {deactivated && (
                    <Badge variant="secondary" style={{ fontSize: 10, fontWeight: 700, background: `${T.textMuted}20`, color: T.textMuted, border: "none", flexShrink: 0 }}>無効</Badge>
                  )}
                </div>
                <span className="nwa-admin-col-course" style={{ fontSize: 13, color: T.textSecondary, opacity: dim }}>{s.course}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: dim }}>
                  <div style={{ flex: 1, height: 4, borderRadius: 99, background: T.borderSubtle, overflow: "hidden" }}>
                    <div style={{ width: `${s.progress}%`, height: "100%", borderRadius: 99, background: `linear-gradient(90deg, ${T.accent}, ${T.accentVivid})` }} />
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, minWidth: 34, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{s.progress}%</span>
                </div>
                <span className="nwa-admin-col-last" style={{ fontSize: 12, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif", opacity: dim }}>{s.last}</span>
                <div className="nwa-admin-col-status">
                  {deactivated ? (
                    <span style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, whiteSpace: "nowrap" }}>無効化日 {formatDeactivatedDate(s.deactivatedAt)}</span>
                  ) : (
                    <Badge variant="secondary" style={{ fontSize: 10, fontWeight: 700, background: `${st[s.progressStatus]?.c}12`, color: st[s.progressStatus]?.c, border: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
                      {st[s.progressStatus]?.l}
                    </Badge>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  {deactivated ? (
                    <Button size="sm" variant="outline" onClick={e => openStatusDialog("reactivate", s, e.currentTarget)} style={{ borderRadius: 8, fontSize: 12, whiteSpace: "nowrap" }}>再有効化</Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={e => openStatusDialog("deactivate", s, e.currentTarget)} style={{ borderRadius: 8, fontSize: 12, whiteSpace: "nowrap", color: T.danger, borderColor: `${T.danger}40` }}>無効化</Button>
                  )}
                </div>
              </div>
              );
            })}
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
  // コースのアイコン。icon が "constructor" や "valueOf" などでも Object の組み込みを拾わないよう、
  // CourseIcons 自身が持つキーだけを使う（ほかの画面の同じ参照はこの PR では変えない）
  const quizCourseIcon = (icon) =>
    typeof icon === "string" && Object.prototype.hasOwnProperty.call(CourseIcons, icon) ? CourseIcons[icon] : null;

  // ── 一覧（/api/quizzes） ──
  const [quizData, setQuizData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // Guards against a second request while one is in flight (reload button, double clicks).
  const quizzesInFlight = useRef(false);

  // Same approach as loadNotifications: an expired session is handled by authFetch
  // (sign out and go to /login), so keep the loading screen and do not fetch again.
  // Any other redirect, non-ok response or a body without a courses array is a failure.
  const loadQuizzes = () => {
    if (quizzesInFlight.current) return;
    quizzesInFlight.current = true;
    setLoading(true);
    setLoadFailed(false);
    let sessionExpired = false;
    authFetch("/api/quizzes").then(res => {
      if (classifyAuthFailure({ status: res.status, redirected: res.redirected, url: res.url }) === "expired") { sessionExpired = true; return null; }
      if (!res.ok || res.redirected) return null;
      return res.json();
    }).then(data => {
      if (sessionExpired) return;
      if (data && Array.isArray(data.courses)) setQuizData(data);
      else setLoadFailed(true);
    }).catch(() => setLoadFailed(true)).finally(() => {
      if (sessionExpired) return;
      quizzesInFlight.current = false;
      setLoading(false);
    });
  };

  useEffect(() => { loadQuizzes(); }, []);

  // ── 受験（QUIZ_ATTEMPTS_ENABLED が false の間は開けない。#8 のあとに公開） ──
  const [activeQuizId, setActiveQuizId] = useState(null);
  const [takeQuiz, setTakeQuiz] = useState(null);
  const [takeLoading, setTakeLoading] = useState(false);
  const [takeFailed, setTakeFailed] = useState(false);
  const [answers, setAnswers] = useState([]);
  const [currentQ, setCurrentQ] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [result, setResult] = useState(null);

  // Bumped on every open / close: responses of a quiz that is no longer shown are dropped.
  const takeSeq = useRef(0);
  // Guards against a second submit while one is in flight (double clicks).
  const submitInFlight = useRef(false);

  const openQuiz = (quizId) => {
    if (!QUIZ_ATTEMPTS_ENABLED) return;
    takeSeq.current += 1;
    const seq = takeSeq.current;
    setActiveQuizId(quizId);
    setTakeQuiz(null);
    setTakeLoading(true);
    setTakeFailed(false);
    setAnswers([]);
    setCurrentQ(0);
    setSubmitFailed(false);
    setResult(null);
    let sessionExpired = false;
    authFetch(`/api/quizzes/${encodeURIComponent(quizId)}`).then(res => {
      if (classifyAuthFailure({ status: res.status, redirected: res.redirected, url: res.url }) === "expired") { sessionExpired = true; return null; }
      if (!res.ok || res.redirected) return null;
      return res.json();
    }).then(data => {
      if (sessionExpired || takeSeq.current !== seq) return;
      const view = toQuizTakeView(data);
      if (view) { setTakeQuiz(view); setAnswers(view.questions.map(() => null)); }
      else setTakeFailed(true);
    }).catch(() => { if (takeSeq.current === seq) setTakeFailed(true); }).finally(() => {
      if (sessionExpired || takeSeq.current !== seq) return;
      setTakeLoading(false);
    });
  };

  const closeQuiz = () => {
    if (submitInFlight.current) return;
    takeSeq.current += 1;
    setActiveQuizId(null);
    setTakeQuiz(null);
    setTakeLoading(false);
    setTakeFailed(false);
    setAnswers([]);
    setCurrentQ(0);
    setSubmitFailed(false);
    setResult(null);
  };

  const selectAnswer = (oi) => {
    if (submitInFlight.current) return;
    setAnswers(prev => prev.map((a, i) => (i === currentQ ? oi : a)));
  };

  // Sends all answers once. Scoring is done by the server only; the page shows its result.
  // On failure the answers are kept so that the same answers can be sent again.
  const submitQuiz = () => {
    if (!QUIZ_ATTEMPTS_ENABLED || submitInFlight.current || !takeQuiz) return;
    const body = buildSubmitBody(answers);
    if (!body) return;
    submitInFlight.current = true;
    const seq = takeSeq.current;
    const questionCount = takeQuiz.questions.length;
    setSubmitting(true);
    setSubmitFailed(false);
    let sessionExpired = false;
    authFetch(`/api/quizzes/${encodeURIComponent(takeQuiz.id)}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(res => {
      if (classifyAuthFailure({ status: res.status, redirected: res.redirected, url: res.url }) === "expired") { sessionExpired = true; return null; }
      if (!res.ok || res.redirected) return null;
      return res.json();
    }).then(data => {
      if (sessionExpired) return;
      const view = toQuizResultView(data, questionCount);
      if (!view) { if (takeSeq.current === seq) setSubmitFailed(true); return; }
      if (takeSeq.current === seq) setResult(view);
      // The best score and pass / fail in the list have changed.
      loadQuizzes();
    }).catch(() => { if (takeSeq.current === seq) setSubmitFailed(true); }).finally(() => {
      if (sessionExpired) return;
      submitInFlight.current = false;
      setSubmitting(false);
    });
  };

  const retakeQuiz = () => {
    if (submitInFlight.current || !takeQuiz) return;
    setAnswers(takeQuiz.questions.map(() => null));
    setCurrentQ(0);
    setSubmitFailed(false);
    setResult(null);
  };

  const spinner = (
    <div style={{ ...glassStyle(), borderRadius: 20, padding: "28px 24px", textAlign: "center", color: T.textMuted }}>
      <div style={{ width: 24, height: 24, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
      <div style={{ fontSize: 13, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Loading...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (QUIZ_ATTEMPTS_ENABLED && activeQuizId !== null) {
    const questions = takeQuiz ? takeQuiz.questions : [];
    const q = questions[currentQ];
    const isLast = currentQ === questions.length - 1;
    const selectedAnswer = answers[currentQ] ?? null;
    const submitBody = buildSubmitBody(answers);

    let takeBody;
    if (takeLoading) {
      takeBody = spinner;
    } else if (takeFailed || !takeQuiz) {
      takeBody = (
        <div role="alert" style={{ ...glassStyle(), borderRadius: 20, padding: "28px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>テストを読み込めませんでした</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>時間をおいて、もう一度お試しください。</div>
          <Button size="sm" onClick={() => openQuiz(activeQuizId)} style={{ marginTop: 14, background: T.accent, color: "#fff", border: "none", borderRadius: 10, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, padding: "6px 15px" }}>
            再読み込み
          </Button>
        </div>
      );
    } else if (result) {
      takeBody = (
        <div style={{ ...glassStyle(), borderRadius: 22, padding: "40px 32px" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ width: 100, height: 100, margin: "0 auto 24px" }}>
              <ResponsiveContainer width="100%" height="100%">
                <RadialBarChart innerRadius={32} outerRadius={48} data={[{ value: result.score, fill: result.passed ? T.success : T.danger }]} startAngle={90} endAngle={-270}>
                  <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                  <RadialBar background={{ fill: T.borderSubtle }} dataKey="value" cornerRadius={14} angleAxisId={0} />
                  <text x="50%" y="46%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 20, fontWeight: 800, fill: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{result.score}</text>
                  <text x="50%" y="63%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 10, fill: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>点</text>
                </RadialBarChart>
              </ResponsiveContainer>
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 800, color: result.passed ? T.success : T.danger, fontFamily: "var(--font-sora), 'Sora', sans-serif", margin: "0 0 8px" }}>
              {quizResultTitle(result.passed)}
            </h2>
            <p style={{ fontSize: 14, color: T.textMuted, margin: "0 0 4px" }}>{result.score}点（{result.total}問中 {result.correct}問正解）</p>
            <p style={{ fontSize: 13, color: T.textSecondary, margin: "0 0 24px" }}>{PASSING_PERCENT}%以上の正解で合格です。</p>
          </div>
          <ol style={{ listStyle: "none", padding: 0, margin: "0 0 28px", borderTop: `1px solid ${T.borderSubtle}` }}>
            {questions.map((x, i) => (
              <li key={x.id} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 4px", borderBottom: `1px solid ${T.borderSubtle}` }}>
                <span style={{ fontSize: 12, color: T.textMuted, flexShrink: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif", minWidth: 48 }}>問題 {i + 1}</span>
                <span style={{ flex: 1, fontSize: 13, color: T.textPrimary, overflowWrap: "anywhere" }}>{x.question}</span>
                <span style={{ fontSize: 12, fontWeight: 700, flexShrink: 0, color: result.results[i] ? T.success : T.danger }}>{result.results[i] ? "正解" : "不正解"}</span>
              </li>
            ))}
          </ol>
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <Button variant="outline" onClick={retakeQuiz}
              style={{ borderRadius: 12, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 600 }}>もう一度受ける</Button>
            <Button onClick={closeQuiz}
              style={{ background: T.accent, borderRadius: 12, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 600, boxShadow: `0 4px 16px ${T.accent}30` }}>テスト一覧に戻る</Button>
          </div>
        </div>
      );
    } else {
      takeBody = (
        <div style={{ ...glassStyle(), borderRadius: 22, overflow: "hidden" }}>
          {/* Progress header */}
          <div style={{ padding: "20px 28px", borderBottom: `1px solid ${T.borderSubtle}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.accent, fontFamily: "var(--font-sora), 'Sora', sans-serif", overflowWrap: "anywhere" }}>{takeQuiz.title}</div>
              <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>問題 {currentQ + 1} / {questions.length}</div>
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }} aria-hidden="true">
              {questions.map((x, i) => (
                <div key={x.id} style={{ width: 20, height: 4, borderRadius: 99, background: i <= currentQ ? T.accent : T.borderSubtle, transition: "background 0.3s" }} />
              ))}
            </div>
          </div>

          {/* Question */}
          <div style={{ padding: "32px 28px" }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: T.dark, margin: "0 0 28px", fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif", lineHeight: 1.5, overflowWrap: "anywhere" }}>{q.question}</h2>
            <div role="radiogroup" aria-label={`問題 ${currentQ + 1} の選択肢`} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {q.options.map((opt, oi) => {
                const selected = selectedAnswer === oi;
                return (
                  <button key={oi} type="button" role="radio" aria-checked={selected} disabled={submitting} onClick={() => selectAnswer(oi)}
                    style={{
                      display: "flex", alignItems: "center", gap: 14, padding: "16px 20px",
                      borderRadius: 14, border: `2px solid ${selected ? T.accent : T.borderSubtle}`,
                      background: selected ? `${T.accent}08` : "transparent",
                      cursor: submitting ? "default" : "pointer", transition: "all 0.2s", textAlign: "left", width: "100%",
                    }}
                  >
                    <div style={{
                      width: 24, height: 24, borderRadius: "50%", border: `2px solid ${selected ? T.accent : T.textMuted}`,
                      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                      background: selected ? T.accent : "transparent", transition: "all 0.2s",
                    }}>
                      {selected && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff" }} />}
                    </div>
                    <span style={{ fontSize: 14, fontWeight: selected ? 600 : 450, color: selected ? T.dark : T.textSecondary, overflowWrap: "anywhere" }}>{opt}</span>
                  </button>
                );
              })}
            </div>

            {submitFailed && (
              <div role="alert" style={{ marginTop: 20, fontSize: 13, color: T.danger }}>
                送信できませんでした。回答はそのまま残っています。もう一度送信してください。
              </div>
            )}

            <div style={{ marginTop: 32, display: "flex", justifyContent: "space-between", gap: 12 }}>
              <Button variant="outline" disabled={currentQ === 0 || submitting} onClick={() => setCurrentQ(currentQ - 1)}
                style={{ borderRadius: 12, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 14 }}>
                前へ
              </Button>
              {!isLast ? (
                <Button
                  disabled={selectedAnswer === null}
                  onClick={() => setCurrentQ(currentQ + 1)}
                  style={{ background: selectedAnswer !== null ? T.accent : T.border, borderRadius: 12, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 14, padding: "10px 28px", gap: 6 }}
                >
                  次へ <ChevronRight size={16} />
                </Button>
              ) : (
                <Button
                  disabled={!submitBody || submitting}
                  onClick={submitQuiz}
                  style={{ background: submitBody && !submitting ? T.accent : T.border, borderRadius: 12, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 14, padding: "10px 28px", gap: 6 }}
                >
                  {submitting ? "送信中..." : submitFailed ? "もう一度送信する" : "回答を送信する"}
                </Button>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <ScrollArea style={{ height: "100%" }}>
        <div className="nwa-page-content" style={{ padding: "36px 40px 48px", maxWidth: 760 }}>
          <FadeIn>
            <Button variant="ghost" size="sm" onClick={closeQuiz} disabled={submitting}
              style={{ gap: 4, color: T.textSecondary, fontSize: 13, fontFamily: "var(--font-sora), 'Sora', sans-serif", marginBottom: 8 }}>
              <ArrowLeft size={16} /> テスト一覧に戻る
            </Button>
            {!result && (
              <p style={{ fontSize: 12, color: T.textMuted, margin: "0 0 16px" }}>回答は最後の問題で送信したときに保存されます。途中で戻ると、それまでの回答は保存されません。</p>
            )}
          </FadeIn>
          {takeBody}
        </div>
      </ScrollArea>
    );
  }

  const courses = toQuizCourseItems(quizData);

  const quizRow = (quiz, course, isFinal, isLastRow) => (
    <div key={quiz.id}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: isFinal ? "16px 26px" : "12px 26px 12px 42px",
        borderBottom: isLastRow ? "none" : `1px solid ${T.borderSubtle}`,
        background: quiz.status === "passed" ? `${T.success}04` : "transparent",
      }}
    >
      {quiz.status === "passed" ? (
        <CheckCircle2 size={isFinal ? 18 : 16} aria-hidden="true" style={{ color: T.success, flexShrink: 0 }} />
      ) : isFinal ? (
        <Award size={18} aria-hidden="true" style={{ color: course.color || T.accent, flexShrink: 0 }} />
      ) : (
        <div aria-hidden="true" style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${quiz.status === "failed" ? T.danger : T.textMuted}`, flexShrink: 0, opacity: quiz.status === "failed" ? 1 : 0.4 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: isFinal ? 14 : 13, fontWeight: isFinal ? 600 : 500, color: T.textPrimary, fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif", overflowWrap: "anywhere" }}>{quiz.title}</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2, fontFamily: "var(--font-sora), 'Sora', sans-serif", overflowWrap: "anywhere" }}>
          {quiz.lessonTitle ? `${quiz.lessonTitle} · ` : ""}{quiz.questionCount}問{quiz.attemptCount > 0 ? ` · 受験 ${quiz.attemptCount}回` : ""}
        </div>
      </div>
      {quiz.bestScore !== null && (
        <span style={{ fontSize: 13, fontWeight: 700, color: quiz.status === "passed" ? T.success : T.danger, fontFamily: "var(--font-sora), 'Sora', sans-serif", flexShrink: 0 }}>最高 {quiz.bestScore}点</span>
      )}
      <span style={{ fontSize: 11, fontWeight: 600, flexShrink: 0, color: quiz.status === "passed" ? T.success : quiz.status === "failed" ? T.danger : T.textMuted }}>{quiz.statusLabel}</span>
      {QUIZ_ATTEMPTS_ENABLED && !course.locked && (
        <Button size="sm" onClick={() => openQuiz(quiz.id)} style={{ background: course.color || T.accent, color: "#fff", borderRadius: 10, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, flexShrink: 0 }}>
          {quiz.attemptCount > 0 ? "もう一度受ける" : "受験する"}
        </Button>
      )}
    </div>
  );

  let body;
  if (loading) {
    body = spinner;
  } else if (loadFailed) {
    body = (
      <div role="alert" style={{ ...glassStyle(), borderRadius: 20, padding: "28px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>確認テストを読み込めませんでした</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>時間をおいて、もう一度お試しください。</div>
        <Button size="sm" onClick={loadQuizzes} disabled={loading} style={{ marginTop: 14, background: T.accent, color: "#fff", border: "none", borderRadius: 10, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, padding: "6px 15px" }}>
          再読み込み
        </Button>
      </div>
    );
  } else if (courses.length === 0) {
    body = (
      <div style={{ ...glassStyle(), borderRadius: 20, padding: "28px 24px", textAlign: "center", fontSize: 13, color: T.textMuted }}>受けられる確認テストはまだありません</div>
    );
  } else {
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {!QUIZ_ATTEMPTS_ENABLED && (
          <div role="status" style={{ ...glassStyle(), borderRadius: 16, padding: "14px 20px", fontSize: 13, color: T.textSecondary }}>
            受験は準備中です。いまは一覧と、これまでの結果だけを表示しています。
          </div>
        )}
        {courses.map((course, ci) => (
          <FadeIn key={course.id} delay={Math.min(80 * ci, 400)}>
            <div style={{ ...glassStyle(), borderRadius: 20, overflow: "hidden", opacity: course.locked ? 0.6 : 1 }}>
              {/* Course header */}
              <div style={{ padding: "22px 26px", display: "flex", alignItems: "center", gap: 16, borderBottom: `1px solid ${T.borderSubtle}` }}>
                <div style={{ width: 46, height: 46, borderRadius: 14, background: `${course.color || T.accent}0A`, border: `1.5px solid ${course.color || T.accent}18`, display: "flex", alignItems: "center", justifyContent: "center", color: course.color || T.accent, flexShrink: 0 }}>
                  {quizCourseIcon(course.icon) ? quizCourseIcon(course.icon)({ size: 22 }) : <BookOpen size={22} aria-hidden="true" />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ fontSize: 16, fontWeight: 700, color: T.dark, margin: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.02em", overflowWrap: "anywhere" }}>{course.name}</h3>
                  <span style={{ fontSize: 12, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>修了テスト {course.finalQuizzes.length}件 · ミニテスト {course.miniQuizzes.length}件</span>
                </div>
                {course.locked && (
                  <Badge variant="secondary" style={{ fontSize: 11, fontWeight: 700, background: T.borderSubtle, color: T.textMuted, border: "none", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
                    <Lock size={12} aria-hidden="true" style={{ marginRight: 4 }} /> 前のコースを終えると受けられます
                  </Badge>
                )}
              </div>

              {course.finalQuizzes.length > 0 && (
                <div>
                  <div style={{ padding: "10px 26px 4px", fontSize: 11, fontWeight: 600, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>修了テスト</div>
                  {course.finalQuizzes.map((quiz, i) => quizRow(quiz, course, true, i === course.finalQuizzes.length - 1 && course.miniQuizzes.length === 0))}
                </div>
              )}

              {course.miniQuizzes.length > 0 && (
                <div style={{ borderTop: course.finalQuizzes.length > 0 ? `1px solid ${T.borderSubtle}` : "none" }}>
                  <div style={{ padding: "10px 26px 4px", fontSize: 11, fontWeight: 600, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>ミニテスト</div>
                  {course.miniQuizzes.map((quiz, i) => quizRow(quiz, course, false, i === course.miniQuizzes.length - 1))}
                </div>
              )}
            </div>
          </FadeIn>
        ))}
      </div>
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
          <p style={{ fontSize: 14, color: T.textMuted, margin: "0 0 32px" }}>コースごとの修了テストと、レッスンごとのミニテストです。{PASSING_PERCENT}%以上の正解で合格です。</p>
        </FadeIn>
        {body}
      </div>
    </ScrollArea>
  );
};

// ═══════════════════════════════════════════
// NOTIFICATIONS / QUESTIONS / ADMIN COURSES
// ═══════════════════════════════════════════
const Notifications = () => {
  const [notifs, setNotifs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // Guards against a second request while one is in flight (reload button, double clicks).
  const notifsInFlight = useRef(false);

  // Same approach as loadDashboard in StudentDashboard: an expired session is handled
  // by authFetch (sign out and go to /login), so keep the loading screen and do not
  // fetch again. Any other redirect, non-ok response or non-array body is a failure.
  const loadNotifications = () => {
    if (notifsInFlight.current) return;
    notifsInFlight.current = true;
    setLoading(true);
    setLoadFailed(false);
    let sessionExpired = false;
    authFetch("/api/notifications").then(res => {
      if (classifyAuthFailure({ status: res.status, redirected: res.redirected, url: res.url }) === "expired") { sessionExpired = true; return null; }
      if (!res.ok || res.redirected) return null;
      return res.json();
    }).then(data => {
      if (sessionExpired) return;
      if (Array.isArray(data)) setNotifs(data);
      else setLoadFailed(true);
    }).catch(() => setLoadFailed(true)).finally(() => {
      if (sessionExpired) return;
      notifsInFlight.current = false;
      setLoading(false);
    });
  };

  useEffect(() => { loadNotifications(); }, []);

  const now = new Date();
  const n = toNewsItems(notifs, now);

  let body;
  if (loading) {
    body = (
      <div style={{ ...glassStyle(), borderRadius: 20, padding: "28px 24px", textAlign: "center", color: T.textMuted }}>
        <div style={{ width: 24, height: 24, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
        <div style={{ fontSize: 13, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Loading...</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  } else if (loadFailed) {
    body = (
      <div role="alert" style={{ ...glassStyle(), borderRadius: 20, padding: "28px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>通知を読み込めませんでした</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>時間をおいて、もう一度お試しください。</div>
        <Button size="sm" onClick={loadNotifications} disabled={loading} style={{ marginTop: 14, background: T.accent, color: "#fff", border: "none", borderRadius: 10, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, padding: "6px 15px" }}>
          再読み込み
        </Button>
      </div>
    );
  } else if (n.length === 0) {
    body = (
      <div style={{ ...glassStyle(), borderRadius: 20, padding: "28px 24px", textAlign: "center", fontSize: 13, color: T.textMuted }}>通知はありません</div>
    );
  } else {
    body = (
      <div style={{ ...glassStyle(), borderRadius: 20, overflow: "hidden" }}>
        {n.map((x, i) => (
          <FadeIn key={x.id} delay={Math.min(50 * i, 500)}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "18px 24px", borderBottom: i < n.length - 1 ? `1px solid ${T.borderSubtle}` : "none", background: x.unread ? `${T.accent}03` : "transparent" }}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <div style={{ width: 42, height: 42, borderRadius: 13, background: `${T.accent}0A`, border: `1px solid ${T.accent}15`, display: "flex", alignItems: "center", justifyContent: "center" }}><Bell size={18} aria-hidden="true" style={{ color: T.accent }} /></div>
                {x.unread && <div role="img" aria-label="未読" style={{ position: "absolute", top: -1, right: -1, width: 10, height: 10, borderRadius: "50%", background: T.accent, border: "2px solid white", boxShadow: `0 0 6px ${T.accent}40` }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: x.unread ? 650 : 450, color: T.textPrimary, overflowWrap: "anywhere" }}>{x.title}</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2, overflowWrap: "anywhere" }}>{x.message}</div>
              </div>
              <span style={{ fontSize: 11, color: T.textMuted, flexShrink: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontWeight: 500 }}>{x.time}</span>
            </div>
          </FadeIn>
        ))}
      </div>
    );
  }

  return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "36px 40px 48px", maxWidth: 880 }}>
        <FadeIn><span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Notifications</span>
          <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 34, fontWeight: 800, color: T.dark, margin: "4px 0 28px", letterSpacing: "-0.04em" }}>通知</h1></FadeIn>
        {body}
      </div>
    </ScrollArea>
  );
};

const Questions = () => {
  const [tab, setTab] = useState("all");
  const [threadRows, setThreadRows] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [expandedIds, setExpandedIds] = useState([]);
  // 1 ページ目の行数（表示の遅れの境界。未回答タブでは 20 件未満・0 件もある）
  const [firstPageCount, setFirstPageCount] = useState(0);
  // 「もっと見る」で読み足した結果の知らせ（role="status" で読み上げる）
  const [moreStatus, setMoreStatus] = useState("");

  // One request at a time (reload button, double clicks). A newer request (switching tabs)
  // makes the older one stale: its response is dropped and it no longer owns the in-flight flag.
  const threadsInFlight = useRef(false);
  const threadsSeq = useRef(0);
  // Once the session has expired, authFetch signs out and goes to /login: keep the loading
  // state and do not fetch again (same approach as Notifications).
  const threadsExpired = useRef(false);

  const requestThreads = (url, onPage, onFail, onDone) => {
    const seq = ++threadsSeq.current;
    threadsInFlight.current = true;
    let sessionExpired = false;
    authFetch(url).then(res => {
      if (classifyAuthFailure({ status: res.status, redirected: res.redirected, url: res.url }) === "expired") { sessionExpired = true; threadsExpired.current = true; return null; }
      if (!res.ok || res.redirected) return null;
      return res.json();
    }).then(data => {
      if (sessionExpired || seq !== threadsSeq.current) return;
      const page = readThreadPage(data);
      if (page) onPage(page);
      else onFail();
    }).catch(() => {
      if (!sessionExpired && seq === threadsSeq.current) onFail();
    }).finally(() => {
      if (sessionExpired || seq !== threadsSeq.current) return;
      threadsInFlight.current = false;
      onDone();
    });
  };

  // First page of a tab. Switching tabs starts over from the first page and drops the previous tab's response.
  const loadThreads = (forTab) => {
    if (threadsExpired.current) return;
    if (threadsInFlight.current && forTab === tab) return;
    setTab(forTab);
    setThreadRows([]);
    setNextCursor(null);
    setExpandedIds([]);
    setFirstPageCount(0);
    setLoading(true);
    setLoadFailed(false);
    setLoadingMore(false);
    setMoreFailed(false);
    setMoreStatus("");
    requestThreads(
      threadListUrl(forTab, null),
      page => { setThreadRows(page.threads); setNextCursor(page.nextCursor); setFirstPageCount(firstPageRowCount(page.threads)); },
      () => setLoadFailed(true),
      () => setLoading(false)
    );
  };

  const loadMore = () => {
    if (threadsExpired.current || threadsInFlight.current || nextCursor === null) return;
    setLoadingMore(true);
    setMoreFailed(false);
    setMoreStatus("");
    requestThreads(
      threadListUrl(tab, nextCursor),
      page => { setMoreStatus(threadsAddedMessage(addedThreadCount(threadRows, page.threads))); setThreadRows(prev => [...prev, ...page.threads]); setNextCursor(page.nextCursor); },
      () => setMoreFailed(true),
      () => setLoadingMore(false)
    );
  };

  const toggleThread = (id) => setExpandedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  useEffect(() => { loadThreads("all"); }, []);

  const now = new Date();
  const items = toQuestionThreadItems(threadRows, now);

  let body;
  if (loading) {
    body = (
      <div style={{ ...glassStyle(), borderRadius: 20, padding: "28px 24px", textAlign: "center", color: T.textMuted }}>
        <div style={{ width: 24, height: 24, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
        <div style={{ fontSize: 13, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Loading...</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  } else if (loadFailed) {
    body = (
      <div role="alert" style={{ ...glassStyle(), borderRadius: 20, padding: "28px 24px", textAlign: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.dark, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>質問を読み込めませんでした</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>時間をおいて、もう一度お試しください。</div>
        <Button size="sm" onClick={() => loadThreads(tab)} disabled={loading} style={{ marginTop: 14, background: T.accent, color: "#fff", border: "none", borderRadius: 10, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, padding: "6px 15px" }}>
          再読み込み
        </Button>
      </div>
    );
  } else if (items.length === 0 && nextCursor === null) {
    // 未回答タブはサーバーで判定して絞るため、0 件でも続き（nextCursor）がありうる。そのときは下の「もっと見る」を出す
    body = (
      <div style={{ ...glassStyle(), borderRadius: 20, padding: "28px 24px", textAlign: "center", fontSize: 13, color: T.textMuted }}>{threadsEmptyMessage(tab)}</div>
    );
  } else {
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {items.map((x, i) => {
          const open = expandedIds.includes(x.id);
          const regionId = `question-thread-${x.id}`;
          const place = [x.courseName, x.lessonTitle].filter(Boolean).join(" / ");
          return (
            <FadeIn key={x.id} delay={threadRowDelay(i, firstPageCount)}>
              <div style={{ ...glassStyle(), borderRadius: 18, borderLeft: `4px solid ${x.answered ? T.success : T.warning}`, overflow: "hidden" }}>
                <button type="button" aria-expanded={open} aria-controls={open ? regionId : undefined} onClick={() => toggleThread(x.id)} style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "20px 24px", cursor: "pointer", color: "inherit", font: "inherit" }}>
                  <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
                      <Avatar aria-hidden="true" style={{ width: 28, height: 28, flexShrink: 0 }}>
                        <AvatarFallback style={{ background: x.isInstructor ? `linear-gradient(135deg, ${T.accent}, ${T.purple})` : "linear-gradient(135deg, #22C55E, #16A34A)", color: "#fff", fontSize: 10, fontWeight: 700, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{x.initial ?? <User size={14} strokeWidth={2} aria-hidden="true" />}</AvatarFallback>
                      </Avatar>
                      <span style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, fontFamily: "var(--font-sora), 'Sora', sans-serif", overflowWrap: "anywhere" }}>{x.name}</span>
                      {x.isInstructor && <Badge variant="outline" style={{ padding: "1px 8px", fontSize: 10, color: T.accent, borderColor: `${T.accent}40` }}>講師</Badge>}
                      <Badge variant="secondary" style={{ fontSize: 10, fontWeight: 700, background: x.answered ? `${T.success}12` : `${T.warning}12`, color: x.answered ? T.success : T.warning, border: "none" }}>{x.answeredLabel}</Badge>
                    </span>
                    <span style={{ fontSize: 11, color: T.textMuted, flexShrink: 0, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{x.time}</span>
                  </span>
                  {/* ボタンの中は閉じているときの要約だけ（ボタン名として全文を読み上げさせない）。開いたら全文を下の領域に出すので、要約は出さない（本文を二重に出さない）。
                      開いたときのボタン名は投稿者・状態・日時・場所・返信数になる */}
                  {!open && <span style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", fontSize: 15, fontWeight: 600, color: T.dark, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif" }}>{x.summary}</span>}
                  <span style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10, fontSize: 11, color: T.textMuted, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
                    {place && <span style={{ overflowWrap: "anywhere" }}><BookOpen size={12} aria-hidden="true" style={{ verticalAlign: "middle" }} /> {place}</span>}
                    <span><MessageSquare size={12} aria-hidden="true" style={{ verticalAlign: "middle" }} /> 返信 {x.replyCount}件</span>
                  </span>
                </button>
                {open && (
                  <div id={regionId} style={{ padding: "4px 24px 20px", borderTop: `1px solid ${T.borderSubtle}` }}>
                    <div style={{ paddingTop: 14, fontSize: 15, fontWeight: 600, color: T.dark, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif" }}>{x.content}</div>
                    {x.replies.length === 0 ? (
                      <div style={{ fontSize: 12, color: T.textMuted, paddingTop: 14 }}>まだ返信はありません</div>
                    ) : (
                      x.replies.map(r => (
                        <div key={r.id} style={{ display: "flex", gap: 12, marginTop: 14 }}>
                          <Avatar aria-hidden="true" style={{ width: 28, height: 28, flexShrink: 0 }}>
                            <AvatarFallback style={{ background: r.isInstructor ? `linear-gradient(135deg, ${T.accent}, ${T.purple})` : "linear-gradient(135deg, #22C55E, #16A34A)", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{r.initial ?? <User size={15} strokeWidth={2} aria-hidden="true" />}</AvatarFallback>
                          </Avatar>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ ...glassStyle(8), borderRadius: 14, padding: "12px 16px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, fontFamily: "var(--font-sora), 'Sora', sans-serif", overflowWrap: "anywhere" }}>{r.name}</span>
                                {r.isInstructor && <Badge variant="outline" style={{ padding: "1px 8px", fontSize: 10, color: T.accent, borderColor: `${T.accent}40` }}>講師</Badge>}
                              </div>
                              <div style={{ fontSize: 13, color: T.textSecondary, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.content}</div>
                            </div>
                            <span style={{ fontSize: 10, color: T.textMuted, paddingLeft: 4, marginTop: 4, display: "block", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>{r.time}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </FadeIn>
          );
        })}
        {nextCursor !== null && (
          <div style={{ marginTop: 4, textAlign: "center" }}>
            {items.length === 0 && (
              <div style={{ ...glassStyle(), borderRadius: 20, padding: "20px 24px", marginBottom: 12, fontSize: 13, color: T.textMuted }}>{threadsMoreHint(tab)}</div>
            )}
            {moreFailed && (
              <div role="alert" style={{ fontSize: 12, color: T.textMuted, marginBottom: 10 }}>続きを読み込めませんでした。もう一度お試しください。</div>
            )}
            <Button size="sm" variant="outline" onClick={loadMore} disabled={loadingMore} style={{ borderRadius: 10, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 12, padding: "6px 15px" }}>
              {loadingMore ? "読み込み中..." : "もっと見る"}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "36px 40px 48px", maxWidth: 980 }}>
        <FadeIn><span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Support</span>
          <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 34, fontWeight: 800, color: T.dark, margin: "4px 0 20px", letterSpacing: "-0.04em" }}>質問スレッド</h1></FadeIn>
        <div role="group" aria-label="質問の絞り込み" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {QUESTION_TABS.map(t => (
            <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => { if (t.key !== tab) loadThreads(t.key); }} style={{ padding: "6px 14px", borderRadius: 999, border: `1px solid ${tab === t.key ? T.accent : T.border}`, background: tab === t.key ? `${T.accent}12` : "transparent", color: tab === t.key ? T.accent : T.textSecondary, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>
              {t.label}
            </button>
          ))}
        </div>
        {body}
        {/* 一覧が空の案内に切り替わっても消えないよう、body の外に置く */}
        <div role="status" aria-live="polite" className="sr-only">{moreStatus}</div>
      </div>
    </ScrollArea>
  );
};

const AdminCourses = () => {
  const [apiCourses, setApiCourses] = useState([]);
  useEffect(() => {
    authFetch("/api/admin/courses").then(r => r.json()).then(data => {
      if (Array.isArray(data)) setApiCourses(data);
    }).catch(() => {});
  }, []);
  const c = apiCourses.map(x => ({
    id: x.id, name: x.name, s: x._count?.sections || 0, l: x._count?.sections || 0, st: "Live", icon: x.icon, color: x.color,
  }));
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

// ═══════════════════════════════════════════
// SETTINGS PAGE
// ═══════════════════════════════════════════
const SettingsPage = () => {
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleChangePw = async () => {
    if (newPw !== confirmPw) { setMsg({ type: "error", text: "新しいパスワードが一致しません" }); return; }
    if (newPw.length < 8) { setMsg({ type: "error", text: "パスワードは8文字以上で入力してください" }); return; }
    setSaving(true);
    // true while moving to /login after a successful change: the button stays disabled
    let leaving = false;
    try {
      const res = await authFetch("/api/user/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }) });
      if (!res.ok) {
        // 400 (wrong current password etc.) / 5xx. A 401 is handled by authFetch (sign out)
        const errBody = await res.json().catch(() => null);
        setMsg({ type: "error", text: errBody?.error || `パスワードを変更できませんでした（${res.status}）` });
        return;
      }
      const data = await res.json();
      if (data?.error) { setMsg({ type: "error", text: data.error }); return; }
      // The server revoked every session, including this one (#11): sign out and go to /login.
      setMsg({ type: "success", text: "パスワードを変更しました。すべての端末からログアウトしました。ログイン画面に移動します…" });
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
      leaving = true;
      await new Promise(resolve => setTimeout(resolve, 2000));
      // Signs out once (falls back to clearing the cookie and going to /login if that fails)
      await handleSessionExpired();
    } catch {
      // leaving: the password was changed but the move to /login failed.
      // Otherwise the request or res.json() failed, so we cannot tell whether it changed.
      setMsg({
        type: "error",
        text: leaving
          ? "パスワードは変更されました。ログイン画面に移動できなかったため、ページを再読み込みしてください"
          : "パスワードを変更できたか確認できませんでした。ページを再読み込みして、新しいパスワードでログインできるか確認してください",
      });
      leaving = false;
    } finally {
      if (!leaving) setSaving(false);
    }
  };

  return (
    <ScrollArea style={{ height: "100%" }}>
      <div className="nwa-page-content" style={{ padding: "36px 40px 48px", maxWidth: 600 }}>
        <FadeIn>
          <span style={{ fontSize: 11, fontWeight: 600, color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>Settings</span>
          <h1 style={{ fontFamily: "var(--font-sora), 'Sora', sans-serif", fontSize: 34, fontWeight: 800, color: T.dark, margin: "4px 0 28px", letterSpacing: "-0.04em" }}>設定</h1>
        </FadeIn>
        <FadeIn delay={100}>
          <div style={{ ...glassStyle(), borderRadius: 20, padding: 28 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: T.dark, margin: "0 0 20px", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>パスワード変更</h3>
            {msg && <div style={{ padding: "10px 14px", borderRadius: 10, marginBottom: 16, background: msg.type === "error" ? `${T.danger}10` : `${T.success}10`, color: msg.type === "error" ? T.danger : T.success, fontSize: 13 }}>{msg.text}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 4 }}>現在のパスワード</label>
                <input type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)} style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.bg, color: T.textPrimary, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 4 }}>新しいパスワード</label>
                <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.bg, color: T.textPrimary, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 4 }}>パスワード確認</label>
                <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.bg, color: T.textPrimary, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
              </div>
              <Button onClick={handleChangePw} disabled={saving || !currentPw || !newPw || !confirmPw} style={{ background: T.accent, borderRadius: 10, fontWeight: 600, marginTop: 8 }}>{saving ? "変更中..." : "パスワードを変更"}</Button>
            </div>
          </div>
        </FadeIn>
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

// (LoginScreen moved to /login/page.tsx)
// ═══════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════
export default function NWALearningPlatform() {
  const [page, setPage] = useState("dashboard");
  // #30: who is signed in, from /api/auth/session (see src/lib/client-session.ts).
  // Nothing is rendered until the role is known, so a revoked instructor is never
  // shown the student screens with empty data.
  const [sessionView, setSessionView] = useState({ kind: "loading" });
  const [isDark, setIsDark] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [selectedCourseId, setSelectedCourseId] = useState(null);

  // Load the session on mount. Any API call that finds the session revoked
  // switches to "expired" through sessionExpiredListener.
  useEffect(() => {
    let cancelled = false;
    sessionExpiredListener = () => setSessionView({ kind: "expired" });
    checkSession().then(view => {
      if (cancelled) return;
      setSessionView(prev => prev.kind === "expired" ? prev : view);
      if (view.kind === "authenticated" && view.role === "INSTRUCTOR") setPage("admin-dashboard");
    });
    return () => {
      cancelled = true;
      sessionExpiredListener = null;
    };
  }, []);

  // Revoked: sign out once and go to /login (the loading screen stays meanwhile)
  useEffect(() => {
    if (sessionView.kind === "expired") expireSession();
  }, [sessionView.kind]);

  const admin = sessionView.kind === "authenticated" && sessionView.role === "INSTRUCTOR";

  const handleLogout = async () => {
    const { signOut } = await import("next-auth/react");
    signOut({ callbackUrl: "/login" });
  };

  const handlePageChange = (p, data) => {
    setPage(p); setMobileMenu(false);
    if (data?.courseId) setSelectedCourseId(data.courseId);
  };

  // Update global T when theme changes + toggle dark class on html
  T = createTheme(isDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  const handleThemeToggle = () => {
    setTransitioning(true);
    setTimeout(() => {
      setIsDark(!isDark);
      setTimeout(() => setTransitioning(false), 400);
    }, 150);
  };

  const pages = {
    "dashboard": <StudentDashboard setCurrentPage={handlePageChange} userName={sessionView.name} />,
    "courses": <CourseList setCurrentPage={handlePageChange} />,
    "lesson": <LessonView setCurrentPage={handlePageChange} courseId={selectedCourseId} isDark={isDark} onThemeToggle={handleThemeToggle} />,
    "quiz": <QuizPage />,
    "notifications": <Notifications />,
    "questions": <Questions />,
    "admin-dashboard": <AdminDashboard />,
    "admin-students": <Placeholder title="生徒管理" desc="生徒の招待・詳細確認・アカウント管理" />,
    "admin-courses": <AdminCourses />,
    "admin-lessons": <Placeholder title="レッスン管理" desc="レッスンの作成・編集・並び替え（管理APIは実装済み）" />,
    "admin-quiz": <Placeholder title="クイズ管理" desc="クイズの作成・編集・採点設定（管理APIは実装済み）" />,
    "settings": <SettingsPage />,
  };

  // Loading / signing out / connection error: no sidebar and no page content
  if (sessionView.kind !== "authenticated") {
    const failed = sessionView.kind === "error";
    return (
      <ThemeContext.Provider value={T}>
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14,
          height: "100vh", width: "100%", backgroundColor: T.bg, color: T.textSecondary,
          fontFamily: "var(--font-sora), 'Sora', sans-serif",
        }}>
          {failed ? (
            <>
              <div style={{ fontSize: 15, fontWeight: 600, color: T.dark }}>接続できませんでした</div>
              <div style={{ fontSize: 13, color: T.textMuted }}>通信状態を確認して、ページを再読み込みしてください。</div>
              <Button size="sm" onClick={() => window.location.reload()} style={{ background: T.accent, color: "#fff", borderRadius: 10, fontWeight: 600 }}>再読み込み</Button>
            </>
          ) : (
            <div role="status" aria-live="polite" style={{ fontSize: 13, color: T.textMuted }}>読み込み中…</div>
          )}
        </div>
      </ThemeContext.Provider>
    );
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

          /* ── Page content centering ── */
          .nwa-page-content { margin: 0 auto; }

          /* ── Responsive ── */
          .nwa-sidebar { transition: transform 0.35s cubic-bezier(0.16,1,0.3,1), opacity 0.35s; }
          .nwa-sidebar-overlay { display: none; }
          .nwa-mobile-header { display: none !important; }
          .nwa-bento { grid-template-columns: repeat(12, 1fr) !important; }
          .nwa-lesson-sidebar { width: 340px !important; display: flex !important; }
          .nwa-admin-table-grid { grid-template-columns: 1.5fr 1fr 1.3fr 0.8fr 0.9fr 0.9fr !important; }

          @media (max-width: 1024px) {
            .nwa-bento { grid-template-columns: repeat(6, 1fr) !important; }
            .nwa-bento > [style*="span 3"] { grid-column: span 3 !important; }
            .nwa-bento > [style*="span 8"] { grid-column: span 6 !important; }
            .nwa-bento > [style*="span 4"] { grid-column: span 6 !important; }
            .nwa-bento > [style*="span 5"] { grid-column: span 6 !important; }
            .nwa-bento > [style*="span 12"] { grid-column: span 6 !important; }
            .nwa-lesson-sidebar { width: 280px !important; }
            .nwa-admin-table-grid { grid-template-columns: 1.5fr 1fr 1.2fr 0.7fr 0.9fr !important; }
            .nwa-admin-table-grid > .nwa-admin-col-status { display: none; }
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
            .nwa-admin-table-grid { grid-template-columns: 1.5fr 1fr auto !important; }
            .nwa-admin-table-grid > .nwa-admin-col-course,
            .nwa-admin-table-grid > .nwa-admin-col-last,
            .nwa-admin-table-grid > .nwa-admin-col-status { display: none; }
            .nwa-course-grid { grid-template-columns: 1fr !important; }
            .nwa-assign-grid { grid-template-columns: repeat(2, 1fr) !important; }
            .nwa-page-content { padding: 20px 16px 32px !important; margin: 0 auto !important; }
          }

          @media (max-width: 480px) {
            .nwa-bento { gap: 12px !important; }
            .nwa-assign-grid { grid-template-columns: 1fr !important; }
          }
        `}</style>

        {/* Mobile menu overlay */}
        {mobileMenu && <div className="nwa-sidebar-overlay" onClick={() => setMobileMenu(false)} />}

        <div className={`nwa-sidebar ${mobileMenu ? "open" : ""}`}>
          <Sidebar currentPage={page} setCurrentPage={handlePageChange} isAdmin={admin} onLogout={handleLogout} userName={sessionView.name} />
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

          {/* Desktop theme toggle — hidden on lesson page (moved into sidebar header) */}
          {page !== "lesson" && (
            <div style={{ position: "absolute", top: 14, right: 20, zIndex: 50 }} className="nwa-desktop-toggle">
              <ThemeToggle isDark={isDark} onToggle={handleThemeToggle} />
            </div>
          )}
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
