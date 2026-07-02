// Pure hold-queue for hard-gated commands awaiting the operator's decision.
// No I/O — the async wiring (awaiting a decision) lives in index.ts.

export interface PendingGate {
  id: string;        // the Command.id being held
  reason: string;    // human reason from classifyClick
  target: string;    // element ref or url the click targets
  host: string;      // page host, best-effort ('' if unknown)
  requestedAt: number;
}

export function createGateQueue() {
  let items: PendingGate[] = [];
  return {
    enqueue(g: PendingGate): void {
      items.push(g);
    },
    list(): PendingGate[] {
      return items.slice();
    },
    remove(id: string): PendingGate | undefined {
      const i = items.findIndex((x) => x.id === id);
      return i === -1 ? undefined : items.splice(i, 1)[0];
    },
    expired(now: number, timeoutMs: number): PendingGate[] {
      return items.filter((x) => now - x.requestedAt >= timeoutMs);
    },
    clear(): PendingGate[] {
      const all = items;
      items = [];
      return all;
    },
  };
}
