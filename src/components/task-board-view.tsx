"use client";

import { useState, type DragEvent } from "react";
import { Plus, Loader2, X, Lock, CircleCheck } from "lucide-react";
import type { BoardColumns, TaskCard, TaskColumn } from "@/lib/task-board";

interface TaskBoardViewProps {
  board: BoardColumns;
  projectId: string;
  onSelectSession: (sessionId: string) => Promise<void>;
  onDispatched: (sessionId: string, prompt: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const COLUMNS: { key: TaskColumn; label: string; dot: string }[] = [
  { key: "todo", label: "To-Do", dot: "bg-[#5c6470]" },
  { key: "in_progress", label: "In-Progress", dot: "bg-[#f0a020]" },
  { key: "done", label: "Done", dot: "bg-[#3fb950]" },
];

export default function TaskBoardView({
  board,
  projectId,
  onSelectSession,
  onDispatched,
  onRefresh,
}: TaskBoardViewProps) {
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [overCol, setOverCol] = useState<TaskColumn | null>(null);

  const allCards = [...board.todo, ...board.in_progress, ...board.done];

  async function createTask() {
    const title = newTitle.trim();
    if (!title) return;
    setBusy(true);
    try {
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, title, description: newDesc.trim() || undefined }),
      });
      setNewTitle("");
      setNewDesc("");
      setAdding(false);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function moveTask(card: TaskCard, to: TaskColumn) {
    if (card.origin !== "manual" || card.column === to) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${card.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: to }),
      });
      const data = (await res.json().catch(() => ({}))) as { sessionId?: string; prompt?: string };
      if (data.sessionId) {
        await onDispatched(data.sessionId, data.prompt ?? "");
        return;
      }
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function deleteTask(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: DragEvent, to: TaskColumn) {
    e.preventDefault();
    setOverCol(null);
    const id = e.dataTransfer.getData("text/plain");
    const card = allCards.find((c) => c.id === id);
    if (card) void moveTask(card, to);
  }

  return (
    <section className="flex-1 flex flex-col min-w-0 bg-[#0a0e14]">
      <div className="h-11 shrink-0 bg-[#11161d] border-b border-[#1e2632] px-4 flex items-center gap-2 select-none">
        <span className="font-semibold text-xs text-[#e6edf3] font-heading">Task Board</span>
        <span className="text-[10px] font-mono text-[#5c6470]">your cards + live agent work</span>
        {busy && <Loader2 className="w-3.5 h-3.5 text-[#00e0ff] animate-spin ml-1" />}
      </div>

      <div className="flex-1 min-h-0 flex gap-3 p-4 overflow-x-auto">
        {COLUMNS.map((col) => {
          const cards = board[col.key];
          return (
            <div
              key={col.key}
              onDragOver={(e) => {
                e.preventDefault();
                setOverCol(col.key);
              }}
              onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
              onDrop={(e) => onDrop(e, col.key)}
              className={`flex-1 min-w-[260px] max-w-[360px] flex flex-col bg-[#11161d] border rounded-lg ${
                overCol === col.key ? "border-[#00e0ff]/50" : "border-[#1e2632]"
              }`}
            >
              <div className="h-11 px-3 border-b border-[#1e2632] flex items-center gap-2 shrink-0">
                <span className={`w-1.5 h-1.5 rounded-full ${col.dot}`} />
                <span className="text-[10px] font-mono tracking-widest uppercase text-[#8b949e]">{col.label}</span>
                <span className="ml-auto text-[9px] font-mono text-[#5c6470] bg-[#161c25] border border-[#2a3441] rounded px-1.5">
                  {cards.length}
                </span>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
                {col.key === "todo" && (
                  <div>
                    {adding ? (
                      <div className="bg-[#161c25] border border-[#2a3441] rounded-lg p-2 flex flex-col gap-2">
                        <input
                          autoFocus
                          value={newTitle}
                          onChange={(e) => setNewTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void createTask();
                            if (e.key === "Escape") setAdding(false);
                          }}
                          placeholder="Task title…"
                          className="bg-[#0a0e14] border border-[#1e2632] rounded px-2 py-1 text-xs text-[#e6edf3] outline-none focus:border-[#00e0ff]/50"
                        />
                        <textarea
                          value={newDesc}
                          onChange={(e) => setNewDesc(e.target.value)}
                          placeholder="Context for Sage (optional)…"
                          rows={2}
                          className="bg-[#0a0e14] border border-[#1e2632] rounded px-2 py-1 text-[11px] text-[#8b949e] outline-none focus:border-[#00e0ff]/50 resize-none"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => void createTask()}
                            disabled={!newTitle.trim() || busy}
                            className="text-[10px] font-mono px-2 py-1 rounded bg-[#00e0ff] text-black font-bold disabled:opacity-40"
                          >
                            Add
                          </button>
                          <button
                            onClick={() => setAdding(false)}
                            className="text-[10px] font-mono px-2 py-1 rounded text-[#8b949e] hover:text-[#e6edf3]"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setAdding(true)}
                        className="w-full flex items-center justify-center gap-1 text-[11px] font-mono text-[#5c6470] hover:text-[#00e0ff] border border-dashed border-[#2a3441] hover:border-[#00e0ff]/40 rounded-lg py-2 transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" /> New task
                      </button>
                    )}
                  </div>
                )}

                {cards.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", card.id)}
                    onOpen={() => card.sessionId && void onSelectSession(card.sessionId)}
                    onDelete={() => void deleteTask(card.id)}
                  />
                ))}

                {cards.length === 0 && col.key !== "todo" && (
                  <div className="text-[10px] font-mono text-[#3a424d] text-center py-6">— empty —</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Card({
  card,
  onDragStart,
  onOpen,
  onDelete,
}: {
  card: TaskCard;
  onDragStart: (e: DragEvent) => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const manual = card.origin === "manual";
  return (
    <div
      draggable={manual}
      onDragStart={manual ? onDragStart : undefined}
      onClick={card.sessionId ? onOpen : undefined}
      className={`group relative rounded-lg border p-2.5 text-xs ${
        manual ? "bg-[#161c25] border-[#2a3441] cursor-grab" : "bg-[#0f141b] border-[#1e2632]"
      } ${card.sessionId ? "hover:border-[#00e0ff]/40" : ""}`}
    >
      <div className="flex items-start gap-2">
        <span className="flex-1 text-[#e6edf3] leading-snug pr-4">{card.title}</span>
        {manual ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete task"
            className="absolute top-2 right-2 text-[#3a424d] hover:text-[#f85149] opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <Lock className="w-3 h-3 text-[#3a424d] shrink-0" />
        )}
      </div>

      {card.description && manual && (
        <p className="mt-1 text-[10px] text-[#8b949e] line-clamp-2">{card.description}</p>
      )}

      <div className="mt-2 flex items-center gap-2 text-[9px] font-mono text-[#5c6470]">
        {card.ready && (
          <span className="flex items-center gap-1 text-[#3fb950]">
            <CircleCheck className="w-3 h-3" /> ready for review
          </span>
        )}
        {!manual && card.sessionStatus && <span>session · {card.sessionStatus}</span>}
        <span className="ml-auto">{manual ? "you" : "auto"}</span>
      </div>
    </div>
  );
}
