import { cookies } from 'next/headers';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
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

const CreateBody = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  instruction: z.string().min(1).max(20_000),
  cadence: CadenceSchema,
});

async function authed(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && !!(await verifySession(token));
}

export async function GET() {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const rows = await db.select().from(schedules).orderBy(desc(schedules.created_at));
  return Response.json({ schedules: rows });
}

export async function POST(req: Request) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 });

  const { projectId, title, instruction, cadence } = parsed.data;
  const now = new Date();
  const id = `sched_${bytesToHex(randomBytes(4))}`;
  await db.insert(schedules).values({
    id,
    project_id: projectId,
    title: title.trim(),
    instruction: instruction.trim(),
    ...cadenceColumns(cadence as Cadence),
    enabled: true,
    next_run_at: computeNextRun(cadence as Cadence, now),
    created_at: now,
    updated_at: now,
  });
  return Response.json({ ok: true, id });
}
