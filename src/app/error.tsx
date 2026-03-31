"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0B1120", fontFamily: "var(--font-zen), 'Zen Kaku Gothic New', sans-serif",
    }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>&#x26A0;&#xFE0F;</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#F1F5F9", fontFamily: "var(--font-sora), 'Sora', sans-serif" }}>エラーが発生しました</div>
        <div style={{ fontSize: 14, color: "#64748B", marginTop: 8, marginBottom: 24 }}>問題が発生しました。もう一度お試しください。</div>
        <button onClick={reset} style={{
          padding: "10px 24px", borderRadius: 12, background: "#60A5FA", color: "#fff",
          border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600,
          fontFamily: "var(--font-sora), 'Sora', sans-serif",
        }}>再試行</button>
      </div>
    </div>
  );
}
