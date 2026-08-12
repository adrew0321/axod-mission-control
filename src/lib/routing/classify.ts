// Pure keyword classifier — no server-only, no DB, no Node built-ins.
// Importable from both server and client code.
// kw-v1: ~30 keyword rules → category, 60–70 % accuracy expected.

export type TaskCategory = 'research' | 'implement' | 'review' | 'design' | 'devops';
export type ClassifierVersion = 'kw-v1' | 'llm-haiku-v1' | 'hybrid-v1';

export interface Classification {
  category: TaskCategory;
  confidence: number;             // 0..1
  classifierVersion: ClassifierVersion;
  keywords: string[];             // which keywords matched, lowercased
}

// ---------------------------------------------------------------------------
// Keyword tables
// ---------------------------------------------------------------------------
// 'build'  is absent here — see ambiguity rule 1 below.
// 'test'   is absent here — see ambiguity rule 2 below.
// 'check'  is absent here — see ambiguity rule 3 below.

const BASE_KEYWORDS: Record<TaskCategory, readonly string[]> = {
  research:  ['research', 'investigate', 'audit', 'study', 'explore', 'analyze',
               'survey', 'find out', 'look into', 'assess', 'evaluate'],
  implement: ['implement', 'fix', 'refactor', 'add', 'create', 'write', 'code',
               'feature'],
  review:    ['review', 'verdict', 'critique', 'qa', 'feedback', 'approve',
               'pass/fail'],
  design:    ['design', 'mockup', 'ui', 'component', 'layout', 'style', 'visual',
               'prototype', 'wireframe'],
  devops:    ['deploy', 'ci', 'lint', 'release', 'push', 'commit', 'migrate',
               'git', 'pipeline'],
};

// Ambiguity rule 1 — 'build' appears in both implement and devops.
// When any of these devops-specific co-tokens is also present in the instruction,
// 'build' is treated as a devops signal (e.g. "build and deploy → devops").
// Without them, 'build' signals implementation work (e.g. "build the API → implement").
const BUILD_DEVOPS_TRIGGERS = new Set([
  'deploy', 'ci', 'lint', 'release', 'pipeline', 'migrate', 'commit', 'push',
]);

// Ambiguity rule 2 — 'test' is only a devops signal when it co-occurs with another
// devops context token. A phrase like "investigate the flakey login test" should
// resolve to research, not devops. 'run' is included as a co-trigger even though it
// is not a keyword on its own.
const TEST_CO_TRIGGERS = new Set([
  'ci', 'lint', 'pipeline', 'deploy', 'release', 'run',
]);

// Tie-break priority: when two categories have the same matched-keyword count,
// the category that appears earliest in this list wins.
// Rationale: implementation-heavy tasks are the most common Sage routing target.
const TIE_PRIORITY: readonly TaskCategory[] = [
  'implement', 'review', 'research', 'devops', 'design',
];

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/** Escape every regex special character in a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return true if `keyword` (already lowercased) appears as a whole-word match
 * inside `text` (already lowercased and whitespace-normalised).
 *
 * Single-token keywords (no spaces, no slashes) use `\b…\b` word boundaries.
 * Multi-token / slash-delimited keywords ('find out', 'look into', 'pass/fail')
 * use a non-word char (or string edge) on each side, because `\b` cannot span
 * whitespace and JS treats `/` as a word-boundary character.
 */
function matchKeyword(text: string, keyword: string): boolean {
  const escaped = escapeRegex(keyword);
  if (/[\s/]/.test(keyword)) {
    return new RegExp('(?:^|\\W)' + escaped + '(?:\\W|$)').test(text);
  }
  return new RegExp('\\b' + escaped + '\\b').test(text);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Rule-based: ~30 keyword rules → category. 60–70 % accuracy expected. */
export function classifyKeyword(instruction: string): Classification {
  // Normalise: lowercase and collapse internal whitespace.
  const text = instruction.toLowerCase().replace(/\s+/g, ' ').trim();

  // Per-category hit sets — Set gives free deduplication (a keyword that
  // appears twice in the instruction still counts once).
  const hits: Record<TaskCategory, Set<string>> = {
    research:  new Set(),
    implement: new Set(),
    review:    new Set(),
    design:    new Set(),
    devops:    new Set(),
  };

  // Pass 1: base keyword matching (build / test / check handled separately).
  for (const cat of Object.keys(BASE_KEYWORDS) as TaskCategory[]) {
    for (const kw of BASE_KEYWORDS[cat]) {
      if (matchKeyword(text, kw)) {
        hits[cat].add(kw);
      }
    }
  }

  // Ambiguity rule 1: resolve 'build'.
  // 'build' is listed as both an implement and a devops keyword.
  // Presence of a devops-specific co-token tips the balance to devops;
  // otherwise 'build' counts as an implementation signal.
  if (matchKeyword(text, 'build')) {
    // Check for devops co-tokens regardless of whether they already scored a
    // category hit — we want the co-occurrence signal, not the score.
    const buildIsDevops = [...BUILD_DEVOPS_TRIGGERS].some(t => matchKeyword(text, t));
    if (buildIsDevops) {
      hits.devops.add('build');
    } else {
      hits.implement.add('build');
    }
  }

  // Ambiguity rule 2: resolve 'test'.
  // 'test' alone is not a reliable devops signal — a "flakey login test" in a
  // research instruction would incorrectly fire devops if counted blindly.
  // Only promote 'test' to devops when at least one devops context token
  // (ci, lint, pipeline, deploy, release, run) also appears.
  if (matchKeyword(text, 'test')) {
    const testIsDevops = [...TEST_CO_TRIGGERS].some(t => matchKeyword(text, t));
    if (testIsDevops) {
      hits.devops.add('test');
    }
    // else: 'test' is intentionally ignored — not a devops signal without context
  }

  // Ambiguity rule 3: resolve 'check'.
  // 'check' is a weak review signal. Count it only when no other category
  // (research, implement, design, devops) has any keyword matches — i.e. it
  // must not swing the result toward review when stronger evidence exists
  // elsewhere.
  if (matchKeyword(text, 'check')) {
    const otherCatsHaveHits = (
      ['research', 'implement', 'design', 'devops'] as TaskCategory[]
    ).some(cat => hits[cat].size > 0);
    if (!otherCatsHaveHits) {
      hits.review.add('check');
    }
  }

  // Tally scores.
  const counts: Record<TaskCategory, number> = {
    research:  hits.research.size,
    implement: hits.implement.size,
    review:    hits.review.size,
    design:    hits.design.size,
    devops:    hits.devops.size,
  };

  const maxCount = Math.max(
    counts.research, counts.implement, counts.review,
    counts.design,   counts.devops,
  );

  // No keywords matched at all → implement is the safest default because
  // Sage most commonly routes work to Atlas (the implementation specialist).
  if (maxCount === 0) {
    return {
      category:          'implement',
      confidence:         0.0,
      classifierVersion: 'kw-v1',
      keywords:          [],
    };
  }

  // Pick winner; ties broken by TIE_PRIORITY order.
  let winner: TaskCategory = TIE_PRIORITY[0];
  for (const cat of TIE_PRIORITY) {
    if (counts[cat] === maxCount) {
      winner = cat;
      break;
    }
  }

  // Confidence: full confidence at ≥ 3 keyword hits, partial below.
  const confidence = Math.min(1.0, counts[winner] / 3);

  return {
    category:          winner,
    confidence,
    classifierVersion: 'kw-v1',
    keywords:          [...hits[winner]],
  };
}
