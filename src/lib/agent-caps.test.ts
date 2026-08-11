import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCaps, stoppedByFromSubtype, capNotice, DEFAULT_CAPS } from './agent-caps';

test('resolveCaps uses the row values when present', () => {
  const caps = resolveCaps({ effort: 'high', max_turns: 40, max_budget_usd: 3 });
  assert.deepEqual(caps, { effort: 'high', maxTurns: 40, maxBudgetUsd: 3 });
});

test('resolveCaps falls back to defaults on null/missing row', () => {
  assert.deepEqual(resolveCaps(null), DEFAULT_CAPS);
  assert.deepEqual(resolveCaps(undefined), DEFAULT_CAPS);
  assert.deepEqual(resolveCaps({ effort: null, max_turns: null, max_budget_usd: null }), DEFAULT_CAPS);
});

test('resolveCaps falls back per-field, not all-or-nothing', () => {
  const caps = resolveCaps({ effort: null, max_turns: 12, max_budget_usd: null });
  assert.equal(caps.maxTurns, 12);
  assert.equal(caps.effort, DEFAULT_CAPS.effort);
  assert.equal(caps.maxBudgetUsd, DEFAULT_CAPS.maxBudgetUsd);
});

test('resolveCaps rejects an unknown effort string', () => {
  assert.equal(resolveCaps({ effort: 'turbo', max_turns: null, max_budget_usd: null }).effort, DEFAULT_CAPS.effort);
});

test('resolveCaps rejects non-positive numeric caps', () => {
  const caps = resolveCaps({ effort: null, max_turns: 0, max_budget_usd: -1 });
  assert.equal(caps.maxTurns, DEFAULT_CAPS.maxTurns);
  assert.equal(caps.maxBudgetUsd, DEFAULT_CAPS.maxBudgetUsd);
});

test('stoppedByFromSubtype maps only the two cap subtypes', () => {
  assert.equal(stoppedByFromSubtype('error_max_turns'), 'max_turns');
  assert.equal(stoppedByFromSubtype('error_max_budget_usd'), 'max_budget');
  assert.equal(stoppedByFromSubtype('error_during_execution'), null);
  assert.equal(stoppedByFromSubtype('success'), null);
});

test('capNotice names the agent, the cap, and where partial work lives', () => {
  const turns = capNotice('Atlas', 'max_turns', 40);
  assert.match(turns, /Atlas stopped early/);
  assert.match(turns, /40-turn cap/);
  assert.match(turns, /worktree/);

  const budget = capNotice('Forge', 'max_budget', 3);
  assert.match(budget, /Forge stopped early/);
  assert.match(budget, /\$3 budget guard/);
});
