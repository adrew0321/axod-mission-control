"use client";

// Shared agent-identity bits used by both the conversation thread (mission-control)
// and the left navbar roster (nav-sidebar): icon, accent, glow, and idle-state copy.

import { Compass, Hammer, Telescope, Bug, Palette, Cog, Sparkles, type LucideIcon } from "lucide-react";

// Per-agent identity: a distinct line icon + accent color matching each
// personality, used for the avatar, roster card border, and name.
export const AGENT_ICON: Record<string, LucideIcon> = {
  sage: Compass, // navigator / orchestrator
  atlas: Hammer, // builder / smith
  nova: Telescope, // researcher
  echo: Bug, // QA critic
  pixel: Palette, // designer
  forge: Cog, // devops
};

export const AGENT_ACCENT: Record<string, { border: string; name: string; bg: string }> = {
  sage: { border: "border-cyan-500/40", name: "text-cyan-300", bg: "bg-cyan-500/30" },
  atlas: { border: "border-indigo-500/40", name: "text-indigo-300", bg: "bg-indigo-500/30" },
  nova: { border: "border-emerald-500/40", name: "text-emerald-300", bg: "bg-emerald-500/30" },
  echo: { border: "border-violet-500/40", name: "text-violet-300", bg: "bg-violet-500/30" },
  pixel: { border: "border-pink-500/40", name: "text-pink-300", bg: "bg-pink-500/30" },
  forge: { border: "border-amber-500/40", name: "text-amber-300", bg: "bg-amber-500/30" },
};

// Raw accent hex per agent, fed to the `--glow` CSS var so the active card's
// breathing glow + sheen tint match the agent's identity. Falls back to cyan.
export const AGENT_GLOW: Record<string, string> = {
  sage: "#00e0ff",
  atlas: "#6366f1",
  nova: "#10b981",
  echo: "#8b5cf6",
  pixel: "#ec4899",
  forge: "#f59e0b",
};

export function AgentIcon({ id, className }: { id: string; className?: string }) {
  const Icon = AGENT_ICON[id] ?? Sparkles;
  return <Icon className={className} />;
}

const IDLE_STATE: Record<string, string> = {
  sage: "Standing by at the helm",
  atlas: "Hammer cooled — ready to forge",
  echo: "Red pen capped — for now",
  nova: "Telescope stowed — ready to dig",
  forge: "Gears idle — ready to ship",
  pixel: "Brushes down — ready to design",
};

export function idleState(agentId: string): string {
  return IDLE_STATE[agentId] ?? "Idle — standing by";
}
