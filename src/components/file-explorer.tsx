"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import FileTree from "@/components/file-tree";
import { defineVividTheme, VIVID_THEME } from "@/lib/monaco-theme";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.Editor), {
  ssr: false,
  loading: () => <div className="p-4 text-[11px] font-mono text-[#5c6470]">Loading editor…</div>,
});

export default function FileExplorer({ projectId }: { projectId: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [language, setLanguage] = useState<string>("plaintext");
  const [binary, setBinary] = useState(false);
  const [loading, setLoading] = useState(false);

  // Reset when the active project changes.
  useEffect(() => {
    setSelectedPath(null);
    setContent("");
    setBinary(false);
  }, [projectId]);

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
      <div className="w-60 shrink-0 border-r border-[#1e2632] overflow-y-auto bg-[#0d1117]">
        <FileTree projectId={projectId} selectedPath={selectedPath} onSelect={open} />
      </div>
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
