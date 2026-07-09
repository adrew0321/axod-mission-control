import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { runSessionTurn } from '@/lib/run-turn';
import { startTurn, subscribe } from '@/lib/turn-broker';
import { startSseStream } from '@/lib/sse-stream';
import { isTerminalTurnEvent } from '@/lib/turn-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id: sessionId } = await ctx.params;

  // Start the turn as a background task. Idempotent: the broker's in-process guard
  // plus runSessionTurn's cross-process DB lease make a concurrent call a no-op.
  // Crucially, req.signal is NOT passed in — a dropped connection no longer aborts
  // the turn; it only tears down this subscription (below).
  startTurn(sessionId, (emit, signal) => runSessionTurn(sessionId, { emit, signal }));

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      startSseStream({
        controller,
        signal: req.signal,
        subscribe: (emit) => subscribe(sessionId, emit),
        // Close only on a TERMINAL event. A non-fatal error (rate_limit, etc.) is
        // emitted mid-turn and must NOT detach the client while the turn runs on.
        closeOn: isTerminalTurnEvent,
      });
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
