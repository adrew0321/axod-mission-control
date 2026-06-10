// src/lib/nav-sections.ts
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
  { id: "live-feed", label: "Live Feed", icon: "Radio", group: "operational", status: "live" },
  { id: "task-board", label: "Task Board", icon: "LayoutGrid", group: "operational", status: "live" },
  { id: "proposals", label: "Proposals", icon: "Inbox", group: "operational", status: "live" },
  { id: "skills", label: "Skills", icon: "Sparkles", group: "system", status: "live" },
  { id: "memory", label: "Memory", icon: "Brain", group: "system", status: "soon" },
  { id: "dreaming", label: "Dreaming", icon: "Moon", group: "system", status: "soon" },
  { id: "scheduler", label: "Scheduler", icon: "CalendarClock", group: "system", status: "soon" },
];
