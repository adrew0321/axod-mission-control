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
     *   - /_next/*          (Next.js static assets + RSC payloads)
     *   - /favicon.ico, sitemap.xml, robots.txt
     *   - any path that contains a "." (static files: .css, .js, .png, etc)
     */
    '/((?!login$|api/auth/|api/health$|_next/|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\..*).*)',
  ],
};
