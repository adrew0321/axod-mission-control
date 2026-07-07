import { registerCompanion } from '@/lib/companion/registry';
import { startCompanionStream } from '@/lib/companion/stream-lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token');
  if (!process.env.COMPANION_TOKEN || token !== process.env.COMPANION_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      startCompanionStream({ controller, register: registerCompanion, signal: req.signal });
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
