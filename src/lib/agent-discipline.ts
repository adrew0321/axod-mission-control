// Shared "do it, don't narrate it" discipline appended to EVERY agent's system
// prompt in the single place all agent turns funnel through (runClaudeAgent in
// agent-runner-sdk). This fixes the narrate-vs-do failure: an agent — Sage or any
// specialist it dispatches — claiming it did something (dispatched, edited, ran,
// reviewed, shipped) without actually firing the tool that does it. Applying it at
// the runner means it covers Sage and every current/future specialist uniformly,
// with no per-agent prompt edits to miss. Pure (no server-only) so it's unit-tested.

export const EXECUTION_DISCIPLINE = `## Execution discipline (always)
Take actions by calling tools, never by describing them. Do NOT say you have dispatched an agent, edited a file, run a command, opened or finished a review, committed, or completed a task unless you actually invoked the tool that does it in THIS turn. A sentence like "dispatching now" or "firing it" is words, not an action. Do the thing first with the tool, then report the result. If you mean to act, act in the same turn rather than promising it for later; if you genuinely cannot finish now, say plainly that it is NOT done and why — never narrate an action as if it happened.`;

/** Append the shared execution discipline to an agent's system prompt. Returns
 *  the prompt unchanged (incl. undefined) when there is none, so the SDK's own
 *  default is not clobbered. */
export function withExecutionDiscipline(systemPrompt: string | undefined): string | undefined {
  return systemPrompt ? `${systemPrompt}\n\n${EXECUTION_DISCIPLINE}` : systemPrompt;
}
