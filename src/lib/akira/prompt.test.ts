import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSnapshot, buildAkiraPrompt, AKIRA_SYSTEM_PROMPT } from './prompt';
import { emptySnapshot } from '../fleet-snapshot';

test('system prompt names AKIRA and her tools', () => {
  assert.match(AKIRA_SYSTEM_PROMPT, /AKIRA/);
  assert.match(AKIRA_SYSTEM_PROMPT, /navigate/);
  assert.match(AKIRA_SYSTEM_PROMPT, /relay/);
  assert.match(AKIRA_SYSTEM_PROMPT, /open/);
});

test('renderSnapshot summarizes counts and health', () => {
  const s = emptySnapshot();
  s.running = [{ projectId: 'p', projectName: 'Web', sessionId: 's1' }];
  s.health = { verdict: 'pass', at: null };
  const text = renderSnapshot(s);
  assert.match(text, /Web/);
  assert.match(text, /pass/i);
});

test('renderSnapshot reports today\'s token usage', () => {
  const snap = emptySnapshot();
  snap.usage = {
    tokensIn: 1200,
    tokensOut: 340,
    cacheReadTokens: 88000,
    cacheCreationTokens: 4100,
    costUsd: 1.25,
    recordedCount: 12,
  };
  const text = renderSnapshot(snap);
  assert.match(text, /Tokens today/);
  assert.match(text, /88,000 cache-read/);
  assert.match(text, /\$1\.25/);
});

test('renderSnapshot says so when no usage was recorded today', () => {
  const text = renderSnapshot(emptySnapshot());
  assert.match(text, /Tokens today: none recorded/);
});

test('buildAkiraPrompt includes snapshot, roster, and transcript', () => {
  const s = emptySnapshot();
  const prompt = buildAkiraPrompt(
    s,
    [{ id: 'atlas', name: 'Atlas', role: 'developer' }],
    [{ role: 'user', content: 'hi' }],
    { atlas: 'Atlas (developer)' },
  );
  assert.match(prompt, /Atlas/);
  assert.match(prompt, /Operator: hi/);
  assert.match(prompt, /FLEET/);
});

test('the prompt explains the two doorway folders and which one asks first', () => {
  assert.match(AKIRA_SYSTEM_PROMPT, /inbox/i);
  assert.match(AKIRA_SYSTEM_PROMPT, /playground/i);
  assert.match(AKIRA_SYSTEM_PROMPT, /~\/AKIRA/);
});

test('the prompt tells her to stop and wait on a gated command, not retry', () => {
  assert.match(AKIRA_SYSTEM_PROMPT, /do not retry|don't retry/i);
});

test('the prompt says her room work is hers and prod is off limits', () => {
  assert.match(AKIRA_SYSTEM_PROMPT, /room/i);
  assert.match(AKIRA_SYSTEM_PROMPT, /cannot reach Mission Control's own files/i);
});
