// Pure parser for the Curator's output → structured insights. Tolerant of a
// fenced ```json block or a bare [...] array embedded in prose. No DB, no
// server-only — unit-testable.

export type InsightCategory = "pattern" | "risk" | "suggestion" | "praise";
export interface Insight {
  category: InsightCategory;
  title: string;
  detail: string;
}

const CATEGORIES = new Set<InsightCategory>(["pattern", "risk", "suggestion", "praise"]);

function extractJsonArray(text: string): unknown {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export function parseInsights(text: string): Insight[] {
  const arr = extractJsonArray(text);
  if (!Array.isArray(arr)) return [];
  const out: Insight[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const { category, title, detail } = item as Record<string, unknown>;
    if (typeof category !== "string" || !CATEGORIES.has(category as InsightCategory)) continue;
    if (typeof title !== "string" || !title.trim()) continue;
    if (typeof detail !== "string" || !detail.trim()) continue;
    out.push({ category: category as InsightCategory, title: title.trim(), detail: detail.trim() });
  }
  return out;
}
