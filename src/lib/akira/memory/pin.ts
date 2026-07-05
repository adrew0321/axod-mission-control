// Pure PIN verification (constant-time) + a small failed-attempt limiter for the
// memory unlock. No I/O — unit-tested.
import { createHash, timingSafeEqual } from 'node:crypto';

export function verifyPin(input: string, secret: string): boolean {
  if (!secret) return false;
  const a = createHash('sha256').update(String(input)).digest();
  const b = createHash('sha256').update(String(secret)).digest();
  return timingSafeEqual(a, b);
}

export interface Limiter {
  allowed(now: number): boolean;
  recordFailure(now: number): void;
  recordSuccess(): void;
}

export function createLimiter(max: number, windowMs: number): Limiter {
  let fails: number[] = [];
  return {
    allowed(now) {
      fails = fails.filter((t) => now - t < windowMs);
      return fails.length < max;
    },
    recordFailure(now) {
      fails.push(now);
    },
    recordSuccess() {
      fails = [];
    },
  };
}
