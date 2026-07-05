// One PIN-attempt limiter shared across all memory routes so failures on any
// endpoint count toward the same 5-per-minute budget (a per-file limiter would
// let one route bypass another's rate limit). Lives here, not in a route file,
// because Next route modules don't share module state with each other.
import { createLimiter } from './pin';

// 5 wrong PINs / minute, process-wide.
export const pinLimiter = createLimiter(5, 60_000);
