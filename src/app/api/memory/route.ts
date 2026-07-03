import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { verifyPin, createLimiter } from '@/lib/akira/memory/pin';
import { listNotes, vaultReady } from '@/lib/akira/memory/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One limiter per server process — 5 wrong PINs / minute.
const limiter = createLimiter(5, 60_000);

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!limiter.allowed(Date.now())) {
    return Response.json({ error: 'Too many attempts — wait a minute.' }, { status: 429 });
  }
  const { pin } = (await req.json().catch(() => ({}))) as { pin?: string };
  if (!verifyPin(String(pin ?? ''), process.env.AKIRA_MEMORY_PIN ?? '')) {
    limiter.recordFailure(Date.now());
    return Response.json({ error: 'Wrong PIN' }, { status: 401 });
  }
  limiter.recordSuccess();
  if (!vaultReady()) return Response.json({ notes: [] });
  const notes = listNotes().map(({ slug, title, description, type, updated }) => ({
    slug, title, description, type, updated,
  }));
  return Response.json({ notes });
}
