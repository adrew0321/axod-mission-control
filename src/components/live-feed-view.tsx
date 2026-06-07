"use client";

import React, { useState, useTransition } from "react";
import { type LiveFeedEvent } from "@/lib/live-feed";
import { type Agent } from "@/lib/mock-data";
import { Loader2 } from "lucide-react";

interface LiveFeedViewProps {
  events: LiveFeedEvent[];
  team: Agent[];
  workingAgents: string[];
  agentActivity: Record<string, string>;
  onSelectSession: (sessionId: string) => Promise<void>;
  onApprovalDecision: (approvalId: string, decision: "approved" | "denied" | "always") => Promise<void>;
}

function formatEventTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;

  const isYesterday = new Date(Date.now() - 24 * 3600 * 1000).toDateString() === d.toDateString();
  const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isYesterday) {
    return `Yesterday ${timeStr}`;
  }
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${timeStr}`;
}

export default function LiveFeedView({
  events,
  team,
  workingAgents,
  agentActivity,
  onSelectSession,
  onApprovalDecision,
}: LiveFeedViewProps) {
  const [filter, setFilter] = useState<"all" | "dispatch" | "approval" | "artifact">("all");
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Helper to format cost/tokens
  const formatCost = (cost?: number, tokensIn?: number, tokensOut?: number) => {
    if (cost === undefined && tokensIn === undefined && tokensOut === undefined) return null;
    const tokensTotal = (tokensIn || 0) + (tokensOut || 0);
    const tokStr = tokensTotal ? `${(tokensTotal / 1000).toFixed(1)}k tok` : "";
    const costStr = cost ? `$${cost.toFixed(2)}` : "";
    return [tokStr, costStr].filter(Boolean).join(" · ");
  };

  // Helper to get agent initial
  const getAgentInitial = (agentId?: string, name?: string) => {
    if (agentId === "sage") return "S";
    if (name) return name.charAt(0).toUpperCase();
    return "◷";
  };

  // Filter events client-side
  const filteredEvents = events.filter((e) => {
    if (filter === "all") return true;
    return e.kind === filter;
  });

  const todayStr = new Date().toDateString();
  const todayEvents = filteredEvents.filter((e) => new Date(e.ts).toDateString() === todayStr);
  const earlierEvents = filteredEvents.filter((e) => new Date(e.ts).toDateString() !== todayStr);

  const handleRowClick = (sessionId: string) => {
    startTransition(async () => {
      await onSelectSession(sessionId);
    });
  };

  const handleApprovalAction = async (e: React.MouseEvent, id: string, decision: "approved" | "denied" | "always") => {
    e.stopPropagation(); // Prevent trigger row click / navigation
    setBusyApprovalId(id);
    try {
      await onApprovalDecision(id, decision);
    } finally {
      setBusyApprovalId(null);
    }
  };

  const renderEventRow = (e: LiveFeedEvent) => {
    const isAttn = e.kind === "approval" && e.meta?.status === "pending";
    const initial = getAgentInitial(e.agentId, e.agentName);
    
    // Dynamic color assignment matching DB colors if possible
    let avBgClass = "bg-[#2a3441] text-[#8b949e]";
    if (e.agentId === "sage") {
      avBgClass = "bg-gradient-to-br from-cyan-400 to-blue-500 text-black";
    } else if (e.agentId === "forge") {
      avBgClass = "bg-gradient-to-br from-amber-400 to-orange-600 text-black";
    } else if (e.agentId === "pixel") {
      avBgClass = "bg-gradient-to-br from-pink-400 to-rose-600 text-black";
    } else if (e.agentId === "nova") {
      avBgClass = "bg-gradient-to-br from-emerald-400 to-teal-600 text-black";
    } else if (e.agentId === "atlas") {
      avBgClass = "bg-gradient-to-br from-blue-400 to-indigo-600 text-black";
    } else if (e.agentId === "echo") {
      avBgClass = "bg-gradient-to-br from-violet-400 to-purple-600 text-black";
    } else if (e.agentColor) {
      avBgClass = `bg-gradient-to-br ${e.agentColor} text-black`;
    }

    // Kind badges
    let kindBadgeColor = "text-[#8b949e] bg-[#161c25]";
    if (e.kind === "dispatch") kindBadgeColor = "text-[#00e0ff] bg-[#00e0ff]/10 border border-[#00e0ff]/20";
    else if (e.kind === "reply") kindBadgeColor = "text-[#3fb950] bg-[#3fb950]/10 border border-[#3fb950]/20";
    else if (e.kind === "artifact") kindBadgeColor = "text-[#a371f7] bg-[#a371f7]/10 border border-[#a371f7]/20";
    else if (e.kind === "approval") kindBadgeColor = "text-[#f0a020] bg-[#f0a020]/10 border border-[#f0a020]/20";

    const costMeta = formatCost(e.meta?.costUsd, e.meta?.tokensIn, e.meta?.tokensOut);

    return (
      <div
        key={e.id}
        onClick={() => handleRowClick(e.sessionId)}
        className={`group flex gap-3 px-4 py-3 border-l-2 border-transparent transition-colors cursor-pointer select-none ${
          isAttn ? "border-l-[#f0a020] bg-[#f0a020]/5 hover:bg-[#f0a020]/10" : "hover:bg-[#0f141b]"
        }`}
      >
        <div className={`w-7 h-7 rounded-[7px] flex-shrink-0 flex items-center justify-center font-bold font-serif text-[11px] ${avBgClass}`}>
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] line-clamp-2 leading-relaxed text-[#e6edf3]">
            {/* Split label for bold styling */}
            {e.kind === "reply" && e.agentName ? (
              <>
                <span className="font-semibold">{e.agentName}</span>
                <span className="text-[#8b949e]"> replied </span>
                {e.quote && <span className="text-[#e6edf3]">· {e.quote}</span>}
              </>
            ) : e.kind === "dispatch" && e.agentName ? (
              <>
                <span className="font-semibold">{e.agentName}</span>
                <span className="text-[#8b949e]"> dispatched </span>
                <span className="text-[#00e0ff]">
                  {e.label.split("dispatched")[1] || "specialist"}
                </span>
                {e.quote && <span className="text-[#e6edf3]"> · {e.quote}</span>}
              </>
            ) : e.kind === "approval" ? (
              <>
                <span className="font-semibold">{e.agentName}</span>
                {e.meta?.status === "pending" ? (
                  <>
                    <span className="text-[#8b949e]"> requests permission to </span>
                    <span className="text-[#e6edf3] font-mono border border-[#2a3441] bg-[#161c25] px-1 py-0.2 rounded text-[11px]">
                      {e.meta?.toolName}
                    </span>
                    <span className="text-[#8b949e]"> → awaiting you</span>
                  </>
                ) : (
                  <>
                    <span className="text-[#8b949e]"> was {e.meta?.status} for </span>
                    <span className="text-[#e6edf3] font-mono border border-[#2a3441] bg-[#161c25] px-1 py-0.2 rounded text-[11px]">
                      {e.meta?.toolName}
                    </span>
                  </>
                )}
              </>
            ) : e.kind === "artifact" ? (
              <>
                <span className="font-semibold">{e.agentName}</span>
                <span className="text-[#8b949e]"> created a </span>
                <span className="text-[#a371f7]">{e.meta?.type}</span>
                {e.quote && <span className="text-[#e6edf3]"> · {e.quote}</span>}
              </>
            ) : (
              <span className="text-[#8b949e]">{e.label}</span>
            )}
          </div>

          <div className="mt-1 flex gap-2 items-center flex-wrap text-[10px] text-[#5c6470]">
            <span className={`px-1.5 py-0.2 rounded text-[9px] uppercase font-mono ${kindBadgeColor}`}>
              {e.kind}
            </span>
            <span className="text-[#7ee787] border border-[#23371f] bg-[#161c25] px-1.5 py-0.2 rounded font-mono">
              {e.projectName}
            </span>
            {costMeta && (
              <span className="text-[#79c0ff] border border-[#1f2b3a] bg-[#161c25] px-1.5 py-0.2 rounded font-mono">
                {costMeta}
              </span>
            )}
            <span className="ml-auto whitespace-nowrap text-[#5c6470]">
              {formatEventTime(new Date(e.ts))}
            </span>
          </div>

          {/* Actionable inline approvals */}
          {isAttn && (
            <div className="flex gap-2 mt-2">
              <button
                disabled={busyApprovalId !== null}
                onClick={(e) => handleApprovalAction(e, aIdOf(e), "approved")}
                className="bg-[#3fb950] border border-[#3fb950] hover:bg-[#3fb950]/90 text-[#06210f] font-bold text-[10px] px-3 py-1 rounded transition-colors cursor-pointer"
              >
                Approve
              </button>
              <button
                disabled={busyApprovalId !== null}
                onClick={(e) => handleApprovalAction(e, aIdOf(e), "denied")}
                className="bg-[#161c25] border border-[#2a3441] hover:bg-[#1c2330] text-[#8b949e] hover:text-[#e6edf3] text-[10px] px-3 py-1 rounded transition-colors cursor-pointer"
              >
                Deny
              </button>
            </div>
          )}
        </div>
      </div>
    );

    function aIdOf(evt: React.MouseEvent) {
      return e.id.replace("approval-", "");
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-[#0a0e14] overflow-hidden relative">
      {/* Loading Overlay */}
      {isPending && (
        <div className="absolute inset-0 bg-[#0a0e14]/60 z-50 flex items-center justify-center backdrop-blur-[1px]">
          <Loader2 className="w-8 h-8 text-[#00e0ff] animate-spin" />
        </div>
      )}

      {/* Header */}
      <div className="h-11 w-full bg-[#11161d] border-b border-[#1e2632] px-4 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-2.5">
          <div className="relative flex items-center">
            <span className="w-2 h-2 rounded-full bg-[#3fb950] animate-pulse shadow-[0_0_6px_#3fb950] mr-2" />
            <b className="font-serif font-semibold text-sm tracking-wide text-[#e6edf3]">Live Feed</b>
          </div>
          <span className="text-[10px] font-mono text-[#5c6470] tracking-wider uppercase hidden sm:inline-block">
            fleet activity · all projects
          </span>
        </div>

        {/* Filter Chips */}
        <div className="flex gap-1.5 text-[10px] font-mono">
          {(["all", "dispatch", "approval", "artifact"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={`px-2.5 py-0.5 rounded-full border transition-all cursor-pointer ${
                filter === t
                  ? "border-[#00e0ff] text-[#00e0ff] bg-[#00e0ff]/5"
                  : "border-[#2a3441] text-[#8b949e] hover:text-[#e6edf3] bg-[#161c25]"
              }`}
            >
              {t === "all" ? "All" : t.charAt(0).toUpperCase() + t.slice(1) + "s"}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable Event Feed */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#1e2632]/50">
        
        {/* Real-time Working Agents */}
        {filter === "all" && workingAgents.length > 0 && (
          <div className="bg-[#11233a]/10 border-b border-[#11233a]/30">
            <div className="px-4 pt-3 pb-1 text-[8.5px] uppercase font-mono tracking-widest text-[#00e0ff] select-none">
              In Progress
            </div>
            <div className="divide-y divide-[#1e2632]/30">
              {workingAgents.map((agentId) => {
                const agent = team.find((a) => a.id === agentId);
                const activity = agentActivity[agentId] || "working...";
                let avBgClass = "bg-[#2a3441] text-[#8b949e]";
                if (agentId === "sage") avBgClass = "bg-gradient-to-br from-cyan-400 to-blue-500 text-black";
                else if (agentId === "forge") avBgClass = "bg-gradient-to-br from-amber-400 to-orange-600 text-black";
                else if (agentId === "pixel") avBgClass = "bg-gradient-to-br from-pink-400 to-rose-600 text-black";
                else if (agentId === "nova") avBgClass = "bg-gradient-to-br from-emerald-400 to-teal-600 text-black";
                else if (agentId === "atlas") avBgClass = "bg-gradient-to-br from-blue-400 to-indigo-600 text-black";
                else if (agentId === "echo") avBgClass = "bg-gradient-to-br from-violet-400 to-purple-600 text-black";

                return (
                  <div key={agentId} className="flex gap-3 px-4 py-3 bg-[#00e0ff]/2">
                    <div className={`w-7 h-7 rounded-[7px] flex-shrink-0 flex items-center justify-center font-bold font-serif text-[11px] ${avBgClass}`}>
                      {getAgentInitial(agentId, agent?.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12.5px] text-[#e6edf3] flex items-center gap-2">
                        <span className="font-semibold">{agent?.name || agentId}</span>
                        <span className="text-[#00e0ff] inline-flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-[#00e0ff] animate-ping" />
                          <span className="animate-pulse">{activity}</span>
                        </span>
                      </div>
                      <div className="mt-1 flex gap-2 items-center text-[10px] text-[#5c6470]">
                        <span className="px-1.5 py-0.2 rounded text-[9px] uppercase font-mono text-[#00e0ff] bg-[#00e0ff]/10 border border-[#00e0ff]/20">
                          working
                        </span>
                        <span className="ml-auto whitespace-nowrap text-[#5c6470]">
                          now
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Today Group */}
        {todayEvents.length > 0 && (
          <div>
            <div className="px-4 pt-3 pb-1 text-[8.5px] uppercase font-mono tracking-widest text-[#5c6470] select-none">
              Today
            </div>
            <div className="divide-y divide-[#1e2632]/30">
              {todayEvents.map(renderEventRow)}
            </div>
          </div>
        )}

        {/* Earlier Group */}
        {earlierEvents.length > 0 && (
          <div>
            <div className="px-4 pt-3 pb-1 text-[8.5px] uppercase font-mono tracking-widest text-[#5c6470] select-none">
              Earlier
            </div>
            <div className="divide-y divide-[#1e2632]/30">
              {earlierEvents.map(renderEventRow)}
            </div>
          </div>
        )}

        {/* Empty State */}
        {filteredEvents.length === 0 && workingAgents.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-[#5c6470] font-mono text-xs select-none">
            No events found in this filter range.
          </div>
        )}
      </div>
    </div>
  );
}
