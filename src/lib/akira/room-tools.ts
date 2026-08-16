import 'server-only';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { sendCommand } from '@/lib/companion/registry';
import { type AkiraToolContext, type ToolResult, ok, err } from './tool-actions';
import { runShell } from './room-shell';

export const AKIRA_ROOM_LIST = 'mcp__akira__room_list';
export const AKIRA_ROOM_READ = 'mcp__akira__room_read';
export const AKIRA_ROOM_WRITE = 'mcp__akira__room_write';
export const AKIRA_ROOM_BASH = 'mcp__akira__room_bash';

export const ROOM_TOOL_NAMES = [AKIRA_ROOM_LIST, AKIRA_ROOM_READ, AKIRA_ROOM_WRITE, AKIRA_ROOM_BASH];

const ROOM_TIMEOUT_MS = 30_000;

async function run(
  action: 'fs_list' | 'fs_read' | 'fs_write',
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const { result } = sendCommand({ action, ...args }, ROOM_TIMEOUT_MS, 'room');
    const r = await result;
    if (r.status === 'blocked') {
      return ok(
        `That path is outside your room (${r.reason ?? 'refused'}). Do not retry — ask the operator to move the file into ~/AKIRA instead.`,
      );
    }
    if (r.status === 'error') return err(r.reason ?? 'room action failed');
    return ok(r.text ?? 'done');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export function roomToolDefs(ctx: AkiraToolContext) {
  return [
    tool(
      'room_list',
      'List a directory in your room on the Mini, or in the shared ~/AKIRA doorway. Paths are relative to your room unless absolute.',
      { path: z.string().min(1).describe('Directory to list, e.g. "." or "/mnt/doorway/inbox".') },
      (a) => run('fs_list', { path: a.path }),
    ),
    tool(
      'room_read',
      'Read a text file in your room or the doorway. Large files are refused.',
      { path: z.string().min(1) },
      (a) => run('fs_read', { path: a.path }),
    ),
    tool(
      'room_write',
      'Write a text file in your room or the doorway. Parent directories are created. Anything outside those two places is refused.',
      { path: z.string().min(1), content: z.string() },
      (a) => run('fs_write', { path: a.path, content: a.content }),
    ),
    tool(
      'room_bash',
      "Run a shell command in your room on the Mini. Use it for real work — converting documents (pandoc), installing tools, git, scripts. The room is yours; you cannot reach prod or the operator's home from it. Commands that would start something long-running (a dev server, a watcher, a backgrounded process) pause for the operator's approval; wait for his answer rather than retrying.",
      {
        command: z.string().min(1).describe('The command line, run through bash -lc.'),
        cwd: z.string().optional().describe('Working directory. Defaults to your workshop root.'),
      },
      (a) => runShell(a.command, a.cwd, ctx),
    ),
  ];
}
