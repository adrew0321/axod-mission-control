import { cookies } from 'next/headers';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { messages, projects, sessions } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { runClaudeAgent, type AgentEvent } from '@/lib/agent-runner-sdk';
import { agents } from '@/db/schema';
import { ensureWorktree } from '@/lib/worktree';
import { createDispatchServer, DISPATCH_SERVER_NAME, DISPATCH_TOOL_NAME } from '@/lib/dispatch';
import { toTerminalEvent } from '@/lib/terminal-events';
import { buildOrchestratorPrompt, type TranscriptMessage } from '@/lib/conversation';
import { parseMention } from '@/lib/mention';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sseEncode(event: AgentEvent | { type: string; [k: string]: unknown }): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  // Whole session, chronological (rowid tie-breaks a dispatch turn so it stays
  // Sage-pre → specialist → Sage-post — same ordering page.tsx uses). A cleared
  // session only feeds Sage messages after the clear marker, so it starts fresh.
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
  if (!lastUserMessage) return new Response('No user prompt to respond to', { status: 400 });

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

  // Direct addressing: a leading "@<agent>" routes the turn to that specialist
  // (bypassing Sage). No / unrecognized mention → Sage. A directly-addressed
  // specialist gets NO dispatch tool (only Sage orchestrates).
  const { agentId: mentionId } = parseMention(lastUserMessage.content, allAgents);
  const addressed = mentionId && mentionId !== 'sage' ? allAgents.find((a) => a.id === mentionId) : undefined;
  const primary = addressed ?? sage;
  const primaryId = primary?.id ?? 'sage';

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(sseEncode({ type: 'start', messageId: lastUserMessage.id }));
        // Sage's text accumulates here and is flushed as a distinct message at
        // each dispatch boundary (and once at the end), so a dispatch turn lands
        // in the DB as Sage-pre → specialist → Sage-post in true chronological
        // order. usage from the final `done` is attributed to the closing flush.
        // The primary agent's text accumulates here. On the Sage path it's flushed
        // at each dispatch boundary (Sage-pre → specialist → Sage-post); a directly
        // addressed specialist has no dispatch, so it's just flushed once at the end.
        let primaryBuffer = '';
        let primaryEmitted = false;
        let costUsd: number | undefined;
        let tokensIn: number | undefined;
        let tokensOut: number | undefined;

        const flushPrimary = async (usage?: { costUsd?: number; tokensIn?: number; tokensOut?: number }) => {
          if (!primaryBuffer.trim()) return;
          const now = new Date();
          await db.insert(messages).values({
            id: `msg_${bytesToHex(randomBytes(8))}`,
            session_id: sessionId,
            agent_id: primaryId,
            role: 'agent',
            content: primaryBuffer,
            token_count_in: usage?.tokensIn,
            token_count_out: usage?.tokensOut,
            cost_usd: usage?.costUsd,
            created_at: now,
          });
          primaryBuffer = '';
          primaryEmitted = true;
        };

        // Run the agent inside this session's own git worktree (isolation: edits
        // land on a throwaway mc/<session> branch, never the project's base
        // branch). Falls back to the main repo if the worktree can't be created.
        let workingDir = project?.repo_path ?? process.cwd();
        if (project?.repo_path) {
          try {
            const wt = await ensureWorktree(
              sessionId,
              project.repo_path,
              project.default_branch ?? 'dev',
            );
            workingDir = wt.path;
            if (session.worktree_path !== wt.path) {
              await db
                .update(sessions)
                .set({ worktree_path: wt.path })
                .where(eq(sessions.id, sessionId));
            }
            controller.enqueue(sseEncode({ type: 'worktree', path: wt.path, branch: wt.branch }));
          } catch (err) {
            controller.enqueue(
              sseEncode({
                type: 'worktree_error',
                message: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }

        // Sage can hand concrete coding tasks to a specialist (Atlas) via the
        // in-process `dispatch_agent` MCP tool. The dispatched agent runs in the
        // SAME worktree, streams to the operator through these closures, and its
        // final summary is returned to Sage as the tool result.
        const dispatchServer = addressed
          ? null
          : createDispatchServer({
          workingDir,
          signal: req.signal,
          emit: (event) => controller.enqueue(sseEncode(event)),
          persistMessage: async (agentId, content, usage) => {
            const now = new Date();
            await db.insert(messages).values({
              id: `msg_${bytesToHex(randomBytes(8))}`,
              session_id: sessionId,
              agent_id: agentId,
              role: 'agent',
              content,
              token_count_in: usage.tokensIn,
              token_count_out: usage.tokensOut,
              cost_usd: usage.costUsd,
              created_at: now,
            });
          },
          onBeforeDispatch: () => flushPrimary(),
        });

        // Interactive approval gates aren't achievable on this SDK (see the
        // week-3 plan Day 1). v1 safety = capability allowlist (below) +
        // worktree isolation (above) + operator diff review.
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
          // The dispatch_agent MCP call blocks while a specialist works — well past
          // the 60s default SDK stream-close timeout. Harmless for a direct agent.
          extraEnv: { CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '600000' },
          signal: req.signal, // operator "Stop" closes the EventSource → aborts the SDK
        })) {
          const term = toTerminalEvent(event, primaryId);
          if (term) controller.enqueue(sseEncode(term as unknown as { type: string; [k: string]: unknown }));

          if (event.type === 'token') {
            primaryBuffer += event.content;
          } else if (event.type === 'tool') {
            // The primary agent's tool activity (Read/Grep/dispatch_agent…) → STATE box.
            controller.enqueue(
              sseEncode({ type: 'activity', agent_id: primaryId, tool: event.name, input: event.input }),
            );
          } else if (event.type === 'done') {
            costUsd = event.costUsd;
            tokensIn = event.tokensIn;
            tokensOut = event.tokensOut;
            if (!primaryBuffer && event.fullText) primaryBuffer = event.fullText;
          }
          // Forward the raw event for the client (token rendering relies on this).
          // Skip raw tool_result entirely: the client never consumes raw results,
          // and Bash output already went out above as a (smaller, filtered)
          // `terminal` event — no point sending the full result payload twice.
          if (event.type !== 'tool_result') controller.enqueue(sseEncode(event));
        }

        // Flush Sage's closing text (post-dispatch summary, or its whole reply
        // when no dispatch happened); the turn's usage rides on this message.
        await flushPrimary({ costUsd, tokensIn, tokensOut });
        if (primaryEmitted) {
          await db.update(sessions).set({ updated_at: new Date() }).where(eq(sessions.id, sessionId));
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
