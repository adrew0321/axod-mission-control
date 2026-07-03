import { isOnline } from '@/lib/companion/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Live companion presence for the HUD topbar. This is a ROUTE HANDLER on purpose:
// it shares the in-memory registry with /api/companion/stream (which registers the
// sink), whereas a server component reads a separate module instance and always
// sees offline. The topbar polls this so the "laptop" dot reflects reality.
export async function GET() {
  return Response.json({ online: isOnline() });
}
