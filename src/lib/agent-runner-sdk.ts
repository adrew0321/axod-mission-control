import 'server-only';
import { existsSync } from 'node:fs';
import { query, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';

export type AgentEvent =
  | { type: 'token'; content: string }
  | { type: 'done'; fullText: string; costUsd?: number; tokensIn?: number; tokensOut?: number }
  | { type: 'error'; message: string };

export interface RunAgentOptions {
  prompt: string;
  workingDir: string;
  model?: string;
  systemPrompt?: string;
  signal?: AbortSignal;
}

// Day-1 safety gate: auto-allow read-only tools, deny anything that mutates or
// shells out. Day 3 replaces this with the DB-backed approval flow
// (tool_permissions + approvals tables, surfaced to the operator).
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite']);

const dayOneGate: CanUseTool = async (toolName): Promise<PermissionResult> => {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { behavior: 'allow', updatedInput: {} };
  }
  return {
    behavior: 'deny',
    message: `Tool "${toolName}" requires operator approval (approval gates land in week 2 day 3).`,
  };
};

export async function* runClaudeAgent(opts: RunAgentOptions): AsyncIterable<AgentEvent> {
  const { prompt, workingDir, model, systemPrompt, signal } = opts;

  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const cwd = workingDir && existsSync(workingDir) ? workingDir : process.cwd();

  let fullText = '';

  try {
    const response = query({
      prompt,
      options: {
        cwd,
        model: model ?? 'claude-opus-4-7',
        ...(systemPrompt ? { systemPrompt } : {}),
        includePartialMessages: true,
        allowedTools: [...READ_ONLY_TOOLS],
        canUseTool: dayOneGate,
        abortController,
      },
    });

    for await (const message of response) {
      if (message.type === 'stream_event') {
        const event = message.event;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const text = event.delta.text;
          if (text) {
            fullText += text;
            yield { type: 'token', content: text };
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
          yield { type: 'error', message: `agent ended: ${message.subtype}` };
        }
      }
    }
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
