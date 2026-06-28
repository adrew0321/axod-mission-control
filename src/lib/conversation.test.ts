import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrchestratorPrompt, type TranscriptMessage } from './conversation';

const LABELS = { sage: 'Sage', atlas: 'Atlas (developer)', echo: 'Echo (qa)' };

test('labels operator and agents, preserves order', () => {
  const msgs: TranscriptMessage[] = [
    { role: 'user', content: 'add a border' },
    { role: 'agent', agentId: 'sage', content: 'dispatching Atlas' },
    { role: 'agent', agentId: 'atlas', content: 'done, edited Hero.astro' },
    { role: 'user', content: 'keep the hero changes' },
  ];
  const out = buildOrchestratorPrompt(msgs, LABELS);
  assert.match(out, /Operator: add a border/);
  assert.match(out, /Sage: dispatching Atlas/);
  assert.match(out, /Atlas \(developer\): done, edited Hero\.astro/);
  // order preserved: first user line precedes the atlas line
  assert.ok(out.indexOf('add a border') < out.indexOf('edited Hero.astro'));
  // ends with the latest operator message
  assert.ok(out.trimEnd().endsWith('Operator: keep the hero changes'));
});

test('includes the framing header', () => {
  const out = buildOrchestratorPrompt([{ role: 'user', content: 'hi' }], LABELS);
  assert.match(out, /ongoing conversation for the current session/i);
});

test('skips system rows and empty content', () => {
  const msgs: TranscriptMessage[] = [
    { role: 'system', content: 'Atlas requested tool permissions' },
    { role: 'agent', agentId: 'sage', content: '   ' },
    { role: 'user', content: 'real message' },
  ];
  const out = buildOrchestratorPrompt(msgs, LABELS);
  assert.doesNotMatch(out, /requested tool permissions/);
  assert.doesNotMatch(out, /Sage:/);
  assert.match(out, /Operator: real message/);
});

test('falls back to agentId when no label, and to Agent when no id', () => {
  const msgs: TranscriptMessage[] = [
    { role: 'agent', agentId: 'nova', content: 'researched X' },
    { role: 'agent', content: 'no id here' },
  ];
  const out = buildOrchestratorPrompt(msgs, LABELS);
  assert.match(out, /nova: researched X/);
  assert.match(out, /Agent: no id here/);
});

test('empty input returns just the header (no throw)', () => {
  const out = buildOrchestratorPrompt([], LABELS);
  assert.match(out, /ongoing conversation for the current session/i);
});

test('orchestrator prompt carries the post-dispatch brevity rule', () => {
  const out = buildOrchestratorPrompt([{ role: 'user', content: 'hi' }], {});
  assert.match(out, /do not restate|don't restate|one-line TL;DR/i);
});
