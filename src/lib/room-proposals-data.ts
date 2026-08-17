import 'server-only';
import { eq, desc, and } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { room_proposals } from '@/db/schema';
import { runAkiraTurn } from '@/lib/akira-turn';
import { type RoomProposal, summarizeDrop } from './room-proposals';

export async function getOpenRoomProposals(): Promise<RoomProposal[]> {
  const rows = await db
    .select()
    .from(room_proposals)
    .where(eq(room_proposals.status, 'open'))
    .orderBy(desc(room_proposals.created_at));
  return rows.map((r) => ({
    id: r.id,
    zone: 'inbox',
    name: r.name,
    path: r.path,
    sizeBytes: r.size_bytes,
    ext: r.ext,
    head: r.head,
    summary: r.summary,
    status: r.status as RoomProposal['status'],
    createdAt: (r.created_at ?? new Date()).toISOString(),
  }));
}

/** Record an inbox drop as an open proposal. Re-dropping the same path at the
 *  same size while one is already open is a no-op, so a re-save does not stack. */
export async function recordInboxDrop(d: {
  name: string;
  path: string;
  sizeBytes: number;
  ext: string;
  head: string;
}): Promise<RoomProposal | null> {
  const existing = await db
    .select({ id: room_proposals.id })
    .from(room_proposals)
    .where(
      and(
        eq(room_proposals.path, d.path),
        eq(room_proposals.size_bytes, d.sizeBytes),
        eq(room_proposals.status, 'open'),
      ),
    )
    .limit(1);
  if (existing.length) return null;

  const row = {
    id: `rprop_${bytesToHex(randomBytes(6))}`,
    zone: 'inbox' as const,
    name: d.name,
    path: d.path,
    size_bytes: d.sizeBytes,
    ext: d.ext || null,
    head: d.head || null,
    summary: summarizeDrop(d),
    status: 'open' as const,
    created_at: new Date(),
    decided_at: null,
  };
  await db.insert(room_proposals).values(row);
  return {
    id: row.id,
    zone: 'inbox',
    name: row.name,
    path: row.path,
    sizeBytes: row.size_bytes,
    ext: row.ext,
    head: row.head,
    summary: row.summary,
    status: 'open',
    createdAt: row.created_at.toISOString(),
  };
}

// AKIRA has ONE persistent thread. Two turns writing it concurrently would
// interleave her conversation, so doorway-triggered turns run one at a time —
// the same chain discipline the room agent uses for commands.
let turnChain: Promise<unknown> = Promise.resolve();

// Playground drops are ungated (the folder carries the permission) but were
// never meant to be unbounded: a file saved several times at different sizes
// (so the watcher's own settle-detection can't collapse them) would otherwise
// queue one full serialized turn per save. The queued turn re-reads the file
// when it finally runs, so it always sees the final state — a duplicate
// entry queued behind it is pure waste, not a missed update. Coalesce by the
// key passed in (the drop's path) for as long as a turn for it is queued or
// running.
const pendingKeys = new Set<string>();

/** Queue a headless AKIRA turn. Fire-and-forget by design: the caller is an
 *  HTTP handler that must not block on a full agent turn.
 *
 *  When `coalesceKey` is given and a turn for that key is already queued or
 *  in flight, this call is a no-op rather than a second enqueue.
 *
 *  `runAkiraTurn` resolves (does not throw) on a failed turn — status
 *  'error' with a `reason` — so both the resolved-error and the rejected
 *  paths are logged; nothing fails silently. */
export function runRoomTurn(instruction: string, coalesceKey?: string): void {
  if (coalesceKey) {
    if (pendingKeys.has(coalesceKey)) return;
    pendingKeys.add(coalesceKey);
  }
  turnChain = turnChain
    .then(() => runAkiraTurn({ instruction }))
    .then((result) => {
      if (result.status === 'error') {
        console.error('[room-event] turn resolved with error:', result.reason);
      }
    })
    .catch((e) => console.error('[room-event] turn failed:', e instanceof Error ? e.message : e))
    .finally(() => {
      if (coalesceKey) pendingKeys.delete(coalesceKey);
    });
}
