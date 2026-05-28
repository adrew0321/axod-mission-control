import { cookies } from 'next/headers';
import { and, desc, eq } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { messages, projects, sessions } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { runClaudeAgent, type AgentEvent } from '@/lib/agent-runner-sdk';
import { agents } from '@/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sseEncode(event: AgentEvent | { type: string; [k: string]: unknown }): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id: sessionId } = await ctx.params;
  const session = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
    .then((r) => r[0]);
  if (!session) return new Response('Session not found', { status: 404 });

  const lastUserMessage = await db
    .select()
    .from(messages)
    .where(and(eq(messages.session_id, sessionId), eq(messages.role, 'user')))
    .orderBy(desc(messages.created_at))
    .limit(1)
    .then((r) => r[0]);
  if (!lastUserMessage) return new Response('No user prompt to respond to', { status: 400 });

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, session.project_id))
    .limit(1)
    .then((r) => r[0]);

  const sage = await db
    .select()
    .from(agents)
    .where(eq(agents.id, 'sage'))
    .limit(1)
    .then((r) => r[0]);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(sseEncode({ type: 'start', messageId: lastUserMessage.id }));
        let fullText = '';
        let costUsd: number | undefined;
        let tokensIn: number | undefined;
        let tokensOut: number | undefined;

        for await (const event of runClaudeAgent({
          prompt: lastUserMessage.content,
          workingDir: project?.repo_path ?? process.cwd(),
          model: sage?.model,
          systemPrompt: sage?.system_prompt,
          allowedTools: sage?.tools_allowlist ?? undefined,
        })) {
          if (event.type === 'token') {
            fullText += event.content;
          } else if (event.type === 'done') {
            costUsd = event.costUsd;
            tokensIn = event.tokensIn;
            tokensOut = event.tokensOut;
            if (!fullText && event.fullText) fullText = event.fullText;
          }
          controller.enqueue(sseEncode(event));
        }

        if (fullText) {
          const now = new Date();
          await db.insert(messages).values({
            id: `msg_${bytesToHex(randomBytes(8))}`,
            session_id: sessionId,
            agent_id: 'sage',
            role: 'agent',
            content: fullText,
            token_count_in: tokensIn,
            token_count_out: tokensOut,
            cost_usd: costUsd,
            created_at: now,
          });
          await db.update(sessions).set({ updated_at: now }).where(eq(sessions.id, sessionId));
        }

        controller.enqueue(sseEncode({ type: 'persisted' }));
      } catch (err) {
        controller.enqueue(
          sseEncode({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
