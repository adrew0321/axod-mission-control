// Pure token-usage aggregation. No IO, never throws — the tsx test runner
// imports it directly, and both the dashboard and AKIRA's fleet snapshot read
// through it so they can never disagree about the arithmetic.

export interface UsageRow {
  agentId: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
}

export interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** Every row considered. */
  messageCount: number;
  /** Rows carrying at least one non-null usage field. Distinguishes "used zero
   *  tokens" from "predates the instrumentation" — the UI shows a dash, not 0,
   *  when this is zero. */
  recordedCount: number;
}

export function emptyTotals(): UsageTotals {
  return {
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    messageCount: 0,
    recordedCount: 0,
  };
}

const num = (n: number | null): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

const isRecorded = (r: UsageRow): boolean =>
  [r.tokensIn, r.tokensOut, r.cacheReadTokens, r.cacheCreationTokens, r.costUsd].some(
    (v) => typeof v === 'number' && Number.isFinite(v),
  );

export function rollUpUsage(rows: UsageRow[]): UsageTotals {
  const t = emptyTotals();
  for (const r of rows) {
    t.tokensIn += num(r.tokensIn);
    t.tokensOut += num(r.tokensOut);
    t.cacheReadTokens += num(r.cacheReadTokens);
    t.cacheCreationTokens += num(r.cacheCreationTokens);
    t.costUsd += num(r.costUsd);
    t.messageCount += 1;
    if (isRecorded(r)) t.recordedCount += 1;
  }
  return t;
}

export function rollUpByAgent(rows: UsageRow[]): Record<string, UsageTotals> {
  const out: Record<string, UsageRow[]> = {};
  for (const r of rows) {
    const key = r.agentId ?? 'unknown';
    (out[key] ??= []).push(r);
  }
  return Object.fromEntries(Object.entries(out).map(([k, rs]) => [k, rollUpUsage(rs)]));
}
