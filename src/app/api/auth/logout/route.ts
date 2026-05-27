import { cookies } from 'next/headers';
import { SESSION_COOKIE, destroySession, verifySession } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const info = await verifySession(token);
    if (info) await destroySession(info.sessionId);
  }
  jar.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
