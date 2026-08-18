# AKIRA In-Vault Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AKIRA a repertoire of named workflows authored as Markdown in her vault, editable in Obsidian, plus the scoped write capability those workflows need.

**Architecture:** Skills live at `data/akira-memory/skills/<name>/SKILL.md`, reached by the SDK through a `.claude/skills` symlink (probe-verified). The vault is registered via `additionalDirectories` and enabled with `skills: 'all'`, with `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` suppressing the ~13 developer skills that ship with Claude Code. One new tool, `vault_write`, lets her write into the document tree. Shipped skills are seeded from a `vault-seed/` directory in this repo, copied only when absent so vault edits always win.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk@0.3.228`, `node:test` via `tsx`, `node:fs`, Zod (tool schemas), in-process MCP server.

**Spec:** `docs/superpowers/specs/2026-08-18-akira-vault-skills-design.md`

## Global Constraints

- **Imports are extensionless.** `import { x } from './store'` — a `.ts` extension breaks `tsc` and the Next build.
- **Tests are `node:test` run through `tsx`.** No test-runner dependency. Full suite: `pnpm test`. Single file: `pnpm exec tsx --test <path>`.
- **File-system tests use temp dirs** via `mkdtempSync(join(tmpdir(), '<prefix>-'))` with `rmSync(dir, { recursive: true, force: true })` in a `finally`.
- **Never operate on a real vault path.** The live vault is on the Mini at `/srv/mission-control/data/akira-memory`.
- **`vault_write` guards are the security surface.** Containment, `memory/`, and Markdown-only are the three that remain. `SOUL.md`, the root `CLAUDE.md`, and `skills/` are **deliberately allowed** (spec D5, D10) — a test must pin that so a future tightening cannot happen by accident.
- **Symlink creation must be non-fatal.** The dev laptop is Windows, where `symlinkSync` needs Developer Mode or admin, and that is where tests run. Only the Mini must actually succeed.
- **Commits are Conventional Commits** ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Vendored third-party content keeps its licence.** `kepano/obsidian-skills` is MIT; the `LICENSE` file travels with the skill folder.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/agent-runner-sdk.ts` (modify) | Thread `additionalDirectories` and `skills` through `RunAgentOptions` into the SDK `query` options |
| `src/lib/akira/vault-write.ts` (create) | Path guards (pure) + the write; the slice's security surface |
| `src/lib/akira/vault-write.test.ts` (create) | One case per guard, plus the deliberately-allowed paths |
| `src/lib/akira/tools.ts` (modify) | Register the `vault_write` MCP tool |
| `src/lib/akira-turn.ts` (modify) | Pass `additionalDirectories`, `skills`, `extraEnv`, and the new tool name |
| `src/lib/akira/prompt.ts` (modify) | One paragraph telling her she has skills and may write them |
| `vault-seed/skills/vault-gardening/SKILL.md` (create) | Index-drift sweep |
| `vault-seed/skills/distil-research/SKILL.md` (create) | Raw capture → distilled page |
| `vault-seed/skills/obsidian-markdown/**` (create) | Vendored MIT reference skill |
| `scripts/migrate-vault.ts` (modify) | `skills` zone, `ensureSkillsLink`, seed copy |
| `scripts/migrate-vault.test.ts` (modify) | Cover the link and the seed copy |

---

### Task 1: Thread `additionalDirectories` and `skills` through the agent runner

