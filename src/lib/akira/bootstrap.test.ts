import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AKIRA_AGENT, AKIRA_AGENT_ID, AKIRA_SESSION_ID } from './agent';

test('AKIRA agent metadata is correct and safe', () => {
  assert.equal(AKIRA_AGENT_ID, 'akira');
  assert.equal(AKIRA_SESSION_ID, 'akira');
  assert.equal(AKIRA_AGENT.id, 'akira');
  assert.equal(AKIRA_AGENT.role, 'concierge');
  assert.equal(AKIRA_AGENT.model, 'claude-haiku-4-5-20251001');
  // never gets edit/exec tools
  for (const t of ['Edit', 'Write', 'Bash']) {
    assert.ok(!AKIRA_AGENT.tools_allowlist.includes(t), `${t} must not be allowed`);
  }
});
