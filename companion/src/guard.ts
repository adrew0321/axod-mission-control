// Pure hard-gate classifier — the Companion's brakes. Decides whether a click
// must wait for explicit operator approval. No Playwright, no deps.
import type { RawEl } from './protocol';

const DANGER = /\b(buy|buy now|place (your )?order|order now|pay|payment|checkout|purchase|subscribe|send|post|publish|tweet|delete|remove account|transfer|wire|confirm (payment|order|purchase)|place bid)\b/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Returns { gated:true, reason } when this click must pause for explicit
 * approval: a dangerous label/intent, a payment field, or a submit on a
 * sensitive (e.g. banking) domain. Ordinary navigation/links are not gated.
 */
export function classifyClick(
  el: RawEl,
  pageUrl: string,
  sensitiveDomains: string[],
): { gated: boolean; reason?: string } {
  const host = hostOf(pageUrl);
  const onSensitive = sensitiveDomains.some((d) => host === d || host.endsWith('.' + d));
  const label = `${el.name ?? ''} ${el.role ?? ''}`.trim();

  if (el.type === 'submit' && onSensitive) {
    return { gated: true, reason: `submit on sensitive domain ${host}` };
  }
  if (DANGER.test(label)) {
    return { gated: true, reason: `action looks irreversible: "${el.name ?? label}"` };
  }
  if (onSensitive && DANGER.test(label)) {
    return { gated: true, reason: `sensitive action on ${host}` };
  }
  return { gated: false };
}
