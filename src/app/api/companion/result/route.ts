import { resolveResult } from '@/lib/companion/registry';
import type { Result } from '@/lib/companion/protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const token = req.headers.get('x-companion-token');
  if (!process.env.COMPANION_TOKEN || token !== process.env.COMPANION_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as Result | null;
  if (!body || !body.id || !body.status) {
    return new Response('bad result', { status: 400 });
  }
  resolveResult(body);
  return Response.json({ ok: true });
}
