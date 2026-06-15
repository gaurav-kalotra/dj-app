import { useEffect, useState } from "react";

export default function App() {
  const [wsStatus, setWsStatus] = useState("connecting…");

  useEffect(() => {
    const ws = new WebSocket("ws://localhost:8888/ws");
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === "connected") setWsStatus("backend connected ✓");
    };
    ws.onerror = () =>
      setWsStatus("backend unreachable — run: make backend");
    return () => ws.close();
  }, []);

  return (
    <div style={{ fontFamily: "monospace", padding: "2rem" }}>
      <h1>AXIOM</h1>
      <p>Autonomous DJ Agent</p>
      <p style={{ color: wsStatus.includes("✓") ? "limegreen" : "orange" }}>
        {wsStatus}
      </p>
    </div>
  );
}
