import 'server-only';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { sendCommand, type CompanionTarget } from '@/lib/companion/registry';
import {
  type AkiraToolContext,
  type ToolResult,
  ok,
  err,
  AKIRA_LIST,
  AKIRA_READ,
  AKIRA_WRITE,
  AKIRA_BASH,
} from './tool-actions';
import { appendActionLog } from './action-log';
import { runShell } from './agent-shell';

export { AKIRA_LIST, AKIRA_READ, AKIRA_WRITE, AKIRA_BASH };
export const AGENT_TOOL_NAMES = [AKIRA_LIST, AKIRA_READ, AKIRA_WRITE, AKIRA_BASH];

const FS_TIMEOUT_MS = 30_000;

/** 'host' is the Mini itself; 'room' is her container. Both are on the same box. */
const targetArg = z
  .enum(['host', 'room'])
  .describe("Which machine: 'host' is the Mini itself (Mission Control, your vault, the operator's home); 'room' is your container.");

async function runFs(
  action: 'fs_list' | 'fs_read' | 'fs_write',
  target: CompanionTarget,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const label = `${action} ${String(args.path ?? '')}`;
  appendActionLog({ at: new Date(), target, event: 'dispatch', command: label });
  try {
    const r = await sendCommand({ action, ...args }, FS_TIMEOUT_MS, target).result;
    appendActionLog({ at: new Date(), target, event: 'result', command: label, status: r.status });
    if (r.status === 'blocked') {
      return ok(`That path was refused (${r.reason ?? 'refused'}). Do not retry the same path.`);
    }
    if (r.status === 'error') return err(r.reason ?? 'the action failed');
    return ok(r.text ?? 'done');
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    appendActionLog({ at: new Date(), target, event: 'result', command: label, status: 'error', reason });
    return err(reason);
  }
}

export function agentToolDefs(ctx: AkiraToolContext) {
  return [
    tool(
      'list',
      'List a directory on the Mini. Use target "host" for the machine itself (Mission Control at /srv/mission-control, your vault at /srv/mission-control/data/akira-memory, the operator\'s home) or "room" for your container.',
      { target: targetArg, path: z.string().min(1).describe('Directory to list.') },
      (a) => runFs('fs_list', a.target, { path: a.path }),
    ),
    tool(
      'read',
      'Read a text file on the Mini. Large files are refused. Use this to read your own vault documents, your SOUL, a skill, or Mission Control\'s source.',
      { target: targetArg, path: z.string().min(1) },
      (a) => runFs('fs_read', a.target, { path: a.path }),
    ),
    tool(
      'write',
      "Write a text file on the Mini. Parent directories are created. For your vault's documents prefer vault_write, and for memory notes use remember — those keep the note model and the indexes correct.",
      { target: targetArg, path: z.string().min(1), content: z.string() },
      (a) => runFs('fs_write', a.target, { path: a.path, content: a.content }),
    ),
    tool(
      'bash',
      'Run a shell command on the Mini. Target "host" runs as root on the machine itself — systemctl, journalctl, git, the deploy. Target "room" runs in your container, where commands that would outlive the turn pause for the operator\'s approval. Restarting mission-control ends your turn; say what you are doing before you do it.',
      {
        target: targetArg,
        command: z.string().min(1).describe('The command line, run through bash -lc.'),
        cwd: z.string().optional().describe('Working directory.'),
      },
      (a) => runShell(a.command, a.cwd, a.target, ctx),
    ),
  ];
}
