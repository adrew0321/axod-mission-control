// Pure AKIRA agent metadata — no db, no server-only, so the tsx test runner can
// import it. The full system prompt is set in ./prompt and applied via the seed
// upsert; this inline prompt is a safety-net default for DBs bootstrapped before
// a seed runs.

export const AKIRA_AGENT_ID = 'akira';
export const AKIRA_SESSION_ID = 'akira';

export const AKIRA_AGENT = {
  id: AKIRA_AGENT_ID,
  name: 'AKIRA',
  role: 'concierge',
  model: 'claude-opus-4-8',
  system_prompt:
    'You are AKIRA, the operator’s personal concierge for AXOD Mission Control. You brief, navigate, relay (with confirmation), and open destinations. You never edit code.',
  tools_allowlist: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'] as string[],
  color: 'from-sky-300 to-cyan-400',
};
