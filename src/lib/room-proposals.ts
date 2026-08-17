// Pure shaping for doorway drops — no db, no server-only, so the tsx test runner
// can import it (same split as proposals.ts / proposals-data.ts).
//
// Decision 9: a non-code artifact is reviewed as a short text summary plus a
// path. Opening it is an ordinary file read; there is no rendered preview.

export interface RoomProposal {
  id: string;
  zone: 'inbox';
  name: string;
  path: string;
  sizeBytes: number;
  ext: string | null;
  head: string | null;
  summary: string;
  status: 'open' | 'approved' | 'dismissed';
  createdAt: string; // ISO
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_SUMMARY = 280;

/** Filename, type, size, and a condensed first look. Bounded on purpose. */
export function summarizeDrop(d: { name: string; ext: string; sizeBytes: number; head: string }): string {
  const kind = d.ext ? d.ext.toLowerCase() : 'file';
  const lead = `${d.name} · ${kind} · ${formatBytes(d.sizeBytes)}`;
  const body = (d.head ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
  const out = body ? `${lead} — ${body}` : lead;
  return out.length > MAX_SUMMARY ? out.slice(0, MAX_SUMMARY - 1).trimEnd() + '…' : out;
}

/** The instruction for the full-cost turn, which runs only AFTER approval. */
export function inboxTurnInstruction(p: { name: string; path: string; summary: string }): string {
  return [
    `A'Keem approved an item in your inbox: ${p.path}`,
    ``,
    `First look: ${p.summary}`,
    ``,
    `Work on it now with your room tools. Read it (convert it first with room_bash if it isn't plain text),`,
    `do what it plainly asks for, and write your result back into the doorway so he can open it.`,
    `Tell him in a few sentences what you did and where the result is.`,
  ].join('\n');
}

/** Playground drops are hers to act on directly — the folder carries the permission. */
export function playgroundTurnInstruction(d: { name: string; path: string; head: string }): string {
  return [
    `A'Keem dropped ${d.name} into your playground: ${d.path}`,
    ``,
    `The playground is yours to work in directly — he is not waiting to be asked.`,
    `Take a look and do the obvious useful thing with it, then tell him briefly what you did.`,
  ].join('\n');
}
