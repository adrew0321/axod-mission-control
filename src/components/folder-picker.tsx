"use client";

import { useState, useEffect, useCallback } from "react";
import { Folder, ChevronUp, Check, RefreshCw } from "lucide-react";
import { breadcrumbSegments } from "@/lib/fs-browse";

type Entry = { name: string; isRepo: boolean };
type BrowseResult = { path: string; parent: string | null; entries: Entry[]; drives: string[] };

function pathSep(p: string): string {
  return /^[A-Za-z]:/.test(p) ? "\\" : "/";
}

export default function FolderPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (absPath: string) => void;
}) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(
    async (path?: string) => {
      setLoading(true);
      setError(null);
      try {
        const qs = path ? `?path=${encodeURIComponent(path)}` : "";
        const res = await fetch(`/api/fs/browse${qs}`);
        const d = await res.json();
        if (!res.ok) {
          setError(d.error ?? "Could not read folder");
        } else {
          setData(d);
          onChange(d.path);
        }
      } catch {
        setError("Network error");
      } finally {
        setLoading(false);
      }
    },
    [onChange],
  );

  useEffect(() => {
    void browse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const crumbs = data ? breadcrumbSegments(data.path) : [];

  return (
    <div className="border border-[#2a3441] rounded-md bg-[#060810] overflow-hidden">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#1e2632] text-[10px] font-mono text-[#8b949e] flex-wrap">
        <Folder className="w-3.5 h-3.5 text-[#e3b341] shrink-0" />
        {crumbs.map((c, i) => (
          <span key={c.path} className="flex items-center gap-1">
            {i > 0 && <span className="text-[#3a424d]">›</span>}
            <button type="button" onClick={() => browse(c.path)} className="hover:text-[#00e0ff] transition-colors">
              {c.label}
            </button>
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {data?.drives && data.drives.length > 0 && (
            <select
              value=""
              onChange={(e) => e.target.value && browse(e.target.value)}
              className="bg-[#161c25] border border-[#2a3441] rounded text-[10px] text-[#8b949e] px-1 py-0.5"
              title="Switch drive"
            >
              <option value="">▾ drive</option>
              {data.drives.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => data?.parent && browse(data.parent)}
            disabled={!data?.parent}
            title="Up one folder"
            className="flex items-center gap-0.5 hover:text-[#00e0ff] disabled:opacity-30 transition-colors"
          >
            <ChevronUp className="w-3.5 h-3.5" /> up
          </button>
        </div>
      </div>

      <div className="max-h-44 overflow-y-auto">
        {loading ? (
          <div className="px-3 py-3 text-[11px] font-mono text-[#5c6470] flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3 animate-spin" /> loading…
          </div>
        ) : error ? (
          <div className="px-3 py-3 text-[11px] font-mono text-red-400">{error}</div>
        ) : data && data.entries.length === 0 ? (
          <div className="px-3 py-3 text-[11px] font-mono text-[#5c6470]">No subfolders here.</div>
        ) : (
          data?.entries.map((e) => (
            <button
              key={e.name}
              type="button"
              onClick={() => browse(`${data.path}${data.path.endsWith("\\") || data.path.endsWith("/") ? "" : pathSep(data.path)}${e.name}`)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] font-mono text-[#e6edf3] hover:bg-[#161c25] text-left"
            >
              <Folder className="w-3.5 h-3.5 text-[#e3b341] shrink-0" />
              <span className="truncate">{e.name}</span>
              {e.isRepo && (
                <span className="ml-auto flex items-center gap-1 text-[#3fb950] text-[9px] shrink-0">
                  <Check className="w-3 h-3" /> git repo
                </span>
              )}
            </button>
          ))
        )}
      </div>

      <div className="px-2 py-1.5 border-t border-[#1e2632] text-[10px] font-mono text-[#5c6470] truncate">
        Selected: <span className="text-[#00e0ff]">{value ?? data?.path ?? "…"}</span>
      </div>
    </div>
  );
}
