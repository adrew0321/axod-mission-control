import 'server-only';
import { asc, eq, sql } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { agents, messages, sessions } from '@/db/schema';
import { runClaudeAgent } from './agent-runner-sdk';
import { getFleetSnapshotLive } from './fleet-contributors';
import { buildAkiraPrompt, AKIRA_SYSTEM_PROMPT } from './akira/prompt';
import {
  createAkiraServer,
  AKIRA_SERVER_NAME,
  AKIRA_NAVIGATE,
  AKIRA_OPEN,
  AKIRA_RELAY,
  AKIRA_LIST_SESSIONS,
  AKIRA_GET_SESSION,
  AKIRA_REMEMBER,
  AKIRA_FORGET,
} from './akira/tools';
import { ensureAkiraThread, AKIRA_AGENT_ID, AKIRA_SESSION_ID } from './akira/bootstrap';
import { trimTranscript } from './akira/transcript';
import { type TranscriptMessage } from './conversation';
import { indexText, gitPullDebounced } from './akira/memory/store';

import { BROWSER_TOOL_NAMES } from './akira/browser-tools';
import { isOnline as companionOnline } from '@/lib/companion/registry';

export type TurnEmit = (e: { type: string; [k: string]: unknown }) => void;
const KEEP_TURNS = 24; // last N messages kept verbatim in the persistent thread

/**
 * Run one AKIRA turn end-to-end, server-side. Unlike runSessionTurn, AKIRA gets
 * NO git worktree (read tools only) and her own action tools (navigate/relay/
 * open + reads). Her persistent thread is messages on the reserved AKIRA session.
 */
export async function runAkiraTurn(
  opts: { emit?: TurnEmit; signal?: AbortSignal; instruction?: string } = {},
): Promise<{ status: 'completed' | 'error'; reason?: string }> {
  const emit: TurnEmit = opts.emit ?? (() => {});
  await ensureAkiraThread();

  try {
    if (opts.instruction?.trim()) {
      await db.insert(messages).values({
        id: `msg_${bytesToHex(randomBytes(8))}`,
        session_id: AKIRA_SESSION_ID,
        role: 'user',
        content: opts.instruction.trim(),
        created_at: new Date(),
      });
    }

    const convo = await db
      .select()
      .from(messages)
      .where(eq(messages.session_id, AKIRA_SESSION_ID))
      .orderBy(asc(messages.created_at), asc(sql`rowid`));

    const allAgents = await db.select().from(agents);
    const roster = allAgents
      .filter((a) => a.id !== AKIRA_AGENT_ID)
      .map((a) => ({ id: a.id, name: a.name, role: a.role }));
    const agentLabels: Record<string, string> = Object.fromEntries(
      allAgents.map((a) => [a.id, a.id === 'sage' ? 'Sage' : `${a.name} (${a.role})`]),
    );

    const transcript = trimTranscript(
      convo.map((m): TranscriptMessage => ({
        role: m.role as TranscriptMessage['role'],
        agentId: m.agent_id,
        content: m.content,
      })),
      KEEP_TURNS,
    );

    const snapshot = await getFleetSnapshotLive();

    gitPullDebounced(); // pick up the operator's Obsidian edits (debounced, best-effort)
    let memoryBlock = '';
    try {
      const idx = indexText();
      memoryBlock = idx
        ? `\n\n## MEMORY\nNotes you've saved (read one with your Read tool at data/akira-memory/<slug>.md):\n${idx}`
        : `\n\n## MEMORY\n(empty — save durable facts with the remember tool)`;
    } catch {
      memoryBlock = '';
    }

    const prompt =
      buildAkiraPrompt(snapshot, roster, transcript, agentLabels) +
      memoryBlock +
      `\n\n## LAPTOP COMPANION\n${companionOnline()
        ? 'The laptop companion is CONNECTED — you may use browser_navigate/read/type/click. Work read→act→read. State the task and let the operator approve before starting; never retry a gated (blocked) action — wait for approval.'
        : 'The laptop companion is OFFLINE — browser actions are unavailable; tell the operator their laptop companion isn\'t connected if they ask for browser work.'}`;

    const akira = allAgents.find((a) => a.id === AKIRA_AGENT_ID);
    const server = createAkiraServer({ emit });

    emit({ type: 'start' });
    let buffer = '';
    let costUsd: number | undefined;
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;

    for await (const event of runClaudeAgent({
      prompt,
      workingDir: process.cwd(), // AKIRA has only read tools; never a worktree
      model: akira?.model,
      systemPrompt: akira?.system_prompt ?? AKIRA_SYSTEM_PROMPT,
      allowedTools: akira?.tools_allowlist ?? undefined,
      mcpServers: { [AKIRA_SERVER_NAME]: server },
      extraAllowedTools: [
        AKIRA_NAVIGATE,
        AKIRA_OPEN,
        AKIRA_RELAY,
        AKIRA_LIST_SESSIONS,
        AKIRA_GET_SESSION,
        AKIRA_REMEMBER,
        AKIRA_FORGET,
        ...BROWSER_TOOL_NAMES,
      ],
      signal: opts.signal,
    })) {
      if (event.type === 'token') {
        buffer += event.content;
      } else if (event.type === 'done') {
        costUsd = event.costUsd;
        tokensIn = event.tokensIn;
        tokensOut = event.tokensOut;
        if (!buffer && event.fullText) buffer = event.fullText;
      }
      if (event.type !== 'tool_result') emit(event);
    }

    if (buffer.trim()) {
      await db.insert(messages).values({
        id: `msg_${bytesToHex(randomBytes(8))}`,
        session_id: AKIRA_SESSION_ID,
        agent_id: AKIRA_AGENT_ID,
        role: 'agent',
        content: buffer,
        token_count_in: tokensIn,
        token_count_out: tokensOut,
        cost_usd: costUsd,
        created_at: new Date(),
      });
      await db.update(sessions).set({ updated_at: new Date() }).where(eq(sessions.id, AKIRA_SESSION_ID));
    }
    emit({ type: 'persisted' });
    return { status: 'completed' };
  } catch (err) {
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}
