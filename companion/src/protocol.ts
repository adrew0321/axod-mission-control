// Shared wire types for the AKIRA Local Companion. Pure — no deps. The companion
// package has a byte-identical copy at companion/src/protocol.ts.

export type CommandAction = 'navigate' | 'read' | 'type' | 'click' | 'wait';

export interface Command {
  id: string;
  action: CommandAction;
  url?: string;
  ref?: string;
  text?: string;
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
