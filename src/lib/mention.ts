/**
 * Parses a leading "@<agent>" mention so the operator can address a specialist
 * directly (bypassing Sage). Pure; never throws.
 * See docs/superpowers/specs/2026-06-01-at-mention-routing-design.md.
 */

export interface MentionAgent {
  id: string;
  name: string;
}

export interface ParsedMention {
  /** Matched agent id, or null → route to Sage. */
  agentId: string | null;
  /** The message with a leading mention removed (original text when no match). */
  text: string;
}

/**
 * Match a LEADING "@<token>" (case-insensitive) against each agent's id or the
 * first word of its name. Absent or unrecognized mention → { agentId: null }.
 */
export function parseMention(text: string, agents: MentionAgent[]): ParsedMention {
  const m = /^\s*@(\S+)\s*/.exec(text);
  if (!m) return { agentId: null, text };
  const token = m[1].toLowerCase();
  const match = agents.find(
    (a) => a.id.toLowerCase() === token || a.name.toLowerCase().split(/\s+/)[0] === token,
  );
  if (!match) return { agentId: null, text };
  return { agentId: match.id, text: text.slice(m[0].length) };
}
