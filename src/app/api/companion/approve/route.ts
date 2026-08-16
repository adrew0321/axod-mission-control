import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { sendCommand, isOnline } from '@/lib/companion/registry';
import { decideGate } from '@/lib/companion/gates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    ref?: string;
    gateId?: string;
    decision?: 'approved' | 'denied';
  };

  // Room gate: the command itself lives server-side against this id — the client
  // only decides. The tool awaiting the decision resumes and reports the output.
  if (body.gateId) {
    const settled = decideGate(body.gateId, body.decision === 'denied' ? 'denied' : 'approved');
    return Response.json({ ok: settled, expired: !settled });
  }

  // Laptop browser gate: unchanged.
  if (!isOnline()) return Response.json({ error: 'companion offline' }, { status: 409 });
  if (!body.ref) return Response.json({ error: 'ref required' }, { status: 400 });

  try {
    const { result } = sendCommand({ action: 'click', ref: body.ref, approved: true });
    const r = await result;
    return Response.json({ ok: r.status === 'ok', status: r.status, text: r.text ?? r.reason ?? '' });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
