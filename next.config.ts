import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // ── Server external packages ────────────────────────────────────────────────
  //
  // discord.js is a Node-only server library with an optional zlib-sync native
  // dependency (gateway compression). Marking it as serverExternal prevents
  // Turbopack from bundling it and pulling in zlib-sync, which is not needed
  // at runtime and fails the build.
  serverExternalPackages: ['discord.js'],

  // ── NFT tracing hardening ────────────────────────────────────────────────
  //
  // Anchor Node File Tracing to the shared mission-control root so paths are
  // stable.  Must match turbopack.root (Next.js 16 enforces they be equal).
  // Three levels up from the worktree __dirname lands at /srv/mission-control,
  // which is the common ancestor of both the worktree and the shared
  // node_modules symlink target (/srv/mission-control/node_modules).
  outputFileTracingRoot: path.resolve(__dirname, '../../..'),

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

  // ── Turbopack root ──────────────────────────────────────────────────────
  //
  // In this worktree setup, node_modules is a symlink to the shared
  // /srv/mission-control/node_modules directory, which is outside the
  // worktree root that Turbopack auto-detects (from pnpm-lock.yaml).
  // Per the Next.js 16 docs (turbopack.md), setting turbopack.root to the
  // common ancestor of both the project and the linked node_modules allows
  // Turbopack to resolve modules without hitting a "symlink out of filesystem
  // root" panic.  Three levels up from __dirname lands at /srv/mission-control.
  //
  // turbopack warning suppression: preview.ts intentionally uses dynamic
  // path.join(wtPath, ...) calls where wtPath is a request-time parameter.
  // Turbopack's static analysis cannot resolve these and may emit a non-fatal
  // trace warning.  Suppress it here; the runtime behaviour is unaffected.
  //
  // turbopack.ignoreIssue was introduced in Next.js 16.2.0 and applies to
  // both `next dev` and `next build` when Turbopack is the active bundler
  // (the default in Next.js 16).
  turbopack: {
    root: path.resolve(__dirname, '../../..'),
    ignoreIssue: [
      {
        path: '**/src/lib/preview.ts',
      },
    ],
  },
};

export default nextConfig;
