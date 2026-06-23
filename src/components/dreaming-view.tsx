"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DreamView } from "@/lib/dreams-data";

const CAT: Record<string, { icon: string; color: string }> = {
  risk: { icon: "⚡", color: "#f87171" },
  pattern: { icon: "◈", color: "#60a5fa" },
  suggestion: { icon: "✨", color: "#22d3ee" },
  praise: { icon: "✓", color: "#34d399" },
};

interface Props {
  dreams: DreamView[];
}

export default function DreamingView({ dreams }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dreamNow() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dream", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { status?: string; reason?: string };
      if (!res.ok) throw new Error(body.reason ?? "Dream failed");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dream failed");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: "new" | "starred" | "dismissed") {
    await fetch(`/api/insights/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    router.refresh();
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString();

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-[#060810] text-[#e2e8f0]">
      <div className="flex items-center mb-5">
        <div>
          <h1 className="text-lg font-semibold">Dreaming</h1>
          <p className="text-xs text-[#7c8794]">
            The Curator reviews recent work and surfaces patterns, risks, and ideas. Nightly — or on demand.
          </p>
        </div>
        <button
          onClick={dreamNow}
          disabled={busy}
          className="ml-auto flex items-center gap-2 bg-gradient-to-r from-violet-400 to-indigo-500 text-[#0a0716] font-semibold rounded-lg px-4 py-2 text-[13px] disabled:opacity-50"
        >
          🌙 {busy ? "Dreaming…" : "Dream now"}
        </button>
      </div>
      {error && <div className="text-[11px] text-red-400 mb-3">{error}</div>}

      {dreams.length === 0 ? (
        <div className="text-sm text-[#7c8794] border border-[#232c3a] rounded-lg p-6 text-center">
          No dreams yet — click Dream now to reflect on recent work.
        </div>
      ) : (
        dreams.map((d) => (
          <div key={d.id} className="mb-6">
            <div className="flex items-center gap-2.5 mb-2.5">
              <span className="text-[13px] font-semibold text-[#c4b5fd]">Dream · {fmt(d.createdAt)}</span>
              <span className="text-[11px] text-[#5b6675]">covers since {fmt(d.coversSince)}</span>
              <span className="text-[11px] text-[#7c8794] ml-auto">
                {d.status === "error" ? "error" : `${d.insights.length} insight${d.insights.length === 1 ? "" : "s"}`}
              </span>
            </div>
            {d.insights.length === 0 ? (
              <div className="text-[12px] text-[#5b6675] italic pl-1">Nothing notable this window.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {d.insights.map((ins) => {
                  const c = CAT[ins.category] ?? { icon: "•", color: "#7c8794" };
                  const dismissed = ins.status === "dismissed";
                  return (
                    <div
                      key={ins.id}
                      className={`flex gap-3 bg-[#131a24] border border-[#232c3a] rounded-lg p-3 ${dismissed ? "opacity-50" : ""}`}
                      style={{ borderLeft: `3px solid ${c.color}` }}
                    >
                      <div className="text-[15px] leading-tight">{c.icon}</div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className="text-[10px] uppercase tracking-wide font-semibold"
                            style={{ color: c.color }}
                          >
                            {ins.category}
                          </span>
                          <span className={`font-semibold text-[13.5px] ${dismissed ? "line-through" : ""}`}>
                            {ins.title}
                          </span>
                        </div>
                        <div className="text-[12.5px] text-[#aab4c0] mt-1">{ins.detail}</div>
                      </div>
                      <div className="flex flex-col gap-1.5 items-center text-[#5b6675]">
                        {dismissed ? (
                          <button onClick={() => setStatus(ins.id, "new")} title="restore">⟲</button>
                        ) : (
                          <>
                            <button
                              onClick={() => setStatus(ins.id, ins.status === "starred" ? "new" : "starred")}
                              title="star"
                              style={ins.status === "starred" ? { color: "#fbbf24" } : undefined}
                            >
                              {ins.status === "starred" ? "★" : "☆"}
                            </button>
                            <button onClick={() => setStatus(ins.id, "dismissed")} title="dismiss">✕</button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
