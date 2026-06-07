"use client";

import { useState, useEffect } from "react";
import type { CSSProperties } from "react";
import * as Icons from "lucide-react";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Plus,
  Settings,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { NAV_SECTIONS, type NavSection } from "@/lib/nav-sections";
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

  function sectionRow(s: NavSection) {
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
        {!collapsed && !live && <span className="text-[8px] uppercase tracking-wider">soon</span>}
      </button>
    );
  }

  return (
    <aside
      className={`bg-[#11161d] border-r border-[#1e2632] flex flex-col shrink-0 ${
        collapsed ? "w-[52px]" : "w-[210px]"
      } ${mobileActive ? "flex w-full md:w-auto" : "hidden md:flex"}`}
    >
      {/* header: app name + collapse toggle */}
      <div className="h-11 flex items-center justify-between px-2 border-b border-[#1e2632] shrink-0 select-none">
        {!collapsed && (
          <span className="text-[10px] font-mono text-[#5c6470] tracking-widest uppercase pl-1">Mission Control</span>
        )}
        <button
          onClick={toggle}
          title={collapsed ? "Expand" : "Collapse"}
          className="w-7 h-7 flex items-center justify-center rounded text-[#5c6470] hover:text-[#00e0ff] hover:bg-[#161c25] transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* operational nav */}
      <div className="px-1.5 pt-2 flex flex-col gap-0.5 shrink-0">
        {!collapsed && (
          <div className="text-[8px] font-mono text-[#3a424d] uppercase tracking-widest px-2 mb-0.5">Operational</div>
        )}
        {operational.map(sectionRow)}
      </div>

      {/* Agent Team panel (the active section) */}
      <div className="flex-1 min-h-0 flex flex-col border-t border-[#1e2632] mt-2">
        {!collapsed && (
          <div className="p-2 flex items-center justify-between shrink-0 select-none">
            <span className="text-[10px] font-mono text-[#5c6470] tracking-widest uppercase">
              Agent Team · {team.length}
            </span>
            <button className="text-[#00e0ff] hover:text-[#00c0dd] transition-colors">
              <Plus className="w-4 h-4" />
            </button>
          </div>
        )}

        {collapsed ? (
          // Compact: avatar icons only (Sage first, then the rest), tooltips for names.
          <ScrollArea className="flex-1 min-h-0">
            <div className="py-1 flex flex-col items-center gap-1.5">
              {team.map((member) => {
                const isWorking = workingAgents.includes(member.id);
                return (
                  <div
                    key={member.id}
                    title={`${member.name} — ${member.role} · ${RUNTIME}`}
                    className={`w-8 h-8 rounded-md bg-gradient-to-br ${member.color} flex items-center justify-center text-black relative shadow-md`}
                  >
                    <AgentIcon id={member.id} className="w-4 h-4" />
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#11161d] ${
                        isWorking ? "bg-[#3fb950] shadow-[0_0_4px_#3fb950] animate-pulse" : "bg-[#5c6470]"
                      }`}
                    />
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        ) : (
          <>
            {sage && (
              <div className="p-4 border-b border-[#1e2632] bg-gradient-to-b from-[#00e0ff]/[0.03] to-transparent relative group">
                <div className="absolute left-0 top-3 bottom-3 w-[3px] bg-gradient-to-b from-cyan-400 to-blue-500 rounded-r" />
                <div className="text-[9px] font-mono text-[#00e0ff] tracking-wider uppercase mb-2">ORCHESTRATOR</div>
                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center text-black relative shadow-md transition-shadow duration-300 ${
                      workingAgents.includes("sage")
                        ? "shadow-[0_0_16px_-3px_#00e0ff] ring-1 ring-white/20"
                        : "shadow-cyan-500/10"
                    }`}
                  >
                    <AgentIcon id="sage" className="w-5 h-5" />
                    <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#11161d] bg-[#3fb950] shadow-[0_0_5px_#3fb950] animate-pulse" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-[#e6edf3] font-heading leading-tight">{sage.name}</div>
                    <div className="text-[10px] font-mono text-[#8b949e]">Orchestration Engine</div>
                    <div className="text-[8.5px] font-mono text-[#5c6470]">{RUNTIME}</div>
                  </div>
                </div>

                <div className="mt-3 p-2 bg-[#161c25] border border-[#1e2632] rounded text-[11px] leading-relaxed text-[#8b949e]">
                  <span className="font-mono text-[9px] text-[#5c6470] uppercase tracking-wider block mb-1">STATUS</span>
                  {workingAgents.includes("sage") ? (
                    <span className="text-[#00e0ff] flex items-center gap-1.5">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                      <span className="line-clamp-2">{agentActivity.sage ?? "Working…"}</span>
                    </span>
                  ) : (
                    <span className="text-[#8b949e] line-clamp-2">{idleState("sage")}</span>
                  )}
                </div>
              </div>
            )}

            <ScrollArea className="flex-1 min-h-0">
              <div className="p-1.5 flex flex-col gap-1">
                {otherAgents.map((member) => {
                  const isWorking = workingAgents.includes(member.id);
                  const activity = agentActivity[member.id];
                  const accent =
                    AGENT_ACCENT[member.id] ?? { border: "border-[#00e0ff]/40", name: "text-[#e6edf3]", bg: "bg-[#161c25]/40" };
                  return (
                    <div
                      key={member.id}
                      style={{ "--glow": AGENT_GLOW[member.id] ?? "#00e0ff" } as CSSProperties}
                      className={`group relative overflow-hidden p-2.5 rounded-lg border transition-all duration-200 cursor-pointer flex flex-col gap-2 ring-1 ring-inset ring-white/[0.04] shadow-md shadow-black/40 hover:-translate-y-0.5 hover:shadow-lg ${accent.bg} ${
                        isWorking ? `${accent.border} animate-breathe` : "border-transparent hover:border-[#2a3441]"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-white/[0.05] to-transparent"
                      />
                      {isWorking && (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-0 animate-sheen bg-[linear-gradient(110deg,transparent_35%,rgba(255,255,255,0.06)_50%,transparent_65%)] bg-[length:250%_100%]"
                        />
                      )}
                      <div className="relative flex items-start gap-2.5">
                        <div
                          className={`w-8 h-8 rounded-md bg-gradient-to-br ${member.color} flex items-center justify-center text-black relative shadow-md transition-shadow duration-300 ${
                            isWorking ? "ring-1 ring-white/20 shadow-[0_0_14px_-3px_var(--glow)]" : ""
                          }`}
                        >
                          <AgentIcon id={member.id} className="w-4 h-4" />
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#11161d] ${
                              isWorking ? "bg-[#3fb950] shadow-[0_0_4px_#3fb950] animate-pulse" : "bg-[#5c6470]"
                            }`}
                          />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-baseline">
                            <span className={`font-semibold text-xs font-heading ${accent.name}`}>{member.name}</span>
                            <span className="text-[9px] font-mono text-[#5c6470]">{isWorking ? "now" : member.lastActive}</span>
                          </div>
                          <div className="text-[10px] font-mono text-[#8b949e]">{member.role}</div>
                        </div>
                      </div>

                      <div className="p-1.5 bg-[#0a0e14]/50 rounded border border-[#1e2632]/80 text-[10px] text-[#8b949e]">
                        <div
                          className={`font-semibold flex items-center gap-1 mb-0.5 ${
                            isWorking ? "text-[#3fb950]" : "text-[#5c6470]"
                          }`}
                        >
                          <span
                            className={`inline-block w-1 h-1 rounded-full ${
                              isWorking ? "bg-[#3fb950] animate-ping" : "bg-[#5c6470]"
                            }`}
                          />
                          {isWorking ? "ACTIVE" : "STATUS"}
                        </div>
                        <p className="line-clamp-2 leading-normal">
                          {isWorking ? activity ?? "Working…" : idleState(member.id)}
                        </p>
                      </div>

                      <div className="flex justify-between items-center text-[9px] font-mono text-[#5c6470]">
                        <span className="bg-[#1c2330] text-[#8b949e] px-1.5 py-0.5 rounded border border-[#2a3441]">
                          {member.model}
                        </span>
                        <span className="text-[#5c6470]">{RUNTIME}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </>
        )}
      </div>

      {/* bottom: system nav + settings + logout */}
      <div className="px-1.5 py-2 border-t border-[#1e2632] shrink-0 flex flex-col gap-0.5">
        {!collapsed && (
          <div className="text-[8px] font-mono text-[#3a424d] uppercase tracking-widest px-2 mb-0.5">System</div>
        )}
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
