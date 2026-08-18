import { resolveResult } from '@/lib/companion/registry';
import type { Result } from '@/lib/companion/protocol';
import { identifyCompanionToken } from '@/lib/companion/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Both machines post here, so the target comes from the credential itself.
  const target = identifyCompanionToken(req.headers.get('x-companion-token'));
  if (!target) {
    return new Response('Unauthorized', { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as Result | null;
  if (!body || !body.id || !body.status) {
    return new Response('bad result', { status: 400 });
  }
  resolveResult(body, target);
  return Response.json({ ok: true });
}
