import { hostname } from 'node:os';
import { loadConfig } from './config';
import { connect } from './connection';
import { createBrowser } from './browser';
import { createGateQueue, type PendingGate } from './gate-queue';
import { startBridge } from './bridge';
import { ingestRepo } from './ingest';
import type { IngestState } from './bridge-protocol';
import type { Command, Result } from './protocol';

const GATE_TIMEOUT_MS = 120_000; // un-actioned gates auto-deny after 2 min

const cfg = loadConfig();
const browser = createBrowser(cfg);
const queue = createGateQueue();

const startedAt = Date.now();
let connected = false;
let currentTask = 'idle';
let ingestState: IngestState = { phase: 'idle' };

// id → resolver for the exec chain awaiting an operator decision
const resolvers = new Map<string, (d: 'approved' | 'denied') => void>();

function describe(cmd: Command): string {
  switch (cmd.action) {
    case 'navigate': return `opening ${cmd.url ?? ''}`.trim();
    case 'read': return 'reading the page';
    case 'type': return 'typing';
    case 'click': return 'clicking';
    case 'wait': return 'waiting';
    default: return 'working';
  }
}

const bridge = startBridge({
  getState: () => ({
    presence: {
      connected,
      operator: cfg.operator,
      host: hostname(),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      task: currentTask,
    },
    queue: queue.list(),
    security: {
      tokenAuthed: true,
      transport: 'outbound-only',
      profile: 'persistent · local',
      sensitiveCount: cfg.sensitiveDomains.length,
    },
    ingest: ingestState,
  }),
  onApprove: (id) => decide(id, 'approved'),
  onDeny: (id) => decide(id, 'denied'),
  onStop: () => stopAll(),
  onIngest: (path) => { void runIngest(path); },
});

function decide(id: string, d: 'approved' | 'denied'): void {
  if (!queue.remove(id)) return;
  resolvers.get(id)?.(d);
  resolvers.delete(id);
  bridge.push();
}

async function runIngest(path: string): Promise<void> {
  ingestState = { phase: 'bundling' };
  bridge.push();
  console.log('[companion] ingest start:', path);
  try {
    const { projectId, name } = await ingestRepo(cfg, path, {
      onPhase: (phase) => { ingestState = { phase }; bridge.push(); },
    });
    ingestState = { phase: 'done', projectName: name, projectId };
    console.log('[companion] ingest done:', projectId);
  } catch (e) {
    ingestState = { phase: 'error', error: e instanceof Error ? e.message : String(e) };
    console.error('[companion] ingest error:', ingestState.error);
  }
  bridge.push();
}

function stopAll(): void {
  for (const g of queue.clear()) {
    resolvers.get(g.id)?.('denied');
    resolvers.delete(g.id);
  }
  void browser.close();
  bridge.push();
  console.log('[companion] STOP — activity aborted, queue cleared');
}

// Expire stale gates → auto-deny.
setInterval(() => {
  const now = Date.now();
  for (const g of queue.expired(now, GATE_TIMEOUT_MS)) decide(g.id, 'denied');
}, 5_000);

// Refresh the uptime/timer on the HUD once a second.
setInterval(() => bridge.push(), 1_000);

async function runWithGate(cmd: Command): Promise<Result> {
  const result = await browser.execute(cmd);
  // Not a hard-gate block, or no HUD to approve on → behave exactly as before.
  if (result.status !== 'blocked' || !bridge.hasClient()) return result;

  const gate: PendingGate = {
    id: cmd.id,
    reason: result.reason ?? 'irreversible action',
    target: cmd.ref ?? cmd.url ?? '',
    host: browser.currentHost(),
    requestedAt: Date.now(),
  };
  queue.enqueue(gate);
  bridge.push();
  console.log('[companion] gate held for approval:', gate.reason);

  const decision = await new Promise<'approved' | 'denied'>((res) => resolvers.set(cmd.id, res));
  if (decision === 'denied') return { id: cmd.id, status: 'blocked', reason: 'operator denied' };
  return browser.execute({ ...cmd, approved: true });
}

// One-at-a-time queue so page actions never interleave.
let chain: Promise<void> = Promise.resolve();

const conn = connect(
  cfg,
  (cmd: Command) => {
    chain = chain.then(async () => {
      currentTask = describe(cmd);
      bridge.push();
      console.log('[companion] exec', cmd.action, cmd.ref ?? cmd.url ?? '');
      const result = await runWithGate(cmd);
      currentTask = 'idle';
      bridge.push();
      await conn.postResult(result);
    }).catch((err) => {
      console.error('[companion] command chain error:', err);
    });
  },
  (up) => {
    connected = up;
    bridge.push();
  },
);

console.log('[companion] AKIRA Local Companion started; profile:', cfg.profileDir);

async function shutdown() {
  console.log('\n[companion] shutting down…');
  conn.stop();
  bridge.stop();
  await browser.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
