import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, pickFemaleVoice } from './chunk';

test('splitSentences emits complete sentences and keeps the remainder', () => {
  const r = splitSentences('Hello there. How are you tod');
  assert.deepEqual(r.ready, ['Hello there.']);
  assert.equal(r.rest, ' How are you tod');
});

test('splitSentences with no terminator keeps everything as rest', () => {
  const r = splitSentences('still going');
  assert.deepEqual(r.ready, []);
  assert.equal(r.rest, 'still going');
});

test('splitSentences handles multiple sentences', () => {
  const r = splitSentences('One. Two! Three? tail');
  assert.deepEqual(r.ready, ['One.', 'Two!', 'Three?']);
  assert.equal(r.rest, ' tail');
});

test('pickFemaleVoice prefers a known female voice name', () => {
  const v = pickFemaleVoice([
    { name: 'Microsoft David - English (United States)', lang: 'en-US' },
    { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  ]);
  assert.equal(v?.name, 'Microsoft Zira - English (United States)');
});

test('pickFemaleVoice falls back to the first en voice', () => {
  const v = pickFemaleVoice([{ name: 'SomeVoice', lang: 'en-GB' }]);
  assert.equal(v?.name, 'SomeVoice');
});
