// The doorway's first pass. Bounded on purpose: filename, type, size, and a
// truncated head read — NOT a full agent turn. Noticing is cheap and constant;
// working is gated and rare.
//
// The FOLDER carries the permission: inbox/ raises a proposal, playground/ is
// hers to act in directly. There is no global mode to remember — the operator
// chooses per item by where he drops it.
// Pure — no fs, no network.
import { basename, isAbsolute, resolve } from 'node:path';
import { within, type Roots } from './paths';

export type DoorwayZone = 'inbox' | 'playground';

export const MAX_HEAD_CHARS = 800;

export interface DropReport {
  zone: DoorwayZone;
  name: string;
  path: string;
  sizeBytes: number;
  /** Lowercased extension without the dot, or '' when there is none. */
  ext: string;
  head: string;
}

/**
 * Which doorway zone an absolute path falls in, or null for neither.
 * `abs` must actually be absolute: `resolve()` silently falls back to
 * `process.cwd()` for relative input, which would make the result depend on
 * process state rather than on `roots` and `abs` alone. Reject that outright
 * instead of resolving against wherever the process happens to be running.
 */
export function zoneForPath(roots: Roots, abs: string): DoorwayZone | null {
  if (!isAbsolute(abs)) return null;
  for (const zone of ['inbox', 'playground'] as const) {
    // Exclusive: the zone folder's own path is not "in" the zone — a drop
    // always names a file under it. See within()'s doc comment in paths.ts.
    if (within(resolve(roots.doorway, zone), abs, { inclusive: false })) return zone;
  }
  return null;
}

/**
 * Editor/download/OS scratch files that appear and vanish mid-copy.
 * Deliberately enumerated rather than "any dot-prefixed name": transient
 * scratch (.DS_Store, .goutputstream-*, AppleDouble ._*, .Trash-*) is
 * low-stakes to mis-sort either way because it vanishes on its own. An
 * ordinary dotfile like .gitignore or .env does NOT vanish — flagging it as
 * noise would silently swallow the drop with no proposal and no action,
 * forever. That's the failure this design exists to avoid.
 */
const NOISE = [
  /^\.DS_Store$/,
  /^\.goutputstream-/,
  /^\._/,                    // AppleDouble resource-fork shadow files
  /^\.Trash-/,
  /^~\$/,                    // Office lock files
  /^\.~lock\..*#$/,          // LibreOffice lock files (.~lock.<filename>#)
  /\.(crdownload|part|partial|tmp|swp|swx)$/i,
];

export function isNoiseName(name: string): boolean {
  return NOISE.some((re) => re.test(name));
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Control bytes outside tab/newline/carriage-return mean "not text". */
function looksBinary(raw: Buffer): boolean {
  const probe = raw.subarray(0, 512);
  for (const b of probe) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) return true;
  }
  return false;
}

export function buildDropReport(input: {
  zone: DoorwayZone;
  path: string;
  sizeBytes: number;
  raw: Buffer;
}): DropReport {
  const name = basename(input.path);
  const ext = extOf(name);
  // Bound the bytes fed to the decoder ourselves — MAX_HEAD_CHARS * 4 is
  // generous enough that even worst-case 4-byte UTF-8 sequences survive to
  // fill the char budget — so boundedness doesn't rest on the caller having
  // already truncated `raw`. A dangling multi-byte sequence at that byte cut
  // self-heals into a single U+FFFD rather than throwing.
  const head = looksBinary(input.raw)
    ? `(binary ${ext ? ext + ' ' : ''}file — ${input.sizeBytes} bytes; convert it before reading)`
    : input.raw.subarray(0, MAX_HEAD_CHARS * 4).toString('utf8').slice(0, MAX_HEAD_CHARS);
  return { zone: input.zone, name, path: input.path, sizeBytes: input.sizeBytes, ext, head };
}
