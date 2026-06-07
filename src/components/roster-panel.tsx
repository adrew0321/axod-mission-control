"use client";

import type { CSSProperties } from "react";
import { RefreshCw, Plus } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AGENT_ACCENT, AGENT_GLOW, AgentIcon, idleState } from "@/components/mission-control-bits";
import type { Agent } from "@/lib/mock-data";

const RUNTIME = "claude-sdk";

// The roster — first column of the "Agent Team" view (Sage + the dispatchable
// specialists). Reads the same data mission-control already computes.
export default function RosterPanel({
  team,
  sage,
  otherAgents,
  workingAgents,
  agentActivity,
  mobileActive,
}: {
  team: Agent[];
  sage: Agent | undefined;
  otherAgents: Agent[];
  workingAgents: string[];
  agentActivity: Record<string, string>;
  mobileActive: boolean;
}) {
  return (
    <section
      className={`w-full md:w-[260px] bg-[#11161d] border-r border-[#1e2632] flex flex-col shrink-0 ${
        mobileActive ? "flex" : "hidden md:flex"
      }`}
    >
      <div className="p-3 border-b border-[#1e2632] flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-[#5c6470] tracking-widest uppercase">AGENT TEAM</span>
          <span className="bg-[#161c25] border border-[#2a3441] text-[#e6edf3] px-1.5 py-0.2 rounded text-[9px] font-mono">
            {team.length}
          </span>
        </div>
        <button className="text-[#00e0ff] hover:text-[#00c0dd] transition-colors">
          <Plus className="w-4 h-4" />
        </button>
      </div>

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
    </section>
  );
}
