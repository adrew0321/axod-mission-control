import 'server-only';
import type { Message, TextBasedChannel } from 'discord.js';
import { chunkReply } from './discord-format';

type SendableChannel = TextBasedChannel & {
  send: (content: string) => Promise<Message>;
};

const THROTTLE_MS = 1200;
const THINKING = '\u{1F4AD} …';

/**
 * Adapts runSessionTurn's emit stream to Discord. Posts a placeholder, accumulates
 * `token` content, and edits the message at most every ~1.2s (well under Discord's
 * rate limits). On `error` it shows the failure. finalize() flushes the last state
 * and spills overflow (>2000 chars) into follow-up messages. Never throws into the turn.
 */
export function createDiscordSink(channel: SendableChannel) {
  let buffer = '';
  let message: Message | null = null;
  let lastEditAt = 0;
  let errored: string | null = null;
  let chain: Promise<void> = Promise.resolve();

  const ensureMessage = async () => {
    if (!message) message = await channel.send(THINKING);
    return message;
  };

  const render = async () => {
    try {
      const text = errored ? `⚠️ turn failed: ${errored}` : buffer.trim() || THINKING;
      const [first] = chunkReply(text);
      const msg = await ensureMessage();
      await msg.edit(first);
      lastEditAt = Date.now();
    } catch (err) {
      console.error('[discord] render failed:', err instanceof Error ? err.message : err);
    }
  };

  const queue = (fn: () => Promise<void>) => {
    chain = chain.then(fn, fn);
    return chain;
  };

  const emit = (e: { type: string; [k: string]: unknown }) => {
    if (e.type === 'token' && typeof e.content === 'string') {
      buffer += e.content;
      if (Date.now() - lastEditAt >= THROTTLE_MS) void queue(render);
    } else if (e.type === 'error' && typeof e.message === 'string') {
      errored = e.message;
      void queue(render);
    }
  };

  const finalize = async () => {
    await chain;
    await render();
    await chain;
    // Spill any overflow beyond the first 2000-char chunk into follow-up messages.
    if (!errored) {
      const chunks = chunkReply(buffer.trim() || THINKING);
      for (const extra of chunks.slice(1)) {
        try {
          await channel.send(extra);
        } catch (err) {
          console.error('[discord] overflow send failed:', err instanceof Error ? err.message : err);
        }
      }
    }
  };

  return { emit, finalize };
}
