import { verifyCompanionToken } from '@/lib/companion/auth';
import { recordInboxDrop, runRoomTurn } from '@/lib/room-proposals-data';
import { playgroundTurnInstruction } from '@/lib/room-proposals';
import { validateDropBody, type DropBody } from '@/lib/room-event-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Room-only: this endpoint exists because of Task 1/2. The laptop has no
  // doorway and no business posting drops.
  if (!verifyCompanionToken(req.headers.get('x-companion-token'), 'room')) {
    return new Response('Unauthorized', { status: 401 });
  }
  const b = (await req.json().catch(() => null)) as DropBody | null;
  const validated = validateDropBody(b);
  if ('error' in validated) {
    return new Response(validated.error, { status: 400 });
  }
  const drop = validated.drop;

  // The folder carries the permission: inbox asks first, playground acts.
  if (drop.zone === 'inbox') {
    const created = await recordInboxDrop(drop);
    return Response.json({ ok: true, proposed: Boolean(created), id: created?.id ?? null });
  }
  if (drop.zone === 'playground') {
    // Coalesced by path: a file re-saved several times while its turn is
    // still queued/running gets one turn, not one per save.
    runRoomTurn(playgroundTurnInstruction(drop), drop.path);
    return Response.json({ ok: true, acting: true });
  }
  return new Response('unknown zone', { status: 400 });
}
