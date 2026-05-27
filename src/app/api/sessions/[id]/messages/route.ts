import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { messages, sessions } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';

export const runtime = 'nodejs';

const Body = z.object({
  content: z.string().min(1).max(20_000),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: sessionId } = await ctx.params;

  const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).then((r) => r[0]);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid message body' }, { status: 400 });
  }

  const now = new Date();
  const id = `msg_${bytesToHex(randomBytes(8))}`;
  await db.insert(messages).values({
    id,
    session_id: sessionId,
    agent_id: null,
    role: 'user',
    content: parsed.data.content,
    created_at: now,
  });
  await db.update(sessions).set({ updated_at: now }).where(eq(sessions.id, sessionId));

  return Response.json({
    id,
    session_id: sessionId,
    role: 'user',
    content: parsed.data.content,
    created_at: now.toISOString(),
  });
}
