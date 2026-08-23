import 'server-only';
import { db } from '@/db/client';
import { schedules } from '@/db/schema';
import type { Client } from 'discord.js';
import { getReadyClient } from './discord-bot';
import { getChannelsForProject } from './discord-bindings';
import { getProposals } from './proposals-data';
import { getDreams } from './dreams-data';
import { getOpenRoomProposals } from './room-proposals-data';
import { readLatestActionAt, readActionsSince } from './akira/action-feed';
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
let actionCursor: number | null = null;
// The room gather can fail independently of the other three (see tick()), so it needs
// its own "have I been primed" bit — priming for it may complete on a later tick than
// the shared `primed` flag below.
let roomProposalPrimed = false;
// The action cursor's own primed bit. Unlike roomProposalCursor (a Set, where
// "empty" only ever means "nothing open"), actionCursor is a number | null
// watermark, and pickNewActions/readActionsSince against a null cursor and an
// empty table both legitimately produce `null` too — so "cursor is null" can't
// double as "never primed" the way it can be read for other sources. This flag
// removes that ambiguity: it is set true only by a successful priming read.
let actionPrimed = false;
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

  // Queried forward from the cursor (ascending, `at > actionCursor`), not backward
  // from "now" — a newest-first window would let a burst larger than the limit push
  // older, not-yet-posted rows permanently out of view. Pre-prime (actionCursor still
  // null) this legitimately reads the oldest rows on hand; that result is discarded
  // below rather than posted, so it never surfaces as a backlog dump.
  const actionRows = await readActionsSince(actionCursor, 50).catch((err) => {
    console.error('[discord-notify] action gather failed:', err instanceof Error ? err.message : err);
    return null;
  });

  const sched = diffScheduleRuns(scheduleCursor, schedRows);
  const dreamD = pickNewDreams(dreamCursor, dreamRows);
  const prop = diffProposals(proposalCursor, currIds);

  // --- first tick: prime cursors, post nothing ---
  if (!primed) {
    scheduleCursor = sched.next;
    dreamCursor = dreamD.next;
    proposalCursor = prop.next;
    // Only mark the room source primed if this tick's gather actually succeeded.
    // If it failed, roomProposalCursor stays empty and unprimed so a later successful
    // gather is treated as a (delayed) priming tick, not a diff against an empty cursor
    // — which would otherwise announce every pre-existing proposal as "new".
    if (roomGather) {
      roomProposalCursor = roomGather.diff.next;
      roomProposalPrimed = true;
    }
    // Prime from the true latest timestamp, NOT from actionRows: with a null
    // cursor, actionRows is the OLDEST window in the table (see the gather
    // above), so deriving "latest" from it would under-seed the cursor whenever
    // more than `limit` actions already exist and dump that backlog on tick 2.
    // `undefined` (thrown) vs `null` (empty table) is deliberate — see the
    // `actionPrimed` declaration for why the cursor's own value can't carry this.
    const latestActionAt = await readLatestActionAt().catch(() => undefined);
    if (latestActionAt !== undefined) {
      actionCursor = latestActionAt;
      actionPrimed = true;
    }
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
    if (p && (await postToProject(client, p.projectId, proposalEmbed(p), [proposalActionRow(p.sessionId)]))) {
      proposalCursor.add(id);
    }
  }
  proposalCursor = new Set([...proposalCursor].filter((id) => currIds.has(id)));

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

  // --- AKIRA's actions: route to the home project channel (not project-scoped) ---
  if (actionRows) {
    if (!actionPrimed) {
      // Priming failed on the original tick 1; this is the first successful gather
      // since then. Seed the cursor from the true latest timestamp — not from
      // actionRows, which (read against a still-null cursor) is the oldest window
      // in the table, not the latest — and post nothing, same as ordinary priming.
      const latestActionAt = await readLatestActionAt().catch(() => undefined);
      if (latestActionAt !== undefined) {
        actionCursor = latestActionAt;
        actionPrimed = true;
      }
    } else {
      // actionRows already arrives filtered to `at > actionCursor` and ascending
      // (readActionsSince), so no further diff/sort is needed here.
      for (const a of actionRows) {
        // Stop at the first failure: the cursor stays at the last SUCCESS, so this
        // action and everything after it retry on the next tick. Advancing past a
        // failure (e.g. with Math.max over an ascending list) would drop it
        // permanently — under D2 that is an action the operator never learns about.
        if (!(await postToProject(client, DREAM_PROJECT_ID, actionEmbed(a)))) break;
        actionCursor = a.atMs;
      }
    }
  }
  // else: this tick's gather failed — actionCursor and actionPrimed are left
  // untouched, so the next successful gather resumes exactly where this one would have.
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
