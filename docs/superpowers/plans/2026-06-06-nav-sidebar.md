# Collapsible Nav Sidebar (Epic C1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed roster section with a collapsible left navbar — Agent Team (live, runtime-aware) plus a Hermes/OpenClaw-aligned set of "soon" section placeholders — that toggles between an icon rail and a labeled sidebar (persisted).

**Architecture:** A typed `NAV_SECTIONS` config drives a new `NavSidebar` client component that replaces the roster `<section>` in `mission-control.tsx`. The existing roster markup (Sage card + agent cards) is relocated verbatim into the navbar's expanded "Agent Team" panel, each card gaining a cosmetic `claude-sdk` runtime badge. Collapsed state persists in `localStorage`. No agent/data-model changes.

**Tech Stack:** React client component, lucide-react, localStorage, node:test via tsx.

**Verified anchors (`src/components/mission-control.tsx`):**
- Roster `<section>`: opens `:813` (`w-full md:w-[280px] … ${mobileActiveTab === "team" ? "flex" : "hidden md:flex"}`), through its `</section>` just before the chat section (`:931` `{/* MIDDLE PANE */}`). Inside: header `:816-826` (AGENT TEAM label + count + Plus), **Sage card** `:828-861`, **`<ScrollArea className="flex-1 min-h-0">` + `otherAgents.map(...)`** `:863-927`.
- Data already computed: `const sage = team.find(a=>a.id==="sage")` `:754`; `const otherAgents = team.filter(...)` `:755`; `workingAgents` `:361`; `agentActivity` `:362`; `idleState()` helper; `AGENT_ICON/AGENT_ACCENT/AGENT_GLOW` maps; `AgentIcon`.
- `handleLogout` `:420` (used by the header Lock button `:801-807`) — reused for the navbar's Logout item.

---

### Task 1: Section config + test (`src/lib/nav-sections.ts`)

**Files:**
- Create: `src/lib/nav-sections.ts`, `src/lib/nav-sections.test.ts`

- [ ] **Step 1: Write the failing test.** Create `src/lib/nav-sections.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_SECTIONS } from './nav-sections';

test('NAV_SECTIONS has unique ids and required fields', () => {
  const ids = NAV_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  for (const s of NAV_SECTIONS) {
    assert.ok(s.label && s.icon && s.group, `${s.id} has label/icon/group`);
    assert.ok(s.status === 'live' || s.status === 'soon');
    assert.ok(s.group === 'operational' || s.group === 'system');
  }
});

test('Agent Team is the only live section', () => {
  const live = NAV_SECTIONS.filter((s) => s.status === 'live').map((s) => s.id);
  assert.deepEqual(live, ['agent-team']);
});
```

- [ ] **Step 2: Run, confirm FAIL.**

Run: `pnpm exec tsx --test src/lib/nav-sections.test.ts`
Expected: FAIL — cannot find module `./nav-sections`.

- [ ] **Step 3: Implement `src/lib/nav-sections.ts`:**

```ts
// Single source of truth for the left navbar sections. `icon` is a lucide-react
// export name. Only Agent Team is live today; the rest are placeholders for the
// OpenClaw operational views + Hermes pillars (Skills/Memory/Dreaming/Crons).

export type NavStatus = "live" | "soon";
export type NavGroup = "operational" | "system";

export interface NavSection {
  id: string;
  label: string;
  icon: string; // lucide-react component name
  group: NavGroup;
  status: NavStatus;
}

export const NAV_SECTIONS: NavSection[] = [
  { id: "agent-team", label: "Agent Team", icon: "Users", group: "operational", status: "live" },
  { id: "live-feed", label: "Live Feed", icon: "Radio", group: "operational", status: "soon" },
  { id: "task-board", label: "Task Board", icon: "LayoutGrid", group: "operational", status: "soon" },
  { id: "proposals", label: "Proposals", icon: "Inbox", group: "operational", status: "soon" },
  { id: "skills", label: "Skills", icon: "Sparkles", group: "system", status: "soon" },
  { id: "memory", label: "Memory", icon: "Brain", group: "system", status: "soon" },
  { id: "dreaming", label: "Dreaming", icon: "Moon", group: "system", status: "soon" },
  { id: "scheduler", label: "Scheduler", icon: "CalendarClock", group: "system", status: "soon" },
];
```

