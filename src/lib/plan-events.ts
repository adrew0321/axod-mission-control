// A live "plan" is the most recent TodoWrite snapshot an agent has written.
// Pure + client-safe (no server-only, no React) so the SSE handler and tests
// can both use it. Mirrors src/lib/terminal-events.ts.

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export interface PlanSnapshot {
  agentId: string;
  todos: TodoItem[];
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

// Turn a TodoWrite tool input into a plan snapshot, or null if this is not a
// usable TodoWrite call. Defensive: the input crosses the SSE boundary as
// untyped JSON, so every field is validated/coerced.
export function toPlanSnapshot(
  tool: string,
  input: unknown,
  agentId: string,
): PlanSnapshot | null {
  if (tool !== "TodoWrite") return null;
  if (!input || typeof input !== "object") return null;

  const rawTodos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(rawTodos)) return null;

  const todos: TodoItem[] = [];
  for (const raw of rawTodos) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { content?: unknown; status?: unknown; activeForm?: unknown };
    const content = typeof r.content === "string" ? r.content.trim() : "";
    if (!content) continue;

    const status: TodoStatus =
      typeof r.status === "string" && KNOWN_STATUSES.has(r.status)
        ? (r.status as TodoStatus)
        : "pending";

    const todo: TodoItem = { content, status };
    if (typeof r.activeForm === "string" && r.activeForm.trim()) {
      todo.activeForm = r.activeForm;
    }
    todos.push(todo);
  }

  if (todos.length === 0) return null;
  return { agentId, todos };
}
