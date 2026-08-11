import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollUpUsage, rollUpByAgent, emptyTotals, type UsageRow } from './usage-rollup';

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  agentId: 'atlas',
  tokensIn: 100,
  tokensOut: 20,
  cacheReadTokens: 900,
  cacheCreationTokens: 50,
  costUsd: 0.25,
  ...over,
});

test('empty input yields zeroed totals', () => {
  assert.deepEqual(rollUpUsage([]), emptyTotals());
});

test('sums every field across rows', () => {
  const t = rollUpUsage([row(), row()]);
  assert.equal(t.tokensIn, 200);
  assert.equal(t.tokensOut, 40);
  assert.equal(t.cacheReadTokens, 1800);
  assert.equal(t.cacheCreationTokens, 100);
  assert.equal(t.costUsd, 0.5);
  assert.equal(t.messageCount, 2);
  assert.equal(t.recordedCount, 2);
});

test('null fields contribute zero but still count as a message', () => {
  const t = rollUpUsage([
    row(),
    { agentId: 'sage', tokensIn: null, tokensOut: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null },
  ]);
  assert.equal(t.tokensIn, 100);
  assert.equal(t.messageCount, 2);
  assert.equal(t.recordedCount, 1); // the all-null row was never instrumented
});

test('recordedCount is zero when nothing was ever recorded', () => {
  const t = rollUpUsage([
    { agentId: 'sage', tokensIn: null, tokensOut: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null },
  ]);
  assert.equal(t.recordedCount, 0);
  assert.equal(t.messageCount, 1);
});

test('a row with any non-null field counts as recorded', () => {
  const t = rollUpUsage([
    { agentId: 'sage', tokensIn: null, tokensOut: null, cacheReadTokens: 7, cacheCreationTokens: null, costUsd: null },
  ]);
  assert.equal(t.recordedCount, 1);
  assert.equal(t.cacheReadTokens, 7);
});

test('rollUpByAgent groups by agent id', () => {
  const byAgent = rollUpByAgent([row(), row({ agentId: 'echo', tokensIn: 5 })]);
  assert.equal(byAgent.atlas.tokensIn, 100);
  assert.equal(byAgent.echo.tokensIn, 5);
  assert.equal(Object.keys(byAgent).length, 2);
});

test('rollUpByAgent buckets a null agent id under "unknown"', () => {
  const byAgent = rollUpByAgent([row({ agentId: null })]);
  assert.equal(byAgent.unknown.tokensIn, 100);
});
