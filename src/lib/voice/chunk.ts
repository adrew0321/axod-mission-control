// Pure helpers for the voice layer — no browser APIs, unit-testable.

/**
 * Given an accumulating text buffer, return the complete sentences ready to
 * speak (split on . ! ? followed by whitespace/end) and the trailing partial to
 * keep. The terminator's trailing whitespace is left on the remainder.
 */
export function splitSentences(buffer: string): { ready: string[]; rest: string } {
  const ready: string[] = [];
  const re = /(.+?[.!?])(?=\s|$)/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = re.exec(buffer)) !== null) {
    ready.push(m[1].trim());
    lastIndex = re.lastIndex;
  }
  const rest = ready.length ? buffer.slice(lastIndex) : buffer;
  return { ready, rest };
}

const FEMALE_HINTS = ['zira', 'aria', 'jenny', 'samantha', 'female', 'eva', 'hazel', 'susan'];

/** Prefer a known female voice; else the first English voice; else null. */
export function pickFemaleVoice(
  voices: { name: string; lang: string }[],
): { name: string; lang: string } | null {
  const female = voices.find((v) => FEMALE_HINTS.some((h) => v.name.toLowerCase().includes(h)));
  if (female) return female;
  const en = voices.find((v) => v.lang.toLowerCase().startsWith('en'));
  return en ?? voices[0] ?? null;
}
