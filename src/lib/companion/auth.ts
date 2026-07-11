// Constant-time verification of the companion bearer token, shared by every
// /api/companion/* route. A raw `token !== process.env.COMPANION_TOKEN` compare
// is length/short-circuit variable-time; hash both sides and use timingSafeEqual
// (same pattern as the memory PIN check). Pure core so it unit-tests.
import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time compare of a presented token against a secret. False if either is empty. */
export function tokenMatches(input: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || !input) return false;
  const a = createHash('sha256').update(String(input)).digest();
  const b = createHash('sha256').update(String(secret)).digest();
  return timingSafeEqual(a, b);
}

/** True iff the presented token matches COMPANION_TOKEN (constant-time). */
export function verifyCompanionToken(input: string | null | undefined): boolean {
  return tokenMatches(input, process.env.COMPANION_TOKEN);
}
