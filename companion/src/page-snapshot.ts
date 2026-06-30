// Pure: turn raw extracted elements + page text into AKIRA's trimmed read model
// with stable refs. No Playwright — the impure extraction lives in browser.ts.
import type { RawEl, Snapshot } from './protocol';

export function buildSnapshot(
  input: { url: string; title: string; pageText: string; raw: Omit<RawEl, 'ref'>[] },
  maxEls = 120,
  maxText = 4000,
): Snapshot {
  const elements: RawEl[] = [];
  for (const r of input.raw) {
    const name = (r.name ?? '').trim();
    // keep only actionable, named elements (links/buttons/inputs); drop noise
    if (!name && !r.href && r.tag !== 'input') continue;
    elements.push({ ref: `e${elements.length + 1}`, ...r, name });
    if (elements.length >= maxEls) break;
  }
  const text = input.pageText.length > maxText ? input.pageText.slice(0, maxText) : input.pageText;
  return { url: input.url, title: input.title, text, elements };
}
