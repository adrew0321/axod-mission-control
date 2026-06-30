import 'server-only';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { sendCommand } from '@/lib/companion/registry';
import { type AkiraToolContext, type ToolResult, ok, err } from './tool-actions';

export const AKIRA_BROWSER_NAVIGATE = 'mcp__akira__browser_navigate';
export const AKIRA_BROWSER_READ = 'mcp__akira__browser_read';
export const AKIRA_BROWSER_TYPE = 'mcp__akira__browser_type';
export const AKIRA_BROWSER_CLICK = 'mcp__akira__browser_click';

export const BROWSER_TOOL_NAMES = [
  AKIRA_BROWSER_NAVIGATE,
  AKIRA_BROWSER_READ,
  AKIRA_BROWSER_TYPE,
  AKIRA_BROWSER_CLICK,
];

function snapshotText(text: string, snap: { url: string; title: string; text: string; elements: { ref: string; tag: string; name?: string }[] } | undefined): string {
  if (!snap) return text;
  const els = snap.elements.map((e) => `${e.ref}: <${e.tag}> ${e.name ?? ''}`.trim()).join('\n');
  return `URL: ${snap.url}\nTITLE: ${snap.title}\n\nELEMENTS:\n${els}\n\nTEXT:\n${snap.text}`;
}

async function run(action: 'navigate' | 'read' | 'type' | 'click', args: Record<string, unknown>, ctx: AkiraToolContext): Promise<ToolResult> {
  try {
    const { result } = sendCommand({ action, ...args });
    const r = await result;
    if (r.status === 'blocked') {
      // hard gate — surface to the operator; AKIRA must stop and ask, not retry.
      ctx.emit({ type: 'hard_gate', ref: String(args.ref ?? ''), reason: r.reason ?? 'sensitive action' });
      return ok(`That action is gated for your safety (${r.reason ?? 'sensitive action'}). I've asked the operator to confirm — do not retry; wait for approval.`);
    }
    if (r.status === 'error') return err(r.reason ?? 'browser action failed');
    return ok(snapshotText(r.text ?? 'done', r.snapshot));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export function browserToolDefs(ctx: AkiraToolContext) {
  return [
    tool('browser_navigate', 'Open a URL in the operator\'s laptop browser. Returns a snapshot of the page.',
      { url: z.string().min(1).describe('The URL to open.') },
      (a) => run('navigate', { url: a.url }, ctx)),
    tool('browser_read', 'Re-read the current page; returns its elements (with refs) and text. Use before deciding the next action.',
      {}, () => run('read', {}, ctx)),
    tool('browser_type', 'Type text into an element by its ref (from the latest snapshot).',
      { ref: z.string().min(1), text: z.string() },
      (a) => run('type', { ref: a.ref, text: a.text }, ctx)),
    tool('browser_click', 'Click an element by its ref. Irreversible actions (buy/send/delete) will be gated and require the operator\'s approval.',
      { ref: z.string().min(1) },
      (a) => run('click', { ref: a.ref }, ctx)),
  ];
}
