"use client";

import { useState, useEffect, useCallback } from "react";
import * as Icons from "lucide-react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, type LucideIcon } from "lucide-react";
import { fileIcon } from "@/lib/file-tree";

type Entry = { name: string; type: "dir" | "file" };

function FileLeaf({
  name,
  path,
  selectedPath,
  onSelect,
}: {
  name: string;
  path: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const { icon, color } = fileIcon(name);
  const Icon = (Icons as unknown as Record<string, LucideIcon>)[icon] ?? Icons.File;
  const active = selectedPath === path;
  return (
    <button
      onClick={() => onSelect(path)}
      className={`w-full flex items-center gap-1.5 pr-2 py-[3px] text-[11px] font-mono text-left transition-colors ${
        active ? "bg-[#11233a] text-[#e6edf3] shadow-[inset_2px_0_0_#00e0ff]" : "hover:bg-[#161c25]"
      }`}
    >
      <Icon className={`w-3.5 h-3.5 shrink-0 ${color}`} />
      <span className="truncate">{name}</span>
    </button>
  );
}

function FolderNode({
  name,
  path,
  projectId,
  depth,
  selectedPath,
  onSelect,
}: {
  name: string;
  path: string;
  projectId: string;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && entries === null) {
      setLoading(true);
      try {
        const res = await fetch(`/api/files?projectId=${encodeURIComponent(projectId)}&dir=${encodeURIComponent(path)}`);
        const data = await res.json();
        setEntries(res.ok ? (data.entries ?? []) : []);
      } catch {
        setEntries([]);
      } finally {
        setLoading(false);
      }
    }
  }, [open, entries, projectId, path]);

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1 pr-2 py-[3px] text-[11px] font-mono text-[#e3b341] hover:bg-[#161c25] text-left"
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0 text-[#5c6470]" /> : <ChevronRight className="w-3 h-3 shrink-0 text-[#5c6470]" />}
        {open ? <FolderOpen className="w-3.5 h-3.5 shrink-0" /> : <Folder className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate">{name}</span>
      </button>
      {open && (
        <div>
          {loading && <div className="text-[10px] font-mono text-[#5c6470]" style={{ paddingLeft: (depth + 1) * 12 + 8 }}>loading…</div>}
          {entries?.map((e) =>
            e.type === "dir" ? (
              <FolderNode
                key={e.name}
                name={e.name}
                path={path ? `${path}/${e.name}` : e.name}
                projectId={projectId}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ) : (
              <div key={e.name} style={{ paddingLeft: (depth + 1) * 12 + 4 }}>
                <FileLeaf name={e.name} path={path ? `${path}/${e.name}` : e.name} selectedPath={selectedPath} onSelect={onSelect} />
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export default function FileTree({
  projectId,
  selectedPath,
  onSelect,
}: {
  projectId: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);

  // Load the repo root once per project (re-runs when the active project changes).
  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    (async () => {
      try {
        const res = await fetch(`/api/files?projectId=${encodeURIComponent(projectId)}&dir=`);
        const data = await res.json();
        if (!cancelled) setEntries(res.ok ? (data.entries ?? []) : []);
      } catch {
        if (!cancelled) setEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (entries === null) {
    return <div className="p-3 text-[11px] font-mono text-[#5c6470]">Loading files…</div>;
  }

  return (
    <div className="py-1">
      {entries.map((e) =>
        e.type === "dir" ? (
          <FolderNode key={e.name} name={e.name} path={e.name} projectId={projectId} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
        ) : (
          <div key={e.name} style={{ paddingLeft: 4 }}>
            <FileLeaf name={e.name} path={e.name} selectedPath={selectedPath} onSelect={onSelect} />
          </div>
        ),
      )}
    </div>
  );
}
