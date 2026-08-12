import type { NextConfig } from 'next';

// In production, __dirname IS the project root (/srv/mission-control) and
// node_modules is a real directory — Turbopack/NFT auto-detection works fine.
// In worktree sessions, node_modules is a symlink to /srv/mission-control/node_modules,
// so we need to anchor the tracing root at the common ancestor.  Set
// MC_TRACING_ROOT=/srv/mission-control in worktree environments to opt in;
// leave it unset in prod so __dirname is used and the root stays tight.
const tracingRoot = process.env.MC_TRACING_ROOT ?? __dirname;

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
  // Anchor Node File Tracing to tracingRoot so paths are stable.
  // Must match turbopack.root (Next.js 16 enforces they be equal).
  // In worktree sessions set MC_TRACING_ROOT=/srv/mission-control so that
  // tracingRoot resolves to the common ancestor of the worktree and the
  // symlinked node_modules.  Leave MC_TRACING_ROOT unset in prod — __dirname
  // already equals /srv/mission-control there, so no override is needed.
  outputFileTracingRoot: tracingRoot,

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
  // Per the Next.js 16 docs (turbopack.md), turbopack.root must cover the
  // common ancestor of both the project directory and any symlinked
  // node_modules so Turbopack can resolve modules without a "symlink out of
  // filesystem root" panic.
  // In worktree sessions node_modules is a symlink to the shared
  // /srv/mission-control/node_modules — set MC_TRACING_ROOT=/srv/mission-control
  // so tracingRoot covers that ancestor.  In prod __dirname is already
  // /srv/mission-control and node_modules is real, so MC_TRACING_ROOT should
  // be left unset; __dirname is used and the root stays tight.
  // Must equal outputFileTracingRoot (Next.js 16 enforces parity).
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
    root: tracingRoot,
    ignoreIssue: [
      {
        path: '**/src/lib/preview.ts',
      },
    ],
  },
};

export default nextConfig;
