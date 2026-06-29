import 'server-only';
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { agents, messages, projects, sessions } from '@/db/schema';
import { runClaudeAgent } from '@/lib/agent-runner-sdk';
import { ensureWorktree } from '@/lib/worktree';
import { createDispatchServer, DISPATCH_SERVER_NAME, DISPATCH_TOOL_NAME } from '@/lib/dispatch';
import { toTerminalEvent } from '@/lib/terminal-events';
import { buildOrchestratorPrompt, type TranscriptMessage } from '@/lib/conversation';
import { parseMention } from '@/lib/mention';
import { savePlanSnapshot } from '@/lib/plans';
import { toPlanSnapshot, type PlanSnapshot } from '@/lib/plan-events';
import { LEASE_GRACE_MS, resolveTurnInput } from '@/lib/turn-lease';

const DEFAULT_MAX_DURATION_MS = 600_000;

export type TurnEmit = (e: { type: string; [k: string]: unknown }) => void;

export interface RunTurnOptions {
  emit?: TurnEmit;
  signal?: AbortSignal;
  instruction?: string;
  maxDurationMs?: number;
}

export type TurnResult = { status: 'completed' | 'skipped' | 'error'; reason?: string };

/**
 * Run one agent turn for a session, end-to-end, server-side. Sink-agnostic: the
 * SSE route passes emit=SSE + signal=req.signal; the CLI passes emit=log + no
 * signal (bounded only by maxDurationMs). Guarded by a cross-process lease on
 * sessions.running_since so a browser turn and a CLI turn can't collide.
 */
