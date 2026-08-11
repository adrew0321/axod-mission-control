import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKeyword } from './classify';

// ---------------------------------------------------------------------------
// 1. Basic category routing
// ---------------------------------------------------------------------------

test('research: investigate the login bug', () => {
  const c = classifyKeyword('investigate the login bug');
  assert.equal(c.category, 'research');
  assert.equal(c.classifierVersion, 'kw-v1');
  assert.ok(c.keywords.includes('investigate'), 'expected "investigate" in keywords');
});

test('implement: implement the new dashboard', () => {
  const c = classifyKeyword('implement the new dashboard');
  assert.equal(c.category, 'implement');
  assert.ok(c.keywords.includes('implement'));
});

test("review: review Atlas's PR", () => {
  const c = classifyKeyword("review Atlas's PR");
  assert.equal(c.category, 'review');
  assert.ok(c.keywords.includes('review'));
});

test('design: design a mockup for the settings page', () => {
  const c = classifyKeyword('design a mockup for the settings page');
  assert.equal(c.category, 'design');
  // both 'design' and 'mockup' should be in keywords
  assert.ok(c.keywords.includes('design'));
  assert.ok(c.keywords.includes('mockup'));
});

test('devops: deploy v1.18 to production', () => {
  const c = classifyKeyword('deploy v1.18 to production');
  assert.equal(c.category, 'devops');
  assert.ok(c.keywords.includes('deploy'));
});

// ---------------------------------------------------------------------------
// 2. Ambiguity rule 1: 'build'
// ---------------------------------------------------------------------------

test('ambiguity — build + deploy → devops (build resolves to devops when deploy is present)', () => {
  const c = classifyKeyword('build and deploy the release');
  assert.equal(c.category, 'devops');
  // 'build' must appear in the matched keywords (resolved as devops)
  assert.ok(c.keywords.includes('build'), 'expected "build" in devops keywords');
  assert.ok(c.keywords.includes('deploy'));
});

test('ambiguity — build alone → implement (no devops co-token present)', () => {
  const c = classifyKeyword('build the new API endpoint');
  assert.equal(c.category, 'implement');
  assert.ok(c.keywords.includes('build'));
  assert.ok(c.confidence > 0, 'confidence should be > 0 with one hit');
});

// ---------------------------------------------------------------------------
// 3. Ambiguity rule 2: 'test'
// ---------------------------------------------------------------------------

test('ambiguity — test in research context → research (test is ignored without devops co-token)', () => {
  const c = classifyKeyword('investigate the flakey login test');
  assert.equal(c.category, 'research');
  // 'test' must NOT appear in the matched keywords for the winning category
  assert.ok(!c.keywords.includes('test'), '"test" should not appear in keywords here');
  assert.ok(c.keywords.includes('investigate'));
});

test('ambiguity — test in devops context → devops (test + ci co-occur)', () => {
  const c = classifyKeyword('run the CI test suite');
  assert.equal(c.category, 'devops');
  assert.ok(c.keywords.includes('test'), '"test" should count when ci is present');
  assert.ok(c.keywords.includes('ci'));
});

// ---------------------------------------------------------------------------
// 4. Tie-breaking
// ---------------------------------------------------------------------------

test('tie-break — design and implement the header → implement (implement beats design)', () => {
  const c = classifyKeyword('design and implement the header');
  assert.equal(c.category, 'implement');
});

// ---------------------------------------------------------------------------
// 5. No-match fallback
// ---------------------------------------------------------------------------

test('no match — "hello there" → implement, confidence 0.0, keywords []', () => {
  const c = classifyKeyword('hello there');
  assert.equal(c.category, 'implement');
  assert.equal(c.confidence, 0.0);
  assert.deepEqual(c.keywords, []);
  assert.equal(c.classifierVersion, 'kw-v1');
});

// ---------------------------------------------------------------------------
// 6. Case insensitivity
// ---------------------------------------------------------------------------

test('case insensitive — INVESTIGATE the API → research', () => {
  const c = classifyKeyword('INVESTIGATE the API');
  assert.equal(c.category, 'research');
  // returned keywords should be lowercased
  assert.ok(c.keywords.includes('investigate'), 'keywords must be lowercased');
});

// ---------------------------------------------------------------------------
// 7. Multi-token keyword
// ---------------------------------------------------------------------------

test('multi-token key — "look into the schema mismatch" → research', () => {
  const c = classifyKeyword('look into the schema mismatch');
  assert.equal(c.category, 'research');
  assert.ok(c.keywords.includes('look into'), 'expected "look into" as a matched phrase');
});

// ---------------------------------------------------------------------------
// 8. Confidence cap
// ---------------------------------------------------------------------------

test('confidence caps at 1.0 even with 5+ keyword hits in one category', () => {
  // Six devops keywords: deploy, release, push, commit, migrate, pipeline
  const c = classifyKeyword('deploy the release, push and commit, then migrate and run the pipeline');
  assert.equal(c.category, 'devops');
  assert.equal(c.confidence, 1.0);
  assert.ok(c.keywords.length >= 5, `expected ≥5 matched keywords, got ${c.keywords.length}`);
});

// ---------------------------------------------------------------------------
// 9. Additional edge cases
// ---------------------------------------------------------------------------

test('check alone → review (weak signal counts when no other category fires)', () => {
  const c = classifyKeyword('check the pull request');
  assert.equal(c.category, 'review');
  assert.ok(c.keywords.includes('check'));
});

test('check suppressed when implement fires — build and check → implement', () => {
  // 'build' (no devops co-token) → implement; 'check' should not count for review
  const c = classifyKeyword('build and check the API');
  assert.equal(c.category, 'implement');
  assert.ok(!c.keywords.includes('check'), '"check" should be suppressed when implement has hits');
});

test('multi-token key — "find out why the login is broken" → research', () => {
  const c = classifyKeyword('find out why the login is broken');
  assert.equal(c.category, 'research');
  assert.ok(c.keywords.includes('find out'));
});

test('devops: ci alone → devops', () => {
  const c = classifyKeyword('run ci for the PR');
  assert.equal(c.category, 'devops');
  assert.ok(c.keywords.includes('ci'));
});

test('classifierVersion is always kw-v1', () => {
  for (const instr of [
    'implement the feature',
    'deploy to production',
    'research the problem',
    'hello there',
  ]) {
    assert.equal(classifyKeyword(instr).classifierVersion, 'kw-v1', `failed for: "${instr}"`);
  }
});

// ---------------------------------------------------------------------------
// 10. Empty / whitespace-only input
// ---------------------------------------------------------------------------

test('kw-v1: empty string returns implement fallback with confidence 0', () => {
  const result = classifyKeyword('');
  assert.equal(result.category, 'implement');
  assert.equal(result.confidence, 0);
  assert.equal(result.classifierVersion, 'kw-v1');
  assert.deepEqual(result.keywords, []);
});

test('kw-v1: whitespace-only string returns implement fallback with confidence 0', () => {
  const result = classifyKeyword('   \t\n  ');
  assert.equal(result.category, 'implement');
  assert.equal(result.confidence, 0);
  assert.equal(result.classifierVersion, 'kw-v1');
  assert.deepEqual(result.keywords, []);
});
