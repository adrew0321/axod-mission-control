import { registerCompanion } from '@/lib/companion/registry';
import type { Command } from '@/lib/companion/protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sse(event: { type: string; [k: string]: unknown }): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token');
  if (!process.env.COMPANION_TOKEN || token !== process.env.COMPANION_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const unregister = registerCompanion({
        send: (cmd: Command) => controller.enqueue(sse({ type: 'command', cmd })),
        close: () => {
          try { controller.close(); } catch { /* already closed */ }
        },
      });
      // heartbeat so the laptop (and any proxy) keeps the stream alive
      const hb = setInterval(() => controller.enqueue(sse({ type: 'ping' })), 15_000);
      req.signal.addEventListener('abort', () => {
        clearInterval(hb);
        unregister();
        try { controller.close(); } catch { /* noop */ }
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
