import { cookies } from 'next/headers';
import { eq, and } from 'drizzle-orm';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { db } from '@/db/client';
import { room_proposals } from '@/db/schema';
import { runRoomTurn } from '@/lib/room-proposals-data';
import { inboxTurnInstruction } from '@/lib/room-proposals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;

  const row = await db
    .select()
    .from(room_proposals)
    .where(and(eq(room_proposals.id, id), eq(room_proposals.status, 'open')))
    .limit(1)
    .then((r) => r[0]);
  if (!row) return Response.json({ error: 'no open proposal' }, { status: 404 });

  await db
    .update(room_proposals)
    .set({ status: 'approved', decided_at: new Date() })
    .where(eq(room_proposals.id, id));

  // The full-cost turn runs only now, after approval.
  runRoomTurn(inboxTurnInstruction({ name: row.name, path: row.path, summary: row.summary }));
  return Response.json({ ok: true });
}
