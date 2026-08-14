import fs from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// Resolve the tracing root at config-load time using filesystem symlink
// detection, so the value is correct even before .env.local is loaded.
//
// Detection logic:
//   • If node_modules doesn't exist or is a real directory → tracingRoot = __dirname
//     (prod layout: /srv/mission-control with a real node_modules, tight root).
//   • If node_modules IS a symlink → resolve its realpath and take the
//     common ancestor of __dirname and that realpath as tracingRoot.
//     (worktree layout: __dirname = /srv/mission-control/data/worktrees/sess_XXX,
//      realpath = /srv/mission-control/node_modules → ancestor = /srv/mission-control)
//
// MC_TRACING_ROOT env-var override: if set, it wins over detection (escape hatch).
function resolveTracingRoot(): string {
  if (process.env.MC_TRACING_ROOT) return process.env.MC_TRACING_ROOT;
  try {
    const nmPath = path.join(__dirname, 'node_modules');
    const stat = fs.lstatSync(nmPath);
    if (!stat.isSymbolicLink()) return __dirname;
    const realNm = fs.realpathSync(nmPath);
    const a = __dirname.split(path.sep).filter(Boolean);
    const b = realNm.split(path.sep).filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i === 0) {
      console.warn('[next.config] symlink detection: no common ancestor found, falling back to __dirname');
      return __dirname;
    }
    return path.sep + a.slice(0, i).join(path.sep);
  } catch (err) {
    console.warn('[next.config] symlink detection failed, falling back to __dirname:', err);
    return __dirname;
  }
}

const tracingRoot = resolveTracingRoot();

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
  // tracingRoot is resolved automatically via symlink detection above —
  // no manual env-var configuration needed.
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
  // tracingRoot is resolved automatically via symlink detection above —
  // no manual env-var configuration needed.
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
