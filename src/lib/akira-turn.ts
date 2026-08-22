import 'server-only';
import { asc, eq, sql } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { agents, messages, sessions } from '@/db/schema';
import { runClaudeAgent } from './agent-runner-sdk';
import { resolveCaps } from '@/lib/agent-caps';
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
  AKIRA_VAULT_WRITE,
} from './akira/tools';
import { ensureAkiraThread, AKIRA_AGENT_ID, AKIRA_SESSION_ID } from './akira/bootstrap';
import { trimTranscript } from './akira/transcript';
import { type TranscriptMessage } from './conversation';
import { indexText, gitPullDebounced, lessonsText, vaultDir } from './akira/memory/store';
import { readSoul } from './akira/memory/soul';
import { soulLessonsPreamble } from './akira/preamble';
import { readVaultMap, vaultBlock } from './akira/memory/vault-map';

import { BROWSER_TOOL_NAMES } from './akira/browser-tools';
import { ROOM_TOOL_NAMES } from './akira/room-tools';
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
        ? `\n\n## MEMORY\nNotes you've saved (read one with your Read tool at data/akira-memory/memory/<slug>.md):\n${idx}`
        : `\n\n## MEMORY\n(empty — save durable facts with the remember tool)`;
    } catch {
      memoryBlock = '';
    }

    let vaultMapBlock = '';
    try {
      const block = vaultBlock(readVaultMap());
      vaultMapBlock = block ? `\n\n${block}` : '';
    } catch {
      vaultMapBlock = ''; // an unreadable map must never break a turn
    }

    let preamble = '';
    try {
      preamble = soulLessonsPreamble(readSoul(), lessonsText().text);
    } catch {
      preamble = soulLessonsPreamble(readSoul(), ''); // lessons unavailable — SOUL still leads
    }

    const prompt =
      preamble + '\n\n' +
      buildAkiraPrompt(snapshot, roster, transcript, agentLabels) +
      memoryBlock +
      vaultMapBlock +
      `\n\n## LAPTOP COMPANION\n${companionOnline()
        ? 'The laptop companion is CONNECTED — you may use browser_navigate/read/type/click. Work read→act→read. State the task and let the operator approve before starting; never retry a gated (blocked) action — wait for approval.'
        : 'The laptop companion is OFFLINE — browser actions are unavailable; tell the operator their laptop companion isn\'t connected if they ask for browser work.'}`;

    const akira = allAgents.find((a) => a.id === AKIRA_AGENT_ID);
    const akiraCaps = resolveCaps(akira);
    // `watched` tracks whether a real, operator-facing emit was supplied
    // (the /api/akira/stream route wires one to the HUD's SSE connection) as
    // opposed to the no-op default used by headless, doorway-triggered turns
    // (room-proposals-data.ts's runRoomTurn calls runAkiraTurn with no emit
    // at all). See room-shell.ts for why this matters for shell gates.
    const server = createAkiraServer({ emit, watched: Boolean(opts.emit) });

    emit({ type: 'start' });
    let buffer = '';
    let costUsd: number | undefined;
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    let cacheReadTokens: number | undefined;
    let cacheCreationTokens: number | undefined;

    for await (const event of runClaudeAgent({
      prompt,
      workingDir: process.cwd(), // AKIRA has only read tools; never a worktree
      model: akira?.model,
      systemPrompt: akira?.system_prompt ?? AKIRA_SYSTEM_PROMPT,
      allowedTools: akira?.tools_allowlist ?? undefined,
      effort: akiraCaps.effort,
      maxTurns: akiraCaps.maxTurns,
      maxBudgetUsd: akiraCaps.maxBudgetUsd,
      mcpServers: { [AKIRA_SERVER_NAME]: server },
      additionalDirectories: [vaultDir()],
      skills: 'all',
      extraEnv: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' },
      extraAllowedTools: [
        AKIRA_NAVIGATE,
        AKIRA_OPEN,
        AKIRA_RELAY,
        AKIRA_LIST_SESSIONS,
        AKIRA_GET_SESSION,
        AKIRA_REMEMBER,
        AKIRA_FORGET,
        AKIRA_VAULT_WRITE,
        ...BROWSER_TOOL_NAMES,
        ...ROOM_TOOL_NAMES,
      ],
      signal: opts.signal,
    })) {
      if (event.type === 'token') {
        buffer += event.content;
      } else if (event.type === 'done') {
        costUsd = event.costUsd;
        tokensIn = event.tokensIn;
        tokensOut = event.tokensOut;
        cacheReadTokens = event.cacheReadTokens;
        cacheCreationTokens = event.cacheCreationTokens;
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
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
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
