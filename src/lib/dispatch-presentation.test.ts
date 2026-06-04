import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchFlavor, dispatchAttribution } from './dispatch-presentation';

test('dispatchFlavor returns the persona line for each known specialist', () => {
  assert.equal(dispatchFlavor('atlas', 'Atlas'), 'Atlas heads to the anvil');
  assert.equal(dispatchFlavor('echo', 'Echo'), 'Echo uncaps the red pen');
  assert.equal(dispatchFlavor('nova', 'Nova'), 'Nova trains the telescope');
  assert.equal(dispatchFlavor('forge', 'Forge'), 'Forge fires up the pipeline');
  assert.equal(dispatchFlavor('pixel', 'Pixel'), 'Pixel sets up the easel');
});

test('dispatchFlavor falls back to "<name> gets to work" for unknown or null ids', () => {
  assert.equal(dispatchFlavor(null, 'Someone'), 'Someone gets to work');
  assert.equal(dispatchFlavor(undefined, 'Someone'), 'Someone gets to work');
});

test('dispatchAttribution returns "via Sage" only when a dispatcher is set', () => {
  assert.equal(dispatchAttribution('sage'), 'via Sage');
  assert.equal(dispatchAttribution('atlas'), 'via Sage');
  assert.equal(dispatchAttribution(null), undefined);
  assert.equal(dispatchAttribution(undefined), undefined);
  assert.equal(dispatchAttribution(''), undefined);
});
