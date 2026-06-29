// Pure AKIRA tool action handlers + tool-name constants. No db, no server-only,
// no SDK — so the tsx test runner can import and exercise them directly. The
// SDK server wiring + db-backed read tools live in ./tools (server-only).

import { resolveDestination } from './destinations';

export const AKIRA_SERVER_NAME = 'akira';
export const AKIRA_NAVIGATE = 'mcp__akira__navigate';
export const AKIRA_OPEN = 'mcp__akira__open';
export const AKIRA_RELAY = 'mcp__akira__relay';
export const AKIRA_LIST_SESSIONS = 'mcp__akira__list_sessions';
export const AKIRA_GET_SESSION = 'mcp__akira__get_session_detail';

export interface AkiraToolContext {
  emit: (e: { type: string; [k: string]: unknown }) => void;
}

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export async function navigateHandler(
  args: { projectId: string; sessionId?: string },
  ctx: AkiraToolContext,
): Promise<ToolResult> {
  if (!args.projectId) return err('projectId is required.');
  ctx.emit({ type: 'navigate', projectId: args.projectId, sessionId: args.sessionId ?? null });
  return ok(`Navigating to ${args.projectId}${args.sessionId ? ` / ${args.sessionId}` : ''}.`);
}

export async function openHandler(
  args: { target: string; query?: string },
  ctx: AkiraToolContext,
): Promise<ToolResult> {
  const dest = resolveDestination(args.target, args.query);
  if (!dest) return err(`I don't have a destination for "${args.target}" yet.`);
  ctx.emit({ type: 'open_url', url: dest.url, label: dest.label });
  return ok(`Opening ${dest.label}.`);
}

export async function relayHandler(
  args: { projectId: string; sessionId: string; instruction: string },
  ctx: AkiraToolContext,
): Promise<ToolResult> {
  // Propose ONLY. Side-effect free: no DB write, no turn. The operator confirms,
  // then the /api/akira/relay/confirm route runs the turn.
  if (!args.sessionId || !args.instruction?.trim()) {
    return err('relay needs a target sessionId and an instruction.');
  }
  ctx.emit({
    type: 'relay_proposal',
    projectId: args.projectId,
    sessionId: args.sessionId,
    instruction: args.instruction,
  });
  return ok(`Proposed to the operator: run "${args.instruction}" in session ${args.sessionId}. Awaiting his confirmation.`);
}