**Files:**
- Modify: `src/lib/agent-runner-sdk.ts` (the `RunAgentOptions` interface, and the `options` object inside `query({...})`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: two new optional fields on `RunAgentOptions` —
  `additionalDirectories?: string[]` and `skills?: string[] | 'all'`. Both default
  to unset, so no existing agent's behaviour changes.

**Why no unit test:** this file spawns the `claude` CLI subprocess and has no
existing test. Its gate is `tsc --noEmit` plus Task 2, which proves the wiring
against a real invocation. Do not build a test harness for the subprocess.

- [ ] **Step 1: Add the two options to the interface**

In `src/lib/agent-runner-sdk.ts`, inside `RunAgentOptions`, directly after the `extraEnv` field:

```typescript
  /**
   * Extra working-directory roots. The SDK reloads CLAUDE.md, skills, and
   * plugins from each. AKIRA uses this to reach her vault's skills — the vault
   * is a strict subdirectory of her cwd, which is what makes it addressable.
   */
  additionalDirectories?: string[];
  /**
   * Skills to enable. `'all'` enables every discovered skill; an array is an
   * allowlist matching each SKILL.md `name`. Per the SDK, this is the single
   * place skills are turned on — do NOT also add `'Skill'` to `allowedTools`.
   * Omitted means "no SDK opinion", which is not the same as off.
   */
  skills?: string[] | 'all';
```

- [ ] **Step 2: Destructure them alongside the existing options**

Find the destructuring block that already pulls `systemPrompt`, `mcpServers`, `maxTurns` and so on out of `opts`, and add both names to it so they are in scope for the `query` call.

- [ ] **Step 3: Pass them to the SDK**

In the `options` object inside `query({ ... })`, immediately after the `...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),` line:

```typescript
        ...(additionalDirectories?.length ? { additionalDirectories } : {}),
        ...(skills ? { skills } : {}),
```

Both use the same conditional-spread style as every other optional option in that block. An empty array must not be passed, hence the `?.length` check.

- [ ] **Step 4: Verify the typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. If the SDK rejects either property name, stop and report it — the spec's first open question is precisely whether these are real in this SDK version, and a type error is the cheapest possible answer.

- [ ] **Step 5: Run the full suite for regressions**

Run: `pnpm test`
Expected: 671 total / 667 pass / 0 fail / 4 skipped, unchanged from the baseline.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent-runner-sdk.ts
git commit -m "feat(agent): thread additionalDirectories and skills to the SDK

Both default to unset, so no existing agent's behaviour changes. AKIRA uses
them to reach the skills in her vault.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Probe that skill discovery and bundled suppression actually work

**Files:** none committed. This is a verification gate that answers the spec's first open question before anything is built on it.

**Interfaces:**
- Consumes: `additionalDirectories` and `skills` from Task 1.

**What is being proven:** that `skills: 'all'` surfaces a skill found through
`additionalDirectories` into a real agent invocation, and that
`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` removes the bundled skills without
removing ours. A probe on the Mini already proved discovery follows a symlinked
`.claude/skills`; this proves the SDK call path in *this* codebase carries it.

- [ ] **Step 1: Build a throwaway vault in the scratchpad**

Use the session scratchpad directory, not `/tmp`. Create this layout, where `ROOT` is a fresh temp directory and `ROOT/vault` is the fake vault (a strict subdirectory, mirroring production):

```
ROOT/vault/skills/probe-skill/SKILL.md
ROOT/vault/.claude/skills -> ../skills
```

`SKILL.md` content:

```markdown
---
name: probe-skill
description: A throwaway probe skill used to verify that vault skill discovery reaches a real agent invocation.
---
Reply with the single word PROBEOK.
```

On Windows, `ln -s` in Git Bash does not create a real symlink. If you cannot create one, run this probe over SSH on the Mini instead (`ssh akeem@10.0.0.219`), which is the environment that actually matters. Say in your report which environment you used.

- [ ] **Step 2: Write a scratch harness that calls the real runner**

Write to the scratchpad (NOT the repo), a file that imports the real runner so the probe exercises the production path:

```typescript
import { runClaudeAgent } from '../../src/lib/agent-runner-sdk';

const VAULT = process.env.PROBE_VAULT!;
let out = '';
for await (const e of runClaudeAgent({
  prompt: 'List the names of every skill available to you, comma separated. Names only.',
  workingDir: process.env.PROBE_ROOT!,
  allowedTools: ['Read', 'Glob', 'Grep'],
  additionalDirectories: [VAULT],
  skills: 'all',
  extraEnv: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' },
  maxTurns: 2,
})) {
  if (e.type === 'token') out += e.content;
}
console.log('---AGENT SAID---');
console.log(out);
```

- [ ] **Step 3: Run it and read the answer**

Expected: the output names `probe-skill`, and does NOT name the bundled skills (`code-review`, `security-review`, `simplify`, `loop`, `schedule`, `init`).

Three outcomes, and each changes what happens next:

- **`probe-skill` present, bundled absent** — the design holds. Continue to Task 3.
- **`probe-skill` present, bundled also present** — `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` is not taking effect through `extraEnv`. Not fatal: the skills still work, and the cost is context. Report it and continue; the controller decides whether to chase it.
- **`probe-skill` absent** — `additionalDirectories` does not carry skill discovery in this call path. **Stop and report.** This invalidates the spec's central mechanism, and the fallback (making the vault itself the cwd, or generating into MC's own `.claude/skills/`) is a design decision, not an implementation one.

- [ ] **Step 4: Delete the scratch harness and the throwaway vault**

This task commits nothing. Leave no files in the repo.

---

### Task 3: `vault-write.ts` — the guards

**Files:**
- Create: `src/lib/akira/vault-write.ts`
- Create: `src/lib/akira/vault-write.test.ts`

