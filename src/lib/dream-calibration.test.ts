import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTriageExamples, MAX_EXAMPLES_PER_SIDE, type TriagedInsight } from './dream-calibration';

const ins = (title: string): TriagedInsight => ({ category: 'risk', title, detail: `detail for ${title}` });

test('both lists empty yields an empty string', () => {
  // A fresh database must produce a prompt identical to today's, not a
  // malformed section with empty headings.
  assert.equal(formatTriageExamples([], []), '');
});

test('starred and dismissed appear under their own distinct headings', () => {
  const out = formatTriageExamples([ins('kept-one')], [ins('binned-one')]);

  const keptHeading = out.indexOf('KEPT');
  const binnedHeading = out.indexOf('THREW AWAY');
  assert.ok(keptHeading >= 0, 'the starred group has a heading');
  assert.ok(binnedHeading >= 0, 'the dismissed group has a heading');
  assert.ok(keptHeading < binnedHeading, 'kept is introduced before dismissed');

  // Each example must sit under ITS OWN heading. An unlabelled concatenation,
  // or the two groups merged, fails here — which the previous version of this
  // test did not catch.
  const keptItem = out.indexOf('kept-one');
  const binnedItem = out.indexOf('binned-one');
  assert.ok(keptItem > keptHeading && keptItem < binnedHeading, 'the starred item sits under the starred heading');
  assert.ok(binnedItem > binnedHeading, 'the dismissed item sits under the dismissed heading');
});

test('only one side present still produces a usable block', () => {
  const starredOnly = formatTriageExamples([ins('kept-one')], []);
  assert.match(starredOnly, /kept-one/);
  const dismissedOnly = formatTriageExamples([], [ins('binned-one')]);
  assert.match(dismissedOnly, /binned-one/);
});

test('each side is capped so the block cannot grow without bound', () => {
  const many = Array.from({ length: MAX_EXAMPLES_PER_SIDE + 5 }, (_, i) => ins(`s${i}`));
  const out = formatTriageExamples(many, many);
  // Every example is emitted as its own `- [category] title — detail` line, so
  // counting those lines counts examples exactly.
  const exampleLines = out.split('\n').filter((l) => l.startsWith('- ['));
  assert.equal(
    exampleLines.length,
    MAX_EXAMPLES_PER_SIDE * 2,
    'both sides capped: 10 starred + 10 dismissed, not 15 + 15',
  );
  // The last item WITHIN the cap is present and the first item PAST it is not,
  // so an off-by-one in either direction fails.
  assert.ok(out.includes(`s${MAX_EXAMPLES_PER_SIDE - 1} `), 'the 10th item is kept');
  assert.ok(!out.includes(`s${MAX_EXAMPLES_PER_SIDE} `), 'the 11th item is excluded');
});
