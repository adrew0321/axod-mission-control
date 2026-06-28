"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

export default function NewSessionDialog({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(""); setError(null);
    fetch(`/api/projects/${encodeURIComponent(projectId)}/branches`)
      .then((r) => r.json())
      .then((d) => { setBranches(d.branches ?? []); setBase(d.default ?? (d.branches?.[0] ?? "dev")); })
      .catch(() => { setBranches([]); setBase("dev"); });
  }, [open, projectId]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title, baseBranch: base }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? `Failed (${res.status})`);
        setPending(false);
        return;
      }
      const { id } = await res.json();
      await fetch(`/api/sessions/${encodeURIComponent(id)}/active`, { method: "POST" });
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setPending(false);
    }
  }

  const inputCls =
    "w-full bg-[#060810] border border-[#2a3441] focus:border-[#00e0ff] rounded-md px-3 py-2 text-xs text-[#e6edf3] placeholder-[#5c6470] focus:outline-none transition-colors mb-3";
  const labelCls = "block text-[10px] font-mono text-[#5c6470] tracking-wider uppercase mb-1";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <form onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}
        className="w-[420px] bg-[#11161d] border border-[#1e2632] rounded-lg p-6 shadow-lg shadow-black/40">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#e6edf3] font-heading">New session</h2>
          <button type="button" onClick={onClose} className="text-[#5c6470] hover:text-[#e6edf3]"><X className="w-4 h-4" /></button>
        </div>

        <label className={labelCls}>Title (optional)</label>
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New session" />

        <label className={labelCls}>Base branch</label>
        <select className={inputCls} value={base} onChange={(e) => setBase(e.target.value)}>
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        {error && (
          <div className="mb-3 px-3 py-2 rounded text-[11px] font-mono bg-red-500/10 border border-red-500/40 text-red-400">{error}</div>
        )}

        <button type="submit" disabled={pending}
          className="w-full bg-[#00e0ff] hover:bg-[#00c0dd] disabled:opacity-50 text-black font-bold py-2 rounded-md text-xs transition-colors">
          {pending ? "Creating…" : "Create session"}
        </button>
      </form>
    </div>
  );
}
