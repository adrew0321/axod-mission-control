// In-memory bridge between AKIRA's browser tools and the connected Companion.
// Single laptop: one sink at a time. Not server-only — pure promise/bus logic,
// unit-tested with a fake sink.
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { Command, Result } from './protocol';

export interface CompanionSink {
  send: (cmd: Command) => void;
  close?: () => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

let sink: CompanionSink | null = null;
const pending = new Map<string, { resolve: (r: Result) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

export function newId(): string {
  return `cmd_${bytesToHex(randomBytes(6))}`;
}

export function registerCompanion(s: CompanionSink): () => void {
  sink?.close?.();
  sink = s;
  return () => {
    if (sink === s) sink = null;
    // fail any in-flight commands — never silently hang
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('companion disconnected'));
      pending.delete(id);
    }
  };
}

export function isOnline(): boolean {
  return sink !== null;
}

export function hasPending(): boolean {
  return pending.size > 0;
}

export function sendCommand(
  cmd: Omit<Command, 'id'>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): { id: string; result: Promise<Result> } {
  const id = newId();
  if (!sink) {
    return { id, result: Promise.reject(new Error('companion offline')) };
  }
  const full: Command = { ...cmd, id };
  const result = new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('companion command timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
  sink.send(full);
  return { id, result };
}

export function resolveResult(r: Result): void {
  const p = pending.get(r.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(r.id);
  p.resolve(r);
}
