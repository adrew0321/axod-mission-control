"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Check, Plus } from "lucide-react";
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
  const [switching, setSwitching] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const active = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function switchTo(id: string) {
    if (id === activeProjectId) { setOpen(false); return; }
    setSwitching(id);
    try {
      await fetch("/api/projects/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id }),
      });
      setOpen(false);
      router.refresh();
    } finally {
      setSwitching(null);
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
        <div className="absolute left-0 top-full mt-1 z-50 min-w-[220px] bg-[#11161d] border border-[#2a3441] rounded-md shadow-lg shadow-black/40 py-1">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => switchTo(p.id)}
              disabled={switching !== null}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#e6edf3] hover:bg-[#1c2330] transition-colors text-left disabled:opacity-50"
            >
              <span className="w-3.5 shrink-0">
                {p.id === activeProjectId && <Check className="w-3.5 h-3.5 text-[#00e0ff]" />}
              </span>
              {p.name}
            </button>
          ))}
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
