// Pure transcript helpers for AKIRA — no db, no server-only.
import { type TranscriptMessage } from '../conversation';

/** Keep only the last `keep` transcript messages (bounds context growth). Pure. */
export function trimTranscript(msgs: TranscriptMessage[], keep: number): TranscriptMessage[] {
  return msgs.length <= keep ? msgs : msgs.slice(msgs.length - keep);
}
