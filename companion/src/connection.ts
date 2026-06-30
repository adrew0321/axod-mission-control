import type { Command, Result } from './protocol';
import type { CompanionConfig } from './config';

export function connect(cfg: CompanionConfig, onCommand: (cmd: Command) => void) {
  let stopped = false;
  let controller: AbortController | null = null;

  async function postResult(r: Result): Promise<void> {
    await fetch(`${cfg.miniUrl}/api/companion/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-companion-token': cfg.token },
      body: JSON.stringify(r),
    }).catch((e) => console.error('[companion] result POST failed:', e?.message ?? e));
  }

  async function loop() {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${cfg.miniUrl}/api/companion/stream?token=${encodeURIComponent(cfg.token)}`, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        console.log('[companion] connected to', cfg.miniUrl);
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
        if (!stopped) console.error('[companion] stream error, retrying:', (e as Error).message);
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 3000)); // backoff
    }
  }
  void loop();

  return {
    postResult,
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
