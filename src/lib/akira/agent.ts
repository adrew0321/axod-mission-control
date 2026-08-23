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
  // The old boundary here — no Read/Glob/Grep because they'd reach .env and the
  // live database as `mc` — is gone. It was removed DELIBERATELY by sub-project C
  // (docs/superpowers/specs/2026-08-22-akira-host-reach-design.md, D1: reach is
  // total): she now has host `read`/`list`/`write`/`bash` via the host agent, and
  // that reaches .env and the database anyway, by design (D2: awareness via the
  // action log, not a veto — see action-log.ts).
  //
  // Read/Glob/Grep are STILL absent, for a different reason: per D4, those run
  // in-process, in the server's own event loop — a long-running one would block
  // the process AKIRA is thinking inside. Reach goes through the host agent
  // instead (see scripts/seed.ts), where every action is logged.
  // 'Skill' is required for her vault skills to be invocable at all: this codebase
  // feeds tools_allowlist into the SDK's `tools` (the base capability set), not
  // just `allowedTools`, so without it skills are discovered but uncallable.
  tools_allowlist: ['WebFetch', 'WebSearch', 'TodoWrite', 'Skill'] as string[],
  color: 'from-sky-300 to-cyan-400',
};
