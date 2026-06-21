import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { schedules } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { cadenceColumns, computeNextRun, type Cadence } from '@/lib/schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CadenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('every_hours'), intervalHours: z.number().int().min(1).max(168) }),
  z.object({ kind: z.literal('daily'), timeOfDay: z.string().regex(/^\d{2}:\d{2}$/) }),
  z.object({
    kind: z.literal('weekly'),
    dayOfWeek: z.number().int().min(0).max(6),
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/),
  }),
]);

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  title: z.string().min(1).max(200).optional(),
  instruction: z.string().min(1).max(20_000).optional(),
  cadence: CadenceSchema.optional(),
});

async function authed(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && !!(await verifySession(token));
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 });

  const existing = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1).then((r) => r[0]);
  if (!existing) return Response.json({ error: 'Not found' }, { status: 404 });

  const now = new Date();
  const set: Record<string, unknown> = { updated_at: now };
  if (parsed.data.enabled !== undefined) set.enabled = parsed.data.enabled;
  if (parsed.data.title !== undefined) set.title = parsed.data.title.trim();
  if (parsed.data.instruction !== undefined) set.instruction = parsed.data.instruction.trim();
  if (parsed.data.cadence) {
    const cadence = parsed.data.cadence as Cadence;
    Object.assign(set, cadenceColumns(cadence));
    set.next_run_at = computeNextRun(cadence, now); // cadence changed → recompute
  }

  await db.update(schedules).set(set).where(eq(schedules.id, id));
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  await db.delete(schedules).where(eq(schedules.id, id)); // linked sessions are kept
  return Response.json({ ok: true });
}