**Interfaces:**
- Consumes: `vaultDir()` from `./memory/store` (the vault ROOT, not `memoryDir()`).
- Produces:
  - `type VaultWriteRejection = 'empty-path' | 'not-markdown' | 'outside-vault' | 'memory-zone'`
  - `checkVaultPath(relPath: string, root: string): { ok: boolean; reason?: VaultWriteRejection; abs?: string }`
  - `vaultWrite(relPath: string, content: string, root?: string): { path: string; bytes: number }`

**Note on the test glob:** `src/lib/akira/*.test.ts` is already in the `test` script in `package.json`. No change needed there.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/akira/vault-write.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVaultPath, vaultWrite } from './vault-write';

function vault() {
  const d = mkdtempSync(join(tmpdir(), 'akira-vw-'));
  for (const z of ['memory', 'projects', 'ops', 'research', 'outputs', 'personal', 'skills']) {
    mkdirSync(join(d, z), { recursive: true });
  }
  return d;
}

test('rejects an empty path', () => {
  const d = vault();
  try {
    assert.equal(checkVaultPath('   ', d).reason, 'empty-path');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rejects anything that is not markdown', () => {
  const d = vault();
  try {
    assert.equal(checkVaultPath('ops/script.sh', d).reason, 'not-markdown');
    assert.equal(checkVaultPath('.claude/settings.json', d).reason, 'not-markdown');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rejects paths that escape the vault', () => {
  const d = vault();
  try {
    assert.equal(checkVaultPath('../escaped.md', d).reason, 'outside-vault');
    assert.equal(checkVaultPath('ops/../../escaped.md', d).reason, 'outside-vault');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rejects the memory zone, which remember/forget owns', () => {
  const d = vault();
  try {
    assert.equal(checkVaultPath('memory/note.md', d).reason, 'memory-zone');
    assert.equal(checkVaultPath('memory/INDEX.md', d).reason, 'memory-zone');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('ALLOWS SOUL.md, the root map, and skills — deliberate, per spec D5/D10', () => {
  const d = vault();
  try {
    assert.equal(checkVaultPath('SOUL.md', d).ok, true, 'SOUL is writable by design (D10)');
    assert.equal(checkVaultPath('CLAUDE.md', d).ok, true, 'the vault map is writable by design (D10)');
    assert.equal(checkVaultPath('skills/foo/SKILL.md', d).ok, true, 'she may author skills (D5)');
    assert.equal(checkVaultPath('INDEX.md', d).ok, true);
    assert.equal(checkVaultPath('research/a-page.md', d).ok, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a symlink pointing outside the vault cannot be used as a bridge', (t) => {
  const d = vault();
  const outside = mkdtempSync(join(tmpdir(), 'akira-outside-'));
  try {
    try {
      symlinkSync(outside, join(d, 'ops', 'escape'), 'dir');
    } catch {
      t.skip('symlink creation unavailable (Windows without Developer Mode)');
      return;
    }
    assert.equal(checkVaultPath('ops/escape/pwned.md', d).reason, 'outside-vault');
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a symlink INSIDE the vault resolves and is allowed', (t) => {
  const d = vault();
  try {
    mkdirSync(join(d, '.claude'), { recursive: true });
    try {
      symlinkSync(join(d, 'skills'), join(d, '.claude', 'skills'), 'dir');
    } catch {
      t.skip('symlink creation unavailable (Windows without Developer Mode)');
      return;
    }
    const c = checkVaultPath('.claude/skills/foo/SKILL.md', d);
    assert.equal(c.ok, true, 'the .claude/skills symlink resolves back into skills/');
    assert.ok(c.abs?.includes(join('skills', 'foo')), 'and resolves to the real skills path');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('vaultWrite creates parent folders and returns the byte count', () => {
  const d = vault();
  try {
    const r = vaultWrite('research/deep/page.md', '# Hello', d);
    assert.equal(r.bytes, 7);
    assert.equal(r.path, 'research/deep/page.md');
    assert.equal(readFileSync(join(d, 'research', 'deep', 'page.md'), 'utf8'), '# Hello');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('vaultWrite throws on a rejected path and writes nothing', () => {
  const d = vault();
  try {
    assert.throws(() => vaultWrite('memory/sneaky.md', 'x', d), /memory-zone/);
    assert.equal(existsSync(join(d, 'memory', 'sneaky.md')), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/akira/vault-write.test.ts`
Expected: FAIL — cannot find module `./vault-write`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/akira/vault-write.ts`:

```typescript
// Scoped writes into AKIRA's vault document tree. Three guards remain, and none
// of them is a trust judgement (see spec D10):
//   - containment: a tool called vault_write writing OUTSIDE the vault is a bug
//   - memory/: mechanism — remember/forget own that zone; a file written here
//     without the note model is invisible to listNotes, and a hand-written
//     memory/INDEX.md is clobbered by the next remember
//   - markdown-only: keeps the vault a document tree
// SOUL.md, the root CLAUDE.md, and skills/ are deliberately writable.
import { existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { vaultDir } from './memory/store';

export type VaultWriteRejection = 'empty-path' | 'not-markdown' | 'outside-vault' | 'memory-zone';

export interface VaultPathCheck {
  ok: boolean;
  reason?: VaultWriteRejection;
  /** The real, symlink-resolved absolute path. Only set when ok. */
  abs?: string;
}

/** The deepest ancestor of `p` that exists, symlink-resolved. */
function realExistingAncestor(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return realpathSync(cur);
}

export function checkVaultPath(relPath: string, root: string): VaultPathCheck {
  const trimmed = relPath.trim();
  if (!trimmed) return { ok: false, reason: 'empty-path' };
  if (!trimmed.toLowerCase().endsWith('.md')) return { ok: false, reason: 'not-markdown' };

  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
  const abs = resolve(realRoot, trimmed);

  // Resolve the deepest existing ancestor BEFORE judging containment, so a
  // symlink inside the vault pointing outside it cannot act as a bridge.
  let probe = abs;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const realProbe = realExistingAncestor(probe);
  const real = realProbe + abs.slice(probe.length);

  const inside = real === realRoot || real.startsWith(realRoot + sep);
  if (!inside) return { ok: false, reason: 'outside-vault' };

  const rel = real.slice(realRoot.length + 1);
  if (rel.split(sep)[0] === 'memory') return { ok: false, reason: 'memory-zone' };

  return { ok: true, abs: real };
}

export function vaultWrite(
  relPath: string,
  content: string,
  root: string = vaultDir(),
): { path: string; bytes: number } {
  const c = checkVaultPath(relPath, root);
  if (!c.ok || !c.abs) throw new Error(`vault_write rejected (${c.reason}): ${relPath}`);
  mkdirSync(dirname(c.abs), { recursive: true });
  writeFileSync(c.abs, content);
  return { path: relPath.trim(), bytes: Buffer.byteLength(content) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/akira/vault-write.test.ts`
Expected: PASS. Two tests may report as skipped on Windows without Developer Mode; that is the designed behaviour, not a failure.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/vault-write.ts src/lib/akira/vault-write.test.ts
git commit -m "feat(akira): add scoped vault_write path guards

Containment resolves symlinks before judging, so a link inside the vault
pointing out of it cannot be used as a bridge. memory/ stays owned by
remember/forget. SOUL.md, the root map, and skills/ are deliberately
writable per spec D5/D10, and a test pins that so it cannot be tightened
by accident.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Register the `vault_write` tool and wire AKIRA's turn

**Files:**
- Modify: `src/lib/akira/tools.ts`
- Modify: `src/lib/akira-turn.ts`

**Interfaces:**
- Consumes: `vaultWrite` from Task 3; `additionalDirectories` / `skills` from Task 1.
- Produces: the exported tool-name constant `AKIRA_VAULT_WRITE`.

- [ ] **Step 1: Add the tool-name constant**

The tool-name constants live in `src/lib/akira/tool-actions.ts`, not in `tools.ts`, and are plain string literals (`export const AKIRA_REMEMBER = 'mcp__akira__remember';` at line 13). Add alongside them, after `AKIRA_FORGET`:

```typescript
export const AKIRA_VAULT_WRITE = 'mcp__akira__vault_write';
```

- [ ] **Step 2: Add the tool definition**

In the same file, immediately after the `forget` tool definition, add the import at the top (`import { vaultWrite } from './vault-write';`) and:

```typescript
  const vaultWriteTool = tool(
    'vault_write',
    "Write a Markdown file into your vault's document tree — projects/, ops/, research/, outputs/, personal/, skills/, any INDEX.md, SOUL.md, or the vault map. Creates parent folders. Overwrites an existing file, so read it first if you mean to append. You CANNOT write into memory/ — use remember/forget for notes. Add the file's line to its folder's INDEX.md in the same turn.",
    {
      path: z.string().min(1).describe('Path relative to the vault root, ending in .md — e.g. research/agentic-os.md'),
      content: z.string().describe('The full Markdown content. This replaces the file.'),
    },
    async (a) => {
      if (!vaultReady()) return err("Your vault isn't configured on this server yet.");
      try {
        const r = vaultWrite(a.path, a.content);
        gitCommitPush(`vault: write ${r.path}`);
        return ok(`Wrote ${r.path} (${r.bytes} bytes).`);
      } catch (e) {
        return err(e instanceof Error ? e.message : 'vault_write failed.');
      }
    },
  );
```

- [ ] **Step 3: Add it to the tool list**

In the same file, extend the `base` array so it reads:

```typescript
  const base = [navigate, open, relay, listSessions, getSession, remember, forget, vaultWriteTool];
```

- [ ] **Step 4: Wire AKIRA's turn**

In `src/lib/akira-turn.ts`, add `AKIRA_VAULT_WRITE` to the import from `./akira/tools`, then in the `runClaudeAgent({...})` call:

Add `AKIRA_VAULT_WRITE,` to the `extraAllowedTools` array, directly after `AKIRA_FORGET,`.

Then add these three options directly after the `mcpServers:` line:

```typescript
      additionalDirectories: [vaultDir()],
      skills: 'all',
      extraEnv: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' },
```

`vaultDir` is imported from `./akira/memory/store` — check whether that import already exists in this file and extend it rather than adding a duplicate.

- [ ] **Step 5: Verify**

Run: `pnpm exec tsc --noEmit` — expected: no errors.
Run: `pnpm test` — expected: no regressions (671/667/0/4 plus Task 3's new tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/akira/tools.ts src/lib/akira-turn.ts
git commit -m "feat(akira): give AKIRA vault_write and turn on vault skills

Registers the vault_write MCP tool and points her turn at the vault as an
additional working-directory root with skills enabled. Bundled Claude Code
skills are suppressed via env — they are developer tools and pure context
cost for her.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The seed skills

**Files:**
- Create: `vault-seed/README.md`
- Create: `vault-seed/skills/vault-gardening/SKILL.md`
- Create: `vault-seed/skills/distil-research/SKILL.md`
- Create: `vault-seed/skills/obsidian-markdown/**` (vendored)

**Interfaces:**
- Produces: the `vault-seed/skills/` tree that Task 6 copies into the vault.

**Why a seed directory:** the vault is a *separate* git repository cloned at
`data/akira-memory` and is not part of this repo. Shipped skills therefore need
a home here that the migration copies from. Copies happen only when the
destination is absent, so an operator edit in the vault always wins; updating a
shipped skill means deleting the vault's copy first.

- [ ] **Step 1: Write the seed README**

Create `vault-seed/README.md`:

```markdown
# Vault seed

Content copied into AKIRA's vault (`data/akira-memory`) by `pnpm vault:migrate`.

The vault is a separate git repository and is not part of this repo, so
anything that ships with the product lives here first.

**Copies happen only when the destination does not exist.** An operator edit in
the vault always wins. To push an updated version of a shipped skill, delete the
vault's copy and re-run the migration.

`skills/obsidian-markdown/` is vendored from
[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) (MIT). Its
`LICENSE` travels with it. It does not track upstream.
```

- [ ] **Step 2: Write the `vault-gardening` skill**

Create `vault-seed/skills/vault-gardening/SKILL.md`:

```markdown
---
name: vault-gardening
description: Sweep a vault zone for documents missing from their folder's INDEX.md and write the missing lines. Use when the operator asks to tidy, garden, or reindex the vault, or when you notice a folder's index is stale.
---

# Vault gardening

Every `INDEX.md` outside `memory/` is maintained by you, by hand. Nothing
generates them and nothing checks them, so they go stale silently — and a stale
index is worse than no index, because the vault's own conventions tell you to
trust it and descend only where it points.

This skill fixes one zone at a time.

## Steps

1. Ask which zone, unless the operator already said. Valid zones: `projects`,
   `ops`, `research`, `outputs`, `personal`, `skills`.
2. `Glob` the zone for `**/*.md`. Exclude every `INDEX.md` from the results.
3. `Read` the zone's `INDEX.md`.
4. For each folder that has documents, compute which of its files have no line
   in that folder's `INDEX.md`.
5. For each missing file, `Read` it and write **one line** that says what it is
   and why someone would open it. A filename restated as a sentence is not a
   summary — if you cannot say something useful, say what question the document
   answers.
6. Write the updated `INDEX.md` with `vault_write`. Preserve existing lines
   verbatim; you are adding, not rewriting.
7. Report what you added, as a count plus the notable ones. Do not paste the
   whole index back.

## Rules

- Never touch `memory/INDEX.md`. It is generated, and `vault_write` will refuse.
- Never invent a summary for a file you did not read.
- If a file is listed in an index but no longer exists, say so — do not silently
  delete the line. A missing file may be a mistake worth surfacing.
```

- [ ] **Step 3: Write the `distil-research` skill**

Create `vault-seed/skills/distil-research/SKILL.md`:

```markdown
---
name: distil-research
description: Turn a raw capture in research/ into a durable distilled page with wikilinks, and index it. Use when the operator drops an article, transcript, or notes into the vault and wants them made useful.
---

# Distil research

Raw captures are worth keeping and painful to reread. This turns one into a page
that answers questions six months from now.

## Steps

1. `Read` the raw capture. If the operator gave a URL instead, `WebFetch` it.
2. Decide the page's **claim** — the one thing it is about. If the source covers
   several unrelated things, make several pages rather than one vague one.
3. Write the page to `research/<slug>.md` with `vault_write`, using the
   structure below.
4. Link it: search the vault with `Grep` for topics the page touches, and add
   `[[wikilinks]]` to the pages that already exist. A page with no links is a
   dead end.
5. Add its line to `research/INDEX.md`, preserving the existing lines.
6. Report the claim and the links you made, in a few sentences.

## Page structure

```
# <Title>

**Source:** <url or file> · **Distilled:** <ISO date>

<Two or three sentences: what this is and why it mattered enough to keep.>

## What it actually says

<The substance. Specific claims, numbers, names. Not a summary of the summary.>

## What it means for us

<Your judgement. What would change if we acted on it. This section is the
reason the page exists — a distillation without it is just a shorter copy.>

## Links

<[[wikilinks]] to related vault pages.>
```

## Rules

- Follow the `obsidian-markdown` skill for callouts, properties, and wikilink
  syntax — this vault is read in Obsidian.
- Preserve the source reference. A distilled page whose provenance is lost
  cannot be checked.
- Never delete the raw capture. Distillation is additive.
```

- [ ] **Step 4: Vendor the `obsidian-markdown` skill**

Fetch the skill and its licence from `kepano/obsidian-skills` (MIT) and place them under `vault-seed/skills/obsidian-markdown/`. Use a shallow clone into a temp directory outside the repo, then copy — do NOT add the upstream repo as a submodule or remote:

```bash
git clone --depth 1 https://github.com/kepano/obsidian-skills.git "$TMP/obsidian-skills"
mkdir -p vault-seed/skills/obsidian-markdown
cp -R "$TMP/obsidian-skills/skills/obsidian-markdown/." vault-seed/skills/obsidian-markdown/
cp "$TMP/obsidian-skills/LICENSE" vault-seed/skills/obsidian-markdown/LICENSE
rm -rf "$TMP/obsidian-skills"
```

Set `TMP` to your session scratchpad directory first — do not clone into the repo or into `/tmp`.

Then verify by listing the result: it must contain `SKILL.md`, `LICENSE`, and a `references/` folder. Copy whatever reference files are actually present rather than assuming a fixed list. Confirm `SKILL.md`'s frontmatter has `name: obsidian-markdown`, and report the file list in your report.

**Record this as a spec deviation in your report:** the spec does not mention `vault-seed/`. It says only that the vendored skill is "copied in with its MIT license and attribution intact," without saying from where. The seed directory is this plan's answer, because the vault is a separate git repository that this repo does not contain. The controller should amend the spec's vault-shape section to name `vault-seed/` as the source.

- [ ] **Step 5: Verify the frontmatter of all three skills**

Every `SKILL.md` must open with a `---` block containing `name:` and `description:` on single lines. The `name` must match its directory name exactly — the SDK matches on it. Read all three back and confirm.

- [ ] **Step 6: Commit**

```bash
git add vault-seed
git commit -m "feat(vault): seed skills — gardening, research distillation, vendored obsidian-markdown

vault-gardening closes the index-drift hazard sub-project A shipped
knowingly. distil-research replaces the obsidian-llm-wiki plugin that was
evaluated and rejected. obsidian-markdown is vendored MIT from
kepano/obsidian-skills, licence included, and does not track upstream.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Provision the skills zone, the symlink, and the seed copy

**Files:**
- Modify: `scripts/migrate-vault.ts`
- Modify: `scripts/migrate-vault.test.ts`

**Interfaces:**
- Consumes: `vault-seed/skills/` from Task 5.
- Produces:
  - `ensureSkillsLink(dir: string): 'created' | 'exists' | 'unsupported'`
  - `seedSkills(dir: string, seedRoot?: string): string[]` — names of skills newly copied in.
  - `migrateVault` return widens to `{ moved, created, stranded, skillsLink, seeded }`.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/migrate-vault.test.ts`. Extend the existing `node:fs` import with `lstatSync` and `readFileSync` if they are not already imported:

```typescript
test('migrateVault creates the skills zone and links .claude/skills to it', (t) => {
  const d = seeded();
  try {
    const out = migrateVault(d);
    assert.ok(existsSync(join(d, 'skills')), 'skills zone exists');
    if (out.skillsLink === 'unsupported') {
      t.skip('symlink creation unavailable (Windows without Developer Mode)');
      return;
    }
    assert.equal(out.skillsLink, 'created');
    assert.ok(lstatSync(join(d, '.claude', 'skills')).isSymbolicLink());
    assert.ok(existsSync(join(d, '.claude', 'skills', 'vault-gardening', 'SKILL.md')),
      'the link resolves to the seeded skills');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('migrateVault seeds the shipped skills', () => {
  const d = seeded();
  try {
    const out = migrateVault(d);
    assert.ok(out.seeded.includes('vault-gardening'));
    assert.ok(out.seeded.includes('distil-research'));
    assert.ok(existsSync(join(d, 'skills', 'vault-gardening', 'SKILL.md')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a seeded skill the operator has edited is never overwritten', () => {
  const d = seeded();
  try {
    migrateVault(d);
    const p = join(d, 'skills', 'vault-gardening', 'SKILL.md');
    writeFileSync(p, 'HUMAN EDITED SKILL');
    const second = migrateVault(d);
    assert.equal(readFileSync(p, 'utf8'), 'HUMAN EDITED SKILL');
    assert.ok(!second.seeded.includes('vault-gardening'), 'not re-reported as seeded');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec tsx --test scripts/migrate-vault.test.ts`
Expected: FAIL — `out.skillsLink` and `out.seeded` are `undefined`.

- [ ] **Step 3: Implement**

In `scripts/migrate-vault.ts`:

Add `'skills'` to the `ZONES` tuple, after `'personal'`. Add its blurb to `ZONE_BLURB`:

```typescript
  skills: 'Named workflows AKIRA can run. Each is a folder with a SKILL.md. Edit them here.',
```

Extend the `node:fs` import with `cpSync`, `lstatSync`, and `symlinkSync`, and add `import { fileURLToPath } from 'node:url';` if the file needs it to locate the repo root — otherwise resolve the seed relative to `process.cwd()`.

Then add both functions above `migrateVault`:

```typescript
/**
 * Point the vault's .claude/skills at the Obsidian-visible skills/ zone. This
 * symlink is the whole reason skills can live somewhere Obsidian will show.
 * Non-fatal by design: the dev laptop is Windows, where symlinkSync needs
 * Developer Mode or admin, and that is where the tests run. Only the Mini has
 * to succeed.
 */
export function ensureSkillsLink(dir: string): 'created' | 'exists' | 'unsupported' {
  const claudeDir = join(dir, '.claude');
  const link = join(claudeDir, 'skills');
  // lstatSync (not existsSync) so a BROKEN symlink still counts as present —
  // existsSync follows the link and would report false, and we would then try
  // to create one that already exists.
  if (lstatSync(link, { throwIfNoEntry: false })) return 'exists';
  try {
    mkdirSync(claudeDir, { recursive: true });
    symlinkSync('../skills', link, 'dir');
    return 'created';
  } catch {
    return 'unsupported';
  }
}

/** Copy shipped skills in, never over an existing one. Vault edits win. */
export function seedSkills(dir: string, seedRoot = join(process.cwd(), 'vault-seed', 'skills')): string[] {
  if (!existsSync(seedRoot)) return [];
  const dest = join(dir, 'skills');
  mkdirSync(dest, { recursive: true });
  const added: string[] = [];
  for (const name of readdirSync(seedRoot)) {
    const to = join(dest, name);
    if (existsSync(to)) continue; // operator's copy wins
    cpSync(join(seedRoot, name), to, { recursive: true });
    added.push(name);
  }
  return added;
}
```

Inside `migrateVault`, after the existing zone-stub loop and before the return, call both and widen the return:

```typescript
  const seeded = seedSkills(dir);
  const skillsLink = ensureSkillsLink(dir);

  return { moved, created, stranded, skillsLink, seeded };
```

Widen the declared return type to `{ moved: number; created: string[]; stranded: string[]; skillsLink: 'created' | 'exists' | 'unsupported'; seeded: string[] }`.

In the CLI entry, extend the success log so the operator sees both outcomes:

```typescript
  console.log(`Vault migrated at ${dir}: ${moved} notes moved, zones created: ${created.join(', ') || 'none'}`);
  console.log(`Skills: link ${skillsLink}, seeded: ${seeded.join(', ') || 'none'}`);
  if (skillsLink === 'unsupported') {
    console.error('WARNING: .claude/skills symlink could not be created — AKIRA will not see vault skills.');
  }
```

Place these lines BEFORE the existing stranded-notes check that calls `process.exit(1)`, so a stranded-note failure does not hide the skills report.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test scripts/migrate-vault.test.ts`
Expected: PASS, including the four pre-existing migration tests. The symlink test may report skipped on Windows.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test` — expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-vault.ts scripts/migrate-vault.test.ts
git commit -m "feat(vault): provision the skills zone, symlink, and seeded skills

skills/ joins ZONES, .claude/skills is symlinked to it, and shipped skills
are copied in only when absent so operator edits always win. Symlink
creation is non-fatal — Windows needs Developer Mode and that is where the
tests run; the CLI reports which of the three outcomes occurred.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Tell AKIRA she has skills

**Files:**
- Modify: `src/lib/akira/prompt.ts`

- [ ] **Step 1: Add the paragraph**

In `AKIRA_SYSTEM_PROMPT`, immediately after the existing `Memory:` paragraph, insert:

```
Skills: you have named workflows in your vault at `skills/`, each a folder with a SKILL.md. They are listed to you automatically — invoke one when the operator's request matches its description rather than improvising the same work from scratch. You can write new ones with vault_write when you find yourself repeating a workflow he asks for; tell him in one line when you do, the same way you do for a lesson. `vault_write` also lets you write anywhere in the document tree — projects, ops, research, outputs, personal, indexes — but NOT into memory/, which remember and forget own. When you add a document to a folder, add its line to that folder's INDEX.md in the same turn.
```

- [ ] **Step 2: Verify**

Run: `pnpm exec tsc --noEmit` — expected: no errors.
Run: `pnpm test` — expected: no regressions.

- [ ] **Step 3: Commit**

```bash
git add src/lib/akira/prompt.ts
git commit -m "feat(akira): tell her she has skills and may author them

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end verification against a copy of the live vault

**Files:** none modified. This is the release gate.

- [ ] **Step 1: Copy the live vault to the scratchpad**

Windows `tar` reads a `C:` prefix as a remote host, so run from inside the scratchpad with relative paths:

```bash
cd "$SCRATCHPAD" && rm -rf vaultcheck vault.tar && mkdir -p vaultcheck
ssh akeem@10.0.0.219 'sudo -n -u mc tar -C /srv/mission-control/data -cf - akira-memory' > vault.tar
cd vaultcheck && tar -xf ../vault.tar
```

- [ ] **Step 2: Run the migration against the copy**

```bash
AKIRA_MEMORY_DIR="<scratchpad>/vaultcheck/akira-memory" pnpm vault:migrate
```

Expected: `0 notes moved` (the copy is already migrated by sub-project A), `zones created: skills`, and a `Skills:` line reporting the link outcome and both seeded skills plus `obsidian-markdown`.

- [ ] **Step 3: Assert the shape**

```bash
ls "<scratchpad>/vaultcheck/akira-memory/skills"
ls "<scratchpad>/vaultcheck/akira-memory/.claude"
```

Expected: `skills/` holds `distil-research`, `obsidian-markdown`, `vault-gardening`. On a POSIX filesystem `.claude/skills` is a symlink; on Windows expect `unsupported` and say so — this step's real verification happens on the Mini at deploy.

- [ ] **Step 4: Prove the skills reach a real agent**

Reuse Task 2's harness shape, pointing `additionalDirectories` at the migrated copy and asking the agent to list its skills.

Expected: `vault-gardening`, `distil-research`, and `obsidian-markdown` all appear; the bundled skills do not. If the symlink was `unsupported` in this environment, this step cannot pass locally — run it over SSH on the Mini instead, and say which environment you used.

- [ ] **Step 5: Clean up**

```bash
rm -rf "<scratchpad>/vaultcheck" "<scratchpad>/vault.tar"
```

This task produces no commit. It gates the release.

---

## Rollout (after all tasks land)

Follow the `ship-mc-feature` workflow. Vault-specific steps:

1. Merge to `dev`, release, deploy to the Mini.
2. **Restart the new build BEFORE migrating** — sub-project A's ordering rule still applies.
3. `cd /srv/mission-control && sudo -n -u mc pnpm vault:migrate`. Confirm the `Skills:` line reports `link created` (or `exists` on a re-run) and the seeded skills.
4. **Reseed agents** — AKIRA's system prompt changed, and a stale seeded prompt is a known trap in this repo.
5. `systemctl --failed`.
6. `git status` in the vault — the migration's commit is wrapped in an unconditional catch, so a real failure is indistinguishable from a clean tree.
7. In a live turn, ask AKIRA to list her skills and confirm all three appear.
8. Update `docs/runbook-akira-memory.md` with the skills zone and the symlink.
