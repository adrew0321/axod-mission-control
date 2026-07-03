// Pure note model for AKIRA's memory vault. Flat frontmatter (title/description/
// type/created/updated) + Markdown body. No I/O — unit-tested.

export interface Note {
  slug: string;
  title: string;
  description: string;
  type: string; // fact | preference | project | decision | reference (tolerant)
  created: string; // ISO
  updated: string; // ISO
  body: string;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** A slug safe as a single filename inside the vault (no slashes/dots survive). */
export function safeSlug(s: string): string | null {
  const x = slugify(s);
  return x.length ? x : null;
}

export function serializeNote(n: Note): string {
  return [
    '---',
    `title: ${n.title}`,
    `description: ${n.description}`,
    `type: ${n.type}`,
    `created: ${n.created}`,
    `updated: ${n.updated}`,
    '---',
    n.body,
  ].join('\n');
}

export function parseNote(slug: string, md: string): Note {
  const lines = md.split('\n');
  const fm: Record<string, string> = {};
  let body = md;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) {
      for (const line of lines.slice(1, close)) {
        const i = line.indexOf(':');
        if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      body = lines.slice(close + 1).join('\n');
    }
  }
  return {
    slug,
    title: fm.title ?? slug,
    description: fm.description ?? '',
    type: fm.type ?? 'fact',
    created: fm.created ?? '',
    updated: fm.updated ?? '',
    body,
  };
}

export function buildIndex(notes: Note[]): string {
  return [...notes]
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0))
    .map((n) => `- [[${n.slug}]] — ${n.description}`)
    .join('\n');
}
