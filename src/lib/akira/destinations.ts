// Pure registry of web destinations AKIRA may open. No DB, no server-only — the
// allowlist that prevents arbitrary URLs. Add an entry to teach AKIRA a new place.

export interface Destination {
  label: string;
  /** Fixed URL (used when there is no query, or for non-searchable sites). */
  url?: string;
  /** Search template containing the literal `{query}`. */
  search?: string;
  /** Site root, opened when a searchable site is asked for without a query. */
  root?: string;
}

export const DESTINATIONS: Record<string, Destination> = {
  outlook: { label: 'Outlook', url: 'https://outlook.office.com/mail/' },
  gmail: { label: 'Gmail', url: 'https://mail.google.com/' },
  github: { label: 'GitHub', url: 'https://github.com/', search: 'https://github.com/search?q={query}' },
  youtube: { label: 'YouTube', root: 'https://www.youtube.com/', search: 'https://www.youtube.com/results?search_query={query}' },
  'youtube studio': { label: 'YouTube Studio', url: 'https://studio.youtube.com/' },
  google: { label: 'Google', root: 'https://www.google.com/', search: 'https://www.google.com/search?q={query}' },
  amazon: { label: 'Amazon', root: 'https://www.amazon.com/', search: 'https://www.amazon.com/s?k={query}' },
};

/**
 * Resolve a free-text target (and optional query) to a single safe URL, or null
 * if no registry entry matches. Matching is case-insensitive and accepts a key
 * appearing anywhere in the phrase (e.g. "open my Outlook inbox" → outlook).
 */
export function resolveDestination(
  target: string,
  query?: string,
): { url: string; label: string } | null {
  if (!target) return null;
  const t = target.toLowerCase();
  // Prefer the longest matching key so "youtube studio" beats "youtube".
  const key = Object.keys(DESTINATIONS)
    .filter((k) => t.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const d = DESTINATIONS[key];
  const q = query?.trim();
  if (q && d.search) {
    return { url: d.search.replace('{query}', encodeURIComponent(q)), label: d.label };
  }
  const url = d.url ?? d.root;
  return url ? { url, label: d.label } : null;
}
