// Lightweight reply formatter for AKIRA's HUD. Pure — no deps. `parseReply`
// turns her text into paragraph/list/code blocks with inline bold, code, and
// links for the renderer; `stripMarkdown` produces clean text for the TTS path.

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; label: string; url: string };

export type Block =
  | { type: 'paragraph'; spans: Inline[] }
  | { type: 'list'; items: Inline[][] }
  | { type: 'code'; value: string };

const INLINE_RE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`/g;
const BULLET_RE = /^\s*[-*]\s+/;
const FENCE_RE = /^\s*```/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;

/** Split a run of text into inline spans (plain / **bold** / `code` / [label](url)). */
function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(s))) {
    if (m.index > last) out.push({ type: 'text', value: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: 'bold', value: m[1] });
    else if (m[2] !== undefined) out.push({ type: 'link', label: m[2], url: m[3] });
    else out.push({ type: 'code', value: m[4] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ type: 'text', value: s.slice(last) });
  return out.length ? out : [{ type: 'text', value: '' }];
}

/** Parse a fence-free run into paragraph + bullet-list blocks. */
function parseProse(text: string): Block[] {
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
 * Parse a reply into blocks. Fenced ``` code blocks are pulled out first (they
 * may span blank lines); everything else is paragraph/list prose. Pure — no I/O.
 */
export function parseReply(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let buf: string[] = [];
  const flush = () => {
    const chunk = buf.join('\n');
    buf = [];
    if (chunk.trim()) blocks.push(...parseProse(chunk));
  };
  let i = 0;
  while (i < lines.length) {
    if (FENCE_RE.test(lines[i])) {
      flush();
      i++; // consume opening fence (```lang and all)
      const code: string[] = [];
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      blocks.push({ type: 'code', value: code.join('\n') });
    } else {
      buf.push(lines[i]);
      i++;
    }
  }
  flush();
  return blocks;
}

/**
 * True when a reply reads better left-aligned than centered: more than one
 * block, any list/code block, or a long single paragraph.
 */
export function isLongReply(text: string): boolean {
  const blocks = parseReply(text);
  if (blocks.length > 1) return true;
  if (blocks.some((b) => b.type === 'list' || b.type === 'code')) return true;
  return text.trim().length > 220;
}

/** Flatten markdown to plain text for the voice path (no symbols spoken aloud). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[^\n]*/g, '') // fence markers (``` and ```lang)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(BULLET_RE, '')
    .replace(/\n\s*[-*]\s+/g, '\n')
    .trim();
}
