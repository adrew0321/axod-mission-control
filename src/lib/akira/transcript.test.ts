import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimTranscript } from './transcript';
import type { TranscriptMessage } from '../conversation';

test('trimTranscript keeps the last N messages', () => {
  const msgs: TranscriptMessage[] = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const out = trimTranscript(msgs, 4);
  assert.equal(out.length, 4);
  assert.equal(out[0].content, 'm6');
  assert.equal(out[3].content, 'm9');
});

test('trimTranscript returns all when under the limit', () => {
  const msgs: TranscriptMessage[] = [{ role: 'user', content: 'a' }];
  assert.equal(trimTranscript(msgs, 20).length, 1);
});
