"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import FileTree from "@/components/file-tree";
import { defineVividTheme, VIVID_THEME } from "@/lib/monaco-theme";
import { clampTreeWidth, TREE_DEFAULT } from "@/lib/ui-helpers";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.Editor), {
  ssr: false,
  loading: () => <div className="p-4 text-[11px] font-mono text-[#5c6470]">Loading editor…</div>,
});

const WIDTH_KEY = "mc_files_tree_width";

export default function FileExplorer({ projectId }: { projectId: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [language, setLanguage] = useState<string>("plaintext");
  const [binary, setBinary] = useState(false);
  const [loading, setLoading] = useState(false);
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  // Restore the saved tree width on mount.
  useEffect(() => {
    const saved = window.localStorage.getItem(WIDTH_KEY);
    if (saved !== null) setTreeWidth(clampTreeWidth(parseInt(saved, 10)));
  }, []);

  // Reset the open file when the active project changes.
  useEffect(() => {
    setSelectedPath(null);
    setContent("");
    setBinary(false);
  }, [projectId]);

  const onDragMove = useCallback((e: MouseEvent) => {
    if (!drag.current) return;
    setTreeWidth(clampTreeWidth(drag.current.startW + (e.clientX - drag.current.startX)));
  }, []);

  const onDragEnd = useCallback(() => {
    drag.current = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
    setTreeWidth((w) => {
      window.localStorage.setItem(WIDTH_KEY, String(w));
      return w;
    });
  }, [onDragMove]);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = { startX: e.clientX, startW: treeWidth };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  }, [treeWidth, onDragMove, onDragEnd]);

  const resetWidth = useCallback(() => {
    setTreeWidth(TREE_DEFAULT);
    window.localStorage.setItem(WIDTH_KEY, String(TREE_DEFAULT));
  }, []);

  const open = useCallback(async (path: string) => {
    setSelectedPath(path);
    setLoading(true);
    setBinary(false);
    try {
      const res = await fetch(`/api/files/content?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.binary) {
        setBinary(true);
        setContent("");
      } else {
        setContent(data.content ?? "");
        setLanguage(data.language ?? "plaintext");
      }
    } catch {
      setBinary(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  return (
    <div className="h-full flex bg-[#11161d] border border-[#1e2632] rounded-lg overflow-hidden">
      <div style={{ width: treeWidth }} className="shrink-0 overflow-y-auto bg-[#0d1117]">
        <FileTree projectId={projectId} selectedPath={selectedPath} onSelect={open} />
      </div>

      {/* drag handle */}
      <div
        onMouseDown={onDragStart}
        onDoubleClick={resetWidth}
        title="Drag to resize · double-click to reset"
        className="w-1 shrink-0 cursor-col-resize bg-[#1e2632] hover:bg-[#00e0ff]/40 transition-colors"
      />

      <div className="flex-1 min-w-0 bg-[#060810]">
        {!selectedPath ? (
          <div className="h-full flex items-center justify-center text-[#5c6470] text-xs font-mono">
            Select a file to view it.
          </div>
        ) : binary ? (
          <div className="h-full flex items-center justify-center text-[#5c6470] text-xs font-mono px-4 text-center">
            Binary or oversized file — not shown.
          </div>
        ) : loading ? (
          <div className="h-full flex items-center justify-center text-[#5c6470] text-xs font-mono">Loading…</div>
        ) : (
          <MonacoEditor
            height="100%"
            theme={VIVID_THEME}
            language={language}
            value={content}
            path={selectedPath}
            beforeMount={defineVividTheme}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              automaticLayout: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
