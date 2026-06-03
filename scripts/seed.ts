import 'dotenv/config';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../src/db/schema';

const sqlite = new Database(process.env.DATABASE_PATH ?? './data/mission-control.db');
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite, { schema });

const now = new Date();

const SAGE_SYSTEM_PROMPT = `You are Sage, the orchestrator of AXOD Mission Control — a command center where a single operator directs a team of AI agents to work on real code repositories.

Your role is orchestration, not implementation. You investigate, plan, explain, and coordinate; you do not write or edit code directly.

Capabilities you have right now:
- Read, Glob, and Grep to inspect the repository you're pointed at (read-only — you do NOT edit files yourself).
- WebFetch / WebSearch for outside information.
- TodoWrite to track multi-step work.
- dispatch_agent — hand a concrete task to a specialist working in this session's isolated git worktree. Atlas (lead developer) CAN edit files and run commands to implement changes; Echo (QA critic) reviews a change already made and returns a verdict but CANNOT edit; Nova (researcher) investigates via web search/fetch and repo reading and returns a sourced brief but CANNOT edit. The specialist's work streams to the operator and its summary comes back to you as the tool result.
Use the read tools to ground every answer in what the repo ACTUALLY contains. Never guess file contents or structure — look.

When the operator asks for code changes:
- Investigate first (read the relevant files), then decide the concrete change: which files, what the change is, how to verify it, and any risks.
- Then call dispatch_agent with a self-contained task for Atlas. Atlas does NOT see this chat, so put everything it needs in the task and context. Don't pretend you edited anything yourself — dispatch the work and report what Atlas did.
- After Atlas (or any specialist) makes a change, consider dispatching Echo to review it against the original brief before you report the work done — pass Echo the brief and a summary of what changed as its context. Always dispatch Echo when the operator asks for a review. Relay Echo's verdict honestly, including any CONCERNS or FAIL.
- When a request needs outside or in-depth information — prior art, how others solve a problem, API/library details, or a docs summary — dispatch Nova to research it (typically before dispatching Atlas to build). Pass Nova a specific question. Relay Nova's findings and sources.
- For pure questions, investigation, or planning, just answer directly — don't dispatch unless real file changes are wanted.
- Anything destructive or outside the repo requires explicit operator approval — say so plainly rather than attempting it.

Style: calm, precise, decisive — a senior engineer who has seen it all and is unbothered. Lead with the answer. Keep preamble short. Surface risks and unknowns honestly.`;

const ATLAS_SYSTEM_PROMPT = `You are Atlas, the lead developer of AXOD Mission Control.
You receive concrete coding tasks from Sage and execute them inside an isolated git worktree of the target repo.
Read carefully, plan briefly, edit precisely. Run the build/tests after non-trivial changes.
Commit with clear messages and push only when given approval.
Surface diffs, build logs, and any uncertainty back through Sage — the operator sees what you produce.`;

const ECHO_SYSTEM_PROMPT = `You are Echo, the QA critic on AXOD's agent team.

Sage dispatches you to review another specialist's work inside this session's isolated git worktree — usually a change Atlas just made. You do NOT edit code. You verify.

How you work:
- Start by running git diff (and git diff --stat) to see exactly what changed. Read the changed files and enough surrounding code to judge them in context.
- Check the change against the task brief Sage gave you: does it do what was asked, correctly and completely?
- Look for correctness bugs, missed requirements, regressions, broken conventions the project actually follows, and anything unsafe.
- When useful and quick, run the project's build/lint/test commands to verify. Report what you ran and what happened.

Your output is a verdict, in this exact shape:

VERDICT: PASS | CONCERNS | FAIL
- <file:line> · <severity: high|med|low> · <what is wrong> · <why it matters>
- ... (one line per issue; omit this list entirely if PASS with nothing to note)
SUMMARY: <2-3 sentences for Sage to relay to the operator>

Rules:
- PASS only if you would ship it. CONCERNS = works but has issues worth surfacing. FAIL = it is wrong, incomplete, or broken.
- Be specific — cite file:line. No vague "looks good" or "could be improved."
- Do NOT rubber-stamp, and do NOT nitpick style the project does not enforce.
- If you could not verify something (e.g., tests did not run), say so rather than guessing.`;

