"use client";

import { memo, useEffect, useRef } from "react";
import { parseAnsi } from "@/lib/ansi";

export interface TerminalLine {
  id: number;
  kind: "command" | "output";
  agentId: string; // reserved for parent use (routing/labeling); not rendered here
  content: string;
  isError?: boolean;
}

// One terminal row. Memoized so appending a new line never re-parses the ANSI
// of the existing (immutable) lines — parseAnsi runs once per line, ever.
const Line = memo(function Line({ line }: { line: TerminalLine }) {
  if (line.kind === "command") {
    return (
      <div className="flex items-start gap-1.5 mt-2 first:mt-0 text-cyan-400">
        <span className="select-none">$</span>
        <span className="text-[#e6edf3] font-bold whitespace-pre-wrap break-all">{line.content}</span>
      </div>
    );
  }
  return (
    <pre className={"whitespace-pre-wrap break-all" + (line.isError ? " text-red-300" : "")}>
      {parseAnsi(line.content).map((seg, i) => (
        <span key={i} style={{ color: seg.color, fontWeight: seg.bold ? 600 : undefined }}>
          {seg.text}
        </span>
      ))}
    </pre>
  );
});

// Append-only Terminal scrollback. Command lines render as "$ cmd" in cyan;
// output lines render ANSI SGR colors via parseAnsi, with errors tinted red.
// Autoscrolls to the newest line. The scroll container and sentinel are always
// mounted so the autoscroll ref is stable across the empty→first-line transition,
// and `min-h-0` lets overflow-y-auto actually engage inside the flex-col wrapper.
export default function TerminalView({ lines }: { lines: TerminalLine[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 text-xs font-mono leading-relaxed bg-black text-[#8b949e]">
      {lines.length === 0 ? (
        <div className="h-full flex items-center justify-center text-[11px] text-[#5c6470]">
          No commands run yet — agent Bash output will stream here.
        </div>
      ) : (
        lines.map((line) => <Line key={line.id} line={line} />)
      )}
      <div ref={endRef} />
    </div>
  );
}
