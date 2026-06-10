import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAgentSkill, buildSkills } from './skills';

test('known tool maps to its catalog entry', () => {
  assert.deepEqual(toAgentSkill('Bash'), {
    name: 'Bash',
    label: 'Bash',
    description: 'Run shell commands',
    kind: 'run',
  });
});

test('Edit and Read carry the right kinds', () => {
  assert.equal(toAgentSkill('Edit').kind, 'edit');
  assert.equal(toAgentSkill('Read').kind, 'read');
});

test('unknown tool falls back to a run-classified entry', () => {
  assert.deepEqual(toAgentSkill('FrobnicateXYZ'), {
    name: 'FrobnicateXYZ',
    label: 'FrobnicateXYZ',
    description: 'Custom tool',
    kind: 'run',
  });
});

test('buildSkills maps a list, de-dupes, preserves order', () => {
  const out = buildSkills(['Read', 'Edit', 'Read', 'Bash']);
  assert.deepEqual(out.map((s) => s.name), ['Read', 'Edit', 'Bash']);
  assert.equal(out[1].kind, 'edit');
});
