import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { verifyPin } from '@/lib/akira/memory/pin';
import { pinLimiter } from '@/lib/akira/memory/pin-limiter';
import { listNotes, vaultReady } from '@/lib/akira/memory/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!pinLimiter.allowed(Date.now())) {
    return Response.json({ error: 'Too many attempts — wait a minute.' }, { status: 429 });
  }
  const { pin } = (await req.json().catch(() => ({}))) as { pin?: string };
  if (!verifyPin(String(pin ?? ''), process.env.AKIRA_MEMORY_PIN ?? '')) {
    pinLimiter.recordFailure(Date.now());
    return Response.json({ error: 'Wrong PIN' }, { status: 401 });
  }
  pinLimiter.recordSuccess();
  if (!vaultReady()) return Response.json({ notes: [] });
  const notes = listNotes().map(({ slug, title, description, type, updated }) => ({
    slug, title, description, type, updated,
  }));
  return Response.json({ notes });
}
