"use client";

export default function NotFound() {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0B1120", fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif",
    }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 80, fontWeight: 800, color: "#60A5FA", fontFamily: "var(--font-sora), 'Sora', sans-serif", letterSpacing: "-0.04em", lineHeight: 1 }}>404</div>
        <div style={{ fontSize: 18, fontWeight: 600, color: "#F1F5F9", marginTop: 12 }}>ページが見つかりません</div>
        <div style={{ fontSize: 14, color: "#64748B", marginTop: 8, marginBottom: 24 }}>お探しのページは存在しないか、移動した可能性があります。</div>
        <a href="/" style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 24px",
          borderRadius: 12, background: "#60A5FA", color: "#fff", textDecoration: "none",
          fontSize: 14, fontWeight: 600, fontFamily: "var(--font-sora), 'Sora', sans-serif",
        }}>ダッシュボードに戻る</a>
      </div>
    </div>
  );
}
