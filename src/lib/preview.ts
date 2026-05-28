import 'server-only';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);

export interface BuildResult {
  ok: boolean;
  /** Trimmed build output (stdout+stderr), capped, for the UI. */
  log: string;
}

export interface PreviewInfo {
  port: number;
  url: string;
}

interface PreviewServer {
  server: Server;
  port: number;
  dist: string;
}

// Survive Next dev HMR: keep the server registry on globalThis so a module
// re-evaluation doesn't orphan listening sockets.
const registry: Map<string, PreviewServer> =
  (globalThis as { __mcPreviewServers?: Map<string, PreviewServer> }).__mcPreviewServers ??
  ((globalThis as { __mcPreviewServers?: Map<string, PreviewServer> }).__mcPreviewServers = new Map());

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Build the worktree's static site (`astro build`). Runs astro directly (not
 * `pnpm build`) so the repo's network `postbuild` script does not fire. Returns
 * the (capped) log either way so the operator can see failures.
 */
export async function buildWorktree(wtPath: string): Promise<BuildResult> {
  if (!wtPath || !existsSync(wtPath)) return { ok: false, log: 'Worktree path does not exist.' };
  if (!existsSync(path.join(wtPath, 'node_modules'))) {
    return { ok: false, log: 'node_modules not found in the worktree — install dependencies there first.' };
  }
  // Invoke astro's JS entry with the Node binary directly. Not `npx`: on Windows
  // Node's execFile can't run `npx`/`.cmd` without a shell, which made every
  // build fail. Running astro.mjs via process.execPath is shell-free and
  // cross-platform.
  const astroBin = path.join(wtPath, 'node_modules', 'astro', 'bin', 'astro.mjs');
  if (!existsSync(astroBin)) {
    return { ok: false, log: 'astro not found in the worktree node_modules — install dependencies there first.' };
  }
  const cap = (s: string) => (s.length > 8000 ? s.slice(-8000) : s);
  try {
    const { stdout, stderr } = await exec(process.execPath, [astroBin, 'build'], {
      cwd: wtPath,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, log: cap(`${stdout}\n${stderr}`.trim()) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, log: cap(`${e.stdout ?? ''}\n${e.stderr ?? e.message ?? 'build failed'}`.trim()) };
  }
}

function safeJoin(root: string, urlPath: string): string | null {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + clean));
  // Guard against path traversal: the resolved path must stay inside dist/.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function resolveFile(dist: string, urlPath: string): Promise<string | null> {
  const base = safeJoin(dist, urlPath);
  if (!base) return null;
  try {
    const s = await stat(base);
    if (s.isFile()) return base;
    if (s.isDirectory()) {
      const idx = path.join(base, 'index.html');
      return existsSync(idx) ? idx : null;
    }
  } catch {
    // not a direct file — try Astro clean-URL form: /foo → /foo/index.html
    const idx = path.join(base, 'index.html');
    if (existsSync(idx)) return idx;
  }
  return null;
}

/**
 * Ensure an in-process static server is serving the worktree's `dist/`. Idempotent
 * per session: reuses the existing server when the dist path matches; otherwise
 * (re)creates one on a fresh ephemeral port. The server reads from disk per
 * request, so a rebuild is reflected without restarting it.
 */
export async function ensurePreviewServer(sessionId: string, wtPath: string): Promise<PreviewInfo> {
  const dist = path.join(wtPath, 'dist');
  if (!existsSync(dist)) throw new Error('No dist/ in the worktree — build first.');

  const existing = registry.get(sessionId);
  if (existing && existing.dist === dist) {
    return { port: existing.port, url: `http://localhost:${existing.port}/` };
  }
  if (existing) await stopPreviewServer(sessionId);

  const server = createServer(async (req, res) => {
    try {
      const file = await resolveFile(dist, req.url ?? '/');
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const body = await readFile(file);
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Preview server error');
    }
  });

  const port: number = await new Promise((resolve, reject) => {
    server.on('error', reject);
    // Bind loopback only — the preview is for the local operator. (VPS remote
    // access needs a reverse-proxy story; see the week-4 plan Day 2 notes.)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  registry.set(sessionId, { server, port, dist });
  return { port, url: `http://localhost:${port}/` };
}

export async function stopPreviewServer(sessionId: string): Promise<void> {
  const entry = registry.get(sessionId);
  if (!entry) return;
  registry.delete(sessionId);
  await new Promise<void>((resolve) => entry.server.close(() => resolve()));
}
