import 'server-only';
import { asc, desc, eq, gt } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { dreams, dream_insights, sessions, messages, agents } from '@/db/schema';
import { runClaudeAgent } from '@/lib/agent-runner-sdk';
import { parseInsights } from '@/lib/dream-insights';
import { isDreamDue } from '@/lib/dream-due';

export const CURATOR_MODEL = 'claude-opus-4-7';

export const CURATOR_SYSTEM_PROMPT = `You are the Curator of AXOD Mission Control — a reflective observer of an AI agent team (Sage the orchestrator plus specialists) working for a single operator on real code.

You are given a transcript of the team's RECENT activity (sessions and messages since the last time you reflected). Your job is to surface a small number of genuinely useful insights about how the work is going — patterns worth noticing, risks worth flagging, concrete suggestions, and earned praise. Be specific and ground every insight in what the transcript actually shows. Do not invent activity that isn't there. Quality over quantity: 0 to 6 insights. If nothing is worth surfacing, return an empty array.

Respond with ONLY a JSON array (optionally inside a \`\`\`json fence), each element:
{ "category": "pattern" | "risk" | "suggestion" | "praise", "title": "<one concise line>", "detail": "<1-3 sentences>" }

No prose outside the array.`;

const DEFAULT_LOOKBACK_MS = 7 * 24 * 3_600_000;
const MAX_MESSAGES = 200;
const MAX_CONTEXT_CHARS = 40_000;
const DREAM_TICK_MS = 15 * 60_000;
const NIGHTLY_HOUR = 3;

export interface RunDreamResult {
  status: 'ok' | 'empty' | 'error';
  dreamId?: string;
  reason?: string;
}

function formatContext(
  rows: Array<{ sessionId: string; sessionTitle: string | null; role: string; agentId: string | null; content: string }>,
  nameFor: (agentId: string | null, role: string) => string,
): string {
  const bySession = new Map<string, { title: string; lines: string[] }>();
  for (const r of rows) {
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, { title: r.sessionTitle ?? '(untitled)', lines: [] });
    bySession.get(r.sessionId)!.lines.push(`${nameFor(r.agentId, r.role)}: ${r.content}`);
  }
  const blocks: string[] = [];
  for (const [, s] of bySession) blocks.push(`## Session: ${s.title}\n${s.lines.join('\n')}`);
  return `# Recent team activity to reflect on\n\n${blocks.join('\n\n')}`;
}

/**
 * Run one Curator reflection: gather conversations since the last dream, ask the
 * Curator for structured insights, persist them. Single-in-flight via a globalThis
 * flag. Never throws — failures land as a 'error' dream row.
 */
export async function runDream(): Promise<RunDreamResult> {
  const g = globalThis as unknown as { __mcDreamInProgress?: boolean };
  if (g.__mcDreamInProgress) return { status: 'error', reason: 'already dreaming' };
  g.__mcDreamInProgress = true;
  const now = new Date();
  try {
    const last = await db
      .select({ created_at: dreams.created_at })
      .from(dreams)
      .orderBy(desc(dreams.created_at))
      .limit(1)
      .then((r) => r[0]);
    const coversSince = last?.created_at ?? new Date(now.getTime() - DEFAULT_LOOKBACK_MS);

    const rows = await db
      .select({
        sessionId: messages.session_id,
        sessionTitle: sessions.title,
        role: messages.role,
        agentId: messages.agent_id,
        content: messages.content,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.session_id, sessions.id))
      .where(gt(messages.created_at, coversSince))
      .orderBy(asc(messages.created_at))
      .limit(MAX_MESSAGES);

    if (rows.length === 0) {
      const id = `dream_${bytesToHex(randomBytes(4))}`;
      await db.insert(dreams).values({ id, created_at: now, covers_since: coversSince, status: 'empty', insight_count: 0 });
      return { status: 'empty', dreamId: id };
    }

    const allAgents = await db.select({ id: agents.id, name: agents.name }).from(agents);
    const nameFor = (agentId: string | null, role: string) =>
      role === 'user' ? 'Operator' : allAgents.find((a) => a.id === agentId)?.name ?? agentId ?? 'System';

    let context = formatContext(rows, nameFor);
    if (context.length > MAX_CONTEXT_CHARS) context = context.slice(0, MAX_CONTEXT_CHARS);

    let fullText = '';
    for await (const ev of runClaudeAgent({
      prompt: context,
      workingDir: process.cwd(),
      model: CURATOR_MODEL,
      systemPrompt: CURATOR_SYSTEM_PROMPT,
      allowedTools: ['Read', 'Glob', 'Grep'], // read-only; the Curator works from the provided context
    })) {
      if (ev.type === 'done') fullText = ev.fullText;
      else if (ev.type === 'error') throw new Error(ev.message);
    }

    const insights = parseInsights(fullText);
    const id = `dream_${bytesToHex(randomBytes(4))}`;
    await db.insert(dreams).values({
      id,
      created_at: now,
      covers_since: coversSince,
      status: insights.length > 0 ? 'ok' : 'empty',
      insight_count: insights.length,
    });
    for (const ins of insights) {
      await db.insert(dream_insights).values({
        id: `insight_${bytesToHex(randomBytes(4))}`,
        dream_id: id,
        category: ins.category,
        title: ins.title,
        detail: ins.detail,
        status: 'new',
        created_at: new Date(),
      });
    }
    return { status: insights.length > 0 ? 'ok' : 'empty', dreamId: id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db.insert(dreams).values({
        id: `dream_${bytesToHex(randomBytes(4))}`,
        created_at: now,
        covers_since: now,
        status: 'error',
        insight_count: 0,
        error: message,
      });
    } catch {
      /* best-effort */
    }
    return { status: 'error', reason: message };
  } finally {
    g.__mcDreamInProgress = false;
  }
}

/**
 * Start the nightly Dreaming ticker. Idempotent (globalThis flag). Every 15 min it
 * checks isDreamDue against the latest dream; runDream's own in-flight guard
 * prevents overlap with a manual trigger.
 */
export function startDreaming(): void {
  const g = globalThis as unknown as { __mcDreamingStarted?: boolean };
  if (g.__mcDreamingStarted) return;
  g.__mcDreamingStarted = true;
  const check = async () => {
    try {
      const last = await db
        .select({ created_at: dreams.created_at })
        .from(dreams)
        .orderBy(desc(dreams.created_at))
        .limit(1)
        .then((r) => r[0]);
      if (isDreamDue(last?.created_at ?? null, new Date(), NIGHTLY_HOUR)) await runDream();
    } catch (err) {
      console.error('[dreaming] check failed:', err instanceof Error ? err.message : err);
    }
  };
  void check();
  setInterval(() => void check(), DREAM_TICK_MS);
  console.log(`[dreaming] started (nightly hour ${NIGHTLY_HOUR})`);
}
