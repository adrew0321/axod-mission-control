"use client";

import { useState } from "react";
import { Loader2, GitMerge, Eye, Trash2, FileDiff } from "lucide-react";
import type { Proposal } from "@/lib/proposals";

interface ProposalsViewProps {
  proposals: Proposal[];
  onSelectSession: (sessionId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export default function ProposalsView({ proposals, onSelectSession, onRefresh }: ProposalsViewProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  async function merge(sessionId: string) {
    setBusyId(sessionId);
    setErrorById((e) => ({ ...e, [sessionId]: "" }));
    try {
      const res = await fetch(`/api/proposals/${sessionId}/merge`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        conflict?: boolean;
        message?: string;
        error?: string;
      };
      if (data.ok) {
        await onRefresh();
      } else {
        setErrorById((e) => ({
          ...e,
          [sessionId]: data.conflict ? "Merge conflict — resolve manually" : data.error ?? "Merge failed",
        }));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function discard(sessionId: string) {
    setBusyId(sessionId);
    try {
      await fetch(`/api/proposals/${sessionId}/discard`, { method: "POST" });
      setConfirmId(null);
      await onRefresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex-1 flex flex-col min-w-0 bg-[#0a0e14]">
      <div className="h-11 shrink-0 bg-[#11161d] border-b border-[#1e2632] px-4 flex items-center gap-2 select-none">
        <span className="font-semibold text-xs text-[#e6edf3] font-heading">Proposals</span>
        <span className="text-[10px] font-mono text-[#5c6470]">changes awaiting your review</span>
        <span className="ml-auto text-[9px] font-mono text-[#5c6470] bg-[#161c25] border border-[#2a3441] rounded px-1.5">
          {proposals.length}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2">
        {proposals.length === 0 && (
          <div className="text-[11px] font-mono text-[#3a424d] text-center py-10">No changes awaiting review.</div>
        )}

        {proposals.map((p) => {
          const busy = busyId === p.sessionId;
          const err = errorById[p.sessionId];
          return (
            <div key={p.sessionId} className="rounded-lg border border-[#1e2632] bg-[#11161d] p-3">
              <div className="flex items-start gap-2">
                <FileDiff className="w-4 h-4 text-[#00e0ff] shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-[#e6edf3] font-heading truncate">{p.sessionTitle}</div>
                  <div className="mt-1 flex items-center gap-2 text-[9px] font-mono text-[#5c6470] flex-wrap">
                    <span className="bg-[#0f141b] border border-[#23371f] text-[#7ee787] rounded px-1.5">{p.projectName}</span>
                    <span className="text-[#3fb950]">+{p.additions}</span>
                    <span className="text-[#f85149]">−{p.deletions}</span>
                    <span>· {p.files.length} {p.files.length === 1 ? "file" : "files"}</span>
                    <span className="text-[#3a424d]">→ {p.baseBranch}</span>
                  </div>
                </div>
              </div>

              <div className="mt-2.5 flex items-center gap-2">
                <button
                  onClick={() => void onSelectSession(p.sessionId)}
                  className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded border border-[#2a3441] text-[#8b949e] hover:text-[#e6edf3] hover:border-[#3a424d]"
                >
                  <Eye className="w-3 h-3" /> View diff
                </button>
                <button
                  onClick={() => void merge(p.sessionId)}
                  disabled={busy}
                  className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded bg-[#00e0ff] text-black font-bold disabled:opacity-40"
                >
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />} Approve → merge
                </button>
                {confirmId === p.sessionId ? (
                  <span className="flex items-center gap-1 text-[10px] font-mono text-[#f0a020]">
                    Discard {p.files.length} {p.files.length === 1 ? "file" : "files"}?
                    <button onClick={() => void discard(p.sessionId)} disabled={busy} className="px-1.5 py-0.5 rounded bg-[#f85149] text-black font-bold">Yes</button>
                    <button onClick={() => setConfirmId(null)} className="px-1.5 py-0.5 rounded text-[#8b949e]">No</button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmId(p.sessionId)}
                    disabled={busy}
                    className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded border border-[#2a3441] text-[#8b949e] hover:text-[#f85149] hover:border-[#f85149]/40 ml-auto"
                  >
                    <Trash2 className="w-3 h-3" /> Discard
                  </button>
                )}
              </div>

              {err && <div className="mt-2 text-[10px] font-mono text-[#f85149]">{err}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
