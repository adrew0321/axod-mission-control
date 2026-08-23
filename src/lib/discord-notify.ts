import 'server-only';
import { db } from '@/db/client';
import { schedules } from '@/db/schema';
import type { Client } from 'discord.js';
import { getReadyClient } from './discord-bot';
import { getChannelsForProject } from './discord-bindings';
import { getProposals } from './proposals-data';
import { getDreams } from './dreams-data';
import { getOpenRoomProposals } from './room-proposals-data';
import { readUnpostedActions, markActionPosted } from './akira/action-feed';
import {
  diffScheduleRuns,
  pickNewDreams,
  diffProposals,
  type ScheduleRunRow,
  type DreamRowLite,
} from './discord-notify-diff';
import {
  scheduleEmbed,
  dreamEmbed,
  proposalEmbed,
  proposalActionRow,
  roomProposalEmbed,
  actionEmbed,
} from './discord-format';
import type { APIEmbed, APIActionRowComponent, APIComponentInMessageActionRow } from 'discord.js';
import { onShutdown } from './shutdown';

const POLL_MS = 30_000;
// Dreams are global (not project-scoped) → route to the operator's "home" project channel.
const DREAM_PROJECT_ID = 'mission-control';

let scheduleCursor = new Map<string, number>();
let dreamCursor: number | null = null;
let proposalCursor = new Set<string>();
let roomProposalCursor = new Set<string>();
// The room gather can fail independently of the other three (see tick()), so it needs
// its own "have I been primed" bit — priming for it may complete on a later tick than
// the shared `primed` flag below.
let roomProposalPrimed = false;
let primed = false;

/** Send an embed to every channel bound to a project. Returns false on send failure
 *  (so the caller can leave the cursor unadvanced and retry). No bound channel → true
 *  (nothing to do; don't retry forever). */
