import 'server-only';
import { and, eq } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { approvals, tool_permissions } from '@/db/schema';

export type ToolPolicy = 'always' | 'ask' | 'deny';

/**
 * Resolve the policy for an (agent, project, tool) triple.
 * No row = 'ask' (default to human-in-the-loop). This is the safe default
 * from the v1 spec: tools run only after explicit approval unless the
 * operator has persisted an "always allow".
 */
export async function getPolicy(
  agentId: string,
  projectId: string,
  toolName: string,
): Promise<ToolPolicy> {
  const row = await db
    .select()
    .from(tool_permissions)
    .where(
      and(
        eq(tool_permissions.agent_id, agentId),
        eq(tool_permissions.project_id, projectId),
        eq(tool_permissions.tool_name, toolName),
      ),
    )
    .limit(1)
    .then((r) => r[0]);
  return (row?.policy as ToolPolicy) ?? 'ask';
}

/** Persist an "always allow" for the (agent, project, tool) triple. */
export async function setAlwaysAllow(
  agentId: string,
  projectId: string,
  toolName: string,
): Promise<void> {
  await db
    .insert(tool_permissions)
    .values({ agent_id: agentId, project_id: projectId, tool_name: toolName, policy: 'always' })
    .onConflictDoUpdate({
      target: [tool_permissions.agent_id, tool_permissions.project_id, tool_permissions.tool_name],
      set: { policy: 'always' },
    });
}

export interface CreatedApproval {
  id: string;
}

/** Insert a pending approval row for a gated tool call. */
export async function createPendingApproval(args: {
  sessionId: string;
  agentId: string;
  toolName: string;
  toolArgs: unknown;
}): Promise<CreatedApproval> {
  const id = `app_${bytesToHex(randomBytes(8))}`;
  await db.insert(approvals).values({
    id,
    session_id: args.sessionId,
    agent_id: args.agentId,
    tool_name: args.toolName,
    tool_args: args.toolArgs,
    status: 'pending',
  });
  return { id };
}

export type ApprovalDecision = 'approved' | 'denied' | 'always';

/** Record the operator's decision on an approval. */
export async function decideApproval(id: string, decision: ApprovalDecision): Promise<void> {
  await db
    .update(approvals)
    .set({ status: decision, decided_at: new Date() })
    .where(eq(approvals.id, id));
}

export async function getApprovalStatus(id: string): Promise<string | undefined> {
  const row = await db
    .select({ status: approvals.status })
    .from(approvals)
    .where(eq(approvals.id, id))
    .limit(1)
    .then((r) => r[0]);
  return row?.status;
}

/**
 * Block until the approval row leaves 'pending', or until timeout.
 * Returns the terminal status ('approved' | 'denied' | 'always') or 'timeout'.
 */
export async function waitForDecision(
  id: string,
  opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<'approved' | 'denied' | 'always' | 'timeout'> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const pollMs = opts.pollMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return 'denied';
    const status = await getApprovalStatus(id);
    if (status && status !== 'pending') {
      return status as 'approved' | 'denied' | 'always';
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  await decideApproval(id, 'denied');
  return 'timeout';
}
