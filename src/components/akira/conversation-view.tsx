"use client";
import { useEffect, useRef, useState } from "react";
import { parseReply, isLongReply, type Inline } from "@/lib/akira/format";
import type { Turn } from "@/lib/akira/turns";

/** Render one AKIRA reply as paragraphs + bullet lists with inline bold/links. */
export function ReplyBody({ text }: { text: string }) {
  const blocks = parseReply(text);
  return (
    <>
      {blocks.map((b, i) =>
        b.type === "list" ? (
          <ul key={i} style={replyList}>
            {b.items.map((item, j) => (
              <li key={j} style={replyLi}>
                <span style={{ color: "#7fdcff", marginRight: 9, flex: "none" }}>•</span>
                <span>{item.map(renderSpan)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} style={replyPara}>
            {b.spans.map(renderSpan)}
          </p>
        ),
      )}
    </>
  );
}
function renderSpan(s: Inline, i: number) {
  if (s.type === "bold") return <strong key={i} style={{ color: "#eaffff", fontWeight: 700 }}>{s.value}</strong>;
  if (s.type === "link")
    return (
      <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" style={replyLink}>
        {s.label}
      </a>
    );
  return <span key={i}>{s.value}</span>;
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function YouTurn({ t }: { t: Turn }) {
  return (
    <div style={youRow}>
      <div style={{ maxWidth: "80%" }}>
        <div style={youLabel}>You · {fmtClock(t.at)}</div>
        <div style={youBubble}>{t.content}</div>
      </div>
    </div>
  );
}
function AkiraTurn({ content, at }: { content: string; at?: number }) {
  return (
    <div>
      <div style={akiraLabel}>
        <span style={akiraDot} />
        AKIRA{at != null ? ` · ${fmtClock(at)}` : ""}
      </div>
      <div style={akiraBlock(isLongReply(content))}>
        <ReplyBody text={content} />
      </div>
    </div>
  );
}

/**
 * Front-door conversation. Collapsed by default: the hero shows only the latest
 * reply (clean, no label). A "⌃ earlier" cue reveals the full thread above it —
 * your messages and hers, with labels + timestamps — and "⌄ collapse" tucks it
 * back. Keeps the hero clean while history stays one tap away.
 */
export function ConversationStream({
  turns,
  liveReply,
  thinking,
  dim,
}: {
  turns: Turn[];
  liveReply: string;
  thinking: boolean;
  dim: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const showLive = liveReply.length > 0;
  const showThinking = thinking && !showLive;

  // The clean "current" reply is the live stream, or the last turn if it's hers.
  const tailIsAkira = !showLive && turns.length > 0 && turns[turns.length - 1].role === "akira";
  const historyCount = tailIsAkira ? turns.length - 1 : turns.length;

  useEffect(() => {
    const el = ref.current;
    if (el && expanded) el.scrollTop = el.scrollHeight; // pin to newest when open
  }, [turns, liveReply, thinking, expanded]);

  // Collapse automatically when a new turn starts (fresh answer becomes the focus).
  useEffect(() => {
    if (showLive || showThinking) setExpanded(false);
  }, [showLive, showThinking]);

  if (turns.length === 0 && !showLive && !showThinking) return null;

  return (
    <div ref={ref} style={{ ...streamStyle, opacity: dim ? 0 : 1, ...(expanded ? expandedScroll : null) }}>
      {expanded ? (
        <>
          <button type="button" style={cueBtn} onClick={() => setExpanded(false)}>⌄ collapse</button>
          {turns.map((t, i) =>
            t.role === "you" ? <YouTurn key={i} t={t} /> : <AkiraTurn key={i} content={t.content} at={t.at} />,
          )}
          {showLive && <AkiraTurn content={liveReply} />}
          {showThinking && <div style={dots}>…</div>}
        </>
      ) : (
        <>
          {historyCount > 0 && (
            <button type="button" style={cueBtn} onClick={() => setExpanded(true)}>
              ⌃ earlier ({historyCount})
            </button>
          )}
          {showLive ? (
            <div style={akiraBlock(isLongReply(liveReply))}>
              <ReplyBody text={liveReply} />
            </div>
          ) : showThinking ? (
            <div style={dots}>…</div>
          ) : tailIsAkira ? (
            <div style={akiraBlock(isLongReply(turns[turns.length - 1].content))}>
              <ReplyBody text={turns[turns.length - 1].content} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

const streamStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 680,
  margin: "8px auto 0",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  transition: "opacity .8s ease",
};
const expandedScroll: React.CSSProperties = { maxHeight: "50vh", overflowY: "auto", overflowX: "hidden", paddingRight: 4 };
const cueBtn: React.CSSProperties = {
  alignSelf: "center",
  background: "transparent",
  border: 0,
  color: "#6b7a8d",
  fontSize: 11.5,
  letterSpacing: 1,
  cursor: "pointer",
  fontFamily: "inherit",
  padding: "2px 10px",
};
const dots: React.CSSProperties = { textAlign: "center", color: "#6b7a8d", fontSize: 15.5 };
const youRow: React.CSSProperties = { display: "flex", justifyContent: "flex-end" };
const youLabel: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "#5f7186",
  textAlign: "right",
  margin: "0 2px 4px 0",
};
const youBubble: React.CSSProperties = {
  background: "rgba(127,220,255,.07)",
  border: "1px solid rgba(127,220,255,.18)",
  color: "#dbe8f2",
  borderRadius: "16px 16px 4px 16px",
  padding: "9px 14px",
  fontSize: 14.5,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  textAlign: "left",
};
const akiraLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 10,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "#5f7186",
  margin: "0 0 5px 2px",
};
const akiraDot: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "#7fdcff",
  boxShadow: "0 0 6px #7fdcff",
  display: "inline-block",
  flex: "none",
};
function akiraBlock(long: boolean): React.CSSProperties {
  return {
    maxWidth: 640,
    width: "100%",
    margin: "0 auto",
    textAlign: long ? "left" : "center",
    color: "#c4d3e3",
    lineHeight: 1.7,
    fontSize: 15.5,
  };
}
const replyPara: React.CSSProperties = { margin: "0 0 12px", lineHeight: 1.7, whiteSpace: "pre-line" };
const replyList: React.CSSProperties = { margin: "0 0 12px", padding: 0, listStyle: "none", display: "grid", gap: 6 };
const replyLi: React.CSSProperties = { display: "flex", alignItems: "flex-start", lineHeight: 1.6 };
const replyLink: React.CSSProperties = { color: "#7fdcff", textDecoration: "underline", textUnderlineOffset: 2 };
