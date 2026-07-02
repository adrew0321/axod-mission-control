// Lightweight reply formatter for AKIRA's HUD. Pure — no deps. `parseReply`
// turns her text into paragraph/list blocks with inline bold + links for the
// renderer; `stripMarkdown` produces clean text for the spoken (TTS) path.

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'link'; label: string; url: string };

export type Block =
  | { type: 'paragraph'; spans: Inline[] }
  | { type: 'list'; items: Inline[][] };

const INLINE_RE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
const BULLET_RE = /^\s*[-*]\s+/;

/** Split a run of text into inline spans (plain / **bold** / [label](url)). */
function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(s))) {
    if (m.index > last) out.push({ type: 'text', value: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: 'bold', value: m[1] });
    else out.push({ type: 'link', label: m[2], url: m[3] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ type: 'text', value: s.slice(last) });
  return out.length ? out : [{ type: 'text', value: '' }];
}

/** Parse a reply into blocks: blank lines separate blocks; all-bullet blocks become lists. */
export function parseReply(text: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of text.trim().split(/\n\s*\n/)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const nonEmpty = lines.filter((l) => l.trim() !== '');
    const allBullets = nonEmpty.length > 0 && nonEmpty.every((l) => BULLET_RE.test(l));
    if (allBullets) {
      blocks.push({ type: 'list', items: nonEmpty.map((l) => parseInline(l.replace(BULLET_RE, ''))) });
    } else {
      blocks.push({ type: 'paragraph', spans: parseInline(chunk) });
    }
  }
  return blocks;
}

/**
 * True when a reply is substantial enough to read better left-aligned than
 * centered: more than one block, any bullet list, or a long single paragraph.
 */
export function isLongReply(text: string): boolean {
  const blocks = parseReply(text);
  if (blocks.length > 1) return true;
  if (blocks.some((b) => b.type === 'list')) return true;
  return text.trim().length > 220;
}

/** Flatten markdown to plain text for the voice path (no symbols spoken aloud). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(BULLET_RE, '')
    .replace(/\n\s*[-*]\s+/g, '\n')
    .trim();
}
