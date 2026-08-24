// Turns the operator's own triage history into a prompt block, so the Curator
// ranks against what he actually keeps rather than its own taste (spec D2).
//
// Pure — no db, no server-only — so it unit-tests. The caller supplies the rows.
//
// Measured before this was written: he had starred 6 insights and dismissed 14,
// out of ~250. The signal is thin but it is the only ground truth there is, and
// it compounds every time he triages.

export interface TriagedInsight {
  category: string;
  title: string;
  detail: string;
}

/** Per side. Without a cap this block grows as triage history accumulates and
 *  would eventually crowd out the transcript it exists to inform. */
export const MAX_EXAMPLES_PER_SIDE = 10;

function bullet(i: TriagedInsight): string {
  return `- [${i.category}] ${i.title} — ${i.detail}`;
}

/**
 * Empty in, empty out: a fresh database must yield the prompt as it was before
 * this feature, not a section with two empty headings.
 */
export function formatTriageExamples(
  starred: TriagedInsight[],
  dismissed: TriagedInsight[],
): string {
  const kept = starred.slice(0, MAX_EXAMPLES_PER_SIDE);
  const binned = dismissed.slice(0, MAX_EXAMPLES_PER_SIDE);
  if (kept.length === 0 && binned.length === 0) return '';

  const parts: string[] = [
    'WHAT THIS OPERATOR ACTUALLY VALUES',
    '',
    'These are his real judgements on past insights. Rank by this, not by your own sense of what is interesting.',
  ];
  if (kept.length > 0) {
    parts.push('', 'He KEPT these (starred):', ...kept.map(bullet));
  }
  if (binned.length > 0) {
    parts.push('', 'He THREW AWAY these (dismissed):', ...binned.map(bullet));
  }
  return parts.join('\n');
}
