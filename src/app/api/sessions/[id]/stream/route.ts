import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { runSessionTurn } from '@/lib/run-turn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sseEncode(event: { type: string; [k: string]: unknown }): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id: sessionId } = await ctx.params;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: { type: string; [k: string]: unknown }) =>
        controller.enqueue(sseEncode(e));
      try {
        // signal = req.signal so the operator closing the EventSource ("Stop") aborts.
        await runSessionTurn(sessionId, { emit, signal: req.signal });
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
