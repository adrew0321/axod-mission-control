// The doorway's first pass. Bounded on purpose: filename, type, size, and a
// truncated head read — NOT a full agent turn. Noticing is cheap and constant;
// working is gated and rare.
//
// The FOLDER carries the permission: inbox/ raises a proposal, playground/ is
// hers to act in directly. There is no global mode to remember — the operator
// chooses per item by where he drops it.
// Pure — no fs, no network.
import { basename, resolve, sep } from 'node:path';
import type { Roots } from './paths';

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

function under(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Which doorway zone an absolute path falls in, or null for neither. */
export function zoneForPath(roots: Roots, abs: string): DoorwayZone | null {
  for (const zone of ['inbox', 'playground'] as const) {
    if (under(resolve(roots.doorway, zone), abs)) return zone;
  }
  return null;
}

/** Editor/download/OS scratch files that appear and vanish mid-copy. */
const NOISE = [
  /^\./,                     // .DS_Store, .goutputstream-…
  /^~\$/,                    // Office lock files
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
  const head = looksBinary(input.raw)
    ? `(binary ${ext ? ext + ' ' : ''}file — ${input.sizeBytes} bytes; convert it before reading)`
    : input.raw.toString('utf8').slice(0, MAX_HEAD_CHARS);
  return { zone: input.zone, name, path: input.path, sizeBytes: input.sizeBytes, ext, head };
}
