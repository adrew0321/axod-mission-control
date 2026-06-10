// Pure memory logic — no db, no server-only, so the tsx test runner can import it.
// Mirrors buildOrchestratorPrompt's filtering so the readout reflects what Sage
// actually receives as context.

export interface MemoryMessageInput {
  role: 'user' | 'agent' | 'system';
  senderName?: string;
  content: string;
}

export interface MemoryBlock {
  label: string; // "Operator" for user; else senderName (fallback "Agent")
  content: string;
}

export interface MemorySummary {
  blocks: MemoryBlock[];
  messageCount: number;
  approxTokens: number;
}

/** Reduce a message list to Sage's working-context blocks + a size readout. */
export function summarizeMemory(messages: MemoryMessageInput[]): MemorySummary {
  const blocks: MemoryBlock[] = [];
  let chars = 0;
  for (const m of messages) {
    if (m.role === 'system') continue;
    const content = m.content?.trim();
    if (!content) continue;
    const label = m.role === 'user' ? 'Operator' : m.senderName || 'Agent';
    blocks.push({ label, content });
    chars += content.length;
  }
  return { blocks, messageCount: blocks.length, approxTokens: Math.ceil(chars / 4) };
}
