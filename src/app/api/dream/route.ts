import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { runDream } from '@/lib/dream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function authed(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && !!(await verifySession(token));
}

export async function POST() {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const result = await runDream();
  if (result.status === 'error' && result.reason === 'already dreaming') {
    return Response.json(result, { status: 409 });
  }
  return Response.json(result);
}
