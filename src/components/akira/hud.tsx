"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { Orb, type OrbMode } from "./orb";
import { Constellation } from "./constellation";
import type { FleetSnapshot } from "@/lib/fleet-snapshot";
import { speak, createRecognizer, voiceSupport } from "@/lib/voice/speech";
import { splitSentences } from "@/lib/voice/chunk";

type RelayProposal = { projectId: string; sessionId: string; instruction: string };

function greetingFor(d: Date): string {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Fade a block in the first time it scrolls into view. */
function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, inView };
}

export function Hud({ snapshot, initialBrief }: { snapshot: FleetSnapshot; initialBrief?: string | null }) {
  const [mode, setMode] = useState<OrbMode>("idle");
  const [reply, setReply] = useState("");
  const [voiceOn, setVoiceOn] = useState(true);
  const [proposal, setProposal] = useState<RelayProposal | null>(null);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [attachments, setAttachments] = useState<
    { id: string; name: string; size: number; isImage: boolean; url?: string; file: File }[]
  >([]);
  const [support, setSupport] = useState({ tts: false, stt: false });
  // Mic is push-to-talk (the 🎙 in the input bar) — privacy-safe: it only ever
  // listens on an explicit tap, so there's no persistent on/off to track.
  const [clock, setClock] = useState("");
  const [greeting, setGreeting] = useState("Hello");
  const [docked, setDocked] = useState(false);
  const [replyDim, setReplyDim] = useState(false);
  // Idle "going to sleep" stages: 0 active · 1 reply faded · 2 greeting faded · 3 resting (textbox faded).
  const [idleStage, setIdleStage] = useState(0);
  const lastActivityRef = useRef(Date.now());
  const spokenBuffer = useRef("");
  const voiceOnRef = useRef(voiceOn);
  useEffect(() => {
    voiceOnRef.current = voiceOn;
  }, [voiceOn]);

  useEffect(() => {
    setSupport(voiceSupport());
    const v = localStorage.getItem("akira_voice");
    if (v !== null) setVoiceOn(v === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem("akira_voice", voiceOn ? "1" : "0");
  }, [voiceOn]);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      setGreeting(greetingFor(d));
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onScroll = () => setDocked(window.scrollY > window.innerHeight * 0.55);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Idle timeline (resets on any activity): 60s → fade her reply; 120s → fade the
  // greeting; 130s → fade the textbox (resting). Wakes on movement/interaction.
  const STAGE1_MS = 60_000;
  const STAGE2_MS = 120_000;
  const STAGE3_MS = 130_000;

  // Any movement/interaction counts as activity → wakes her on the next tick.
  useEffect(() => {
    const bump = () => {
      lastActivityRef.current = Date.now();
    };
    const evs = ["mousemove", "pointerdown", "keydown", "scroll", "touchstart", "wheel"];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, bump));
  }, []);

  // Advance / reset the idle stage once per second. While she's working (not idle),
  // she's active — stay awake.
  useEffect(() => {
    if (mode !== "idle") {
      lastActivityRef.current = Date.now();
      setIdleStage(0);
      return;
    }
    const id = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;
      const stage = idle >= STAGE3_MS ? 3 : idle >= STAGE2_MS ? 2 : idle >= STAGE1_MS ? 1 : 0;
      setIdleStage((s) => (s === stage ? s : stage));
    }, 1000);
    return () => clearInterval(id);
  }, [mode]);

  // Stage 1: fade her reply (height stable), then clear it so the box collapses
  // on empty content (smoother than fading + collapsing at once). Wake undoes it.
  useEffect(() => {
    if (idleStage === 0) {
      setReplyDim(false);
      return;
    }
    if (idleStage >= 1 && reply) {
      setReplyDim(true);
      const t = setTimeout(() => {
        setReply("");
        setReplyDim(false);
      }, 800);
      return () => clearTimeout(t);
    }
  }, [idleStage, reply]);

  const runTurn = useCallback((instruction?: string) => {
    setReply("");
    setReplyDim(false);
    lastActivityRef.current = Date.now();
    setIdleStage(0);
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
          setReply((r) => r || "I couldn't compose a brief just now — tap to retry.");
        } else if (voiceOnRef.current && spokenBuffer.current.trim()) {
          speak(spokenBuffer.current);
        }
        setMode("idle");
        es.close();
      }
    };
    es.onerror = () => {
      setReply((r) => r || "I couldn't reach the brief just now — tap to retry.");
      setMode("idle");
      es.close();
    };
  }, []);

  useEffect(() => {
    // If a recent brief exists, show it without a turn (no Claude call on refresh).
    // Only run a fresh brief when there's nothing recent to reuse.
    if (initialBrief) {
      setReply(initialBrief);
      lastActivityRef.current = Date.now();
      setIdleStage(0);
      setMode("idle");
      return;
    }
    runTurn("Brief the operator on the current fleet state.");
  }, [runTurn, initialBrief]);

  async function goToProject(projectId: string, sessionId?: string | null) {
    await fetch("/api/projects/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    if (sessionId) await fetch(`/api/sessions/${sessionId}/active`, { method: "POST" });
    // Open in a new tab so AKIRA stays put in her own window/monitor.
    window.open("/dashboard", "_blank", "noopener");
  }

  function addFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith("image/");
      setAttachments((a) => [
        ...a,
        { id: `${Date.now()}-${file.name}-${a.length}`, name: file.name, size: file.size, isImage, url: isImage ? URL.createObjectURL(file) : undefined, file },
      ]);
    }
  }
  function removeAttachment(id: string) {
    setAttachments((x) => {
      const gone = x.find((y) => y.id === id);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return x.filter((y) => y.id !== id);
    });
  }

  async function submitDraft(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    setDraft("");
    const atts = attachments;
    setAttachments([]);
    if (atts.length === 0) {
      runTurn(text);
      return;
    }
    // Upload each file so AKIRA can read it by path with her Read tool.
    setMode("thinking");
    const paths: string[] = [];
    for (const a of atts) {
      const fd = new FormData();
      fd.append("file", a.file, a.name);
      const r = await fetch("/api/akira/upload", { method: "POST", body: fd }).then((x) => x.json()).catch(() => null);
      if (r?.path) paths.push(r.path);
      if (a.url) URL.revokeObjectURL(a.url);
    }
    const instruction = paths.length
      ? `${text}\n\n[Attached files — open them with your Read tool:\n${paths.map((p) => `- ${p}`).join("\n")}]`
      : text;
    runTurn(instruction);
  }

  function startMic() {
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

  const stats = [
    { n: String(snapshot.projects.length), l: "Projects" },
    { n: String(snapshot.running.length), l: "Running" },
    { n: String(snapshot.proposals.length), l: "Proposals" },
    { n: snapshot.health.verdict, l: "Health" },
  ];

  const glance = useInView<HTMLDivElement>();
  const projectsView = useInView<HTMLDivElement>();
  const briefView = useInView<HTMLDivElement>();

  return (
    <>
      <Constellation />

      <div style={topbar}>
        <span style={{ fontWeight: 700, letterSpacing: 2.5, fontSize: 14, color: "#7fdcff" }}>AKIRA</span>
        <span style={meta}>v1.10.12</span>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#37d39b", boxShadow: "0 0 8px #37d39b" }} />
        <span style={meta}>online</span>
        <span style={{ flex: 1 }} />
        <span style={meta}>{clock}</span>
      </div>

      {/* docked mini-orb (appears on scroll) */}
      <div
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        title="Summon AKIRA"
        style={{
          position: "fixed", bottom: 18, left: 18, zIndex: 20, cursor: "pointer",
          opacity: docked ? 1 : 0, transform: docked ? "scale(1)" : "scale(.6)",
          transition: ".35s", pointerEvents: docked ? "auto" : "none",
        }}
      >
        <Orb mode={mode} size={54} />
      </div>

      {/* HERO */}
      <section style={hero}>
        <div
          style={{
            transform: idleStage >= 3 ? "scale(1.45)" : "scale(1)",
            transition: "transform 1.4s cubic-bezier(.4,0,.2,1)",
          }}
        >
          <Orb mode={mode} size={320} />
        </div>
        <div
          style={{
            ...greetLine,
            opacity: idleStage >= 2 ? 0 : 1,
            transition: "opacity 1s ease",
          }}
        >
          {greeting}, A&apos;Keem.
        </div>
        <div
          style={{
            width: "100%",
            maxWidth: 680,
            display: "grid",
            // Animate only when collapsing (empty); on open, track the streaming
            // text naturally — far smoother than animating against growing content.
            gridTemplateRows: reply || mode === "thinking" ? "1fr" : "0fr",
            transition: reply || mode === "thinking" ? "none" : "grid-template-rows .6s cubic-bezier(.4,0,.2,1)",
          }}
        >
          <div style={{ overflow: "hidden", minHeight: 0 }}>
            <div style={{ ...replyText, minHeight: 0, opacity: replyDim ? 0 : 1, transition: "opacity .8s ease" }}>
              {reply || (mode === "thinking" ? "…" : "")}
            </div>
          </div>
        </div>

        {proposal && (
          <div style={proposalCard}>
            <div style={{ marginBottom: 10 }}>
              Run “{proposal.instruction}” in {proposal.projectId}?
            </div>
            <button onClick={confirmRelay} style={pillStyle}>Confirm</button>
            <button onClick={() => setProposal(null)} style={{ ...pillStyle, marginLeft: 8 }}>Cancel</button>
          </div>
        )}

        {/* input wrapper — drop zone + attachment chips + control bar */}
        <div
          onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files); }}
          onDragOver={(e) => e.preventDefault()}
          style={{
            width: "min(540px, 90vw)",
            marginTop: reply ? 22 : 8,
            opacity: idleStage >= 3 ? 0 : 1,
            pointerEvents: idleStage >= 3 ? "none" : "auto",
            transition: "margin-top .55s cubic-bezier(.4,0,.2,1), opacity 1s ease",
          }}
        >
        <form onSubmit={submitDraft} style={askBox(focused, attachments.length > 0)}>
          {attachments.length > 0 && (
            <div style={chipRow}>
              {attachments.map((a) => (
                <div key={a.id} style={chip}>
                  {a.isImage && a.url ? (
                    <img src={a.url} alt="" style={chipImg} />
                  ) : (
                    <span style={chipDoc}>📄</span>
                  )}
                  <span style={chipName}>{a.name}</span>
                  <button type="button" onClick={() => removeAttachment(a.id)} style={chipX} title="Remove">×</button>
                </div>
              ))}
            </div>
          )}
          <div style={controlRow}>
          {support.stt && (
            <button
              type="button"
              onClick={startMic}
              title="Tap to speak"
              style={iconBtn(mode === "listening")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </button>
          )}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onPaste={(e) => {
              if (e.clipboardData?.files?.length) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
            placeholder="Ask AKIRA…"
            autoComplete="off"
            style={askInput}
          />
          {support.tts && (
            <button
              type="button"
              onClick={() => setVoiceOn((v) => !v)}
              title={voiceOn ? "Voice on — she speaks replies" : "Voice off"}
              style={iconBtn(voiceOn)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                {voiceOn ? (
                  <>
                    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
                  </>
                ) : (
                  <>
                    <line x1="22" y1="9" x2="16" y2="15" />
                    <line x1="16" y1="9" x2="22" y2="15" />
                  </>
                )}
              </svg>
            </button>
          )}
          <button type="submit" title="Send" aria-label="Send" style={sendBtn(draft.trim().length > 0 || attachments.length > 0)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="6 11 12 5 18 11" />
            </svg>
          </button>
          </div>
        </form>
        </div>

        <div style={scrollCue}>
          SCROLL INTO MISSION CONTROL
          <span style={chev} />
        </div>
      </section>

      {/* MISSION CONTROL */}
      <main style={mc}>
        <div style={mcHead}>
          <h2 style={{ fontSize: 16, letterSpacing: 1, margin: 0 }}>Mission Control</h2>
          <a href="/dashboard" target="_blank" rel="noopener" style={openReal}>Open full dashboard ↗</a>
        </div>

        <h3 style={sec}>At a glance</h3>
        <div ref={glance.ref} style={statRow}>
          {stats.map((s, i) => (
            <div key={s.l} style={fadeCard(glance.inView, i, statCard)}>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#eaffff" }}>{s.n}</div>
              <div style={statLabel}>{s.l}</div>
            </div>
          ))}
        </div>

        {snapshot.projects.length > 0 && (
          <>
            <h3 style={sec}>Projects</h3>
            <div ref={projectsView.ref} style={grid}>
              {snapshot.projects.map((p, i) => {
                const isRunning = snapshot.running.some((r) => r.projectId === p.id);
                return (
                  <div key={p.id} style={fadeCard(projectsView.inView, i, card)}>
                    <div style={cardH}>
                      <span style={dot(isRunning ? "#7fdcff" : "#3a4859", isRunning)} />
                      {p.name}
                    </div>
                    <div style={cardMeta}>{isRunning ? "turn running" : "idle"}</div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <h3 style={sec}>AKIRA — overnight brief</h3>
        <div ref={briefView.ref} style={grid}>
          <div style={fadeCard(briefView.inView, 0, card)}>
            <div style={cardH}>
              <span style={dot(snapshot.health.verdict === "fail" ? "#ffb84d" : "#37d39b", true)} />
              Health check
            </div>
            <div style={cardMeta}>
              {snapshot.health.verdict.toUpperCase()}
              {snapshot.health.at ? ` · ${new Date(snapshot.health.at).toLocaleString()}` : ""}
            </div>
          </div>

          <div style={fadeCard(briefView.inView, 1, card)}>
            <div style={cardH}>
              <span style={dot(snapshot.insights.length ? "#7fdcff" : "#3a4859", snapshot.insights.length > 0)} />
              Dream insights
            </div>
            <div style={cardMeta}>
              {snapshot.insights.length
                ? snapshot.insights.map((x) => x.title).join(" · ")
                : "No new insights."}
            </div>
          </div>

          <div style={fadeCard(briefView.inView, 2, card)}>
            <div style={cardH}>
              <span style={dot(snapshot.schedules.length ? "#ffb84d" : "#3a4859", snapshot.schedules.length > 0)} />
              Scheduled today
            </div>
            <div style={cardMeta}>
              {snapshot.schedules.length
                ? snapshot.schedules.map((x) => x.title).join(" · ")
                : "Nothing scheduled."}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

const topbar: React.CSSProperties = {
  position: "fixed", top: 0, left: 0, right: 0, height: 48, zIndex: 20,
  display: "flex", alignItems: "center", gap: 14, padding: "0 18px",
  background: "linear-gradient(180deg, rgba(4,6,11,.92), rgba(4,6,11,.5) 70%, transparent)",
  backdropFilter: "blur(6px)",
};
const meta: React.CSSProperties = { color: "#6b7a8d", fontSize: 12, fontFamily: "ui-monospace, monospace" };
const hero: React.CSSProperties = {
  position: "relative", zIndex: 1, minHeight: "100vh",
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "70px 18px 40px",
};
const greetLine: React.CSSProperties = {
  marginTop: -28, fontSize: "clamp(20px,3.4vmin,30px)", fontWeight: 600, letterSpacing: 0.3,
  background: "linear-gradient(90deg,#eaffff,#7fdcff)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
};
const replyText: React.CSSProperties = {
  marginTop: 10, maxWidth: 680, textAlign: "center", color: "#c4d3e3", lineHeight: 1.7, fontSize: 15.5, minHeight: 44,
};
const scrollCue: React.CSSProperties = {
  position: "absolute", bottom: 22, left: "50%", transform: "translateX(-50%)",
  color: "#6b7a8d", fontSize: 11, letterSpacing: 2, textAlign: "center",
};
const chev: React.CSSProperties = {
  display: "block", margin: "8px auto 0", width: 12, height: 12,
  borderRight: "2px solid #7fdcff", borderBottom: "2px solid #7fdcff", transform: "rotate(45deg)", opacity: 0.8,
};
const mc: React.CSSProperties = {
  position: "relative", zIndex: 1, maxWidth: 1000, margin: "0 auto", padding: "30px 20px 90px",
};
const mcHead: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10,
};
const openReal: React.CSSProperties = {
  border: "1px solid rgba(127,220,255,.35)", color: "#7fdcff", background: "rgba(127,220,255,.05)",
  borderRadius: 8, padding: "9px 16px", fontSize: 13, textDecoration: "none",
};
const sec: React.CSSProperties = {
  fontSize: 12, letterSpacing: 2, color: "#6b7a8d", textTransform: "uppercase",
  margin: "26px 0 12px", borderBottom: "1px solid #13202e", paddingBottom: 7,
};
const statRow: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 };
const statCard: React.CSSProperties = {
  background: "rgba(7,13,22,.7)", border: "1px solid #13202e", borderRadius: 12, padding: 18, textAlign: "center",
};
const statLabel: React.CSSProperties = {
  color: "#6b7a8d", fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", marginTop: 4,
};
const grid: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 14,
};
const card: React.CSSProperties = {
  background: "rgba(7,13,22,.7)", border: "1px solid #13202e", borderRadius: 12, padding: 16,
};
const cardH: React.CSSProperties = { display: "flex", alignItems: "center", gap: 9, fontWeight: 600, fontSize: 15 };
const cardMeta: React.CSSProperties = {
  color: "#6b7a8d", fontSize: 12, marginTop: 8, lineHeight: 1.6, fontFamily: "ui-monospace, monospace",
};
const pillStyle: React.CSSProperties = {
  border: "1px solid rgba(127,220,255,.35)", color: "#7fdcff", background: "rgba(127,220,255,.05)",
  borderRadius: 30, padding: "9px 16px", fontSize: 13, cursor: "pointer", fontFamily: "inherit",
};
const proposalCard: React.CSSProperties = {
  marginTop: 18, padding: 14, border: "1px solid #1f3347", borderRadius: 12, background: "rgba(7,13,22,.85)", textAlign: "center",
};

const chipRow: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, padding: "2px 4px 8px" };
const chip: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 7, padding: "4px 7px 4px 4px",
  background: "rgba(127,220,255,.06)", border: "1px solid rgba(127,220,255,.18)", borderRadius: 9, maxWidth: 180,
};
const chipImg: React.CSSProperties = { width: 24, height: 24, objectFit: "cover", borderRadius: 5, flex: "none" };
const chipDoc: React.CSSProperties = {
  width: 24, height: 24, display: "grid", placeItems: "center", borderRadius: 5, flex: "none",
  background: "rgba(127,220,255,.1)", fontSize: 13,
};
const chipName: React.CSSProperties = {
  fontSize: 12, color: "#c4d3e3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};
const chipX: React.CSSProperties = {
  flex: "none", width: 20, height: 20, borderRadius: "50%", border: 0, cursor: "pointer",
  background: "transparent", color: "#6b7a8d", fontSize: 16, lineHeight: "16px",
};

function dot(color: string, glow: boolean): React.CSSProperties {
  return { width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: glow ? `0 0 7px ${color}` : "none" };
}
function fadeCard(inView: boolean, i: number, base: React.CSSProperties): React.CSSProperties {
  return {
    ...base,
    opacity: inView ? 1 : 0,
    transform: inView ? "none" : "translateY(10px)",
    transition: "opacity .45s ease, transform .45s ease",
    transitionDelay: `${i * 70}ms`,
  };
}
const askInput: React.CSSProperties = {
  flex: 1,
  background: "transparent",
  border: 0,
  outline: "none",
  color: "#e6edf3",
  fontFamily: "inherit",
  fontSize: 14.5,
  letterSpacing: 0.2,
  padding: "0 8px",
};
const iconBase: React.CSSProperties = {
  width: 34,
  height: 34,
  flex: "none",
  border: 0,
  borderRadius: "50%",
  cursor: "pointer",
  display: "grid",
  placeItems: "center",
  fontSize: 15,
  transition: "background .2s, color .2s",
  background: "transparent",
};

function askBox(focused: boolean, hasChips: boolean): React.CSSProperties {
  return {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    background: focused ? "rgba(8,15,26,.62)" : "rgba(8,15,26,.42)",
    border: `1px solid ${focused ? "rgba(127,220,255,.7)" : "rgba(127,220,255,.16)"}`,
    borderRadius: hasChips ? 18 : 999,
    boxShadow: focused ? "0 0 22px rgba(127,220,255,.10)" : "none",
    backdropFilter: "blur(10px)",
    padding: hasChips ? "8px 8px 4px" : "0 6px",
    transition: "border-color .3s, box-shadow .3s, background .3s, border-radius .3s, padding .3s",
  };
}
const controlRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  height: 44,
  width: "100%",
};
function iconBtn(active: boolean): React.CSSProperties {
  return {
    ...iconBase,
    color: active ? "#7fdcff" : "rgba(127,220,255,.6)",
    background: active ? "rgba(127,220,255,.14)" : "rgba(127,220,255,.05)",
  };
}
function sendBtn(active: boolean): React.CSSProperties {
  return {
    ...iconBase,
    color: active ? "#04060b" : "#7fdcff",
    background: active ? "#7fdcff" : "rgba(127,220,255,.16)",
  };
}
