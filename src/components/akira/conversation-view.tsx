"use client";
import { useEffect, useRef } from "react";
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

/**
 * The front-door conversation stream: past turns (your bubbles + her replies)
 * oldest→newest, then the live streaming reply. Scrolls internally, pinned to
 * the newest turn; scroll up within it for history.
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
  const ref = useRef<HTMLDivElement>(null);
  const showLive = liveReply.length > 0;
  const showThinking = thinking && !showLive;

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight; // keep the newest turn in view
  }, [turns, liveReply, thinking]);

  if (turns.length === 0 && !showLive && !showThinking) return null;

  return (
    <div ref={ref} style={{ ...streamStyle, opacity: dim ? 0 : 1 }}>
      {turns.map((t, i) =>
        t.role === "you" ? (
          <div key={i} style={youRow}>
            <div style={youBubble}>{t.content}</div>
          </div>
        ) : (
          <div key={i} style={akiraBlock(isLongReply(t.content))}>
            <ReplyBody text={t.content} />
          </div>
        ),
      )}
      {showLive && (
        <div style={akiraBlock(isLongReply(liveReply))}>
          <ReplyBody text={liveReply} />
        </div>
      )}
      {showThinking && <div style={{ ...akiraBlock(false), color: "#6b7a8d" }}>…</div>}
    </div>
  );
}

const streamStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 680,
  margin: "8px auto 0",
  maxHeight: "44vh",
  overflowY: "auto",
  overflowX: "hidden",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  transition: "opacity .8s ease",
};
const youRow: React.CSSProperties = { display: "flex", justifyContent: "flex-end" };
const youBubble: React.CSSProperties = {
  maxWidth: "78%",
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
