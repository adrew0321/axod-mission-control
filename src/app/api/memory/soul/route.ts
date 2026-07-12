import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { verifyPin } from '@/lib/akira/memory/pin';
import { pinLimiter } from '@/lib/akira/memory/pin-limiter';
import { writeSoul, readSoul, DEFAULT_SOUL, readSoulProposal, clearSoulProposal } from '@/lib/akira/memory/soul';
import { gitCommitPush, vaultReady } from '@/lib/akira/memory/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!pinLimiter.allowed(Date.now())) {
    return Response.json({ error: 'Too many attempts — wait a minute.' }, { status: 429 });
  }
  const { pin, soul, reset } = (await req.json().catch(() => ({}))) as
    { pin?: string; soul?: string; reset?: boolean };
  if (!verifyPin(String(pin ?? ''), process.env.AKIRA_MEMORY_PIN ?? '')) {
    pinLimiter.recordFailure(Date.now());
    return Response.json({ error: 'Wrong PIN' }, { status: 401 });
  }
  pinLimiter.recordSuccess();
  if (!vaultReady()) return Response.json({ error: "Memory isn't configured on this server." }, { status: 400 });
  const text = reset ? DEFAULT_SOUL : String(soul ?? '');
  if (!text.trim()) return Response.json({ error: 'Soul cannot be empty.' }, { status: 400 });
  writeSoul(text);
  gitCommitPush('soul: update');
  return Response.json({ ok: true, soul: readSoul() });
}

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!pinLimiter.allowed(Date.now())) {
    return Response.json({ error: 'Too many attempts — wait a minute.' }, { status: 429 });
  }
  const { pin, action } = (await req.json().catch(() => ({}))) as
    { pin?: string; action?: 'approve' | 'reject' };
  if (!verifyPin(String(pin ?? ''), process.env.AKIRA_MEMORY_PIN ?? '')) {
    pinLimiter.recordFailure(Date.now());
    return Response.json({ error: 'Wrong PIN' }, { status: 401 });
  }
  pinLimiter.recordSuccess();
  if (action !== 'approve' && action !== 'reject') {
    return Response.json({ error: 'Invalid action' }, { status: 400 });
  }
  const proposal = readSoulProposal();
  if (!proposal) return Response.json({ error: 'No pending proposal.' }, { status: 404 });
  if (action === 'approve') {
    writeSoul(proposal.text);
    clearSoulProposal();
    gitCommitPush('soul: approved proposal');
    return Response.json({ ok: true, soul: proposal.text });
  }
  clearSoulProposal();
  gitCommitPush('soul: rejected proposal');
  return Response.json({ ok: true });
}
