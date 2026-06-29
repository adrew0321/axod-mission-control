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
