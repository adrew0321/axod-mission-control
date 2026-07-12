// Parse the Reflector's JSON output tolerantly (optional ```json fence, partial/garbled
// content). Pure — unit-tested. A parse failure yields a safe empty result so the caller
// never mutates the vault on bad output.
export interface DistilledLesson { title: string; description: string; body: string }
export interface ReflectionOutput {
  lessons: DistilledLesson[];
  soulProposal: { text: string; reason: string } | null;
}

export function parseReflection(raw: string): ReflectionOutput {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence ? fence[1] : raw).trim();
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    const rawLessons = Array.isArray(o.lessons) ? o.lessons : [];
    const lessons: DistilledLesson[] = rawLessons
      .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
      .filter((l) => typeof l.title === 'string' && typeof l.description === 'string' && typeof l.body === 'string')
      .map((l) => ({ title: l.title as string, description: l.description as string, body: l.body as string }));
    const sp = o.soulProposal as Record<string, unknown> | null | undefined;
    const soulProposal =
      sp && typeof sp.text === 'string' && sp.text.trim()
        ? { text: sp.text, reason: typeof sp.reason === 'string' ? sp.reason : '' }
        : null;
    return { lessons, soulProposal };
  } catch {
    return { lessons: [], soulProposal: null };
  }
}
