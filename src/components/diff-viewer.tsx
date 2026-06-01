"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { PanelLeftClose, PanelLeftOpen, RefreshCw } from "lucide-react";

// Monaco is heavy and browser-only — load it lazily, client-side, only when the
// Code tab is open. @monaco-editor/react fetches the editor via its default CDN
// loader, which also sidesteps Turbopack web-worker bundling. (Self-hosting the
// editor assets is a week-5 deploy follow-up.)
const DiffEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => <div className="p-4 text-[11px] font-mono text-[#5c6470]">Loading editor…</div>,
});

export interface FileDiff {
  path: string;
  status: string;
  original: string;
  modified: string;
  skipped?: boolean;
}

function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "astro":
    case "html":
    case "vue":
    case "svelte":
      return "html";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "json":
      return "json";
    case "md":
    case "mdx":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "py":
      return "python";
    case "sh":
      return "shell";
    default:
      return "plaintext";
  }
}

function statusColor(status: string): string {
  if (status.startsWith("A")) return "text-[#3fb950]";
  if (status.startsWith("D")) return "text-red-400";
  return "text-[#d29922]";
}

export default function DiffViewer({
  files,
  base,
  loading,
  onRefresh,
}: {
  files: FileDiff[];
  base: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const [filesOpen, setFilesOpen] = useState(true);
  const active = files[selected] ?? files[0];

  // Auto-collapse the file list on narrow screens (the mobile single-pane
  // layout) so the side-by-side diff gets the full width. Resolved once on
  // mount; after that the toggle is operator-driven (no resize listener).
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
      setFilesOpen(false);
    }
  }, []);

  return (
    <div className="h-full flex flex-col bg-[#11161d] border border-[#1e2632] rounded-lg overflow-hidden">
      <div className="h-9 w-full bg-[#161c25] border-b border-[#1e2632] px-3 flex items-center justify-between text-xs select-none">
        <div className="flex items-center gap-2 min-w-0">
          {files.length > 0 && (
            <button
              onClick={() => setFilesOpen((v) => !v)}
              aria-label={filesOpen ? "Hide file list" : "Show file list"}
              title={filesOpen ? "Hide file list" : "Show file list"}
              className="shrink-0 flex items-center text-[#8b949e] hover:text-[#00e0ff] transition-colors"
            >
              {filesOpen ? (
                <PanelLeftClose className="w-3.5 h-3.5" />
              ) : (
                <PanelLeftOpen className="w-3.5 h-3.5" />
              )}
            </button>
          )}
          <div className="font-mono text-[10px] text-[#8b949e] flex items-center gap-2 min-w-0">
            {files.length > 0 ? (
              <>
                <span className="text-[#5c6470] shrink-0">
                  {files.length} file{files.length > 1 ? "s" : ""}
                </span>
                {base && (
                  <span className="text-[#5c6470] shrink-0">
                    vs <span className="text-[#00e0ff]">{base}</span>
                  </span>
                )}
              </>
            ) : (
              <span className="text-[#5c6470]">No changes in this session&apos;s worktree</span>
            )}
          </div>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="shrink-0 flex items-center gap-1 text-[9.5px] font-mono text-[#8b949e] hover:text-[#00e0ff] bg-[#11161d] border border-[#2a3441] px-2 py-0.5 rounded transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin text-[#00e0ff]" : ""}`} />
          Refresh
        </button>
      </div>

      {files.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[#5c6470] text-xs font-mono">
          {loading ? "Loading diff…" : "No changes yet — dispatch a specialist to edit files."}
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* changed-files picker — collapsible via the header toggle */}
          {filesOpen && (
          <div className="w-52 shrink-0 border-r border-[#1e2632] overflow-y-auto bg-[#0d1117]">
            {files.map((f, i) => (
              <button
                key={f.path}
                onClick={() => setSelected(i)}
                title={f.path}
                className={`w-full text-left px-2.5 py-1.5 font-mono text-[10.5px] flex items-center gap-1.5 border-l-2 transition-colors ${
                  i === selected
                    ? "bg-[#161c25] border-[#00e0ff] text-[#e6edf3]"
                    : "border-transparent text-[#8b949e] hover:bg-[#161c25]/50"
                }`}
              >
                <span className={`shrink-0 font-bold ${statusColor(f.status)}`}>{f.status}</span>
                <span className="truncate">{f.path}</span>
              </button>
            ))}
          </div>
          )}

          {/* side-by-side diff */}
          <div className="flex-1 min-w-0">
            {active?.skipped ? (
              <div className="h-full flex items-center justify-center text-[#5c6470] text-xs font-mono">
                {active.original}
              </div>
            ) : (
              <DiffEditor
                height="100%"
                theme="vs-dark"
                language={languageFromPath(active?.path ?? "")}
                original={active?.original ?? ""}
                modified={active?.modified ?? ""}
                options={{
                  readOnly: true,
                  renderSideBySide: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                  automaticLayout: true,
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
