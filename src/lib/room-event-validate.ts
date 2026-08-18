// Pure request-body validation for POST /api/companion/room-event, kept
// separate from the route handler (which transitively imports 'server-only'
// via room-proposals-data.ts, and so cannot be exercised directly by
// node:test — see room-shell.ts for the same split, for the same reason).
//
// This route trusts the room's TOKEN, not the room's JUDGMENT: `name` and
// `path` feed straight into AKIRA's instruction text (room-proposals.ts —
// inboxTurnInstruction/playgroundTurnInstruction), so a compromised or
// merely buggy room agent must not be able to smuggle control characters
// through, or write unbounded strings into the database. The room agent
// already truncates `head` at MAX_HEAD_CHARS (room-agent/src/doorway.ts) —
// this is the server independently enforcing the same bound rather than
// trusting the client actually did.

export const MAX_NAME_CHARS = 500;
export const MAX_PATH_CHARS = 4096;
export const MAX_HEAD_CHARS = 800;

export interface DropBody {
  zone?: string;
  name?: string;
  path?: string;
  sizeBytes?: number;
  ext?: string;
  head?: string;
}

export interface ValidDrop {
  zone?: string;
  name: string;
  path: string;
  sizeBytes: number;
  ext: string;
  head: string;
}

/** True iff `s` contains any C0 control byte or DEL — not just newlines. A
 *  legitimate filename or absolute path never needs one. */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Validate and clamp a raw drop body. Returns an error message to send back
 *  as a 400, or the sanitized drop ready for recordInboxDrop/runRoomTurn. */
export function validateDropBody(b: DropBody | null): { error: string } | { drop: ValidDrop } {
  if (!b || !b.path || !b.name || typeof b.sizeBytes !== 'number') {
    return { error: 'bad drop' };
  }
  if (hasControlChars(b.name) || hasControlChars(b.path)) {
    return { error: 'control characters in name or path' };
  }
  if (b.name.length > MAX_NAME_CHARS || b.path.length > MAX_PATH_CHARS) {
    return { error: 'name or path too long' };
  }
  return {
    drop: {
      zone: b.zone,
      name: b.name,
      path: b.path,
      sizeBytes: b.sizeBytes,
      ext: b.ext ?? '',
      head: (b.head ?? '').slice(0, MAX_HEAD_CHARS),
    },
  };
}
