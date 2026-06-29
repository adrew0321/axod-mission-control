// Pure AKIRA agent metadata — no db, no server-only, so the tsx test runner can
// import it. Pulls the canonical system prompt from ./prompt (also pure).

import { AKIRA_SYSTEM_PROMPT } from './prompt';

export const AKIRA_AGENT_ID = 'akira';
export const AKIRA_SESSION_ID = 'akira';

export const AKIRA_AGENT = {
  id: AKIRA_AGENT_ID,
  name: 'AKIRA',
  role: 'concierge',
  model: 'claude-opus-4-8',
  system_prompt: AKIRA_SYSTEM_PROMPT,
  tools_allowlist: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'] as string[],
  color: 'from-sky-300 to-cyan-400',
};
