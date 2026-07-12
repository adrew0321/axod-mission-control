import { resolveResult } from '@/lib/companion/registry';
import type { Result } from '@/lib/companion/protocol';
import { verifyCompanionToken } from '@/lib/companion/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const token = req.headers.get('x-companion-token');
  if (!verifyCompanionToken(token)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as Result | null;
  if (!body || !body.id || !body.status) {
    return new Response('bad result', { status: 400 });
  }
  resolveResult(body);
  return Response.json({ ok: true });
}
