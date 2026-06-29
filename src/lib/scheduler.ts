import 'server-only';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { schedules, sessions, projects, messages } from '@/db/schema';
import { runSessionTurn } from '@/lib/run-turn';
import { computeNextRun, parseCadence } from '@/lib/schedule';
import { healthStatus } from '@/lib/health-verdict';
import { discardWorktree } from '@/lib/worktree';

const TICK_MS = 60_000;

/** The most recent agent-authored message in a session, or null. */
async function getFinalAgentMessage(sessionId: string): Promise<string | null> {
  const row = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.session_id, sessionId), eq(messages.role, 'agent')))
    .orderBy(desc(messages.created_at), desc(sql`rowid`))
    .limit(1)
    .then((r) => r[0]);
  return row?.content ?? null;
}

/**
 * Start the in-process scheduler. Idempotent: a globalThis flag survives Next's
 * dev/HMR re-imports so the ticker is only ever started once per process.
 */
export function startScheduler(): void {
  const g = globalThis as unknown as { __mcSchedulerStarted?: boolean };
  if (g.__mcSchedulerStarted) return;
  g.__mcSchedulerStarted = true;
  void tick(); // run once at boot, then on the interval
  setInterval(() => void tick(), TICK_MS);
  console.log('[scheduler] started (60s tick)');
}

/**
 * One poll: fire every enabled schedule whose next_run_at has passed. Each job's
 * next_run_at is advanced BEFORE it runs so a slow run / the next tick can't
 * double-fire it. Errors are caught per-job; the tick itself never throws.
 */
export async function tick(): Promise<void> {
  const now = new Date();
  let due: (typeof schedules.$inferSelect)[];
  try {
    due = await db
      .select()
      .from(schedules)
      .where(and(eq(schedules.enabled, true), lte(schedules.next_run_at, now)));
  } catch (err) {
    console.error('[scheduler] due query failed:', err instanceof Error ? err.message : err);
    return;
  }

  for (const s of due) {
    let sessionId: string | undefined;
    try {
      const cadence = parseCadence(s);
      // Advance first — guards against double-fire on a slow run / next tick.
      await db
        .update(schedules)
        .set({ next_run_at: computeNextRun(cadence, now), updated_at: new Date() })
        .where(eq(schedules.id, s.id));

      const project = await db
        .select({ default_branch: projects.default_branch })
        .from(projects)
        .where(eq(projects.id, s.project_id))
        .limit(1)
        .then((r) => r[0]);

      sessionId = `sess_${bytesToHex(randomBytes(4))}`;
      const ts = new Date();
      await db.insert(sessions).values({
        id: sessionId,
        project_id: s.project_id,
        title: s.title,
        branch: project?.default_branch ?? 'dev',
        worktree_path: null,
        status: 'active',
        cleared_at: null,
        created_at: ts,
        updated_at: ts,
      });

      const result = await runSessionTurn(sessionId, { instruction: s.instruction });
      const finalMessage =
        result.status === 'completed' ? await getFinalAgentMessage(sessionId) : null;
      const last_status = healthStatus(result, finalMessage);
      await db
        .update(schedules)
        .set({ last_run_at: new Date(), last_session_id: sessionId, last_status, updated_at: new Date() })
        .where(eq(schedules.id, s.id));
    } catch (err) {
      console.error(`[scheduler] schedule ${s.id} failed:`, err instanceof Error ? err.message : err);
      try {
        await db
          .update(schedules)
          .set({ last_run_at: new Date(), last_status: 'error', updated_at: new Date() })
          .where(eq(schedules.id, s.id));
      } catch {
        /* best-effort */
      }
    } finally {
      // Scheduled runs are automation, not reviewable work — never leave a lingering proposal.
      // Runs on both success and error paths; safe no-op if sessionId was never assigned.
      if (sessionId) {
        try {
          const ran = await db
            .select({ wt: sessions.worktree_path, projectId: sessions.project_id })
            .from(sessions).where(eq(sessions.id, sessionId)).limit(1).then((r) => r[0]);
          if (ran?.wt && ran.projectId) {
            const proj = await db
              .select({ repo: projects.repo_path })
              .from(projects).where(eq(projects.id, ran.projectId)).limit(1).then((r) => r[0]);
            if (proj) await discardWorktree(sessionId, proj.repo).catch(() => {});
            await db.update(sessions).set({ worktree_path: null }).where(eq(sessions.id, sessionId));
          }
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }
}
