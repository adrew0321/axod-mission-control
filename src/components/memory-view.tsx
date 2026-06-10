"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { summarizeMemory } from "@/lib/memory";
import type { Message } from "@/lib/mock-data";

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export default function MemoryView({
  messages,
  sessionTitle,
  clearedAt,
  onClear,
}: {
  messages: Message[];
  sessionTitle: string;
  clearedAt: string | null;
  onClear: () => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { blocks, messageCount, approxTokens } = summarizeMemory(messages);

  return (
    <section className="flex-1 flex flex-col min-w-0 bg-[#0a0e14]">
      <div className="h-11 shrink-0 bg-[#11161d] border-b border-[#1e2632] px-4 flex items-center gap-2 select-none">
        <span className="font-semibold text-xs text-[#e6edf3] font-heading">Memory</span>
        <span className="text-[10px] font-mono text-[#5c6470]">what Sage remembers this session</span>
        {confirming ? (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] font-mono text-[#f0a020]">
            Clear Sage&apos;s memory? (archived, not deleted)
            <button
              onClick={() => {
                setConfirming(false);
                void onClear();
              }}
              className="px-1.5 py-0.5 rounded bg-[#f85149] text-black font-bold"
            >
              Yes
            </button>
            <button onClick={() => setConfirming(false)} className="px-1.5 py-0.5 rounded text-[#8b949e]">
              No
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={messageCount === 0}
            className="ml-auto flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded border border-[#2a3441] text-[#8b949e] hover:text-[#f85149] hover:border-[#f85149]/40 disabled:opacity-40"
          >
            <Trash2 className="w-3 h-3" /> Clear memory
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="text-[10px] font-mono text-[#5c6470] mb-3">
          {messageCount} message{messageCount === 1 ? "" : "s"} in context · ~{formatTokens(approxTokens)} tokens · session{" "}
          <span className="text-[#8b949e]">&quot;{sessionTitle}&quot;</span>
        </div>

        {clearedAt && (
          <div className="text-[10px] font-mono text-[#f0a020] border-l-2 border-[#f0a020]/40 pl-2 mb-3">
            Memory was cleared earlier — showing context since.
          </div>
        )}

        {blocks.length === 0 ? (
          <div className="text-[11px] font-mono text-[#3a424d] text-center py-10">
            Sage has no memory yet this session.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {blocks.map((b, i) => (
              <div key={i}>
                <div
                  className={`text-[10px] font-mono mb-0.5 ${
                    b.label === "Operator" ? "text-[#00e0ff]" : "text-[#8b949e]"
                  }`}
                >
                  {b.label}
                </div>
                <div className="text-[11px] text-[#c9d1d9] whitespace-pre-wrap break-words leading-relaxed">
                  {b.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
