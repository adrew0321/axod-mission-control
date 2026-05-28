import 'server-only';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { db } from '@/db/client';
import { agents } from '@/db/schema';
import { runClaudeAgent } from './agent-runner-sdk';

/**
 * In-process MCP server name. The dispatch tool is therefore exposed to Sage as
 * `mcp__mission_control__dispatch_agent` (server name + tool name).
 */
export const DISPATCH_SERVER_NAME = 'mission_control';
export const DISPATCH_TOOL_NAME = `mcp__${DISPATCH_SERVER_NAME}__dispatch_agent`;

/**
 * Specialists Sage may dispatch. Enum-restricted so Sage can't invent an agent.
 * Sage itself is intentionally absent (no self-dispatch / recursion), as is any
 * agent that isn't yet a real SDK runner. Atlas (developer) is the only one for
 * week 3.
 */
const DISPATCHABLE = ['atlas'] as const;

export interface DispatchTokenUsage {
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface DispatchContext {
  /** The session's git worktree — the dispatched agent runs in the same cwd as Sage. */
  workingDir: string;
  /** Operator "Stop" aborts the parent stream and, through this, the dispatched agent. */
  signal?: AbortSignal;
  /** Emit an SSE event to the operator's stream (dispatch_start / _token / _done / _error). */
  emit: (event: { type: string; [k: string]: unknown }) => void;
  /** Persist the dispatched agent's final message to the DB (role 'agent', its own agent_id). */
  persistMessage: (agentId: string, content: string, usage: DispatchTokenUsage) => Promise<void>;
}

function buildTaskPrompt(task: string, context?: string): string {
  if (!context?.trim()) return task;
  return `${task}\n\n## Context from Sage\n${context}`;
}

/**
 * Build the in-process MCP server that gives Sage its `dispatch_agent` tool.
 *
 * When Sage calls the tool, the handler loads the target specialist from the DB,
 * runs it as a nested `runClaudeAgent` in the same worktree, streams its output
 * to the operator via `ctx.emit`, persists its final message, and returns that
 * summary to Sage as the tool result so Sage can continue the turn.
 *
 * The dispatched agent does NOT receive this server, so it cannot dispatch
 * further (no recursion).
 */
export function createDispatchServer(ctx: DispatchContext) {
  const dispatchTool = tool(
    'dispatch_agent',
    'Hand a concrete, self-contained coding task to a specialist agent that can edit files and run commands in this session\'s isolated worktree. Use this whenever the operator wants real code changes — you (Sage) plan and coordinate, the specialist implements. Returns the specialist\'s final summary of what it did.',
    {
      agent_id: z
        .enum(DISPATCHABLE)
        .describe('Which specialist to dispatch. Only "atlas" (lead developer) is available right now.'),
      task: z
        .string()
        .min(1)
        .describe(
          'A concrete, self-contained task: which files to change, what the change is, and how to verify it. The specialist does not see the operator chat, so include everything it needs.',
        ),
      context: z
        .string()
        .optional()
        .describe('Optional background: findings from your own investigation, constraints, or prior decisions.'),
    },
    async (args) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, args.agent_id))
        .limit(1)
        .then((r) => r[0]);

      if (!agent) {
        const message = `No specialist with id "${args.agent_id}" exists.`;
        ctx.emit({ type: 'dispatch_error', agent_id: args.agent_id, message });
        return { content: [{ type: 'text', text: message }], isError: true };
      }

      ctx.emit({
        type: 'dispatch_start',
        agent_id: agent.id,
        agent_name: agent.name,
        task: args.task,
      });

      let fullText = '';
      const usage: DispatchTokenUsage = {};
      let errored: string | undefined;

      for await (const event of runClaudeAgent({
        prompt: buildTaskPrompt(args.task, args.context),
        workingDir: ctx.workingDir,
        model: agent.model,
        systemPrompt: agent.system_prompt,
        allowedTools: agent.tools_allowlist ?? undefined,
        signal: ctx.signal,
      })) {
        if (event.type === 'token') {
          fullText += event.content;
          ctx.emit({ type: 'dispatch_token', agent_id: agent.id, content: event.content });
        } else if (event.type === 'tool') {
          ctx.emit({ type: 'dispatch_activity', agent_id: agent.id, tool: event.name, input: event.input });
        } else if (event.type === 'done') {
          usage.costUsd = event.costUsd;
          usage.tokensIn = event.tokensIn;
          usage.tokensOut = event.tokensOut;
          if (!fullText && event.fullText) fullText = event.fullText;
        } else if (event.type === 'error') {
          errored = event.message;
          ctx.emit({ type: 'dispatch_error', agent_id: agent.id, message: event.message });
        }
      }

      if (fullText) {
        await ctx.persistMessage(agent.id, fullText, usage);
      }
      ctx.emit({ type: 'dispatch_done', agent_id: agent.id, errored: Boolean(errored) });

      const result =
        fullText || (errored ? `${agent.name} failed: ${errored}` : `${agent.name} produced no output.`);
      return { content: [{ type: 'text', text: result }], isError: Boolean(errored) && !fullText };
    },
  );

  return createSdkMcpServer({
    name: DISPATCH_SERVER_NAME,
    version: '1.0.0',
    // Always include the tool in Sage's prompt (don't defer behind tool search) —
    // it's Sage's one orchestration lever and must always be visible.
    alwaysLoad: true,
    tools: [dispatchTool],
  });
}
