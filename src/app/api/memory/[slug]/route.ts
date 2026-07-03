import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { verifyPin } from '@/lib/akira/memory/pin';
import { deleteNote, gitCommitPush, vaultReady } from '@/lib/akira/memory/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { pin } = (await req.json().catch(() => ({}))) as { pin?: string };
  if (!verifyPin(String(pin ?? ''), process.env.AKIRA_MEMORY_PIN ?? '')) {
    return Response.json({ error: 'Wrong PIN' }, { status: 401 });
  }
  const { slug } = await params;
  if (!vaultReady() || !deleteNote(slug)) {
    return Response.json({ error: 'No such note' }, { status: 404 });
  }
  gitCommitPush(`forget: ${slug}`);
  return Response.json({ ok: true });
}
