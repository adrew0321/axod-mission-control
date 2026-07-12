// Pure planner: turn a distilled lesson set into the note ops needed to make the vault
// match it. Matches by slug (safeSlug of the title). Safety floor: an empty distilled set
// against a non-empty current set is treated as a no-op — a bad parse can never wipe all
// lessons.
import { safeSlug } from './memory/note';
import type { DistilledLesson } from './reflect-parse';

export interface LessonNote { slug: string; title: string; description: string; body: string }
export interface LessonOps { deletes: string[]; writes: DistilledLesson[] }

export function planLessonReplace(current: LessonNote[], distilled: DistilledLesson[]): LessonOps | null {
  if (distilled.length === 0 && current.length > 0) return null; // safety floor

  const distilledSlugs = new Set(distilled.map((d) => safeSlug(d.title) ?? ''));
  const currentBySlug = new Map(current.map((c) => [c.slug, c]));

  const deletes = current.filter((c) => !distilledSlugs.has(c.slug)).map((c) => c.slug);
  const writes = distilled.filter((d) => {
    const c = currentBySlug.get(safeSlug(d.title) ?? '');
    return !c || c.title !== d.title || c.description !== d.description || c.body.trim() !== d.body.trim();
  });

  if (deletes.length === 0 && writes.length === 0) return null; // already equivalent
  return { deletes, writes };
}
