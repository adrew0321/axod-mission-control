// Small pure UI helpers (no DOM/DB). Unit-tested.

const TREE_MIN = 160;
const TREE_MAX = 560;
export const TREE_DEFAULT = 260;

/** Clamp a desired file-tree width to the allowed range; NaN → the default. */
export function clampTreeWidth(px: number): number {
  if (Number.isNaN(px)) return TREE_DEFAULT;
  return Math.max(TREE_MIN, Math.min(TREE_MAX, px));
}

/**
 * The project that should become active after removing `removedId`. If the removed
 * project was the active one, pick the first remaining project (id ≠ removedId);
 * otherwise keep the current active id. Returns undefined if nothing remains.
 */
export function nextActiveProjectId(
  projects: { id: string }[],
  removedId: string,
  currentActiveId: string | undefined,
): string | undefined {
  if (currentActiveId !== removedId) return currentActiveId;
  return projects.find((p) => p.id !== removedId)?.id;
}
