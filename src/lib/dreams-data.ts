import 'server-only';
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { dreams, dream_insights } from '@/db/schema';
import type { TriagedInsight } from '@/lib/dream-calibration';

export interface InsightView {
  id: string;
  category: string;
  title: string;
  detail: string;
  status: string;
  /** 1 = most useful. NULL on insights that predate calibrated ranking. */
  rank: number | null;
}
export interface DreamView {
  id: string;
  createdAt: string;
  coversSince: string;
  status: string;
  insights: InsightView[];
}

const MAX_DREAMS = 30;

/** The operator's own triage signal, newest first, for calibrating the Curator.
 *  Starred and dismissed are read separately so the prompt can label them. */
export async function readTriagedInsights(
  limit = 10,
): Promise<{ starred: TriagedInsight[]; dismissed: TriagedInsight[] }> {
  const pick = async (status: 'starred' | 'dismissed'): Promise<TriagedInsight[]> => {
    const rows = await db
      .select({ category: dream_insights.category, title: dream_insights.title, detail: dream_insights.detail })
      .from(dream_insights)
      .where(eq(dream_insights.status, status))
      .orderBy(desc(dream_insights.created_at))
      .limit(limit);
    return rows.map((r) => ({ category: r.category, title: r.title, detail: r.detail }));
  };
  return { starred: await pick('starred'), dismissed: await pick('dismissed') };
}

export async function getDreams(): Promise<DreamView[]> {
  const dreamRows = await db.select().from(dreams).orderBy(desc(dreams.created_at)).limit(MAX_DREAMS);
  if (dreamRows.length === 0) return [];
  const ids = dreamRows.map((d) => d.id);
  const insightRows = await db.select().from(dream_insights).where(inArray(dream_insights.dream_id, ids));
  const byDream = new Map<string, InsightView[]>();
  for (const i of insightRows) {
    if (!byDream.has(i.dream_id)) byDream.set(i.dream_id, []);
    byDream.get(i.dream_id)!.push({ id: i.id, category: i.category, title: i.title, detail: i.detail, status: i.status, rank: i.rank });
  }
  for (const list of byDream.values()) {
    // Nulls last: pre-calibration insights keep their existing relative order
    // beneath the ranked ones (spec D5 leaves the backlog alone).
    list.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  }
  return dreamRows.map((d) => ({
    id: d.id,
    createdAt: d.created_at.toISOString(),
    coversSince: d.covers_since.toISOString(),
    status: d.status,
    insights: byDream.get(d.id) ?? [],
  }));
}
