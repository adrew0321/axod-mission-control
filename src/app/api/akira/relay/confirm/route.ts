import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { runSessionTurn } from '@/lib/run-turn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sseEncode(event: { type: string; [k: string]: unknown }): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) return new Response('Unauthorized', { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { sessionId?: string; instruction?: string };
  if (!body.sessionId || !body.instruction?.trim()) {
    return new Response('sessionId and instruction are required', { status: 400 });
  }
  const { sessionId, instruction } = body;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: { type: string; [k: string]: unknown }) => controller.enqueue(sseEncode(e));
      try {
        // runSessionTurn inserts `instruction` as a user message in the target
        // session, then runs the turn. This is the human-confirmed launch path —
        // AKIRA's relay tool only proposes; nothing runs until this route is hit.
        await runSessionTurn(sessionId, { emit, signal: req.signal, instruction });
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
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