- [ ] **Step 4: Run, confirm PASS.**

Run: `pnpm exec tsx --test src/lib/nav-sections.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite.**

Run: `pnpm test`
Expected: `tests 74 / pass 74 / fail 0` (existing 72 + 2 new).

- [ ] **Step 6: Commit.**

```bash
git add src/lib/nav-sections.ts src/lib/nav-sections.test.ts
git commit -m "feat(nav-sidebar): NAV_SECTIONS config (Agent Team live + Hermes/OpenClaw placeholders) + test"
```

---

### Task 2: `NavSidebar` component (`src/components/nav-sidebar.tsx`)

**Files:**
- Create: `src/components/nav-sidebar.tsx`

**Approach:** the component owns the navbar chrome (collapse state, section nav, bottom items). The **roster markup is relocated, not rewritten** — copy the exact JSX from `mission-control.tsx` into the spots marked below, then add the runtime badge.

- [ ] **Step 1: Create the file skeleton.** Create `src/components/nav-sidebar.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import * as Icons from "lucide-react";
import {
  ChevronLeft, ChevronRight, RefreshCw, Plus, Settings, LogOut, type LucideIcon,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { NAV_SECTIONS } from "@/lib/nav-sections";
import { AGENT_ACCENT, AGENT_GLOW, AgentIcon, idleState } from "@/components/mission-control-bits";
import type { Agent } from "@/lib/mock-data";

const COLLAPSE_KEY = "mc_nav_collapsed";
const RUNTIME = "claude-sdk";

export default function NavSidebar({
  team,
  sage,
  otherAgents,
  workingAgents,
  agentActivity,
  mobileActive,
  onLogout,
}: {
  team: Agent[];
  sage: Agent | undefined;
  otherAgents: Agent[];
  workingAgents: string[];
  agentActivity: Record<string, string>;
  mobileActive: boolean;
  onLogout: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  }

  const lucide = (name: string): LucideIcon =>
    (Icons as unknown as Record<string, LucideIcon>)[name] ?? Icons.Square;

  const operational = NAV_SECTIONS.filter((s) => s.group === "operational");
  const system = NAV_SECTIONS.filter((s) => s.group === "system");

  const sectionRow = (s: (typeof NAV_SECTIONS)[number]) => {
    const Icon = lucide(s.icon);
    const live = s.status === "live";
    return (
      <button
        key={s.id}
        disabled={!live}
        title={collapsed ? `${s.label}${live ? "" : " · coming soon"}` : live ? undefined : "Coming soon"}
        className={`w-full flex items-center ${collapsed ? "justify-center" : "gap-2"} px-2 py-1.5 rounded-md text-[11px] font-mono transition-colors ${
          s.id === "agent-team"
            ? "bg-[#11233a] text-[#00e0ff]"
            : live
              ? "text-[#8b949e] hover:bg-[#1c2330]"
              : "text-[#3a424d] cursor-default"
        }`}
      >
        <Icon className="w-4 h-4 shrink-0" />
        {!collapsed && <span className="flex-1 text-left truncate">{s.label}</span>}
        {!collapsed && !live && <span className="text-[8px] uppercase tracking-wider text-[#3a424d]">soon</span>}
      </button>
    );
  };

  return (
    <aside
      className={`bg-[#11161d] border-r border-[#1e2632] flex flex-col shrink-0 transition-[width] duration-150 ${
        collapsed ? "w-[52px]" : "w-[210px]"
      } ${mobileActive ? "flex w-full md:w-auto" : "hidden md:flex"}`}
    >
      {/* header: logo + collapse toggle */}
      <div className="h-11 flex items-center justify-between px-2 border-b border-[#1e2632] shrink-0 select-none">
        {!collapsed && <span className="text-[10px] font-mono text-[#5c6470] tracking-widest uppercase pl-1">Mission Control</span>}
        <button onClick={toggle} title={collapsed ? "Expand" : "Collapse"} className="w-7 h-7 flex items-center justify-center rounded text-[#5c6470] hover:text-[#00e0ff] hover:bg-[#161c25] transition-colors">
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* operational nav */}
      <div className="px-1.5 pt-2 flex flex-col gap-0.5 shrink-0">
        {!collapsed && <div className="text-[8px] font-mono text-[#3a424d] uppercase tracking-widest px-2 mb-0.5">Operational</div>}
        {operational.map(sectionRow)}
      </div>

      {/* Agent Team panel (the active section) */}
      <div className="flex-1 min-h-0 flex flex-col border-t border-[#1e2632] mt-2">
        {!collapsed && (
          <div className="p-2 flex items-center justify-between shrink-0 select-none">
            <span className="text-[10px] font-mono text-[#5c6470] tracking-widest uppercase">Agent Team · {team.length}</span>
            <button className="text-[#00e0ff] hover:text-[#00c0dd] transition-colors"><Plus className="w-4 h-4" /></button>
          </div>
        )}

        {/* === RELOCATE: Sage card === */}
        {/* Paste the Sage card block from mission-control.tsx (the `{sage && ( ... )}`
            block, ~:828-861) HERE. Then add a runtime badge inside the name area:
            after the `Orchestration Engine` line, add:
              <div className="text-[8.5px] font-mono text-[#5c6470]">{RUNTIME}</div>
            In collapsed mode it still renders the avatar; the surrounding card padding
            is fine to keep. */}

        {/* === RELOCATE: other-agents list === */}
        {/* Paste the `<ScrollArea className="flex-1 min-h-0"> ... {otherAgents.map(...)} </ScrollArea>`
            block (~:863-927) HERE, unchanged, EXCEPT add a runtime badge into each
            card near the model chip — find the existing model chip span and add beside it:
              <span className="text-[8.5px] font-mono text-[#5c6470]">{RUNTIME}</span>
            (When `collapsed`, render a compact variant: the avatar + status dot only.
            Simplest: keep the existing cards but the aside is 52px so they shrink; if
            that looks cramped, gate the full card behind `{!collapsed && (...)}` and
            render just `<AgentIcon>` avatars when collapsed.) */}
      </div>

      {/* bottom: settings + logout */}
      <div className="px-1.5 py-2 border-t border-[#1e2632] shrink-0 flex flex-col gap-0.5">
        {!collapsed && <div className="text-[8px] font-mono text-[#3a424d] uppercase tracking-widest px-2 mb-0.5">System</div>}
        {system.map(sectionRow)}
        <button
          disabled
          title="Coming soon"
          className={`w-full flex items-center ${collapsed ? "justify-center" : "gap-2"} px-2 py-1.5 rounded-md text-[11px] font-mono text-[#3a424d] cursor-default`}
        >
          <Settings className="w-4 h-4 shrink-0" />
          {!collapsed && <span className="flex-1 text-left">Settings</span>}
          {!collapsed && <span className="text-[8px] uppercase tracking-wider">soon</span>}
        </button>
        <button
          onClick={onLogout}
          title="Sign out"
          className={`w-full flex items-center ${collapsed ? "justify-center" : "gap-2"} px-2 py-1.5 rounded-md text-[11px] font-mono text-[#8b949e] hover:bg-[#1c2330] hover:text-[#e6edf3] transition-colors`}
        >
          <LogOut className="w-4 h-4 shrink-0" />
          {!collapsed && <span className="flex-1 text-left">Logout</span>}
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Relocate the roster markup.** Copy the **Sage card** block (`mission-control.tsx` `:828-861`) and the **`<ScrollArea>` + `otherAgents.map`** block (`:863-927`) into the two marked spots, applying the two small badge additions noted in the comments. These blocks reference `workingAgents`, `agentActivity`, `idleState`, `AgentIcon`, `AGENT_ACCENT`, `AGENT_GLOW`, `RefreshCw` — all imported/props in this component. (`React.CSSProperties` is used inline; add `import type React from "react"` if tsc requires it.)

- [ ] **Step 3: Extract shared bits.** The Sage/agent cards use `AgentIcon`, `idleState`, `AGENT_ACCENT`, `AGENT_GLOW` which currently live in `mission-control.tsx`. Create `src/components/mission-control-bits.tsx` (`"use client"`) that **exports** `AgentIcon`, `idleState`, `AGENT_ICON`, `AGENT_ACCENT`, `AGENT_GLOW` (move their definitions there from `mission-control.tsx`), and have `mission-control.tsx` import them back. This gives both files one source. (If you prefer minimal churn, instead pass `AgentIcon`/`idleState` as props — but the shared module is cleaner.)

- [ ] **Step 4: Build.**

Run: `pnpm build`
Expected: clean compile. Report BLOCKED with the exact message on any TS error.

- [ ] **Step 5: Commit.**

```bash
git add src/components/nav-sidebar.tsx src/components/mission-control-bits.tsx
git commit -m "feat(nav-sidebar): collapsible NavSidebar with relocated roster + runtime badge"
```

---

### Task 3: Wire `NavSidebar` into `mission-control.tsx`

**Files:**
- Modify: `src/components/mission-control.tsx`

- [ ] **Step 1: Import it.** With the other `@/components` imports: `import NavSidebar from "@/components/nav-sidebar";` (and switch `AgentIcon`/`idleState`/`AGENT_*` to import from `@/components/mission-control-bits` per Task 2.3).

- [ ] **Step 2: Replace the roster section.** Delete the entire roster `<section> … </section>` (`:813` through its close before the chat `{/* MIDDLE PANE */}` at `:931`) and put in its place:

```tsx
        <NavSidebar
          team={team}
          sage={sage}
          otherAgents={otherAgents}
          workingAgents={workingAgents}
          agentActivity={agentActivity}
          mobileActive={mobileActiveTab === "team"}
          onLogout={handleLogout}
        />
```

- [ ] **Step 3: Build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript`. Pre-existing next.config.ts NFT warning acceptable.

- [ ] **Step 4: Commit.**

```bash
git add src/components/mission-control.tsx
git commit -m "feat(nav-sidebar): mount NavSidebar in place of the roster section"
```

---

### Task 4: Full verification + manual smoke

**Files:** none

- [ ] **Step 1: Build + full test suite.**

Run: `pnpm build && pnpm test`
Expected: build clean; `tests 74 / pass 74 / fail 0`.

- [ ] **Step 2: Manual smoke (operator-run).** With `pnpm dev` + logged in:
  - The left navbar shows **Operational** (Agent Team active + Live Feed/Task Board/Proposals dimmed "soon") and **System** (Skills/Memory/Dreaming/Scheduler "soon") + Settings (soon) + Logout.
  - **Agent Team** shows the 6 agents with status + a `claude-sdk` badge; Sage highlighted; working agents animate.
  - **Collapse** (chevron) → icon rail (icons + tooltips, agent avatars); **expand** → labeled sidebar; the state **persists** across reload.
  - `soon` rows are dimmed/non-interactive with a "coming soon" tooltip; **Logout** signs out; the **mobile** "team" tab shows the navbar.

---

## Wrap-up (after Task 4 passes)

- [ ] Add a "what actually happened" note to `docs/superpowers/specs/2026-06-06-nav-sidebar-design.md`.
- [ ] Update `README.md` (navbar shipped; Hermes/OpenClaw sections stubbed; C2 polish + Hermes runtime/Dream engine as future epics).
- [ ] Integrate `feature/nav-sidebar` → `dev` (operator confirms).

## Self-review (done at authoring)

- **Spec coverage:** NAV_SECTIONS config + test → Task 1; collapsible NavSidebar (icon rail ↔ labeled sidebar, persisted), section IA, roster relocation, runtime badge, settings/logout, mobile → Task 2; mount/replace roster + shared-bits extraction → Tasks 2.3/3; verification → Task 4. No gaps.
- **Placeholder scan:** the only "paste existing block" instructions (Task 2.2) are deliberate verbatim relocations with exact line anchors — not vague TODOs. New chrome code is complete.
- **Type/name consistency:** `NAV_SECTIONS`/`NavSection`, `NavSidebar` props (`team/sage/otherAgents/workingAgents/agentActivity/mobileActive/onLogout`), `mc_nav_collapsed`, and the `mission-control-bits` exports (`AgentIcon/idleState/AGENT_ICON/AGENT_ACCENT/AGENT_GLOW`) are consistent across tasks. Test count 72 → 74 (Tasks 1 and 4).
- **Risk note:** the roster markup uses `AGENT_*` maps + `AgentIcon` + `idleState` defined in `mission-control.tsx`; Task 2.3 extracts them to a shared module to avoid duplication. The collapsed-mode agent rendering may need a compact variant (called out in Task 2.2) — verify visually in Task 4 and adjust.