async function postToProject(
  client: Client,
  projectId: string,
  embed: APIEmbed,
  components?: APIActionRowComponent<APIComponentInMessageActionRow>[],
): Promise<boolean> {
  try {
    const channelIds = await getChannelsForProject(projectId);
    for (const id of channelIds) {
      const ch = await client.channels.fetch(id);
      if (ch && 'send' in ch && typeof ch.send === 'function') {
        await ch.send({ embeds: [embed], ...(components ? { components } : {}) });
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
  // Each of these three used to be awaited bare: a persistent throw in any one of
  // them rejected tick() before the action section ever ran, taking the D2 safety
  // feed dark for a reason unrelated to actions. Guarded the same way the room and
  // action gathers already were; null just skips that source for this tick (its
  // cursor is left untouched, so a later successful gather resumes normally).
  const schedGather: ScheduleRunRow[] | null = await db
    .select({
      id: schedules.id,
      projectId: schedules.project_id,
      title: schedules.title,
      lastRunAt: schedules.last_run_at,
      lastStatus: schedules.last_status,
    })
    .from(schedules)
    .then((rows) =>
      rows.map((s) => ({
        id: s.id,
        projectId: s.projectId,
        title: s.title,
        lastRunAtMs: s.lastRunAt ? s.lastRunAt.getTime() : null,
        lastStatus: s.lastStatus,
      })),
    )
    .catch((err) => {
      console.error('[discord-notify] schedule gather failed:', err instanceof Error ? err.message : err);
      return null;
    });

  const dreamGather: DreamRowLite[] | null = await getDreams()
    .then((ds) =>
      ds.map((d) => ({
        id: d.id,
        createdAtMs: new Date(d.createdAt).getTime(),
        status: d.status,
        insightCount: d.insights.length,
      })),
    )
    .catch((err) => {
      console.error('[discord-notify] dream gather failed:', err instanceof Error ? err.message : err);
      return null;
    });

  const proposalGather = await getProposals().catch((err) => {
    console.error('[discord-notify] proposal gather failed:', err instanceof Error ? err.message : err);
    return null;
  });
  const currIds = proposalGather ? new Set(proposalGather.map((p) => p.sessionId)) : null;

  // Newest, least-exercised gather of the four: isolate it so a persistent bug here
  // degrades to "no room embeds" instead of blocking schedules/dreams/proposals below.
  // null (not []) on failure: [] is a factual claim ("nothing is open") that the diff/
  // prune below would believe and act on, wiping the cursor and causing duplicate posts
  // on the next successful tick. null means "unknown" — the right response is to touch
  // nothing, so the diff, posting loop, and prune are all skipped this tick when it's null.
  const roomGather = await getOpenRoomProposals()
    .then((props) => {
      const ids = new Set(props.map((p) => p.id));
      return { props, ids, diff: diffProposals(roomProposalCursor, ids) };
    })
    .catch((err) => {
      console.error('[discord-notify] room-proposal gather failed:', err instanceof Error ? err.message : err);
      return null;
    });

  // Delivery state for actions lives in the row (posted_at), not in a cursor here,
  // so there is nothing to prime — a restart just resumes from whatever is still
  // unposted (see action-feed.ts). This runs unconditionally, including on the
  // very first tick: on a fresh deploy the table is empty and there is nothing to
  // post, but if unposted rows already exist at startup they are delivered, not
  // skipped, which is the correct direction under D2.
  const actionRows = await readUnpostedActions(50).catch((err) => {
    console.error('[discord-notify] action gather failed:', err instanceof Error ? err.message : err);
    return null;
  });

  // --- AKIRA's actions: route to the home project channel (not project-scoped) ---
  if (actionRows) {
    for (const a of actionRows) {
      // Stop at the first failure so the rest retry next tick. Delivery is
      // recorded per row, so a restart resumes here rather than skipping ahead.
      if (!(await postToProject(client, DREAM_PROJECT_ID, actionEmbed(a)))) break;
      await markActionPosted(a.id).catch((err) =>
        console.warn('[discord-notify] marking action posted failed:', err instanceof Error ? err.message : err));
    }
  }

  const sched = schedGather ? diffScheduleRuns(scheduleCursor, schedGather) : null;
  const dreamD = dreamGather ? pickNewDreams(dreamCursor, dreamGather) : null;
  const prop = currIds ? diffProposals(proposalCursor, currIds) : null;

  // --- first tick: prime cursors, post nothing ---
  if (!primed) {
    // Only prime a source whose gather actually succeeded this tick; a source
    // that failed is left untouched (empty Map/Set/null), matching the room
    // source's own delayed-priming handling below.
    if (sched) scheduleCursor = sched.next;
    if (dreamD) dreamCursor = dreamD.next;
    if (prop) proposalCursor = prop.next;
    // Only mark the room source primed if this tick's gather actually succeeded.
    // If it failed, roomProposalCursor stays empty and unprimed so a later successful
    // gather is treated as a (delayed) priming tick, not a diff against an empty cursor
    // — which would otherwise announce every pre-existing proposal as "new".
    if (roomGather) {
      roomProposalCursor = roomGather.diff.next;
      roomProposalPrimed = true;
    }
    primed = true;
    return;
  }

  // --- schedules: advance per-id on successful post ---
  if (sched) {
    for (const run of sched.newRuns) {
      if (await postToProject(client, run.projectId, scheduleEmbed(run))) {
        scheduleCursor.set(run.id, run.lastRunAtMs as number);
      }
    }
  }

  // --- dreams: route to the home project channel ---
  if (dreamD) {
    for (const d of dreamD.newDreams) {
      if (await postToProject(client, DREAM_PROJECT_ID, dreamEmbed(d))) {
        dreamCursor = Math.max(dreamCursor ?? 0, d.createdAtMs);
      }
    }
  }

  // --- proposals: add on success, then drop any that are no longer present ---
  if (prop && proposalGather && currIds) {
    for (const id of prop.newIds) {
      const p = proposalGather.find((x) => x.sessionId === id);
      if (p && (await postToProject(client, p.projectId, proposalEmbed(p), [proposalActionRow(p.sessionId)]))) {
        proposalCursor.add(id);
      }
    }
    proposalCursor = new Set([...proposalCursor].filter((id) => currIds.has(id)));
  }

  // --- AKIRA's inbox: route to the home project channel (drops are not project-scoped) ---
  if (roomGather) {
    if (!roomProposalPrimed) {
      // Priming failed on the original tick 1; this is the first successful gather since
      // then. Seed the cursor and post nothing, same as ordinary priming — do not diff
      // against the still-empty cursor, which would read every open proposal as new.
      roomProposalCursor = roomGather.diff.next;
      roomProposalPrimed = true;
    } else {
      for (const id of roomGather.diff.newIds) {
        const p = roomGather.props.find((x) => x.id === id);
        if (p && (await postToProject(client, DREAM_PROJECT_ID, roomProposalEmbed(p)))) {
          roomProposalCursor.add(id);
        }
      }
      roomProposalCursor = new Set([...roomProposalCursor].filter((id) => roomGather.ids.has(id)));
    }
  }
  // else: this tick's gather failed — cursor and roomProposalPrimed are left untouched,
  // so the next successful gather resumes exactly where this one would have.
}

/** Start the notification poller. Idempotent; only when the bot token is set. */
export function startDiscordNotify(): void {
  if (!process.env.DISCORD_BOT_TOKEN) return;
  const g = globalThis as unknown as { __mcDiscordNotifyStarted?: boolean };
  if (g.__mcDiscordNotifyStarted) return;
  g.__mcDiscordNotifyStarted = true;
  const handle = setInterval(() => {
    void tick().catch((err) =>
      console.error('[discord-notify] tick failed:', err instanceof Error ? err.message : err),
    );
  }, POLL_MS);
  onShutdown('discord-notify', () => {
    clearInterval(handle);
    g.__mcDiscordNotifyStarted = false;
  });
  console.log('[discord-notify] started (30s poll)');
}
