"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import FolderPicker from "@/components/folder-picker";
import { validateRepoName } from "@/lib/fs-browse";

export default function AddProjectDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [name, setName] = useState("");
  const [browsed, setBrowsed] = useState<string | null>(null); // current folder in the picker
  const [newFolder, setNewFolder] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("dev");
  const [githubUrl, setGithubUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!open) return null;

  function join(parent: string, child: string): string {
    const sep = /^[A-Za-z]:/.test(parent) ? "\\" : "/";
    return parent.replace(/[\\/]+$/, "") + sep + child;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!browsed) {
      setError(mode === "create" ? "Pick a parent folder." : "Pick the repo folder.");
      return;
    }
    let repoPath = browsed;
    if (mode === "create") {
      const v = validateRepoName(newFolder);
      if (!v.ok) {
        setError(v.error);
        return;
      }
      repoPath = join(browsed, newFolder.trim());
    }

    setPending(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, repoPath, defaultBranch, githubUrl, create: mode === "create" }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? `Failed (${res.status})`);
        setPending(false);
        return;
      }
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
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[440px] bg-[#11161d] border border-[#1e2632] rounded-lg p-6 shadow-lg shadow-black/40"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#e6edf3] font-heading">Add project</h2>
          <button type="button" onClick={onClose} className="text-[#5c6470] hover:text-[#e6edf3]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <label className={labelCls}>Name</label>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="My Client Site" required />

        <div className="flex gap-1 mb-3 p-0.5 bg-[#060810] border border-[#2a3441] rounded-md text-[11px] font-mono">
          {(["existing", "create"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setError(null); }}
              className={`flex-1 py-1 rounded transition-colors ${
                mode === m ? "bg-[#161c25] text-[#00e0ff]" : "text-[#5c6470] hover:text-[#8b949e]"
              }`}
            >
              {m === "existing" ? "Use existing repo" : "Create new"}
            </button>
          ))}
        </div>

        <label className={labelCls}>{mode === "create" ? "Parent folder" : "Repo folder"}</label>
        <div className="mb-3">
          <FolderPicker value={browsed} onChange={setBrowsed} />
        </div>

        {mode === "create" && (
          <>
            <label className={labelCls}>New folder name</label>
            <input className={inputCls} value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="my-new-repo" />
          </>
        )}

        <label className={labelCls}>Default branch</label>
        <input className={inputCls} value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} placeholder="dev" />

        <label className={labelCls}>GitHub URL (optional)</label>
        <input className={inputCls} value={githubUrl} onChange={(e) => setGithubUrl(e.target.value)} placeholder="https://github.com/you/repo" />

        {error && (
          <div className="mb-3 px-3 py-2 rounded text-[11px] font-mono bg-red-500/10 border border-red-500/40 text-red-400">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full bg-[#00e0ff] hover:bg-[#00c0dd] disabled:opacity-50 text-black font-bold py-2 rounded-md text-xs transition-colors"
        >
          {pending ? "Working…" : mode === "create" ? "Create + add project" : "Add project"}
        </button>
      </form>
    </div>
  );
}
