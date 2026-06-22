import 'server-only';
import { desc, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { dreams, dream_insights } from '@/db/schema';

export interface InsightView {
  id: string;
  category: string;
  title: string;
  detail: string;
  status: string;
}
export interface DreamView {
  id: string;
  createdAt: string;
  coversSince: string;
  status: string;
  insights: InsightView[];
}

const MAX_DREAMS = 30;

export async function getDreams(): Promise<DreamView[]> {
  const dreamRows = await db.select().from(dreams).orderBy(desc(dreams.created_at)).limit(MAX_DREAMS);
  if (dreamRows.length === 0) return [];
  const ids = dreamRows.map((d) => d.id);
  const insightRows = await db.select().from(dream_insights).where(inArray(dream_insights.dream_id, ids));
  const byDream = new Map<string, InsightView[]>();
  for (const i of insightRows) {
    if (!byDream.has(i.dream_id)) byDream.set(i.dream_id, []);
    byDream.get(i.dream_id)!.push({ id: i.id, category: i.category, title: i.title, detail: i.detail, status: i.status });
  }
  return dreamRows.map((d) => ({
    id: d.id,
    createdAt: d.created_at.toISOString(),
    coversSince: d.covers_since.toISOString(),
    status: d.status,
    insights: byDream.get(d.id) ?? [],
  }));
}
