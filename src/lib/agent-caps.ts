// Pure per-agent execution caps: resolution with defaults, SDK stop-reason
// mapping, and the operator-facing notice for a capped run. No IO, never throws,
// so the tsx test runner can import it directly.

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type StoppedBy = 'max_turns' | 'max_budget';

const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ResolvedCaps {
  effort: EffortLevel;
  maxTurns: number;
  maxBudgetUsd: number;
}

/** Applied when an agent row leaves a cap null. Deliberately conservative:
 *  a new agent gets a safe ceiling until someone tunes its row. */
export const DEFAULT_CAPS: ResolvedCaps = {
  effort: 'medium',
  maxTurns: 20,
  maxBudgetUsd: 3,
};

export interface CapsRow {
  effort?: string | null;
  max_turns?: number | null;
  max_budget_usd?: number | null;
}

const positive = (n: number | null | undefined, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;

/** Resolve an agent row's caps, falling back per-field so a partially-tuned
 *  row keeps the values it does set. */
export function resolveCaps(row: CapsRow | null | undefined): ResolvedCaps {
  const effort = EFFORT_LEVELS.find((e) => e === row?.effort) ?? DEFAULT_CAPS.effort;
  return {
    effort,
    maxTurns: positive(row?.max_turns, DEFAULT_CAPS.maxTurns),
    maxBudgetUsd: positive(row?.max_budget_usd, DEFAULT_CAPS.maxBudgetUsd),
  };
}

/** A cap hit is a *bounded stop*, not a crash — the SDK reports it as an error
 *  subtype, but partial work is real and must reach the operator. Other error
 *  subtypes stay fatal. */
export function stoppedByFromSubtype(subtype: string): StoppedBy | null {
  if (subtype === 'error_max_turns') return 'max_turns';
  if (subtype === 'error_max_budget_usd') return 'max_budget';
  return null;
}

/** The sentence prefixed to a capped specialist's report. Never claim done. */
export function capNotice(agentName: string, stoppedBy: StoppedBy, limit: number): string {
  const cap = stoppedBy === 'max_turns' ? `${limit}-turn cap` : `$${limit} budget guard`;
  return (
    `${agentName} stopped early: hit its ${cap} before finishing the task. ` +
    `Any files it already changed are in the worktree. Partial output follows.`
  );
}
