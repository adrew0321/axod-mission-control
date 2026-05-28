"use client";

import React, { useState, useRef, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Compass,
  ChevronDown,
  Terminal as TerminalIcon,
  FileText,
  Send,
  Sparkles,
  Plus,
  AlertCircle,
  Lock,
  RefreshCw,
  Layers,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Agent, Message, Artifact, Session } from "@/lib/mock-data";

export interface MissionControlProps {
  team: Agent[];
  session: Session;
  initialMessages: Message[];
  artifacts: Artifact[];
}

export default function MissionControl({
  team: initialTeam,
  session: initialSession,
  initialMessages,
  artifacts: initialArtifacts,
}: MissionControlProps) {
  const router = useRouter();
  const [team] = useState<Agent[]>(initialTeam);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [artifacts] = useState<Artifact[]>(initialArtifacts);
  const [activeTab, setActiveTab] = useState<string>("plan");
  const [inputText, setInputText] = useState<string>("");
  const [session] = useState<Session>(initialSession);
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setMessages(initialMessages);
  }, [initialMessages]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  // Send the operator's decision to the server. The open agent stream is
  // blocked in the permission gate waiting on this row to change; once we POST,
  // the gate unblocks and tokens resume flowing into the streaming bubble.
  const handleApproval = async (id: string, decision: "approved" | "denied" | "always") => {
    const displayStatus = decision === "denied" ? "denied" : "approved";
    setMessages((prev) =>
      prev.map((msg) =>
        msg.approval && msg.approval.id === id
          ? { ...msg, approval: { ...msg.approval, status: displayStatus } }
          : msg,
      ),
    );
    try {
      await fetch(`/api/approvals/${id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
    } catch {
      setSendError("Failed to send decision");
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = inputText.trim();
    if (!text) return;

    const optimisticId = `u_${Date.now()}`;
    const optimistic: Message = {
      id: optimisticId,
      role: "user",
      senderName: "adrew0321",
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    setMessages((prev) => [...prev, optimistic]);
    setInputText("");
    setSendError(null);

    try {
      const res = await fetch(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        setInputText(text);
        setSendError(body.error ?? `Send failed (${res.status})`);
        return;
      }

      const streamingId = `stream_${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: streamingId,
          role: "agent",
          agentId: "sage",
          senderName: "Sage",
          content: "",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          isStreaming: true,
        },
      ]);
      setIsTyping(true);

      const es = new EventSource(`/api/sessions/${session.id}/stream`);
      es.onmessage = (ev) => {
        try {
          const evt = JSON.parse(ev.data) as {
            type: string;
            content?: string;
            message?: string;
            approvalId?: string;
            toolName?: string;
            toolInput?: unknown;
            decision?: string;
          };
          if (evt.type === "token" && typeof evt.content === "string") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingId ? { ...m, content: m.content + evt.content } : m,
              ),
            );
          } else if (evt.type === "approval_requested" && evt.approvalId) {
            const approvalId = evt.approvalId;
            const toolName = evt.toolName ?? "unknown";
            const toolArgs = evt.toolInput;
            setIsTyping(false);
            setMessages((prev) => [
              ...prev,
              {
                id: `sys_${approvalId}`,
                role: "system",
                senderName: "System",
                content: `Sage requested permission to use ${toolName}`,
                timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                approval: { id: approvalId, toolName, toolArgs, status: "pending" },
              },
            ]);
          } else if (evt.type === "approval_resolved") {
            // Re-show the thinking indicator once the operator has decided.
            setIsTyping(true);
          } else if (evt.type === "error") {
            setSendError(evt.message ?? "Agent error");
          } else if (evt.type === "persisted") {
            es.close();
            setIsTyping(false);
            setMessages((prev) => prev.filter((m) => m.id !== streamingId));
            startTransition(() => router.refresh());
          }
        } catch {
          // ignore non-JSON keepalives
        }
      };
      es.onerror = () => {
        es.close();
        setIsTyping(false);
        setSendError((prev) => prev ?? "Stream disconnected");
      };
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setInputText(text);
      setSendError(err instanceof Error ? err.message : "Network error");
    }
  };

  const applyPreset = (preset: string) => {
    setInputText(preset);
  };

  const sage = team.find((a) => a.id === "sage");
  const otherAgents = team.filter((a) => a.id !== "sage");

  return (
    <div className="flex flex-col h-screen w-full bg-[#060810] text-[#e6edf3] font-sans antialiased overflow-hidden selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* ─── Top bar ─── */}
      <header className="h-12 w-full bg-[#11161d] border-b border-[#1e2632] flex items-center px-4 justify-between shrink-0 select-none">
        <div className="flex items-center gap-4">
          <div className="logo flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center font-extrabold text-[12px] text-black shadow-md shadow-cyan-500/10">
              MC
            </div>
            <span className="font-semibold text-sm tracking-tight font-heading">
              AXOD MISSION CONTROL
            </span>
          </div>

          <div className="h-4 w-[1px] bg-[#1e2632]" />

          <div className="flex items-center gap-2 px-2.5 py-1 bg-[#161c25] border border-[#1e2632] rounded-md cursor-pointer hover:bg-[#1c2330] transition-colors">
            <span className="text-[9px] font-mono text-[#5c6470] uppercase tracking-wider">PROJECT</span>
            <span className="text-xs font-semibold text-[#e6edf3]">{session.project}</span>
            <ChevronDown className="w-3.5 h-3.5 text-[#5c6470]" />
          </div>

          <div className="flex items-center gap-2 px-2.5 py-1 bg-[#161c25] border border-[#2a3441] rounded-md">
            <div className="w-2 h-2 rounded-full bg-[#3fb950] animate-pulse shadow-[0_0_8px_#3fb950]" />
            <span className="text-[10px] font-mono text-[#8b949e]">{session.branch}</span>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-4 text-[11px] font-mono text-[#8b949e]">
            <div className="flex gap-1.5 items-center bg-[#161c25]/50 px-2 py-0.5 rounded border border-[#1e2632]">
              <span className="text-[#5c6470]">COST:</span>
              <span className="text-[#00e0ff] font-bold">${session.costUsd.toFixed(2)}</span>
            </div>
            <div className="flex gap-1.5 items-center bg-[#161c25]/50 px-2 py-0.5 rounded border border-[#1e2632]">
              <span className="text-[#5c6470]">IN:</span>
              <span className="text-[#e6edf3]">{(session.tokensIn / 1000).toFixed(1)}k</span>
            </div>
            <div className="flex gap-1.5 items-center bg-[#161c25]/50 px-2 py-0.5 rounded border border-[#1e2632]">
              <span className="text-[#5c6470]">OUT:</span>
              <span className="text-[#e6edf3]">{(session.tokensOut / 1000).toFixed(1)}k</span>
            </div>
          </div>

          <button
            onClick={handleLogout}
            title="Sign out"
            className="relative w-8 h-8 rounded-md border border-[#2a3441] flex items-center justify-center text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161c25] transition-colors"
          >
            <Lock className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="flex-1 w-full flex overflow-hidden">
        {/* ─── LEFT PANE: TEAM ROSTER ─── */}
        <section className="w-[280px] bg-[#11161d] border-r border-[#1e2632] flex flex-col shrink-0">
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
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center text-lg font-bold text-black relative shadow-md shadow-cyan-500/10">
                  {sage.avatar}
                  <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#11161d] bg-[#3fb950] shadow-[0_0_5px_#3fb950] animate-pulse" />
                </div>
                <div className="flex-1 min-width-0">
                  <div className="font-semibold text-sm text-[#e6edf3] font-heading leading-tight">{sage.name}</div>
                  <div className="text-[10px] font-mono text-[#8b949e]">Orchestration Engine</div>
                </div>
              </div>

              <div className="mt-3 p-2 bg-[#161c25] border border-[#1e2632] rounded text-[11px] leading-relaxed text-[#8b949e]">
                <span className="font-mono text-[9px] text-[#5c6470] uppercase tracking-wider block mb-1">STATE</span>
                {isTyping ? (
                  <span className="text-[#00e0ff] flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Analyzing input request...
                  </span>
                ) : (
                  <span className="text-[#e6edf3] line-clamp-2">
                    {sage.currentTask ?? "Idle — awaiting next instruction."}
                  </span>
                )}
              </div>
            </div>
          )}

          <ScrollArea className="flex-1">
            <div className="p-1.5 flex flex-col gap-1">
              {otherAgents.map((member) => (
                <div
                  key={member.id}
                  className={`group p-2.5 rounded-md border transition-all cursor-pointer flex flex-col gap-2 ${
                    member.status === "working"
                      ? "bg-[#161c25]/75 border-[#00e0ff]/20 hover:border-[#00e0ff]/40 shadow-inner"
                      : "border-transparent hover:bg-[#161c25]/40 hover:border-[#1e2632]"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <div
                      className={`w-8 h-8 rounded-md bg-gradient-to-br ${member.color} flex items-center justify-center font-semibold text-black relative`}
                    >
                      {member.avatar}
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#11161d] ${
                          member.status === "working" ? "bg-[#3fb950] shadow-[0_0_4px_#3fb950]" : "bg-[#5c6470]"
                        }`}
                      />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-baseline">
                        <span className="font-semibold text-xs text-[#e6edf3] font-heading">{member.name}</span>
                        <span className="text-[9px] font-mono text-[#5c6470]">{member.lastActive}</span>
                      </div>
                      <div className="text-[10px] font-mono text-[#8b949e]">{member.role}</div>
                    </div>
                  </div>

                  {member.currentTask && (
                    <div className="p-1.5 bg-[#0a0e14]/50 rounded border border-[#1e2632]/80 text-[10px] text-[#8b949e]">
                      <div className="text-[#3fb950] font-semibold flex items-center gap-1 mb-0.5">
                        <span className="inline-block w-1 h-1 rounded-full bg-[#3fb950] animate-ping" />
                        ACTIVE
                      </div>
                      <p className="line-clamp-2 leading-normal">{member.currentTask}</p>
                    </div>
                  )}

                  <div className="flex justify-between items-center text-[9px] font-mono text-[#5c6470]">
                    <span className="bg-[#1c2330] text-[#8b949e] px-1.5 py-0.5 rounded border border-[#2a3441]">
                      {member.model}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </section>

        {/* ─── MIDDLE PANE: ORCHESTRATOR CHAT ─── */}
        <section className="flex-1 bg-[#0a0e14] border-r border-[#1e2632] flex flex-col min-w-[400px]">
          <div className="h-11 w-full bg-[#11161d] border-b border-[#1e2632] px-4 flex items-center gap-2 justify-between shrink-0 select-none">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-xs text-[#e6edf3] font-heading">Session Logs</span>
              <span className="text-[10px] font-mono text-[#5c6470] tracking-wider block">ID: {session.id}</span>
            </div>

            <div className="text-[10px] font-mono text-[#8b949e] flex items-center gap-1">
              <span className="text-[#5c6470]">Target Directory:</span>
              <code className="bg-[#161c25] border border-[#1e2632] px-1.5 py-0.2 rounded text-[#00e0ff]">
                {session.repoPath}
              </code>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg) => (
              <div key={msg.id} className="max-w-full">
                {msg.role !== "system" && (
                  <div className="flex items-center gap-2 mb-1.5 text-[10px] font-mono">
                    <span
                      className={`font-bold ${
                        msg.role === "user"
                          ? "text-[#e6edf3]"
                          : msg.agentId === "sage"
                            ? "text-[#00e0ff]"
                            : "text-[#93c5fd]"
                      }`}
                    >
                      {msg.senderName}
                    </span>
                    {msg.attribution && (
                      <span className="bg-[#161c25] border border-[#1e2632] px-1.5 py-0.2 rounded text-[#5c6470] text-[9px]">
                        {msg.attribution}
                      </span>
                    )}
                    <span className="text-[#5c6470]">{msg.timestamp}</span>
                  </div>
                )}

                {msg.role === "system" && !msg.approval && (
                  <div className="flex items-center gap-2 py-1.5 px-3 bg-[#161c25] border border-[#1e2632] rounded-md text-[11px] font-mono text-[#8b949e]">
                    <span className="text-[#3b82f6]">❖</span>
                    <span>{msg.content}</span>
                    <span className="text-[#5c6470] ml-auto">{msg.timestamp}</span>
                  </div>
                )}

                {msg.role !== "system" && (
                  <div
                    className={`text-xs leading-relaxed p-3 rounded-md border ${
                      msg.role === "user"
                        ? "bg-[#161c25]/80 border-[#2a3441] text-[#e6edf3]"
                        : "bg-[#11161d] border-[#1e2632] text-[#8b949e] whitespace-pre-wrap"
                    }`}
                  >
                    {msg.content}

                    {msg.dispatch && (
                      <div className="mt-3 p-2.5 bg-[#060810] border border-cyan-500/10 rounded-md relative group overflow-hidden">
                        <div className="absolute left-0 inset-y-0 w-1 bg-gradient-to-b from-[#00e0ff] to-transparent" />
                        <div className="flex justify-between items-center text-[9px] font-mono text-cyan-400 uppercase tracking-wider mb-1.5">
                          <div className="flex items-center gap-1.5">
                            <Layers className="w-3.5 h-3.5" />
                            Orchestrated Dispatch
                          </div>
                          <span className="text-[#3fb950] animate-pulse">Running</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs font-semibold text-[#e6edf3]">
                          <span className="w-5 h-5 rounded bg-gradient-to-br from-blue-400 to-indigo-600 flex items-center justify-center text-[10px] text-black">
                            ⚒
                          </span>
                          {msg.dispatch.agentName} <ArrowRight className="w-3 h-3 text-[#5c6470]" /> Lead Developer
                        </div>
                        <p className="text-[11px] text-[#8b949e] mt-1">{msg.dispatch.task}</p>
                      </div>
                    )}
                  </div>
                )}

                {msg.approval && (
                  <div className="mt-2 p-3.5 bg-[#d29922]/[0.05] border border-[#d29922]/40 rounded-lg shadow-lg relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-[#d29922]/[0.02] rounded-full blur-xl" />

                    <div className="flex items-center gap-2 text-[#d29922] font-mono text-[10px] uppercase tracking-wider mb-2">
                      <AlertCircle className="w-4 h-4" />
                      Pending Approval Gate
                      <span className="ml-auto text-[#8b949e] font-sans lowercase normal-case">from Sage</span>
                    </div>

                    <div className="text-xs text-[#e6edf3] mb-3 leading-relaxed">
                      Sage is requesting authorization to invoke{" "}
                      <code className="bg-[#11161d] border border-[#1e2632] px-1.5 py-0.5 rounded text-cyan-400 font-mono text-[10.5px]">
                        {msg.approval.toolName}
                      </code>
                      :
                      <div className="mt-2 p-2 bg-[#060810] border border-[#2a3441] rounded font-mono text-[10.5px] text-[#8b949e] whitespace-pre-wrap break-all">
                        {JSON.stringify(msg.approval.toolArgs, null, 2)}
                      </div>
                    </div>

                    {msg.approval.status === "pending" ? (
                      <div className="flex gap-2 flex-wrap">
                        <button
                          onClick={() => handleApproval(msg.approval!.id, "approved")}
                          className="px-3.5 py-1.5 bg-[#3fb950] hover:bg-[#34a244] text-[#060810] font-bold rounded text-xs transition-colors flex items-center gap-1 shadow-md shadow-[#3fb950]/10"
                        >
                          <ShieldCheck className="w-3.5 h-3.5" />
                          Approve
                        </button>
                        <button
                          onClick={() => handleApproval(msg.approval!.id, "always")}
                          className="px-3.5 py-1.5 bg-transparent border border-[#3fb950]/40 hover:border-[#3fb950] hover:bg-[#3fb950]/10 text-[#3fb950] rounded text-xs transition-all"
                        >
                          Always allow
                        </button>
                        <button
                          onClick={() => handleApproval(msg.approval!.id, "denied")}
                          className="px-3.5 py-1.5 bg-transparent border border-[#2a3441] hover:border-red-500/50 hover:bg-red-500/10 text-[#8b949e] hover:text-red-400 rounded text-xs transition-all"
                        >
                          Deny
                        </button>
                      </div>
                    ) : (
                      <div className="p-2 rounded bg-[#161c25]/80 border border-[#1e2632] flex items-center gap-2 text-xs font-mono">
                        <span className={msg.approval.status === "approved" ? "text-[#3fb950]" : "text-red-500"}>
                          ✓ {msg.approval.status === "approved" ? "APPROVED" : "DENIED"}
                        </span>
                        <span className="text-[#5c6470]">at {msg.timestamp}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {isTyping && (
              <div className="flex items-center gap-1.5 text-xs text-[#5c6470] font-mono">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#00e0ff]" />
                Sage is typing...
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className="px-4 py-2 border-t border-[#1e2632] bg-[#11161d]/50 flex gap-2 overflow-x-auto shrink-0 select-none">
            <button
              onClick={() => applyPreset("List files in src/components")}
              className="text-[10px] font-mono bg-[#161c25] border border-[#2a3441] hover:border-cyan-500/40 text-[#8b949e] hover:text-[#00e0ff] px-2 py-1 rounded transition-colors whitespace-nowrap"
            >
              List Components
            </button>
            <button
              onClick={() => applyPreset("What is the current build status?")}
              className="text-[10px] font-mono bg-[#161c25] border border-[#2a3441] hover:border-cyan-500/40 text-[#8b949e] hover:text-[#00e0ff] px-2 py-1 rounded transition-colors whitespace-nowrap"
            >
              Check Build status
            </button>
            <button
              onClick={() => applyPreset("Summarize existing project specs")}
              className="text-[10px] font-mono bg-[#161c25] border border-[#2a3441] hover:border-cyan-500/40 text-[#8b949e] hover:text-[#00e0ff] px-2 py-1 rounded transition-colors whitespace-nowrap"
            >
              Read Specs
            </button>
          </div>

          <form onSubmit={handleSendMessage} className="p-3 bg-[#11161d] border-t border-[#1e2632] shrink-0">
            <div className="flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Talk to Sage, or type '@Atlas task' to target developer..."
                className="flex-1 bg-[#060810] border border-[#2a3441] focus:border-[#00e0ff] rounded-md px-3 py-2 text-xs text-[#e6edf3] placeholder-[#5c6470] focus:outline-none transition-colors"
              />
              <button
                type="submit"
                disabled={isPending}
                className="bg-[#00e0ff] hover:bg-[#00c0dd] disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold px-4 rounded-md text-xs flex items-center justify-center gap-1.5 transition-colors shadow-md shadow-cyan-500/10"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Send</span>
              </button>
            </div>

            {sendError && (
              <div className="mt-2 px-2 py-1 rounded text-[10px] font-mono bg-red-500/10 border border-red-500/40 text-red-400">
                {sendError}
              </div>
            )}

            <div className="flex justify-between items-center mt-2.5 text-[9px] font-mono text-[#5c6470] select-none">
              <div className="flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-[#00e0ff]" />
                <span>Routing to Sage by default</span>
              </div>
              <span>{isPending ? "Saving..." : "Press Enter to send"}</span>
            </div>
          </form>
        </section>

        {/* ─── RIGHT PANE: WORKSPACE TABS ─── */}
        <section className="flex-1 bg-[#0a0e14] flex flex-col overflow-hidden min-w-[400px]">
          <div className="h-11 bg-[#11161d] border-b border-[#1e2632] flex items-center justify-between px-4 shrink-0 select-none">
            <div className="flex h-full gap-1">
              <button
                onClick={() => setActiveTab("plan")}
                className={`px-3 flex items-center gap-1.5 border-b-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                  activeTab === "plan"
                    ? "border-[#00e0ff] text-[#00e0ff] font-semibold"
                    : "border-transparent text-[#5c6470] hover:text-[#8b949e]"
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                Plan
              </button>

              <button
                onClick={() => setActiveTab("code")}
                className={`px-3 flex items-center gap-1.5 border-b-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                  activeTab === "code"
                    ? "border-[#00e0ff] text-[#00e0ff] font-semibold"
                    : "border-transparent text-[#5c6470] hover:text-[#8b949e]"
                }`}
              >
                <Compass className="w-3.5 h-3.5" />
                Code Diff
                <span className="bg-cyan-500/10 border border-cyan-500/25 text-[#00e0ff] text-[8.5px] px-1 py-0.2 rounded font-bold">
                  1
                </span>
              </button>

              <button
                onClick={() => setActiveTab("terminal")}
                className={`px-3 flex items-center gap-1.5 border-b-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                  activeTab === "terminal"
                    ? "border-[#00e0ff] text-[#00e0ff] font-semibold"
                    : "border-transparent text-[#5c6470] hover:text-[#8b949e]"
                }`}
              >
                <TerminalIcon className="w-3.5 h-3.5" />
                Terminal
              </button>
            </div>

            <div className="text-[10px] font-mono text-[#8b949e] flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#3fb950] animate-pulse" />
              <span>WORKSPACE ACTIVE</span>
            </div>
          </div>

          <div className="flex-1 overflow-hidden p-4 relative">
            {activeTab === "plan" && (
              <ScrollArea className="h-full bg-[#11161d] border border-[#1e2632] rounded-lg p-5">
                <div className="prose prose-invert max-w-none text-xs text-[#8b949e] font-mono">
                  <div className="flex items-center justify-between mb-4 pb-2 border-b border-[#2a3441]">
                    <h2 className="text-sm font-bold text-[#e6edf3] font-heading uppercase tracking-wide">
                      Dynamic Plan
                    </h2>
                    <span className="bg-[#161c25] border border-[#2a3441] px-2 py-0.5 rounded text-[10px] text-cyan-400">
                      UPDATED
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap leading-relaxed text-xs font-sans text-[#8b949e]">
                    {artifacts.find((a) => a.type === "plan")?.content}
                  </pre>
                </div>
              </ScrollArea>
            )}

            {activeTab === "code" && (
              <div className="h-full flex flex-col bg-[#11161d] border border-[#1e2632] rounded-lg overflow-hidden">
                <div className="h-9 w-full bg-[#161c25] border-b border-[#1e2632] px-4 flex items-center justify-between text-xs select-none">
                  <div className="font-mono text-[10px] text-[#e6edf3]">
                    📂 src/components/<span className="text-[#00e0ff] font-bold">Testimonials.astro</span>
                  </div>
                  <span className="text-[9.5px] font-mono text-[#3fb950] bg-[#3fb950]/10 px-2 py-0.2 rounded border border-[#3fb950]/30">
                    DIFF READY
                  </span>
                </div>

                <ScrollArea className="flex-1 font-mono p-4 text-[11px] leading-relaxed bg-[#060810] overflow-x-auto">
                  <div className="whitespace-pre min-w-max text-[#8b949e]">
                    {artifacts
                      .find((a) => a.type === "code")
                      ?.content.split("\n")
                      .map((line, idx) => {
                        const isDeleted = line.startsWith("-") || line.includes("<<<< ORIGINAL");
                        const isAdded =
                          line.startsWith("+") ||
                          line.includes("====") ||
                          line.includes(">>>>") ||
                          line.includes("<!--");
                        let lineClass = "text-[#8b949e]";
                        let bgClass = "";

                        if (
                          line.includes("<<<< ORIGINAL") ||
                          line.includes("====") ||
                          line.includes(">>>>")
                        ) {
                          lineClass =
                            "text-yellow-500 font-bold border-y border-yellow-500/20 block py-0.5 my-1";
                          bgClass = "bg-yellow-500/5";
                        } else if (line.trim().startsWith("-") || isDeleted) {
                          lineClass = "text-red-400";
                          bgClass = "bg-red-500/10 block";
                        } else if (line.trim().startsWith("+") || isAdded) {
                          lineClass = "text-[#3fb950]";
                          bgClass = "bg-[#3fb950]/10 block";
                        }

                        return (
                          <div key={idx} className={`${bgClass} px-2`}>
                            <span className={`${lineClass}`}>{line}</span>
                          </div>
                        );
                      })}
                  </div>
                </ScrollArea>
              </div>
            )}

            {activeTab === "terminal" && (
              <div className="h-full flex flex-col bg-black border border-[#1e2632] rounded-lg overflow-hidden font-mono shadow-inner shadow-black">
                <div className="h-9 w-full bg-[#11161d] border-b border-[#1e2632] px-4 flex items-center justify-between text-xs select-none">
                  <div className="flex items-center gap-2">
                    <TerminalIcon className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="font-bold text-[10px] text-[#e6edf3]">AXOD-COMMAND-RUNNER</span>
                  </div>
                  <span className="text-[9px] bg-[#161c25] px-1.5 py-0.5 rounded border border-[#2a3441] text-[#8b949e]">
                    xterm-stream
                  </span>
                </div>

                <ScrollArea className="flex-1 p-4 text-xs font-mono leading-relaxed bg-black text-[#8b949e]">
                  <pre className="whitespace-pre-wrap">{artifacts.find((a) => a.type === "terminal")?.content}</pre>

                  <div className="mt-3 border-t border-[#1e2632]/80 pt-2 flex items-center gap-1.5 text-cyan-400">
                    <span>$</span>
                    <span className="text-[#e6edf3] font-bold">pnpm run build</span>
                    <div className="w-2 h-4 bg-cyan-400 animate-pulse ml-0.5 inline-block align-middle" />
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        </section>
      </main>

      {/* ─── Footer strip ─── */}
      <footer className="h-8 w-full bg-[#11161d] border-t border-[#1e2632] px-4 flex items-center justify-between text-[10px] font-mono text-[#5c6470] shrink-0 select-none">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#3fb950] shadow-[0_0_4px_#3fb950]" />
            SERVER ONLINE
          </span>
          <span>•</span>
          <span>
            WORKDIR: <code className="text-[#8b949e]">{session.worktreePath}</code>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-cyan-400">Claude SDK Engine active</span>
          <span>•</span>
          <span>v1.0.0-skeleton</span>
        </div>
      </footer>
    </div>
  );
}
