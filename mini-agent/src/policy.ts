// One agent codebase, two deployments. The room is path-scoped and gated; the
// host is neither — that is the entire point of sub-project C. Everything else
// (the wire, the reconnect loop, the process-group kill, the output cap) is
// shared, because duplicating shell-ops.ts would mean fixing every future bug
// in it twice.
import type { Roots } from './paths';

export type AgentMode = 'room' | 'host';

export type ExecPolicy =
  | { mode: 'room'; roots: Roots }
  | { mode: 'host'; defaultCwd: string };

export function isRoom(p: ExecPolicy): p is { mode: 'room'; roots: Roots } {
  return p.mode === 'room';
}

export function isHost(p: ExecPolicy): p is { mode: 'host'; defaultCwd: string } {
  return p.mode === 'host';
}
