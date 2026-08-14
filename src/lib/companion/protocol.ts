// Shared wire types for the AKIRA Local Companion and the room agent. Pure — no deps.
// THREE byte-identical copies exist: src/lib/companion/protocol.ts,
// companion/src/protocol.ts, room-agent/src/protocol.ts.
// protocol-copies.test.ts enforces that they stay identical.

export type CommandAction =
  | 'navigate'
  | 'read'
  | 'type'
  | 'click'
  | 'wait'
  | 'fs_list'
  | 'fs_read'
  | 'fs_write';

export interface Command {
  id: string;
  action: CommandAction;
  url?: string;
  ref?: string;
  text?: string;
  /** fs_* actions: path relative to the room root, or absolute inside the doorway. */
  path?: string;
  /** fs_write: the bytes to write, UTF-8. */
  content?: string;
  /** Set true only after the operator explicitly approved a hard-gated action. */
  approved?: boolean;
}

export interface RawEl {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  type?: string;
  href?: string;
}

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  elements: RawEl[];
}

export type ResultStatus = 'ok' | 'error' | 'blocked';

export interface Result {
  id: string;
  status: ResultStatus;
  snapshot?: Snapshot;
  text?: string;
  reason?: string;
}
