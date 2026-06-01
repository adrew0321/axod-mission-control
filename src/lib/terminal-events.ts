import type { AgentEvent } from "./agent-runner-sdk";

// A single Terminal-tab line: either a command the agent ran, or a chunk of
// that command's output. Bash-only — other tools stay in the STATE pane / diff.
export interface TerminalEvent {
  type: "terminal";
  stream: "command" | "output";
  agent_id: string;
  content: string;
  isError?: boolean;
}

// Map a runner AgentEvent to a Terminal SSE event, or null if it is not a Bash
// command/result. Shared by the Sage stream loop and the dispatch loop so the
// Bash-only filtering lives in exactly one place.
export function toTerminalEvent(event: AgentEvent, agentId: string): TerminalEvent | null {
  if (event.type === "tool" && event.name === "Bash") {
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    return { type: "terminal", stream: "command", agent_id: agentId, content: command };
  }
  if (event.type === "tool_result" && event.tool === "Bash") {
    return {
      type: "terminal",
      stream: "output",
      agent_id: agentId,
      content: event.content,
      isError: event.isError,
    };
  }
  return null;
}
