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

// A dropped file's name AND path are not fully operator-authored (they're
// whatever the source handed us — an extracted archive, a download, or, on
// the ungated playground path, a crafted /api/companion/room-event POST from
// a compromised room). Both feed straight into AKIRA's instruction text via
// inboxTurnInstruction/playgroundTurnInstruction; a newline in either could
// read there as an injected instruction line. Collapse to one line wherever
// either value reaches an instruction — not just the (already-sanitized)
// summary, and not just `name` — `path` carries the same risk.
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Filename, type, size, and a condensed first look. Bounded on purpose. */
export function summarizeDrop(d: { name: string; ext: string; sizeBytes: number; head: string }): string {
  const kind = d.ext ? d.ext.toLowerCase() : 'file';
  const safeName = oneLine(d.name);
  const lead = `${safeName} · ${kind} · ${formatBytes(d.sizeBytes)}`;
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
  const safePath = oneLine(p.path);
  return [
    `A'Keem approved an item in your inbox: ${safePath}`,
    ``,
    `First look: ${p.summary}`,
    ``,
    `Work on it now with your room tools. Read it (convert it first with room_bash if it isn't plain text),`,
    `do what it plainly asks for, and write your result back into the doorway so he can open it.`,
    `Tell him in a few sentences what you did and where the result is.`,
  ].join('\n');
}

/** Playground drops are hers to act on directly — the folder carries the permission.
 *  UNGATED: this instruction runs with no approval step, so `name` and `path`
 *  get the same one-line collapse the (approval-gated) inbox path gets via
 *  summarizeDrop — the risk is the same, and this is the path with no human
 *  in front of it to notice something odd before it's acted on. */
export function playgroundTurnInstruction(d: { name: string; path: string; head: string }): string {
  const safeName = oneLine(d.name);
  const safePath = oneLine(d.path);
  return [
    `A'Keem dropped ${safeName} into your playground: ${safePath}`,
    ``,
    `The playground is yours to work in directly — he is not waiting to be asked.`,
    `Take a look and do the obvious useful thing with it, then tell him briefly what you did.`,
  ].join('\n');
}
