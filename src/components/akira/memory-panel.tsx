"use client";
import { useEffect, useRef, useState } from "react";

type Note = { slug: string; title: string; description: string; type: string; updated: string };

const RELOCK_MS = 120_000; // auto-lock after 2 min idle

const chipColor: Record<string, string> = {
  project: "#37d39b", preference: "#ff5acf", fact: "#7fdcff", decision: "#ffb84d", reference: "#8fb2c9",
};

export function MemoryPanel() {
  const [open, setOpen] = useState(false); // panel expanded (only when unlocked)
  const [notes, setNotes] = useState<Note[] | null>(null); // null = locked
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pinRef = useRef(""); // held only while unlocked, for delete calls
  const relockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function lock() {
    setNotes(null); setOpen(false); setPin(""); setError(""); pinRef.current = "";
    if (relockTimer.current) clearTimeout(relockTimer.current);
  }
  function armRelock() {
    if (relockTimer.current) clearTimeout(relockTimer.current);
    relockTimer.current = setTimeout(lock, RELOCK_MS);
  }
  useEffect(() => () => { if (relockTimer.current) clearTimeout(relockTimer.current); }, []);

  async function unlock() {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/memory", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (!r.ok) { setError(r.status === 429 ? "Too many attempts." : "Wrong PIN."); return; }
      const { notes } = await r.json();
      pinRef.current = pin; setNotes(notes); setOpen(true); setPin(""); armRelock();
    } catch { setError("Couldn't reach the server."); }
    finally { setBusy(false); }
  }

  async function forget(slug: string) {
    armRelock();
    const r = await fetch(`/api/memory/${encodeURIComponent(slug)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pinRef.current }),
    });
    if (r.ok) setNotes((ns) => (ns ?? []).filter((n) => n.slug !== slug));
  }

  const unlocked = notes !== null;
  return (
    <div style={panel} onMouseMove={unlocked ? armRelock : undefined}>
      <div style={head} onClick={() => unlocked && setOpen((o) => !o)}>
        <span style={{ color: unlocked ? "#37d39b" : "#ffb84d" }}>{unlocked ? "🔓" : "🔒"}</span>
        <span style={{ fontWeight: 700, color: "#eaffff" }}>Settings</span>
        <span style={{ marginLeft: "auto", ...meta }}>
          {unlocked ? `Unlocked · ${notes!.length} notes` : "Locked — memory & sensitive info"}
        </span>
      </div>

      {!unlocked && (
        <div style={pinRow}>
          <input
            type="password" inputMode="numeric" value={pin} placeholder="PIN"
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlock()}
            style={pinInput} autoComplete="off"
          />
          <button onClick={unlock} disabled={busy || !pin} style={unlockBtn}>Unlock</button>
          {error && <span style={{ ...meta, color: "#ff8fdc" }}>{error}</span>}
        </div>
      )}

      {unlocked && open && (
        <div style={{ padding: "4px 6px 10px" }}>
          <div style={memTop}>
            <span style={{ ...meta, color: "#7fdcff", letterSpacing: 1.5 }}>◉ MEMORY</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <a href="#" style={lnk}>Open in Obsidian ↗</a>
              <button onClick={lock} style={relockBtn}>🔒 Lock</button>
            </div>
          </div>
          {notes!.length === 0 ? (
            <div style={{ ...meta, padding: "8px 8px 4px" }}>No notes yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Type</th><th style={th}>Note</th><th style={th}>Updated</th><th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {notes!.map((n) => (
                  <tr key={n.slug}>
                    <td style={td}>
                      <span style={{ ...chip, color: chipColor[n.type] ?? "#8fb2c9", background: `${chipColor[n.type] ?? "#8fb2c9"}22` }}>{n.type}</span>
                    </td>
                    <td style={td}>
                      <div style={{ color: "#eaffff", fontWeight: 600, fontSize: 13 }}>{n.title}</div>
                      <div style={{ color: "#8494a6", fontSize: 11.5, marginTop: 3 }}>{n.description}</div>
                    </td>
                    <td style={{ ...td, ...meta, whiteSpace: "nowrap" }}>{new Date(n.updated).toLocaleDateString()}</td>
                    <td style={td}>
                      <button onClick={() => forget(n.slug)} title="Forget" style={xBtn}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

const meta: React.CSSProperties = { color: "#6b7a8d", fontSize: 12, fontFamily: "ui-monospace, monospace" };
const panel: React.CSSProperties = { border: "1px solid #1c2c3d", borderRadius: 14, background: "rgba(7,13,22,.7)", overflow: "hidden" };
const head: React.CSSProperties = { display: "flex", alignItems: "center", gap: 11, padding: "14px 16px", cursor: "pointer" };
const pinRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "0 16px 15px", flexWrap: "wrap" };
const pinInput: React.CSSProperties = { width: 120, height: 34, borderRadius: 8, border: "1px solid #1c2c3d", background: "#0a1626", color: "#e6edf3", padding: "0 12px", fontFamily: "ui-monospace, monospace", letterSpacing: 3, outline: "none" };
const unlockBtn: React.CSSProperties = { height: 34, padding: "0 15px", borderRadius: 8, border: 0, background: "#7fdcff", color: "#04121c", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const memTop: React.CSSProperties = { display: "flex", alignItems: "center", padding: "10px 8px 8px" };
const lnk: React.CSSProperties = { fontSize: 11.5, color: "#7fdcff", textDecoration: "none", border: "1px solid rgba(127,220,255,.28)", borderRadius: 7, padding: "6px 11px" };
const relockBtn: React.CSSProperties = { fontSize: 11.5, color: "#ffb84d", border: "1px solid rgba(255,184,77,.35)", borderRadius: 7, padding: "6px 11px", background: "transparent", cursor: "pointer", fontFamily: "inherit" };
const th: React.CSSProperties = { ...meta, fontSize: 9.5, letterSpacing: 1.2, textTransform: "uppercase", textAlign: "left", padding: "6px 10px", borderBottom: "1px solid #13202e" };
const td: React.CSSProperties = { padding: "10px", borderBottom: "1px solid rgba(19,32,46,.6)", verticalAlign: "top" };
const chip: React.CSSProperties = { fontSize: 9, letterSpacing: 0.8, textTransform: "uppercase", borderRadius: 5, padding: "2px 7px", fontWeight: 700, whiteSpace: "nowrap" };
const xBtn: React.CSSProperties = { background: "transparent", border: 0, color: "#5f7186", cursor: "pointer", fontSize: 16, lineHeight: "16px" };
