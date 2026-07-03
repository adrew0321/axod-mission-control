import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth-edge';

export function proxy(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    /*
     * Run on every path EXCEPT:
     *   - /login            (the login page itself)
     *   - /api/auth/*       (login + logout endpoints)
     *   - /api/health       (uptime monitoring; never gated)
     *   - /api/companion/stream, /api/companion/result
     *                       (the Local Companion authenticates with
     *                        COMPANION_TOKEN, not a session cookie — it has no
     *                        browser session, so the session gate would redirect
     *                        its SSE connection to /login and it could never
     *                        register. These routes self-authenticate the token.)
     *   - /_next/*          (Next.js static assets + RSC payloads)
     *   - /favicon.ico, sitemap.xml, robots.txt
     *   - any path that contains a "." (static files: .css, .js, .png, etc)
     */
    '/((?!login$|api/auth/|api/companion/(?:stream|result)$|api/health$|_next/|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\..*).*)',
  ],
};
