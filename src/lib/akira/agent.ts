// Pure AKIRA agent metadata — no db, no server-only, so the tsx test runner can
// import it. Pulls the canonical system prompt from ./prompt (also pure).

import { AKIRA_SYSTEM_PROMPT } from './prompt';

export const AKIRA_AGENT_ID = 'akira';
export const AKIRA_SESSION_ID = 'akira';

export const AKIRA_AGENT = {
  id: AKIRA_AGENT_ID,
  name: 'AKIRA',
  role: 'concierge',
  // Haiku: AKIRA is light-duty (summarize/route/chat) and latency-sensitive
  // (brief runs every landing); far lighter on the Pro cap than Opus.
  model: 'claude-haiku-4-5-20251001',
  system_prompt: AKIRA_SYSTEM_PROMPT,
  tools_allowlist: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'] as string[],
  color: 'from-sky-300 to-cyan-400',
};
