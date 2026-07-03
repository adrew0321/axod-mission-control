// Localhost-only WebSocket bridge to the native HUD. Binds 127.0.0.1 on a random
// port, writes {port, token} to ~/.akira-companion/bridge.json (mode 600) so the
// HUD can find + authenticate to it. No inbound network exposure.
import { WebSocketServer, type WebSocket } from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { buildState, parseClientMsg, type StateSnapshot } from './bridge-protocol';

export interface BridgeHandlers {
  getState: () => StateSnapshot;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onStop: () => void;
}

export const BRIDGE_FILE = join(homedir(), '.akira-companion', 'bridge.json');

export function startBridge(h: BridgeHandlers) {
  const token = randomBytes(24).toString('hex');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const authed = new Set<WebSocket>();

  wss.on('listening', () => {
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    mkdirSync(dirname(BRIDGE_FILE), { recursive: true });
    writeFileSync(BRIDGE_FILE, JSON.stringify({ port, token }), { mode: 0o600 });
    console.log(`[companion] HUD bridge listening on 127.0.0.1:${port}`);
  });

  wss.on('error', (err) => {
    console.error('[companion] HUD bridge error:', err);
  });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = parseClientMsg(data.toString());
      if (!msg) return;
      if (msg.type === 'hello') {
        if (msg.token === token) {
          authed.add(ws);
          try {
            ws.send(JSON.stringify(buildState(h.getState())));
          } catch {
            authed.delete(ws);
          }
        } else {
          ws.close();
        }
        return;
      }
      if (!authed.has(ws)) return; // ignore commands before a valid hello
      if (msg.type === 'approve') h.onApprove(msg.id);
      else if (msg.type === 'deny') h.onDeny(msg.id);
      else if (msg.type === 'stop') h.onStop();
    });
    ws.on('close', () => authed.delete(ws));
    ws.on('error', () => authed.delete(ws));
  });

  return {
    hasClient(): boolean {
      return authed.size > 0;
    },
    push(): void {
      const s = JSON.stringify(buildState(h.getState()));
      for (const ws of authed) {
        try {
          ws.send(s);
        } catch {
          authed.delete(ws);
        }
      }
    },
    stop(): void {
      wss.close();
    },
  };
}
