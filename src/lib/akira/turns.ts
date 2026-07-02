// Pure mapping from persisted messages to front-door conversation turns.
// No server-only / db imports so it is unit-testable and client-importable.

/** A message row as read from the DB (subset we need). */
export interface MessageRow {
  role: string;
  content: string;
  created_at: Date;
}

/** A turn as rendered in the front-door conversation stream. */
export interface Turn {
  role: 'you' | 'akira';
  content: string;
  at: number;
}

// User messages the HUD injects on the operator's behalf — not real typed input,
// so they must not appear as "you" bubbles in the history.
const SYNTHETIC_PREFIXES = [
  'Brief the operator', // the auto-brief instruction
  'I approved the gated action', // gate-approval continuation
];

/** Strip the attachment wrapper the HUD appends, leaving the real question. */
function unwrapAttachments(content: string): string {
  const i = content.indexOf('\n\n[Attached files');
  return i === -1 ? content : content.slice(0, i);
}

function isSynthetic(content: string): boolean {
  return SYNTHETIC_PREFIXES.some((p) => content.startsWith(p));
}

/**
 * Map DB message rows to render-ready turns: oldest-first, roles normalized to
 * you/akira, synthetic operator messages and blank rows dropped, attachment
 * wrappers stripped. Pure — no I/O.
 */
export function toTurns(rows: MessageRow[]): Turn[] {
  return [...rows]
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
    .flatMap((r): Turn[] => {
      const isUser = r.role === 'user';
      const raw = isUser ? unwrapAttachments(r.content) : r.content;
      const content = raw.trim();
      if (!content) return [];
      if (isUser && isSynthetic(content)) return [];
      return [{ role: isUser ? 'you' : 'akira', content, at: r.created_at.getTime() }];
    });
}
