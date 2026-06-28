/**
 * Builds the orchestrator's prompt from a session's stored messages — the fix
 * for Sage having no memory within a session. Pure: no IO, never throws.
 * See docs/superpowers/specs/2026-06-01-session-memory-design.md.
 */

export interface TranscriptMessage {
  role: 'user' | 'agent' | 'system';
  agentId?: string | null;
  content: string;
}

const FRAMING_HEADER =
  'This is the ongoing conversation for the current session. Reply to the latest Operator message below, using the full context of the conversation. ' +
  'When you dispatch an agent and receive its report, do NOT restate or re-summarize the report — the Operator can already read it. ' +
  'Reply with at most a one-line TL;DR of the outcome, or simply note the report is ready. Never duplicate information the Operator can already see.';

/**
 * Render messages (in the order given — caller passes them chronologically) into
 * an attributed transcript. `agentLabels` maps an agentId to a display label,
 * e.g. { sage: 'Sage', atlas: 'Atlas (developer)' }. System rows and
 * empty/whitespace content are skipped.
 */
export function buildOrchestratorPrompt(
  messages: TranscriptMessage[],
  agentLabels: Record<string, string>,
): string {
  const blocks: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const content = m.content?.trim();
    if (!content) continue;
    const label =
      m.role === 'user'
        ? 'Operator'
        : (m.agentId && agentLabels[m.agentId]) || m.agentId || 'Agent';
    blocks.push(`${label}: ${content}`);
  }
  if (blocks.length === 0) return FRAMING_HEADER;
  return `${FRAMING_HEADER}\n\n${blocks.join('\n\n')}`;
}
