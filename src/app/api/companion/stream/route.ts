import { registerCompanion } from '@/lib/companion/registry';
import { startCompanionStream } from '@/lib/companion/stream-lifecycle';
import { verifyCompanionToken } from '@/lib/companion/auth';
import { targetFromParam } from '@/lib/companion/target-param';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const token = params.get('token');
  const target = targetFromParam(params.get('target'));
  // Verify against THIS target's secret — a room credential cannot claim
  // ?target=laptop and displace the operator's real companion.
  if (!verifyCompanionToken(token, target)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      startCompanionStream({
        controller,
        register: (sink) => registerCompanion(sink, target),
        signal: req.signal,
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
