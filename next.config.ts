import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // ── NFT tracing hardening ────────────────────────────────────────────────
  //
  // Anchor Node File Tracing to the repo root so paths are stable and the
  // tracer never walks above the project directory into system folders.
  outputFileTracingRoot: path.resolve(__dirname),

  // Exclude paths that NFT would otherwise conservatively pull in for the
  // preview route.  The preview handler calls createServer / readFile /
  // path.join against a *runtime-supplied* worktree path — those joins are
  // not statically resolvable, so NFT can over-include heavy tool-chain
  // directories.  Excluding them keeps the serverless bundle lean.
  outputFileTracingExcludes: {
    // Route key uses the URL-path pattern (not the filesystem src/ path).
    // Brackets must be escaped for picomatch so [id] is treated as literal.
    '/api/sessions/\\[id\\]/preview': [
      // Heavy compiler/bundler deps — never needed at request-time.
      './node_modules/@swc/**',
      './node_modules/esbuild/**',
      './node_modules/webpack/**',
      // The worktrees directory is entirely runtime-supplied;
      // NFT has nothing useful to trace there at build time.
      './data/worktrees/**',
    ],
  },

  // ── Turbopack warning suppression ───────────────────────────────────────
  //
  // preview.ts intentionally uses dynamic path.join(wtPath, ...) calls where
  // wtPath is a request-time parameter.  Turbopack's static analysis cannot
  // resolve these and may emit a non-fatal trace warning.  Suppress it here;
  // the runtime behaviour is unaffected.
  //
  // turbopack.ignoreIssue was introduced in Next.js 16.2.0 and applies to
  // both `next dev` and `next build` when Turbopack is the active bundler
  // (the default in Next.js 16).
  turbopack: {
    ignoreIssue: [
      {
        path: '**/src/lib/preview.ts',
      },
    ],
  },
};

export default nextConfig;
