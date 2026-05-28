import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { approvals } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { decideApproval } from '@/lib/permissions';

export const runtime = 'nodejs';

const Body = z.object({
  decision: z.enum(['approved', 'denied', 'always']),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;

  const existing = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, id))
    .limit(1)
    .then((r) => r[0]);
  if (!existing) return Response.json({ error: 'Approval not found' }, { status: 404 });
  if (existing.status !== 'pending') {
    return Response.json({ error: `Already ${existing.status}` }, { status: 409 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid decision' }, { status: 400 });
  }

  await decideApproval(id, parsed.data.decision);
  return Response.json({ ok: true, id, decision: parsed.data.decision });
}
