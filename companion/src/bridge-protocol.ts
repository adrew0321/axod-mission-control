// Pure wire types + parse/build helpers for the localhost HUD bridge.
// No sockets here — bridge.ts owns the WebSocket server.
import type { PendingGate } from './gate-queue';

export interface Presence {
  connected: boolean;   // companion↔Mini SSE link is up
  operator: string;
  host: string;         // laptop hostname
  uptimeSec: number;
  task: string;         // current browser task, e.g. 'idle' | 'reading example.com'
}

export interface Security {
  tokenAuthed: boolean;
  transport: string;    // 'outbound-only'
  profile: string;      // 'persistent · local'
  sensitiveCount: number;
}

export interface IngestState {
  phase: 'idle' | 'bundling' | 'uploading' | 'done' | 'error';
  projectName?: string;
  projectId?: string;
  error?: string;
}

export interface WritebackSession {
  sessionId: string;
  sessionName: string;
  changed: boolean;
  fileCount: number;
}
export interface WritebackProject {
  projectId: string;
  projectName: string;
  sessions: WritebackSession[];
}
export interface WritebackState {
  phase: 'idle' | 'listing' | 'verifying' | 'downloading' | 'applying' | 'done' | 'error';
  projects?: WritebackProject[];
  branch?: string;
  commits?: number;
  files?: number;
  error?: string;
}

export interface StateSnapshot {
  presence: Presence;
  queue: PendingGate[];
  security: Security;
  ingest: IngestState;
  writeback: WritebackState;
}

export interface StateMsg extends StateSnapshot {
  type: 'state';
}

export type ClientMsg =
  | { type: 'hello'; token: string }
  | { type: 'approve'; id: string }
  | { type: 'deny'; id: string }
  | { type: 'stop' }
  | { type: 'ingest'; path: string }
  | { type: 'writeback:list' }
  | { type: 'writeback'; projectId: string; sessionId: string };

export function buildState(s: StateSnapshot): StateMsg {
  return { type: 'state', presence: s.presence, queue: s.queue, security: s.security, ingest: s.ingest, writeback: s.writeback };
}

export function parseClientMsg(raw: string): ClientMsg | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const m = o as Record<string, unknown>;
  switch (m.type) {
    case 'hello':
      return typeof m.token === 'string' ? { type: 'hello', token: m.token } : null;
    case 'approve':
      return typeof m.id === 'string' ? { type: 'approve', id: m.id } : null;
    case 'deny':
      return typeof m.id === 'string' ? { type: 'deny', id: m.id } : null;
    case 'stop':
      return { type: 'stop' };
    case 'ingest':
      return typeof m.path === 'string' && m.path ? { type: 'ingest', path: m.path } : null;
    case 'writeback:list':
      return { type: 'writeback:list' };
    case 'writeback':
      return typeof m.projectId === 'string' && m.projectId && typeof m.sessionId === 'string' && m.sessionId
        ? { type: 'writeback', projectId: m.projectId, sessionId: m.sessionId }
        : null;
    default:
      return null;
  }
}
