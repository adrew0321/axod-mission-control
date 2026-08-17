import type { Command, Result } from './protocol';
import type { RoomConfig } from './config';
import type { DropReport } from './doorway';

export function connect(
  cfg: RoomConfig,
  onCommand: (cmd: Command) => void,
  onStatus?: (connected: boolean) => void,
) {
  let stopped = false;
  let controller: AbortController | null = null;

  async function postResult(r: Result): Promise<void> {
    await fetch(`${cfg.miniUrl}/api/companion/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-companion-token': cfg.token },
      body: JSON.stringify(r),
    }).catch((e) => console.error('[room] result POST failed:', e?.message ?? e));
  }

  async function postDrop(r: DropReport): Promise<void> {
    await fetch(`${cfg.miniUrl}/api/companion/room-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-companion-token': cfg.token },
      body: JSON.stringify(r),
    }).catch((e) => console.error('[room] drop POST failed:', e?.message ?? e));
  }

  async function loop() {
    while (!stopped) {
      controller = new AbortController();
      try {
        const url = `${cfg.miniUrl}/api/companion/stream?token=${encodeURIComponent(cfg.token)}&target=room`;
        const res = await fetch(url, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        console.log('[room] connected to', cfg.miniUrl);
        onStatus?.(true);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const f of frames) {
            const m = f.match(/^data: (.*)$/m);
            if (!m) continue;
            const evt = JSON.parse(m[1]);
            if (evt.type === 'command') onCommand(evt.cmd as Command);
          }
        }
      } catch (e) {
        onStatus?.(false);
        if (!stopped) console.error('[room] stream error, retrying:', (e as Error).message);
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 3000)); // backoff
    }
  }
  void loop();

  return {
    postResult,
    postDrop,
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
