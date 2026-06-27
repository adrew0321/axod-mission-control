import type { APIEmbed, APIActionRowComponent, APIMessageActionRowComponent } from 'discord.js'; // type-only: erased at runtime, keeps this module pure
import type { ScheduleRunRow, DreamRowLite } from './discord-notify-diff';
import type { Proposal } from './proposals';

const GREEN = 0x10b981;
const RED = 0xef4444;
const AMBER = 0xf59e0b;
const BLUE = 0x3b82f6;
const GREY = 0x6e7681;

/**
 * Split text into Discord-sendable chunks each ≤ max chars (default 2000).
 * Prefers to break on the last newline, then the last space, before max; a single
 * token longer than max is hard-split. Never returns an empty array. Pure.
 */
export function chunkReply(text: string, max = 2000): string[] {
  if (text.length === 0) return [' ']; // Discord rejects empty content
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max; // no boundary → hard split
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(rest[cut] === '\n' || rest[cut] === ' ' ? cut + 1 : cut);
  }
  chunks.push(rest);
  return chunks;
}

/** Embed for a finished scheduled task; color reflects last_status. Pure. */
export function scheduleEmbed(run: ScheduleRunRow): APIEmbed {
  const status = run.lastStatus ?? 'unknown';
  const color = status === 'ok' ? GREEN : status === 'fail' || status === 'error' ? RED : AMBER;
  return {
    title: `Scheduled task: ${run.title}`,
    description: `Status: **${status}**`,
    color,
  };
}

/** Embed for a new dream. Pure. */
export function dreamEmbed(dream: DreamRowLite): APIEmbed {
  return {
    title: 'New dream',
    description: `${dream.status} · ${dream.insightCount} insight${dream.insightCount === 1 ? '' : 's'}`,
    color: BLUE,
  };
}

/** Embed for a proposal ready to merge. Pure. */
export function proposalEmbed(p: Proposal): APIEmbed {
  return {
    title: `Proposal ready: ${p.sessionTitle}`,
    color: BLUE,
    fields: [
      { name: 'Project', value: p.projectName, inline: true },
      { name: 'Changes', value: `+${p.additions} / -${p.deletions}`, inline: true },
      { name: 'Files', value: String(p.files.length), inline: true },
    ],
  };
}

/** Encode/parse a proposal-action button id. Pure. */
export function buildActionId(action: 'merge' | 'discard', sessionId: string): string {
  return `mc:${action}:${sessionId}`;
}
export function parseActionId(
  customId: string,
): { action: 'merge' | 'discard'; sessionId: string } | null {
  const m = /^mc:(merge|discard):(.+)$/.exec(customId);
  return m ? { action: m[1] as 'merge' | 'discard', sessionId: m[2] } : null;
}

/**
 * Action row for a proposal embed: green "Approve & Merge" + red "Discard".
 * Hand-built component JSON (Discord literals: ActionRow=1, Button=2; Success=3, Danger=4)
 * so this module never imports discord.js runtime enums. Pure.
 */
export function proposalActionRow(sessionId: string): APIActionRowComponent<APIMessageActionRowComponent> {
  return {
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Approve & Merge', custom_id: buildActionId('merge', sessionId) },
      { type: 2, style: 4, label: 'Discard', custom_id: buildActionId('discard', sessionId) },
    ],
  } as unknown as APIActionRowComponent<APIMessageActionRowComponent>;
}

/** Embed shown after a proposal button resolves (replaces the proposal embed). Pure. */
export function proposalResultEmbed(
  kind: 'merged' | 'discarded' | 'conflict' | 'stale',
  opts?: { baseBranch?: string; sessionTitle?: string },
): APIEmbed {
  const description = opts?.sessionTitle;
  if (kind === 'merged')
    return { title: `✅ Merged${opts?.baseBranch ? ` into ${opts.baseBranch}` : ''}`, description, color: GREEN };
  if (kind === 'discarded') return { title: '🗑️ Discarded', description, color: GREY };
  if (kind === 'conflict')
    return { title: '⚠️ Merge conflict — resolve in Mission Control', description, color: AMBER };
  return { title: 'Proposal already resolved', description, color: GREY };
}
