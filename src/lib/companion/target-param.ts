import type { CompanionTarget } from './registry';

/** Parse the ?target= query parameter. Anything unrecognised — including absent,
 *  which is what the already-deployed laptop companion sends — is 'laptop'. */
export function targetFromParam(raw: string | null): CompanionTarget {
  return raw === 'room' ? 'room' : 'laptop';
}
