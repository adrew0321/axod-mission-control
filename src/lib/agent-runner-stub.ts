import 'server-only';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export type AgentEvent =
  | { type: 'token'; content: string }
  | { type: 'done'; fullText: string; costUsd?: number; tokensIn?: number; tokensOut?: number }
  | { type: 'error'; message: string };

interface StreamEventLine {
  type?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  result?: string;
  subtype?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function* runClaudeCodeStub(
  prompt: string,
  workingDir: string,
): AsyncIterable<AgentEvent> {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  if (workingDir && existsSync(workingDir)) {
    args.push('--add-dir', workingDir);
  }

  const proc = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true, // Windows: resolve claude.exe / claude.cmd via PATH
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  let fullText = '';
  let buffer = '';
  let finalCost: number | undefined;
  let finalTokensIn: number | undefined;
  let finalTokensOut: number | undefined;
  let sawResult = false;
  let stderr = '';

  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const decoder = new TextDecoder();
  try {
    for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let evt: StreamEventLine;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }

        if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta') {
          const text = evt.event.delta?.text ?? '';
          if (text) {
            fullText += text;
            yield { type: 'token', content: text };
          }
        } else if (evt.type === 'result' && evt.subtype === 'success') {
          sawResult = true;
          finalCost = evt.total_cost_usd;
          finalTokensIn = evt.usage?.input_tokens;
          finalTokensOut = evt.usage?.output_tokens;
          if (!fullText && typeof evt.result === 'string') {
            fullText = evt.result;
            yield { type: 'token', content: evt.result };
          }
        } else if (evt.type === 'result' && evt.subtype !== 'success') {
          yield { type: 'error', message: `claude returned subtype=${evt.subtype}` };
        }
      }
    }
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    return;
  }

  const exitCode: number = await new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    proc.once('exit', (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0 && !sawResult) {
    yield {
      type: 'error',
      message: `claude exited ${exitCode}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`,
    };
    return;
  }

  yield {
    type: 'done',
    fullText,
    costUsd: finalCost,
    tokensIn: finalTokensIn,
    tokensOut: finalTokensOut,
  };
}
