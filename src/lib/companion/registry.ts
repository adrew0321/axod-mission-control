// In-memory bridge between AKIRA's tools and the connected companions.
// One sink per target (laptop / room). Not server-only — pure promise/bus logic,
// unit-tested with fake sinks.
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { Command, Result } from './protocol';

export interface CompanionSink {
  send: (cmd: Command) => void;
  close?: () => void;
}

/** Which machine a command is bound for. 'laptop' is the operator's (replaceable) work
 *  machine; 'room' is AKIRA's container on the Mini. */
export type CompanionTarget = 'laptop' | 'room';

const DEFAULT_TIMEOUT_MS = 60_000;

const sinks = new Map<CompanionTarget, CompanionSink>();
const pending = new Map<
  string,
  { target: CompanionTarget; resolve: (r: Result) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

export function newId(): string {
  return `cmd_${bytesToHex(randomBytes(6))}`;
}

export function registerCompanion(s: CompanionSink, target: CompanionTarget = 'laptop'): () => void {
  sinks.get(target)?.close?.();
  sinks.set(target, s);
  return () => {
    if (sinks.get(target) === s) sinks.delete(target);
    // Fail only this target's in-flight commands — never silently hang, and never
    // take down the other machine's work.
    for (const [id, p] of pending) {
      if (p.target !== target) continue;
      clearTimeout(p.timer);
      p.reject(new Error('companion disconnected'));
      pending.delete(id);
    }
  };
}

export function isOnline(target: CompanionTarget = 'laptop'): boolean {
  return sinks.has(target);
}

export function hasPending(): boolean {
  return pending.size > 0;
}

export function sendCommand(
  cmd: Omit<Command, 'id'>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  target: CompanionTarget = 'laptop',
): { id: string; result: Promise<Result> } {
  const id = newId();
  const sink = sinks.get(target);
  if (!sink) {
    return { id, result: Promise.reject(new Error(`companion offline: ${target}`)) };
  }
  const full: Command = { ...cmd, id };
  const result = new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('companion command timeout'));
    }, timeoutMs);
    pending.set(id, { target, resolve, reject, timer });
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
