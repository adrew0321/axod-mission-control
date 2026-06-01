"use client";

import type { PlanSnapshot, TodoItem } from "@/lib/plan-events";

// Map an agent id to a display name for the plan header. Falls back to a
// capitalized id for any agent not explicitly named.
function ownerLabel(agentId: string): string {
  const known: Record<string, string> = { sage: "Sage", atlas: "Atlas" };
  const name = known[agentId] ?? agentId.charAt(0).toUpperCase() + agentId.slice(1);
  return `${name}'s plan`;
}

// One checklist row. Pending = hollow circle, in-progress = half circle (cyan,
// uses activeForm), completed = check (green, struck through).
function Row({ todo }: { todo: TodoItem }) {
  if (todo.status === "completed") {
    return (
      <li className="flex items-start gap-2.5 py-1">
        <span className="select-none text-green-400 mt-0.5">✓</span>
        <span className="text-[#5c6470] line-through">{todo.content}</span>
      </li>
    );
  }
  if (todo.status === "in_progress") {
    return (
      <li className="flex items-start gap-2.5 py-1">
        <span className="select-none text-cyan-400 mt-0.5">◐</span>
        <span className="text-[#e6edf3] font-medium">{todo.activeForm ?? todo.content}</span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2.5 py-1">
      <span className="select-none text-[#5c6470] mt-0.5">○</span>
      <span className="text-[#8b949e]">{todo.content}</span>
    </li>
  );
}

// Live plan checklist. Renders the most recent TodoWrite snapshot (latest writer
// wins, managed by the parent). Shows a quiet placeholder until the first plan
// arrives this session. Ephemeral — gone on a full reload.
export default function PlanView({ snapshot }: { snapshot: PlanSnapshot | null }) {
  if (!snapshot || snapshot.todos.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-[#11161d] border border-[#1e2632] rounded-lg p-5">
        <p className="text-[11px] text-[#5c6470]">
          No plan yet — Sage will chart the course when work begins.
        </p>
      </div>
    );
  }

  const total = snapshot.todos.length;
  const done = snapshot.todos.filter((t) => t.status === "completed").length;

  return (
    <div className="h-full flex flex-col bg-[#11161d] border border-[#1e2632] rounded-lg p-5 overflow-hidden">
      <div className="flex items-center justify-between mb-4 pb-2 border-b border-[#2a3441] shrink-0">
        <h2 className="text-sm font-bold text-[#e6edf3] font-heading uppercase tracking-wide">
          {ownerLabel(snapshot.agentId)}
        </h2>
        <span className="bg-[#161c25] border border-[#2a3441] px-2 py-0.5 rounded text-[10px] text-cyan-400">
          {done} / {total}
        </span>
      </div>
      <ul className="flex-1 min-h-0 overflow-y-auto text-xs font-sans leading-relaxed pr-1">
        {snapshot.todos.map((todo, i) => (
          <Row key={i} todo={todo} />
        ))}
      </ul>
    </div>
  );
}
