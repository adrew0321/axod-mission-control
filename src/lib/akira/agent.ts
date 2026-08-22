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
  // NO Read/Glob/Grep — see the note in scripts/seed.ts. These execute in the MC
  // process as `mc` with cwd=/srv/mission-control, so they reach .env and the live
  // database. room_read covers files; relay covers code.
  // 'Skill' is required for her vault skills to be invocable at all: this codebase
  // feeds tools_allowlist into the SDK's `tools` (the base capability set), not
  // just `allowedTools`, so without it skills are discovered but uncallable.
  tools_allowlist: ['WebFetch', 'WebSearch', 'TodoWrite', 'Skill'] as string[],
  color: 'from-sky-300 to-cyan-400',
};
