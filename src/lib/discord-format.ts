import type { APIEmbed } from 'discord.js'; // type-only: erased at runtime, keeps this module pure
import type { ScheduleRunRow, DreamRowLite } from './discord-notify-diff';
import type { Proposal } from './proposals';

const GREEN = 0x10b981;
const RED = 0xef4444;
const AMBER = 0xf59e0b;
const BLUE = 0x3b82f6;

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
