"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { Orb, type OrbMode } from "./orb";
import type { FleetSnapshot } from "@/lib/fleet-snapshot";
import { speak, createRecognizer, voiceSupport } from "@/lib/voice/speech";
import { splitSentences } from "@/lib/voice/chunk";

type RelayProposal = { projectId: string; sessionId: string; instruction: string };

export function Hud({ snapshot }: { snapshot: FleetSnapshot }) {
  const [mode, setMode] = useState<OrbMode>("idle");
  const [reply, setReply] = useState("");
  const [micOn, setMicOn] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [proposal, setProposal] = useState<RelayProposal | null>(null);
  const support = useRef(voiceSupport());
  const spokenBuffer = useRef("");
  const voiceOnRef = useRef(voiceOn);
  useEffect(() => {
    voiceOnRef.current = voiceOn;
  }, [voiceOn]);

  useEffect(() => {
    const m = localStorage.getItem("akira_mic");
    if (m !== null) setMicOn(m === "1");
    const v = localStorage.getItem("akira_voice");
    if (v !== null) setVoiceOn(v === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem("akira_mic", micOn ? "1" : "0");
  }, [micOn]);
  useEffect(() => {
    localStorage.setItem("akira_voice", voiceOn ? "1" : "0");
  }, [voiceOn]);

  const runTurn = useCallback((instruction?: string) => {
    setReply("");
    spokenBuffer.current = "";
    setMode("thinking");
    const qs = instruction ? `?instruction=${encodeURIComponent(instruction)}` : "";
    const es = new EventSource(`/api/akira/stream${qs}`);
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === "token") {
        setMode("speaking");
        setReply((r) => r + e.content);
        if (voiceOnRef.current) {
          spokenBuffer.current += e.content;
          const { ready, rest } = splitSentences(spokenBuffer.current);
          ready.forEach(speak);
          spokenBuffer.current = rest;
        }
      } else if (e.type === "navigate") {
        void goToProject(e.projectId, e.sessionId);
      } else if (e.type === "open_url") {
        window.open(e.url, "_blank", "noopener");
      } else if (e.type === "relay_proposal") {
        setProposal({ projectId: e.projectId, sessionId: e.sessionId, instruction: e.instruction });
      } else if (e.type === "persisted" || e.type === "error") {
        if (e.type === "error") {
          setReply((r) => r || "Good to see you, A'Keem. I couldn't compose a brief just now — tap to retry.");
        } else if (voiceOnRef.current && spokenBuffer.current.trim()) {
          speak(spokenBuffer.current);
        }
        setMode("idle");
        es.close();
      }
    };
    es.onerror = () => {
      setReply((r) => r || "Good to see you, A'Keem. I couldn't reach the brief just now — tap to retry.");
      setMode("idle");
      es.close();
    };
  }, []);

  useEffect(() => {
    runTurn("Brief the operator on the current fleet state.");
  }, [runTurn]);

  async function goToProject(projectId: string, sessionId?: string | null) {
    await fetch("/api/projects/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    if (sessionId) await fetch(`/api/sessions/${sessionId}/active`, { method: "POST" });
    window.location.href = "/dashboard";
  }

  function startMic() {
    if (!micOn) return;
    setMode("listening");
    const rec = createRecognizer({
      onResult: (t) => runTurn(t),
      onEnd: () => setMode((m) => (m === "listening" ? "idle" : m)),
    });
    rec?.start();
  }

  async function confirmRelay() {
    if (!proposal) return;
    const p = proposal;
    setProposal(null);
    setMode("thinking");
    setReply("");
    const res = await fetch("/api/akira/relay/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: p.sessionId, instruction: p.instruction }),
    });
    const reader = res.body?.getReader();
    const dec = new TextDecoder();
    if (!reader) {
      setMode("idle");
      return;
    }
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split("\n\n")) {
        const m = line.match(/^data: (.*)$/m);
        if (!m) continue;
        const e = JSON.parse(m[1]);
        if (e.type === "token") {
          setMode("speaking");
          setReply((r) => r + e.content);
        }
      }
    }
    setMode("idle");
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        padding: "60px 18px",
      }}
    >
      <div style={{ position: "fixed", top: 12, right: 16, display: "flex", gap: 10, zIndex: 10 }}>
        <button
          disabled={!support.current.stt}
          onClick={() => setMicOn((v) => !v)}
          title="Microphone (speech input)"
          style={toggleStyle(micOn, support.current.stt)}
        >
          {micOn ? "🎙 Mic On" : "🎙 Mic Off"}
        </button>
        <button
          disabled={!support.current.tts}
          onClick={() => setVoiceOn((v) => !v)}
          title="Voice (spoken replies)"
          style={toggleStyle(voiceOn, support.current.tts)}
        >
          {voiceOn ? "🔊 Voice On" : "🔇 Voice Off"}
        </button>
      </div>

      <Orb mode={mode} size={320} />

      <div style={{ marginTop: 18, maxWidth: 680, textAlign: "center", color: "#c4d3e3", lineHeight: 1.6, minHeight: 48 }}>
        {reply || (mode === "thinking" ? "…" : "")}
      </div>
      <div style={{ marginTop: 10, color: "#7fdcff", fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
        {snapshot.running.length} running · {snapshot.proposals.length} proposal(s) · health: {snapshot.health.verdict}
      </div>

      {micOn && (
        <button onClick={startMic} style={{ ...pillStyle, marginTop: 16 }}>
          🎤 Tap to speak
        </button>
      )}

      {proposal && (
        <div style={{ marginTop: 16, padding: 14, border: "1px solid #1f3347", borderRadius: 10, background: "#070d16" }}>
          <div style={{ marginBottom: 10 }}>
            Run “{proposal.instruction}” in {proposal.projectId}?
          </div>
          <button onClick={confirmRelay} style={pillStyle}>
            Confirm
          </button>
          <button onClick={() => setProposal(null)} style={{ ...pillStyle, marginLeft: 8 }}>
            Cancel
          </button>
        </div>
      )}

      <a href="/dashboard" style={{ marginTop: 22, color: "#6b7a8d", fontSize: 13 }}>
        Open full dashboard ↗
      </a>
    </div>
  );
}

const pillStyle: React.CSSProperties = {
  border: "1px solid rgba(127,220,255,.35)",
  color: "#7fdcff",
  background: "rgba(127,220,255,.05)",
  borderRadius: 30,
  padding: "9px 16px",
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
};

function toggleStyle(on: boolean, supported: boolean): React.CSSProperties {
  return {
    ...pillStyle,
    opacity: supported ? 1 : 0.4,
    cursor: supported ? "pointer" : "not-allowed",
    background: on ? "rgba(127,220,255,.14)" : "rgba(127,220,255,.03)",
  };
}
