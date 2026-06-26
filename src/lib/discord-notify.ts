import 'server-only';
import { db } from '@/db/client';
import { schedules } from '@/db/schema';
import type { Client } from 'discord.js';
import { getReadyClient } from './discord-bot';
import { getChannelsForProject } from './discord-bindings';
import { getProposals } from './proposals-data';
import { getDreams } from './dreams-data';
import {
  diffScheduleRuns,
  pickNewDreams,
  diffProposals,
  type ScheduleRunRow,
  type DreamRowLite,
} from './discord-notify-diff';
import { scheduleEmbed, dreamEmbed, proposalEmbed } from './discord-format';
import type { APIEmbed } from 'discord.js';

const POLL_MS = 30_000;
// Dreams are global (not project-scoped) → route to the operator's "home" project channel.
const DREAM_PROJECT_ID = 'mission-control';

let scheduleCursor = new Map<string, number>();
let dreamCursor: number | null = null;
let proposalCursor = new Set<string>();
let primed = false;

/** Send an embed to every channel bound to a project. Returns false on send failure
 *  (so the caller can leave the cursor unadvanced and retry). No bound channel → true
 *  (nothing to do; don't retry forever). */
async function postToProject(client: Client, projectId: string, embed: APIEmbed): Promise<boolean> {
  try {
    const channelIds = await getChannelsForProject(projectId);
    for (const id of channelIds) {
      const ch = await client.channels.fetch(id);
      if (ch && 'send' in ch && typeof ch.send === 'function') {
        await ch.send({ embeds: [embed] });
      }
    }
    return true;
  } catch (err) {
    console.error('[discord-notify] post failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

async function tick(): Promise<void> {
  const client = getReadyClient();
  if (!client) return; // gateway not connected yet

  // --- gather current state ---
  const schedRows: ScheduleRunRow[] = (
    await db
      .select({
        id: schedules.id,
        projectId: schedules.project_id,
        title: schedules.title,
        lastRunAt: schedules.last_run_at,
        lastStatus: schedules.last_status,
      })
      .from(schedules)
  ).map((s) => ({
    id: s.id,
    projectId: s.projectId,
    title: s.title,
    lastRunAtMs: s.lastRunAt ? s.lastRunAt.getTime() : null,
    lastStatus: s.lastStatus,
  }));

  const dreamRows: DreamRowLite[] = (await getDreams()).map((d) => ({
    id: d.id,
    createdAtMs: new Date(d.createdAt).getTime(),
    status: d.status,
    insightCount: d.insights.length,
  }));

  const proposals = await getProposals();
  const currIds = new Set(proposals.map((p) => p.sessionId));

  const sched = diffScheduleRuns(scheduleCursor, schedRows);
  const dreamD = pickNewDreams(dreamCursor, dreamRows);
  const prop = diffProposals(proposalCursor, currIds);

  // --- first tick: prime cursors, post nothing ---
  if (!primed) {
    scheduleCursor = sched.next;
    dreamCursor = dreamD.next;
    proposalCursor = prop.next;
    primed = true;
    return;
  }

  // --- schedules: advance per-id on successful post ---
  for (const run of sched.newRuns) {
    if (await postToProject(client, run.projectId, scheduleEmbed(run))) {
      scheduleCursor.set(run.id, run.lastRunAtMs as number);
    }
  }

  // --- dreams: route to the home project channel ---
  for (const d of dreamD.newDreams) {
    if (await postToProject(client, DREAM_PROJECT_ID, dreamEmbed(d))) {
      dreamCursor = Math.max(dreamCursor ?? 0, d.createdAtMs);
    }
  }

  // --- proposals: add on success, then drop any that are no longer present ---
  for (const id of prop.newIds) {
    const p = proposals.find((x) => x.sessionId === id);
    if (p && (await postToProject(client, p.projectId, proposalEmbed(p)))) {
      proposalCursor.add(id);
    }
  }
  proposalCursor = new Set([...proposalCursor].filter((id) => currIds.has(id)));
}

/** Start the notification poller. Idempotent; only when the bot token is set. */
export function startDiscordNotify(): void {
  if (!process.env.DISCORD_BOT_TOKEN) return;
  const g = globalThis as unknown as { __mcDiscordNotifyStarted?: boolean };
  if (g.__mcDiscordNotifyStarted) return;
  g.__mcDiscordNotifyStarted = true;
  setInterval(() => {
    void tick().catch((err) =>
      console.error('[discord-notify] tick failed:', err instanceof Error ? err.message : err),
    );
  }, POLL_MS);
  console.log('[discord-notify] started (30s poll)');
}
