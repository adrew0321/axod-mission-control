import 'server-only';
import { existsSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

export type AgentEvent =
  | { type: 'token'; content: string }
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
  signal?: AbortSignal;
}

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'];

export async function* runClaudeAgent(opts: RunAgentOptions): AsyncIterable<AgentEvent> {
  const { prompt, workingDir, model, systemPrompt, signal } = opts;
  const allowedTools =
    opts.allowedTools && opts.allowedTools.length > 0 ? opts.allowedTools : DEFAULT_ALLOWED_TOOLS;

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
        // Same set for capability (model only sees these) and auto-run
        // (no permission round-trip → no hang). See RunAgentOptions.allowedTools.
        tools: allowedTools,
        allowedTools,
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
      } else if (message.type === 'assistant' && message.error) {
        // auth_failed | rate_limit | billing_error | model_not_found | etc.
        yield { type: 'error', message: `agent error: ${message.error}` };
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
