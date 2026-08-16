// In-memory broker for operator gate decisions, in the shape of registry.ts.
// The laptop companion parks its gated clicks locally (gate-queue.ts + its
// Electron HUD); the room has no local HUD, so a gated room command parks here
// while the front-door HUD asks, and the tool awaiting `decision` gets the real
// answer — and then the real command output — inside the same turn.
//
// The COMMAND is stored server-side against a minted id, so the browser only
// ever says approve/deny. It never gets to choose what runs.
// Pure promise/map logic — no db, no server-only, unit-tested.
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { CompanionTarget } from './registry';

export type GateDecision = 'approved' | 'denied';

export interface GateEntry {
  id: string;
  target: CompanionTarget;
  reason: string;
  command: string;
  openedAt: number;
}

/** Silence is not consent: an un-actioned gate auto-denies. Matches the laptop
 *  companion's GATE_TIMEOUT_MS. */
export const GATE_TIMEOUT_MS = 120_000;

const gates = new Map<
  string,
  { entry: GateEntry; settle: (d: GateDecision) => void; timer: ReturnType<typeof setTimeout> }
>();

export function openGate(
  input: { target: CompanionTarget; reason: string; command: string },
  timeoutMs = GATE_TIMEOUT_MS,
): { id: string; decision: Promise<GateDecision> } {
  const id = `gate_${bytesToHex(randomBytes(6))}`;
  const entry: GateEntry = { id, ...input, openedAt: Date.now() };
  const decision = new Promise<GateDecision>((resolve) => {
    const timer = setTimeout(() => {
      gates.delete(id);
      resolve('denied');
    }, timeoutMs);
    gates.set(id, { entry, settle: resolve, timer });
  });
  return { id, decision };
}

/** Settle a gate. False if it is unknown or already settled. */
export function decideGate(id: string, d: GateDecision): boolean {
  const g = gates.get(id);
  if (!g) return false;
  clearTimeout(g.timer);
  gates.delete(id);
  g.settle(d);
  return true;
}

export function getGate(id: string): GateEntry | undefined {
  return gates.get(id)?.entry;
}

export function pendingGateCount(): number {
  return gates.size;
}
