"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Check, Plus } from "lucide-react";

export type SessionOption = { id: string; title: string; baseBranch: string; hasChanges: boolean; isActive: boolean };

export default function SessionSwitcher({
  sessions,
  activeSessionId,
  onNewSession,
}: {
  sessions: SessionOption[];
  activeSessionId: string;
  onNewSession: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const active = sessions.find((s) => s.id === activeSessionId);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function switchTo(id: string) {
    if (id === activeSessionId) { setOpen(false); return; }
    setBusy(id);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(id)}/active`, { method: "POST" });
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative hidden sm:block" ref={ref}>
      <button onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-2.5 py-1 bg-[#161c25] border border-[#1e2632] rounded-md cursor-pointer hover:bg-[#1c2330] transition-colors">
        <span className="text-[9px] font-mono text-[#5c6470] uppercase tracking-wider">SESSION</span>
        <span className="text-xs font-semibold text-[#e6edf3] max-w-[160px] truncate">{active?.title ?? "—"}</span>
        {active && <span className="text-[9px] font-mono text-[#5c6470]">{active.baseBranch}</span>}
        <ChevronDown className="w-3.5 h-3.5 text-[#5c6470]" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[260px] bg-[#11161d] border border-[#2a3441] rounded-md shadow-lg shadow-black/40 py-1">
          {sessions.map((s) => (
            <button key={s.id} onClick={() => switchTo(s.id)} disabled={busy !== null}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#e6edf3] text-left hover:bg-[#1c2330] transition-colors disabled:opacity-50">
              <span className="w-3.5 shrink-0">{s.id === activeSessionId && <Check className="w-3.5 h-3.5 text-[#00e0ff]" />}</span>
              <span className="flex-1 min-w-0 truncate">{s.title}</span>
              {s.hasChanges && <span title="has changes" className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] shrink-0" />}
              <span className="text-[9px] font-mono text-[#5c6470] shrink-0">{s.baseBranch}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-[#1e2632]" />
          <button onClick={() => { setOpen(false); onNewSession(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#00e0ff] hover:bg-[#1c2330] transition-colors text-left">
            <Plus className="w-3.5 h-3.5" /> New session
          </button>
        </div>
      )}
    </div>
  );
}
