"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Check, Plus, Trash2 } from "lucide-react";
import type { ProjectOption } from "@/lib/mock-data";

export default function ProjectSwitcher({
  projects,
  activeProjectId,
  onAddProject,
}: {
  projects: ProjectOption[];
  activeProjectId: string;
  onAddProject: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const active = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmingId(null);
        setError(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function switchTo(id: string) {
    if (id === activeProjectId) { setOpen(false); return; }
    setBusy(id);
    try {
      await fetch("/api/projects/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id }),
      });
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? `Failed (${res.status})`);
        setConfirmingId(null);
        return;
      }
      setConfirmingId(null);
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative hidden sm:block" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-2.5 py-1 bg-[#161c25] border border-[#1e2632] rounded-md cursor-pointer hover:bg-[#1c2330] transition-colors"
      >
        <span className="text-[9px] font-mono text-[#5c6470] uppercase tracking-wider">PROJECT</span>
        <span className="text-xs font-semibold text-[#e6edf3]">{active?.name ?? "—"}</span>
        <ChevronDown className="w-3.5 h-3.5 text-[#5c6470]" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[240px] bg-[#11161d] border border-[#2a3441] rounded-md shadow-lg shadow-black/40 py-1">
          {projects.map((p) =>
            confirmingId === p.id ? (
              <div key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-xs text-[#e6edf3]">
                <span className="flex-1 min-w-0 truncate">
                  Remove <span className="font-semibold">{p.name}</span>?
                  <span className="block text-[9.5px] text-[#5c6470] font-mono">files on disk are kept</span>
                </span>
                <button
                  onClick={() => remove(p.id)}
                  disabled={busy !== null}
                  className="text-[10px] font-mono text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded border border-red-500/40 disabled:opacity-50"
                >
                  remove
                </button>
                <button
                  onClick={() => setConfirmingId(null)}
                  className="text-[10px] font-mono text-[#8b949e] hover:text-[#e6edf3] px-1.5 py-0.5"
                >
                  cancel
                </button>
              </div>
            ) : (
              <div key={p.id} className="group flex items-center hover:bg-[#1c2330] transition-colors">
                <button
                  onClick={() => switchTo(p.id)}
                  disabled={busy !== null}
                  className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-xs text-[#e6edf3] text-left disabled:opacity-50"
                >
                  <span className="w-3.5 shrink-0">
                    {p.id === activeProjectId && <Check className="w-3.5 h-3.5 text-[#00e0ff]" />}
                  </span>
                  <span className="truncate">{p.name}</span>
                </button>
                <button
                  onClick={() => { setConfirmingId(p.id); setError(null); }}
                  title="Remove project"
                  className="shrink-0 px-2 text-[#5c6470] opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ),
          )}

          {error && (
            <div className="mx-2 my-1 px-2 py-1 rounded text-[10px] font-mono bg-red-500/10 border border-red-500/40 text-red-400">
              {error}
            </div>
          )}

          <div className="my-1 h-px bg-[#1e2632]" />
          <button
            onClick={() => { setOpen(false); onAddProject(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#00e0ff] hover:bg-[#1c2330] transition-colors text-left"
          >
            <Plus className="w-3.5 h-3.5" />
            Add project
          </button>
        </div>
      )}
    </div>
  );
}
