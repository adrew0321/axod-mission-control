import { cookies } from 'next/headers';
import { eq, and } from 'drizzle-orm';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { db } from '@/db/client';
import { room_proposals } from '@/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  await db
    .update(room_proposals)
    .set({ status: 'dismissed', decided_at: new Date() })
    .where(and(eq(room_proposals.id, id), eq(room_proposals.status, 'open')));
  return Response.json({ ok: true });
}
