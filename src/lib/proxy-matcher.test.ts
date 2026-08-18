// Guards a recurring bug class in this repo: a token-authed companion route
// (the room agent or the laptop companion, authenticating with
// COMPANION_TOKEN/ROOM_COMPANION_TOKEN — no browser session cookie) gets
// silently redirected to /login by src/proxy.ts's session gate. It has
// happened three times, each discovered by symptom rather than by a test:
//   - v1.11.3: stream + result
//   - 37171a4: writeback
//   - this branch (slice 2): room-event
//
// Rather than hand-maintain a list of route names to check against the
// matcher (which is exactly what drifted three times), this test discovers
// every route.ts under src/app/api/companion ON DISK, reads each one to see
// whether it self-authenticates via verifyCompanionToken, and cross-checks
// that against proxy.ts's actual matcher regex. A new token-authed route
// added without updating the matcher fails HERE, not in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@/proxy';

const COMPANION_DIR = join(process.cwd(), 'src', 'app', 'api', 'companion');

// Both are the same self-authenticating family from src/lib/companion/auth.ts:
// verifyCompanionToken checks against one known target, identifyCompanionToken
// (used by /result, which both machines post to) learns the target from the
// credential itself. Either means "no browser session — must be excluded".
const TOKEN_AUTH = /verifyCompanionToken|identifyCompanionToken/;

interface RouteFile {
  /** URL pathname, e.g. /api/companion/writeback/list */
  pathname: string;
  source: string;
}

function collectRoutes(dir: string, pathname: string): RouteFile[] {
  const out: RouteFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRoutes(full, `${pathname}/${entry.name}`));
    } else if (entry.name === 'route.ts') {
      out.push({ pathname, source: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

/** True iff src/proxy.ts's middleware would run the session gate on this
 *  pathname. Built from the SAME matcher config.matcher[0] the running
 *  middleware uses — not a re-derived or hand-copied approximation. */
function isSessionGated(pathname: string): boolean {
  const re = new RegExp('^' + config.matcher[0] + '$');
  return re.test(pathname);
}

test('every companion route that self-authenticates with the token is excluded from the session gate', () => {
  const routes = collectRoutes(COMPANION_DIR, '/api/companion');
  assert.ok(routes.length >= 6, 'sanity check — the companion route scan found suspiciously few routes');

  const selfAuthenticating = routes.filter((r) => TOKEN_AUTH.test(r.source));
  assert.ok(selfAuthenticating.length >= 4, 'sanity check — expected several token-authed companion routes');

  for (const r of selfAuthenticating) {
    assert.equal(
      isSessionGated(r.pathname),
      false,
      `${r.pathname} calls verifyCompanionToken (no browser session) but IS matched by proxy.ts's ` +
        `session gate — it would 302 to /login instead of ever reaching the route handler. ` +
        `Add it to the exclusion list in src/proxy.ts's config.matcher.`,
    );
  }
});

test('a companion route that does NOT self-authenticate with the token stays behind the session gate', () => {
  // The converse check: routes like status/approve are consumed by the
  // authenticated dashboard (same-origin fetch, cookie sent automatically)
  // and have no business being exempted from the session gate. This catches
  // the matcher regex being widened too far in the other direction.
  const routes = collectRoutes(COMPANION_DIR, '/api/companion');
  const sessionBased = routes.filter((r) => !TOKEN_AUTH.test(r.source));
  assert.ok(sessionBased.length >= 1, 'sanity check — expected at least one session-authed companion route');

  for (const r of sessionBased) {
    assert.equal(
      isSessionGated(r.pathname),
      true,
      `${r.pathname} does not call verifyCompanionToken, so it relies on the session gate for auth — ` +
        `but proxy.ts's matcher excludes it, leaving it unauthenticated.`,
    );
  }
});
