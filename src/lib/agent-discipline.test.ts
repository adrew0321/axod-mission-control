import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withExecutionDiscipline, EXECUTION_DISCIPLINE } from './agent-discipline';

test('appends the execution discipline after a present system prompt', () => {
  const out = withExecutionDiscipline('You are Sage.');
  assert.ok(out);
  assert.ok(out.startsWith('You are Sage.'), 'keeps the agent persona first');
  assert.ok(out.includes(EXECUTION_DISCIPLINE), 'includes the shared discipline');
});

test('leaves an absent system prompt as undefined (no override of SDK default)', () => {
  assert.equal(withExecutionDiscipline(undefined), undefined);
});

test('discipline forbids narrating an unfired action', () => {
  assert.match(EXECUTION_DISCIPLINE, /tool/i);
  // covers dispatch (Sage) AND specialist work (edit/run/review/complete)
  assert.match(EXECUTION_DISCIPLINE, /dispatch|edit|run|review|complete/i);
});
