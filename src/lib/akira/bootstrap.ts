import 'server-only';
import { db } from '@/db/client';
import { agents, sessions } from '@/db/schema';
import { AKIRA_AGENT, AKIRA_SESSION_ID } from './agent';
import { vaultReady } from './memory/store';
import { seedSoulIfMissing } from './memory/soul';

export { AKIRA_AGENT, AKIRA_AGENT_ID, AKIRA_SESSION_ID } from './agent';

/**
 * Idempotently ensure AKIRA's agent row and reserved conversation session exist.
 * Safe to call on every turn; uses onConflictDoNothing so it never clobbers a
 * seeded prompt or an existing thread.
 */
export async function ensureAkiraThread(): Promise<void> {
  await db.insert(agents).values(AKIRA_AGENT).onConflictDoNothing();

  const now = new Date();
  await db
    .insert(sessions)
    .values({
      id: AKIRA_SESSION_ID,
      project_id: null,
      title: 'AKIRA',
      branch: null,
      base_branch: null,
      worktree_path: null,
      status: 'active',
      cleared_at: null,
      created_at: now,
      updated_at: now,
      running_since: null,
      archived_at: null,
    })
    .onConflictDoNothing();

  if (vaultReady()) seedSoulIfMissing();
}
