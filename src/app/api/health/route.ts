import { db } from '@/db/client';
import { sql } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const startedAt = Date.now();
  let dbStatus: 'ok' | 'error' = 'ok';
  let dbError: string | undefined;
  try {
    await db.run(sql`select 1`);
  } catch (err) {
    dbStatus = 'error';
    dbError = err instanceof Error ? err.message : String(err);
  }

  const body = {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    db: dbStatus,
    ...(dbError ? { dbError } : {}),
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
    version: '1.10.4',
  };

  return Response.json(body, { status: dbStatus === 'ok' ? 200 : 503 });
}
