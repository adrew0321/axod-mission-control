// Constant-time verification of the companion bearer token, shared by every
// /api/companion/* route. A raw `token !== process.env.COMPANION_TOKEN` compare
// is length/short-circuit variable-time; hash both sides and use timingSafeEqual
// (same pattern as the memory PIN check). Pure core so it unit-tests.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { CompanionTarget } from './registry';

/** Constant-time compare of a presented token against a secret. False if either is empty. */
export function tokenMatches(input: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || !input) return false;
  const a = createHash('sha256').update(String(input)).digest();
  const b = createHash('sha256').update(String(secret)).digest();
  return timingSafeEqual(a, b);
}

/** The two shared secrets, one per target. Passed in so the resolver stays pure. */
export interface CompanionSecrets {
  laptop: string | null | undefined;
  room: string | null | undefined;
}

/**
 * Which target a presented token authenticates as, or null for none.
 * Pure — the caller supplies the secrets.
 *
 * Laptop is checked first, so if the operator ever sets both env vars to the
 * same value the room fails closed (loudly, in its retry loop) rather than
 * silently inheriting the laptop's authority.
 */
export function resolveTarget(
  input: string | null | undefined,
  secrets: CompanionSecrets,
): CompanionTarget | null {
  if (tokenMatches(input, secrets.laptop)) return 'laptop';
  if (tokenMatches(input, secrets.room)) return 'room';
  return null;
}

function envSecrets(): CompanionSecrets {
  return { laptop: process.env.COMPANION_TOKEN, room: process.env.ROOM_COMPANION_TOKEN };
}

/** True iff the presented token authenticates as exactly `target` (constant-time). */
export function verifyCompanionToken(
  input: string | null | undefined,
  target: CompanionTarget = 'laptop',
): boolean {
  return resolveTarget(input, envSecrets()) === target;
}

/** Which target the presented token authenticates as, or null. For routes that
 *  serve both machines and learn the target from the credential itself. */
export function identifyCompanionToken(input: string | null | undefined): CompanionTarget | null {
  return resolveTarget(input, envSecrets());
}
