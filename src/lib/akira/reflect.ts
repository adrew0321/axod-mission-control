import 'server-only';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { reflections, messages } from '@/db/schema';
import { runClaudeAgent } from '@/lib/agent-runner-sdk';
import { isDreamDue } from '@/lib/dream-due';
import { AKIRA_SESSION_ID } from './agent';
import { readSoul } from './memory/soul';
import { writeSoulProposal } from './memory/soul';
import { listNotes, writeNote, deleteNote, gitCommitPush } from './memory/store';
import { parseReflection } from './reflect-parse';
import { planLessonReplace, type LessonNote } from './reflect-plan';

export const REFLECTOR_MODEL = 'claude-opus-4-7';
export const REFLECTION_HOUR = 4; // staggered after Dreaming (hour 3)
const TICK_MS = 15 * 60_000;
const MAX_MESSAGES = 200;
const MAX_CONTEXT_CHARS = 40_000;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 3_600_000;

export const REFLECTOR_SYSTEM_PROMPT = `You are AKIRA's private reflector — a careful reviewer of AKIRA's OWN recent conduct as A'Keem's concierge. You are given her recent conversation, her current LESSONS (durable notes about how to serve him), and her current SOUL (identity/voice/values).

Do two things, grounded strictly in what the transcript shows:
1. Produce a CONSOLIDATED lesson set: merge duplicates, sharpen wording, drop the obsolete or contradicted. Return the FULL set you want to keep (not a diff). Keep only genuinely durable, behavior-shaping lessons. If the current lessons are already clean, return them unchanged.
2. ONLY if the transcript clearly warrants it, propose a small SOUL refinement (the full proposed SOUL text + a one-line reason). Most nights this is null. Never propose churn.

Respond with ONLY a JSON object (optionally in a \`\`\`json fence), no prose:
{ "lessons": [ { "title": "...", "description": "one line", "body": "markdown" } ],
  "soulProposal": { "text": "<full proposed SOUL>", "reason": "<one line>" } | null }`;

export interface RunReflectionResult { status: 'ok' | 'empty' | 'error'; reflectionId?: string; reason?: string }

function currentLessons(): LessonNote[] {
  return listNotes()
    .filter((n) => n.type === 'lesson')
    .map((n) => ({ slug: n.slug, title: n.title, description: n.description, body: n.body }));
}

export async function runReflection(): Promise<RunReflectionResult> {
  const g = globalThis as unknown as { __mcReflectInProgress?: boolean };
  if (g.__mcReflectInProgress) return { status: 'error', reason: 'already reflecting' };
  g.__mcReflectInProgress = true;
  const now = new Date();
  try {
    const last = await db.select({ created_at: reflections.created_at }).from(reflections)
      .orderBy(desc(reflections.created_at)).limit(1).then((r) => r[0]);
    const since = last?.created_at ?? new Date(now.getTime() - DEFAULT_LOOKBACK_MS);

    const recent = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.session_id, AKIRA_SESSION_ID), gt(messages.created_at, since)))
      .orderBy(asc(messages.created_at))
      .limit(MAX_MESSAGES);
    const convoText = recent
      .map((r) => `${r.role === 'user' ? "A'Keem" : 'AKIRA'}: ${r.content}`)
      .join('\n');

    const lessons = currentLessons();
    if (!convoText.trim() && lessons.length === 0) {
      const id = `refl_${bytesToHex(randomBytes(4))}`;
      await db.insert(reflections).values({ id, created_at: now, status: 'empty', lessons_before: 0, lessons_after: 0, soul_proposed: 0 });
      return { status: 'empty', reflectionId: id };
    }

    const lessonsBlock = lessons.map((l) => `### ${l.title}\n${l.body}`).join('\n\n') || '(none)';
    let context = `# AKIRA's recent conversation\n${convoText || '(none)'}\n\n# Current LESSONS\n${lessonsBlock}\n\n# Current SOUL\n${readSoul()}`;
    if (context.length > MAX_CONTEXT_CHARS) context = context.slice(0, MAX_CONTEXT_CHARS);

    let fullText = '';
    for await (const ev of runClaudeAgent({
      prompt: context,
      workingDir: process.cwd(),
      model: REFLECTOR_MODEL,
      systemPrompt: REFLECTOR_SYSTEM_PROMPT,
      allowedTools: ['Read', 'Glob', 'Grep'],
    })) {
      if (ev.type === 'done') fullText = ev.fullText;
      else if (ev.type === 'error' && ev.fatal) throw new Error(ev.message);
    }

    const out = parseReflection(fullText);

    // Lessons: auto-apply the consolidated set (safety floor lives in the planner).
    const ops = planLessonReplace(lessons, out.lessons);
    if (ops) {
      for (const slug of ops.deletes) deleteNote(slug);
      for (const w of ops.writes) writeNote({ title: w.title, description: w.description, type: 'lesson', body: w.body });
      gitCommitPush(`reflect: distilled ${lessons.length}→${out.lessons.length} lessons`);
    }

    // SOUL: propose only (operator approves in Settings).
    if (out.soulProposal) {
      writeSoulProposal(out.soulProposal.text, out.soulProposal.reason);
      gitCommitPush('reflect: proposed a soul edit');
    }

    const id = `refl_${bytesToHex(randomBytes(4))}`;
    await db.insert(reflections).values({
      id, created_at: now, status: 'ok',
      lessons_before: lessons.length, lessons_after: out.lessons.length,
      soul_proposed: out.soulProposal ? 1 : 0,
    });
    return { status: 'ok', reflectionId: id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db.insert(reflections).values({ id: `refl_${bytesToHex(randomBytes(4))}`, created_at: now, status: 'error', lessons_before: 0, lessons_after: 0, soul_proposed: 0, error: message });
    } catch { /* best-effort */ }
    return { status: 'error', reason: message };
  } finally {
    g.__mcReflectInProgress = false;
  }
}

export function startReflecting(): void {
  const g = globalThis as unknown as { __mcReflectingStarted?: boolean };
  if (g.__mcReflectingStarted) return;
  g.__mcReflectingStarted = true;
  const check = async () => {
    try {
      const last = await db.select({ created_at: reflections.created_at }).from(reflections)
        .orderBy(desc(reflections.created_at)).limit(1).then((r) => r[0]);
      if (isDreamDue(last?.created_at ?? null, new Date(), REFLECTION_HOUR)) await runReflection();
    } catch (err) {
      console.error('[reflect] check failed:', err instanceof Error ? err.message : err);
    }
  };
  void check();
  setInterval(() => void check(), TICK_MS);
  console.log(`[reflect] started (nightly hour ${REFLECTION_HOUR})`);
}