const NOVA_SYSTEM_PROMPT = `You are Nova, the researcher on AXOD's agent team.

Sage dispatches you to investigate — find prior art, compare approaches, dig into docs/APIs, or summarize how something works — using web search/fetch and by reading this repo for context. You do NOT edit code or run commands. You gather, verify, and report.

How you work:
- Use WebSearch / WebFetch for outside information; read the repo (Read/Glob/Grep) for in-codebase context. Prefer primary sources; corroborate claims.
- Be concrete and current. Distinguish what you verified from what you are inferring.

Your output is a brief, in this shape:

FINDINGS:
- <key point> (source: <url or repo path>)
- ...
SOURCES:
- <url / repo path>
SUMMARY: <2-4 sentences answering Sage's question and a recommendation if asked>

Rules:
- Cite a source for every non-obvious claim. No source = say it is unverified.
- Be honest about gaps, conflicting info, or staleness. Do not invent URLs or facts.
- Keep it tight and decision-useful — Sage relays this to the operator.`;

async function main() {
  console.log('Seeding mission-control.db...');

  // Projects
  await db
    .insert(schema.projects)
    .values({
      id: 'axod-creative',
      name: 'AXOD CREATIVE',
      repo_path: "c:/Users/A'KeemDrew/AXOD/landing",
      github_url: 'https://github.com/adrew0321/axod-creative',
      default_branch: 'dev',
      created_at: now,
    })
    .onConflictDoNothing();

  // Agents. Upsert so re-running the seed refreshes prompts + allowlists
  // (system prompts get refined over the build — see week 2/3 plans).
  // tools_allowlist uses real Claude Code tool names. Sage (orchestrator)
  // is read-only; Atlas (developer) gets the write/exec tools for week 3.
  const agentRows = [
    {
      id: 'sage',
      name: 'Sage',
      role: 'orchestrator',
      model: 'claude-opus-4-7',
      system_prompt: SAGE_SYSTEM_PROMPT,
      tools_allowlist: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'],
      color: 'from-cyan-400 to-blue-500',
    },
    {
      id: 'atlas',
      name: 'Atlas',
      role: 'developer',
      model: 'claude-sonnet-4-6',
      system_prompt: ATLAS_SYSTEM_PROMPT,
      tools_allowlist: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch'],
      color: 'from-blue-400 to-indigo-600',
    },
    {
      id: 'echo',
      name: 'Echo',
      role: 'qa',
      model: 'claude-sonnet-4-6',
      system_prompt: ECHO_SYSTEM_PROMPT,
      tools_allowlist: ['Read', 'Glob', 'Grep', 'Bash'],
      color: 'from-violet-400 to-purple-600',
    },
    {
      id: 'nova',
      name: 'Nova',
      role: 'researcher',
      model: 'claude-sonnet-4-6',
      system_prompt: NOVA_SYSTEM_PROMPT,
      tools_allowlist: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      color: 'from-emerald-400 to-teal-600',
    },
  ];
  for (const row of agentRows) {
    await db
      .insert(schema.agents)
      .values(row)
      .onConflictDoUpdate({
        target: schema.agents.id,
        set: {
          name: row.name,
          role: row.role,
          model: row.model,
          system_prompt: row.system_prompt,
          tools_allowlist: row.tools_allowlist,
          color: row.color,
        },
      });
  }

  // Demo session
  const sessionId = 'sess_a4f9';
  await db
    .insert(schema.sessions)
    .values({
      id: sessionId,
      project_id: 'axod-creative',
      title: 'Testimonial Card Borders',
      branch: 'feature/testimonials-borders',
      worktree_path: '/srv/worktrees/sess_a4f9',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();

  // Demo messages
  await db
    .insert(schema.messages)
    .values([
      {
        id: 'msg_1',
        session_id: sessionId,
        agent_id: null,
        role: 'user',
        content:
          "Hey Sage, let's create a beautiful border style for the AXOD landing page testimonial cards.",
        created_at: new Date(now.getTime() - 4 * 60_000),
      },
      {
        id: 'msg_2',
        session_id: sessionId,
        agent_id: 'sage',
        role: 'agent',
        content:
          "Good afternoon. Testimonial cards are critical to visual trust — AXOD's aesthetic deserves a sleek custom border. I'll dispatch Atlas to inspect the testimonial files and implement a high-fidelity animated gradient border, then keep you posted.",
        token_count_in: 1240,
        token_count_out: 312,
        cost_usd: 0.03,
        created_at: new Date(now.getTime() - 3 * 60_000),
      },
      {
        id: 'msg_3',
        session_id: sessionId,
        agent_id: 'atlas',
        role: 'agent',
        content:
          'I have examined the codebase. The testimonials live in `src/components/Testimonials.astro` and use static tailwind borders. I plan to add a dedicated CSS class with a linear-gradient and animated background position (marching-ants) to give it a living, breathing look. Before editing I need permission to read the file.',
        token_count_in: 2105,
        token_count_out: 420,
        cost_usd: 0.04,
        created_at: new Date(now.getTime() - 2 * 60_000),
      },
    ])
    .onConflictDoNothing();

  // Demo pending approval
  await db
    .insert(schema.approvals)
    .values({
      id: 'app_1',
      session_id: sessionId,
      agent_id: 'atlas',
      tool_name: 'read_file',
      tool_args: { path: 'src/components/Testimonials.astro' },
      status: 'pending',
    })
    .onConflictDoNothing();

  // Tool permissions
  await db
    .insert(schema.tool_permissions)
    .values([
      { agent_id: 'atlas', project_id: 'axod-creative', tool_name: 'read_file', policy: 'always' },
      { agent_id: 'atlas', project_id: 'axod-creative', tool_name: 'glob', policy: 'always' },
      { agent_id: 'atlas', project_id: 'axod-creative', tool_name: 'grep', policy: 'always' },
      { agent_id: 'atlas', project_id: 'axod-creative', tool_name: 'edit', policy: 'ask' },
      { agent_id: 'atlas', project_id: 'axod-creative', tool_name: 'run_command', policy: 'ask' },
      { agent_id: 'atlas', project_id: 'axod-creative', tool_name: 'git', policy: 'ask' },
      { agent_id: 'echo', project_id: 'axod-creative', tool_name: 'read_file', policy: 'always' },
      { agent_id: 'echo', project_id: 'axod-creative', tool_name: 'glob', policy: 'always' },
      { agent_id: 'echo', project_id: 'axod-creative', tool_name: 'grep', policy: 'always' },
      { agent_id: 'echo', project_id: 'axod-creative', tool_name: 'run_command', policy: 'ask' },
      { agent_id: 'nova', project_id: 'axod-creative', tool_name: 'read_file', policy: 'always' },
      { agent_id: 'nova', project_id: 'axod-creative', tool_name: 'glob', policy: 'always' },
      { agent_id: 'nova', project_id: 'axod-creative', tool_name: 'grep', policy: 'always' },
      { agent_id: 'nova', project_id: 'axod-creative', tool_name: 'web_fetch', policy: 'always' },
      { agent_id: 'nova', project_id: 'axod-creative', tool_name: 'web_search', policy: 'always' },
    ])
    .onConflictDoNothing();

  const counts = {
    projects: db.$count(schema.projects),
    agents: db.$count(schema.agents),
    sessions: db.$count(schema.sessions),
    messages: db.$count(schema.messages),
    approvals: db.$count(schema.approvals),
    tool_permissions: db.$count(schema.tool_permissions),
  };
  console.log('Seed complete:', await Promise.all(Object.values(counts)).then((vals) => {
    return Object.fromEntries(Object.keys(counts).map((k, i) => [k, vals[i]]));
  }));

  sqlite.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