export async function runSessionTurn(
  sessionId: string,
  opts: RunTurnOptions = {},
): Promise<TurnResult> {
  const emit: TurnEmit = opts.emit ?? (() => {});
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

  const session = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
    .then((r) => r[0]);
  if (!session) {
    emit({ type: 'error', message: 'session not found' });
    return { status: 'error', reason: 'session not found' };
  }

  // --- Acquire the lease: atomic compare-and-set. 0 rows changed => held. ---
  const now = new Date();
  const cutoff = new Date(now.getTime() - (maxDurationMs + LEASE_GRACE_MS));
  const acq = db
    .update(sessions)
    .set({ running_since: now })
    .where(
      and(
        eq(sessions.id, sessionId),
        or(isNull(sessions.running_since), lt(sessions.running_since, cutoff)),
      ),
    )
    .run();
  if (acq.changes === 0) {
    emit({ type: 'skipped', reason: 'turn already running' });
    return { status: 'skipped', reason: 'turn already running' };
  }

  // Abort: max-duration timeout, linked with any external signal (browser Stop).
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), maxDurationMs);
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    // Self-initiated instruction → persist as a user message so it joins the transcript.
    if (opts.instruction?.trim()) {
      await db.insert(messages).values({
        id: `msg_${bytesToHex(randomBytes(8))}`,
        session_id: sessionId,
        role: 'user',
        content: opts.instruction.trim(),
        created_at: new Date(),
      });
    }

    // Whole session, chronological (rowid tie-breaks within a second). A cleared
    // session only feeds messages after the clear marker.
    const conversation = await db
      .select()
      .from(messages)
      .where(
        session.cleared_at
          ? and(eq(messages.session_id, sessionId), gt(messages.created_at, session.cleared_at))
          : eq(messages.session_id, sessionId),
      )
      .orderBy(asc(messages.created_at), asc(sql`rowid`));
    const lastUserMessage = [...conversation].reverse().find((m) => m.role === 'user');

    if (resolveTurnInput(opts.instruction, Boolean(lastUserMessage)).kind === 'none') {
      emit({ type: 'error', message: 'no prompt to respond to' });
      return { status: 'error', reason: 'no prompt to respond to' };
    }
    // lastUserMessage is now guaranteed (instruction was inserted, or one existed).

    if (!session.project_id) {
      emit({ type: 'error', message: 'session has no project — cannot run a turn' });
      return { status: 'error', reason: 'no project' };
    }
    const project = await db
      .select()
      .from(projects)
      .where(eq(projects.id, session.project_id))
      .limit(1)
      .then((r) => r[0]);

    const allAgents = await db.select().from(agents);
    const sage = allAgents.find((a) => a.id === 'sage');
    const agentLabels: Record<string, string> = Object.fromEntries(
      allAgents.map((a) => [a.id, a.id === 'sage' ? 'Sage' : `${a.name} (${a.role})`]),
    );
    const transcript = buildOrchestratorPrompt(
      conversation.map((m): TranscriptMessage => ({
        role: m.role as TranscriptMessage['role'],
        agentId: m.agent_id,
        content: m.content,
      })),
      agentLabels,
    );

    const { agentId: mentionId } = parseMention(lastUserMessage!.content, allAgents);
    const addressed =
      mentionId && mentionId !== 'sage' ? allAgents.find((a) => a.id === mentionId) : undefined;
    const primary = addressed ?? sage;
    const primaryId = primary?.id ?? 'sage';

    emit({ type: 'start', messageId: lastUserMessage!.id });

    let primaryBuffer = '';
    let primaryEmitted = false;
    let costUsd: number | undefined;
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;

    const flushPrimary = async (usage?: { costUsd?: number; tokensIn?: number; tokensOut?: number }) => {
      if (!primaryBuffer.trim()) return;
      await db.insert(messages).values({
        id: `msg_${bytesToHex(randomBytes(8))}`,
        session_id: sessionId,
        agent_id: primaryId,
        role: 'agent',
        content: primaryBuffer,
        token_count_in: usage?.tokensIn,
        token_count_out: usage?.tokensOut,
        cost_usd: usage?.costUsd,
        created_at: new Date(),
      });
      primaryBuffer = '';
      primaryEmitted = true;
    };

    // An agent must NEVER run outside a real isolated worktree. If we can't create
    // one, abort the turn — do not fall back to repo_path or process.cwd() (the live
    // app dir). The lease is released by the finally below.
    if (!project?.repo_path) {
      emit({ type: 'error', message: 'no repo configured for this project — cannot run a turn' });
      return { status: 'error', reason: 'no repo_path' };
    }
    let workingDir: string;
    try {
      const wt = await ensureWorktree(sessionId, project.repo_path, session.base_branch ?? project.default_branch ?? 'dev');
      workingDir = wt.path;
      if (session.worktree_path !== wt.path) {
        await db.update(sessions).set({ worktree_path: wt.path }).where(eq(sessions.id, sessionId));
      }
      emit({ type: 'worktree', path: wt.path, branch: wt.branch });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', message: `could not prepare an isolated worktree: ${message}` });
      return { status: 'error', reason: `worktree failed: ${message}` };
    }

    // Best-effort plan persistence: never let a DB hiccup break the turn.
    const persistPlan = async (snapshot: PlanSnapshot) => {
      try {
        await savePlanSnapshot(sessionId, snapshot);
      } catch (err) {
        console.error('plan persist failed:', err instanceof Error ? err.message : err);
      }
    };

    const dispatchServer = addressed
      ? null
      : createDispatchServer({
          workingDir,
          signal: combinedSignal,
          emit,
          persistMessage: async (agentId, content, usage) => {
            await db.insert(messages).values({
              id: `msg_${bytesToHex(randomBytes(8))}`,
              session_id: sessionId,
              agent_id: agentId,
              dispatched_via: primaryId,
              role: 'agent',
              content,
              token_count_in: usage.tokensIn,
              token_count_out: usage.tokensOut,
              cost_usd: usage.costUsd,
              created_at: new Date(),
            });
          },
          onBeforeDispatch: () => flushPrimary(),
          savePlanSnapshot: persistPlan,
        });

    for await (const event of runClaudeAgent({
      prompt: transcript,
      workingDir,
      model: primary?.model,
      systemPrompt: primary?.system_prompt,
      allowedTools: primary?.tools_allowlist ?? undefined,
      ...(dispatchServer
        ? {
            mcpServers: { [DISPATCH_SERVER_NAME]: dispatchServer },
            extraAllowedTools: [DISPATCH_TOOL_NAME],
          }
        : {}),
      extraEnv: { CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '600000' },
      signal: combinedSignal,
    })) {
      const term = toTerminalEvent(event, primaryId);
      if (term) emit(term as unknown as { type: string; [k: string]: unknown });

      if (event.type === 'token') {
        primaryBuffer += event.content;
      } else if (event.type === 'tool') {
        emit({ type: 'activity', agent_id: primaryId, tool: event.name, input: event.input });
        const planSnap = toPlanSnapshot(event.name, event.input, primaryId);
        if (planSnap) await persistPlan(planSnap);
      } else if (event.type === 'done') {
        costUsd = event.costUsd;
        tokensIn = event.tokensIn;
        tokensOut = event.tokensOut;
        if (!primaryBuffer && event.fullText) primaryBuffer = event.fullText;
      }
      if (event.type !== 'tool_result') emit(event);
    }

    await flushPrimary({ costUsd, tokensIn, tokensOut });
    if (primaryEmitted) {
      await db.update(sessions).set({ updated_at: new Date() }).where(eq(sessions.id, sessionId));
    }
    emit({ type: 'persisted' });
    return { status: 'completed' };
  } catch (err) {
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    // We acquired the lease above (we only reach try/finally after acq.changes>0),
    // so release it. Best-effort: a failed release self-heals via the stale TTL.
    try {
      await db.update(sessions).set({ running_since: null }).where(eq(sessions.id, sessionId)).run();
    } catch (err) {
      console.error('lease release failed:', err instanceof Error ? err.message : err);
    }
  }
}
