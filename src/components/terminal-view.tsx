"use client";

import { useEffect, useRef } from "react";
import { parseAnsi } from "@/lib/ansi";

export interface TerminalLine {
  id: number;
  kind: "command" | "output";
  agentId: string;
  content: string;
  isError?: boolean;
}

// Append-only Terminal scrollback. Command lines render as "$ cmd" in cyan;
// output lines render ANSI SGR colors via parseAnsi, with errors tinted red.
// Autoscrolls to the newest line.
export default function TerminalView({ lines }: { lines: TerminalLine[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  if (lines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-[#5c6470] p-4">
        No commands run yet — agent Bash output will stream here.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 text-xs font-mono leading-relaxed bg-black text-[#8b949e]">
      {lines.map((line) =>
        line.kind === "command" ? (
          <div key={line.id} className="flex items-start gap-1.5 mt-2 first:mt-0 text-cyan-400">
            <span className="select-none">$</span>
            <span className="text-[#e6edf3] font-bold whitespace-pre-wrap break-all">{line.content}</span>
          </div>
        ) : (
          <pre
            key={line.id}
            className={`whitespace-pre-wrap break-all ${line.isError ? "text-red-300" : ""}`}
          >
            {parseAnsi(line.content).map((seg, i) => (
              <span key={i} style={{ color: seg.color, fontWeight: seg.bold ? 600 : undefined }}>
                {seg.text}
              </span>
            ))}
          </pre>
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}
