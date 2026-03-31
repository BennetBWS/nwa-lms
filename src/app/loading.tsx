export default function Loading() {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0B1120",
    }}>
      <div style={{
        width: 32, height: 32, border: "3px solid #1E293B",
        borderTopColor: "#60A5FA", borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
