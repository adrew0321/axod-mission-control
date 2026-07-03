import 'server-only';
import { existsSync } from 'node:fs';
import { query, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

export type AgentEvent =
  | { type: 'token'; content: string }
  | { type: 'tool'; name: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; content: string; isError: boolean }
  | { type: 'done'; fullText: string; costUsd?: number; tokensIn?: number; tokensOut?: number }
  | { type: 'error'; message: string };

export interface RunAgentOptions {
  prompt: string;
  workingDir: string;
  model?: string;
  systemPrompt?: string;
  /**
   * Tools this agent may use. For now this is BOTH the capability set and the
   * auto-run set: the agent can only see these tools, and they execute without
   * a per-call gate.
   *
   * Why no interactive approval gate yet: the SDK's `canUseTool` permission
   * callback is never invoked by the installed `claude` CLI (2.1.150) under
   * SDK 0.3.152 — any tool needing a permission decision hangs the stream
   * (verified across 7 probes; see docs/plans/week-2-single-agent-sdk.md
   * Day 3 notes). Until that's fixed we keep agents to safe, auto-runnable
   * tool sets via `allowedTools`. Dangerous tools are simply not in any v1
   * agent's allowlist. The approval infra (src/lib/permissions.ts, the
   * /api/approvals/[id]/decision route, and the approval-card UI) is built and
   * dormant, ready to wire to `canUseTool` once the gate works.
   */
  allowedTools?: string[];
  /**
   * In-process MCP servers exposing custom tools (e.g. Sage's `dispatch_agent`).
   * Their tools are named `mcp__<serverName>__<toolName>` and must also be
   * listed in `extraAllowedTools` to auto-run without a permission round-trip.
   */
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  /**
   * Fully-qualified MCP tool names to auto-run (e.g.
   * `mcp__mission_control__dispatch_agent`). Kept separate from `allowedTools`
   * because `tools` (the built-in capability set) only accepts built-in names.
   */
  extraAllowedTools?: string[];
  /**
   * Extra environment variables merged over `process.env` for the CLI subprocess.
   * Used to raise `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` for an orchestrator whose
   * `dispatch_agent` MCP call blocks while a specialist works (>60s default).
   */
  extraEnv?: Record<string, string>;
  signal?: AbortSignal;
}

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'];

// A tool_result block's content is either a plain string or an array of
// content blocks; for Bash it's the command's combined stdout/stderr. Flatten
// to a single string, keeping only text parts.
function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && (b as { type?: string }).type === 'text'
          ? String((b as { text?: string }).text ?? '')
          : '',
      )
      .join('');
  }
  return '';
}

export async function* runClaudeAgent(opts: RunAgentOptions): AsyncIterable<AgentEvent> {
  const { prompt, workingDir, model, systemPrompt, signal, mcpServers, extraAllowedTools, extraEnv } =
    opts;
  const allowedTools =
    opts.allowedTools && opts.allowedTools.length > 0 ? opts.allowedTools : DEFAULT_ALLOWED_TOOLS;
  // Built-ins (capability set) plus any MCP tool names the caller wants auto-run.
  const autoRun = extraAllowedTools?.length ? [...allowedTools, ...extraAllowedTools] : allowedTools;

  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const cwd = workingDir && existsSync(workingDir) ? workingDir : process.cwd();

  let fullText = '';
  // When the agent interleaves text with tool calls, its text arrives as
  // separate blocks with no separator ("…clocks." + "Now let me…" = "clocks.Now").
  // Insert a paragraph break before the first text after a tool call.
  let pendingBreak = false;
  // Correlate tool_result blocks (which carry only tool_use_id) back to the
  // tool name, so consumers can tell which results were Bash commands.
  const toolNames = new Map<string, string>();

  try {
    const response = query({
      prompt,
      options: {
        cwd,
        model: model ?? 'claude-opus-4-7',
        ...(systemPrompt ? { systemPrompt } : {}),
        includePartialMessages: true,
        // `tools` is the built-in capability set the model can see; `allowedTools`
        // is what auto-runs (no permission round-trip → no hang). MCP tools are
        // added via `mcpServers` and auto-run through `extraAllowedTools`.
        tools: allowedTools,
        allowedTools: autoRun,
        ...(mcpServers ? { mcpServers } : {}),
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
        abortController,
      },
    });

    for await (const message of response) {
      if (message.type === 'stream_event') {
        const event = message.event;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          let text = event.delta.text;
          if (text) {
            if (pendingBreak && fullText.trim() && !fullText.endsWith('\n')) {
              text = '\n\n' + text;
            }
            pendingBreak = false;
            fullText += text;
            yield { type: 'token', content: text };
          }
        }
      } else if (message.type === 'assistant') {
        if (message.error) {
          // auth_failed | rate_limit | billing_error | model_not_found | etc.
          yield { type: 'error', message: `agent error: ${message.error}` };
        } else {
          // Surface each tool the agent invokes so the UI can show live activity
          // ("Reading X", "Editing Y", "Running …"). tool_use blocks carry the
          // complete name + input on the assistant message.
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_use') {
                const tu = block as { id?: string; name?: string; input?: unknown };
                if (tu.name) {
                  if (tu.id) toolNames.set(tu.id, tu.name);
                  pendingBreak = true; // break before the next text block
                  yield {
                    type: 'tool',
                    name: tu.name,
                    input:
                      tu.input && typeof tu.input === 'object'
                        ? (tu.input as Record<string, unknown>)
                        : undefined,
                  };
                }
              }
            }
          }
        }
      } else if (message.type === 'user') {
        // Tool results come back on a `user` message as tool_result blocks.
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result') {
              const tr = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
              const tool = (tr.tool_use_id && toolNames.get(tr.tool_use_id)) || 'unknown';
              yield {
                type: 'tool_result',
                tool,
                content: flattenToolResultContent(tr.content),
                isError: Boolean(tr.is_error),
              };
            }
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          if (!fullText && message.result) {
            fullText = message.result;
            yield { type: 'token', content: message.result };
          }
          yield {
            type: 'done',
            fullText,
            costUsd: message.total_cost_usd,
            tokensIn: message.usage?.input_tokens,
            tokensOut: message.usage?.output_tokens,
          };
        } else {
          const detail = 'errors' in message && message.errors?.length ? `: ${message.errors.join('; ')}` : '';
          yield { type: 'error', message: `agent ended (${message.subtype})${detail}` };
        }
      }
    }
  } catch (err) {
    // AbortError is expected when the operator stops generation — not a failure.
    if (err instanceof Error && err.name === 'AbortError') return;
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
