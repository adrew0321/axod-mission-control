"use client";

import React, { useState, useRef, useEffect, useTransition, useCallback } from "react";
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
  Eraser,
  Layers,
  ArrowRight,
  ShieldCheck,
  Eye,
  Hammer,
  Telescope,
  Bug,
  Palette,
  Cog,
  Users,
  MessageSquare,
  Briefcase,
  type LucideIcon,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Agent, Message, Session } from "@/lib/mock-data";
import DiffViewer, { type FileDiff } from "@/components/diff-viewer";
import Markdown from "@/components/markdown";
import { splitMessageSegments } from "@/lib/message-segments";
import { parseMention } from "@/lib/mention";
import TerminalView, { type TerminalLine } from "@/components/terminal-view";
import PlanView from "@/components/plan-view";
import { toPlanSnapshot, type PlanSnapshot } from "@/lib/plan-events";

export interface MissionControlProps {
  team: Agent[];
  session: Session;
  initialMessages: Message[];
}

// Per-agent identity: a distinct line icon + accent color matching each
// personality, used for the avatar, roster card border, and name.
const AGENT_ICON: Record<string, LucideIcon> = {
  sage: Compass, // navigator / orchestrator
  atlas: Hammer, // builder / smith
  nova: Telescope, // researcher
  echo: Bug, // QA critic
  pixel: Palette, // designer
  forge: Cog, // devops
};

const AGENT_ACCENT: Record<string, { border: string; name: string; bg: string }> = {
  sage: { border: "border-cyan-500/40", name: "text-cyan-300", bg: "bg-cyan-500/30" },
  atlas: { border: "border-indigo-500/40", name: "text-indigo-300", bg: "bg-indigo-500/30" },
  nova: { border: "border-emerald-500/40", name: "text-emerald-300", bg: "bg-emerald-500/30" },
  echo: { border: "border-violet-500/40", name: "text-violet-300", bg: "bg-violet-500/30" },
  pixel: { border: "border-pink-500/40", name: "text-pink-300", bg: "bg-pink-500/30" },
  forge: { border: "border-amber-500/40", name: "text-amber-300", bg: "bg-amber-500/30" },
};

// Raw accent hex per agent, fed to the `--glow` CSS var so the active card's
// breathing glow + sheen tint match the agent's identity. Falls back to cyan.
const AGENT_GLOW: Record<string, string> = {
  sage: "#00e0ff",
  atlas: "#6366f1",
  nova: "#10b981",
  echo: "#8b5cf6",
  pixel: "#ec4899",
  forge: "#f59e0b",
};

// Per-speaker accent + low-opacity bubble tint for the conversation thread.
// The operator is cyan; Sage is a distinct blue (so "you vs Sage" reads at a
// glance); other agents use their own hue.
function speakerStyle(role: string, agentId?: string | null): { accent: string; tint: string } {
  if (role === "user") return { accent: "#00e0ff", tint: "rgba(0,224,255,0.07)" };
  if (agentId === "sage") return { accent: "#3b82f6", tint: "rgba(59,130,246,0.08)" };
  if (agentId === "atlas") return { accent: "#6366f1", tint: "rgba(99,102,241,0.08)" };
  if (agentId === "echo") return { accent: "#8b5cf6", tint: "rgba(139,92,246,0.08)" };
  if (agentId === "nova") return { accent: "#10b981", tint: "rgba(16,185,129,0.08)" };
  return { accent: "#93c5fd", tint: "rgba(147,197,253,0.06)" };
}

function AgentIcon({ id, className }: { id: string; className?: string }) {
  const Icon = AGENT_ICON[id] ?? Sparkles;
  return <Icon className={className} />;
}

// Each agent has its own voice in the STATE panel. The persona flavors the verb,
// but the exact target (file / command / pattern) always stays visible so the
// operator knows precisely what's happening.
const IDLE_STATE: Record<string, string> = {
  sage: "Standing by at the helm",
  atlas: "Hammer cooled — ready to forge",
  echo: "Red pen capped — for now",
  nova: "Telescope stowed — ready to dig",
};
function idleState(agentId: string): string {
  return IDLE_STATE[agentId] ?? "Idle — standing by";
}

function friendlyActivity(agentId: string, tool: string, input?: Record<string, unknown>): string {
  const basename = (p: unknown) => (typeof p === "string" ? p.split(/[\\/]/).pop() || p : "");
  const clip = (s: unknown, n = 40) => {
    const str = typeof s === "string" ? s : "";
    return str.length > n ? str.slice(0, n) + "…" : str;
  };
  const file = basename(input?.file_path ?? input?.notebook_path);
  const genericFallback = () =>
    tool.startsWith("mcp__") ? tool.split("__").pop() ?? tool : tool;

  if (agentId === "atlas") {
    // Atlas — the builder/smith.
    switch (tool) {
      case "Read":
        return `Studying ${file}`;
      case "Edit":
      case "MultiEdit":
      case "Write":
      case "NotebookEdit":
        return `Forging changes → ${file}`;
      case "Glob":
        return "Scouring the codebase…";
      case "Grep":
        return input?.pattern ? `Hunting for "${clip(input.pattern, 28)}"` : "Hunting through the code…";
      case "Bash":
        return `At the anvil: ${clip(input?.command)}`;
      case "WebFetch":
      case "WebSearch":
        return "Consulting the archives…";
      case "TodoWrite":
        return "Drawing up the plan…";
      default:
        return genericFallback();
    }
  }

  if (agentId === "echo") {
    // Echo — the QA critic with a red pen.
    switch (tool) {
      case "Read":
        return `Inspecting ${file}`;
      case "Glob":
        return "Casing the codebase…";
      case "Grep":
        return input?.pattern ? `Combing for trouble: "${clip(input.pattern, 28)}"` : "Combing for trouble…";
      case "Bash": {
        const cmd = typeof input?.command === "string" ? input.command : "";
        return /\bgit\s+diff\b/.test(cmd)
          ? "Cross-examining the diff"
          : `Running the gauntlet: ${clip(input?.command)}`;
      }
      case "TodoWrite":
        return "Tallying the verdict…";
      default:
        return genericFallback();
    }
  }

  if (agentId === "nova") {
    // Nova — the researcher with a telescope.
    switch (tool) {
      case "WebSearch":
      case "WebFetch":
        return "Scouring the web…";
      case "Read":
        return `Reading up on ${file}`;
      case "Grep":
        return input?.pattern ? `Digging for "${clip(input.pattern, 28)}"` : "Digging through the code…";
      case "Glob":
        return "Casing the codebase…";
      case "TodoWrite":
        return "Outlining the findings…";
      default:
        return genericFallback();
    }
  }

  // Sage — the calm navigator/orchestrator (and default voice).
  switch (tool) {
    case "Read":
      return `Surveying ${file}`;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `Editing ${file}`;
    case "Glob":
      return "Surveying the repo…";
    case "Grep":
      return input?.pattern ? `Searching for "${clip(input.pattern, 28)}"` : "Searching…";
    case "Bash":
      return `Running: ${clip(input?.command)}`;
    case "WebFetch":
    case "WebSearch":
      return "Consulting outside sources…";
    case "TodoWrite":
      return "Charting the course…";
    default:
      if (tool.includes("dispatch_agent"))
        return `Handing the build to ${input?.agent_id ?? "a specialist"} →`;
      return genericFallback();
  }
}

export default function MissionControl({
  team: initialTeam,
  session: initialSession,
  initialMessages,
}: MissionControlProps) {
  const router = useRouter();
  const [team] = useState<Agent[]>(initialTeam);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [activeTab, setActiveTab] = useState<string>("plan");
  const [inputText, setInputText] = useState<string>("");
  const [session] = useState<Session>(initialSession);
  const [isTyping, setIsTyping] = useState<boolean>(false);
  // Who the "… is typing" indicator names — the agent driving the current turn
  // (Sage, or an @-addressed specialist).
  const [typingName, setTypingName] = useState<string>("Sage");
  const [typingColor, setTypingColor] = useState<string>("#00e0ff");
  const [sendError, setSendError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Live worktree diff (Day 4 — operator reviews what the dispatched agent changed).
  const [diffFiles, setDiffFiles] = useState<FileDiff[]>([]);
  const [diffBase, setDiffBase] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);

  // Preview tab: build the worktree's static site, serve it, iframe the result.
  const [previewStatus, setPreviewStatus] = useState<"idle" | "building" | "ready" | "error">("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLog, setPreviewLog] = useState<string>("");
  const [previewNonce, setPreviewNonce] = useState<number>(0); // bump to force iframe reload

  const buildPreview = useCallback(async () => {
    setPreviewStatus("building");
    setPreviewLog("");
    try {
      const res = await fetch(`/api/sessions/${initialSession.id}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "build" }),
      });
      const data = (await res.json()) as { ok?: boolean; url?: string; log?: string; error?: string };
      if (data.ok && data.url) {
        setPreviewUrl(data.url);
        setPreviewLog(data.log ?? "");
        setPreviewNonce((n) => n + 1);
        setPreviewStatus("ready");
      } else {
        setPreviewLog(data.log ?? data.error ?? "Build failed.");
        setPreviewStatus("error");
      }
    } catch (err) {
      setPreviewLog(err instanceof Error ? err.message : "Network error");
      setPreviewStatus("error");
    }
  }, [initialSession.id]);

  // Live Terminal tab: agents' Bash commands + output, accumulated in-session.
  // Ephemeral — cleared on full page reload (fresh mount), capped to bound memory.
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const lineIdRef = useRef<number>(0);

  // Live Plan tab: the most recent TodoWrite snapshot (latest writer wins).
  // Ephemeral — gone on full reload, persists across turns, not cleared on Stop.
  const [plan, setPlan] = useState<PlanSnapshot | null>(null);

  // Live agent state for the left pane: which agents are actively working, and
  // a one-line "what they're doing right now" string per agent. Driven by SSE.
  const [workingAgents, setWorkingAgents] = useState<string[]>([]);
  const [agentActivity, setAgentActivity] = useState<Record<string, string>>({});

  // Mobile responsive layout active tab state ("team" | "chat" | "workspace").
  // Defaults to "chat" view on mobile. Navigation is via the bottom tab bar.
  const [mobileActiveTab, setMobileActiveTab] = useState<"team" | "chat" | "workspace">("chat");

  const fetchDiff = useCallback(async () => {
    setDiffLoading(true);
    try {
      const res = await fetch(`/api/sessions/${initialSession.id}/diff`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { base: string | null; files: FileDiff[] };
      setDiffFiles(data.files ?? []);
      setDiffBase(data.base);
    } catch {
      // leave the previous diff in place on a transient fetch error
    } finally {
      setDiffLoading(false);
    }
  }, [initialSession.id]);

  useEffect(() => {
    setMessages(initialMessages);
  }, [initialMessages]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  function handleStop() {
    esRef.current?.close();
    esRef.current = null;
    setIsTyping(false);
    setWorkingAgents([]);
    setAgentActivity({});
    setMessages((prev) => prev.filter((m) => !m.isStreaming));
    startTransition(() => router.refresh());
  }

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  // Refresh the worktree diff whenever the operator opens the Code Diff tab.
  useEffect(() => {
    if (activeTab === "code") fetchDiff();
  }, [activeTab, fetchDiff]);

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

    const { agentId: mentionId } = parseMention(text, team);
    const primary =
      (mentionId && mentionId !== "sage" && team.find((a) => a.id === mentionId)) ||
      team.find((a) => a.id === "sage");
    const primaryId = primary?.id ?? "sage";
    const primaryName = primary?.name ?? "Sage";

    const optimisticId = `u_${Date.now()}`;
    const optimistic: Message = {
      id: optimisticId,
      role: "user",
      senderName: "AXOD",
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    setMessages((prev) => [...prev, optimistic]);
    setInputText("");
    setSendError(null);
    setWorkingAgents([primaryId]);
    setAgentActivity({ [primaryId]: primaryId === "sage" ? "Charting the course…" : "On it…" });
    setTypingName(primaryName);
    setTypingColor(speakerStyle("agent", primaryId).accent);

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
          agentId: primaryId,
          senderName: primaryName,
          content: "",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          isStreaming: true,
        },
      ]);
      setIsTyping(true);

      // Tracks the live "Atlas · via Sage" bubble while a dispatch is streaming.
      let dispatchStreamId: string | null = null;
      // The primary bubble currently receiving tokens (Sage, or an @-addressed
      // specialist). After a Sage dispatch, Sage's continuation goes into a NEW
      // bubble below the specialist's, so the live order matches what's saved.
      let currentPrimaryId = streamingId;
      let pendingNewSageBubble = false;
      const clientBubbleIds = [streamingId];

      const es = new EventSource(`/api/sessions/${session.id}/stream`);
      esRef.current = es;
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
            agent_id?: string;
            agent_name?: string;
            task?: string;
            errored?: boolean;
            tool?: string;
            input?: Record<string, unknown>;
            stream?: "command" | "output";
            isError?: boolean;
          };
          if (evt.type === "activity" && evt.agent_id && evt.tool) {
            const agentId = evt.agent_id;
            const label = friendlyActivity(agentId, evt.tool, evt.input);
            setAgentActivity((prev) => ({ ...prev, [agentId]: label }));
            const snap = toPlanSnapshot(evt.tool, evt.input, agentId);
            if (snap) setPlan(snap);
          } else if (evt.type === "terminal" && typeof evt.content === "string" && evt.stream) {
            // Skip empty command lines (a bare "$" is noise).
            if (!(evt.stream === "command" && evt.content.trim() === "")) {
              const line: TerminalLine = {
                id: lineIdRef.current++,
                kind: evt.stream,
                agentId: evt.agent_id ?? "sage",
                content: evt.content,
                isError: evt.isError,
              };
              setTerminalLines((prev) => {
                const next = [...prev, line];
                return next.length > 1000 ? next.slice(next.length - 1000) : next;
              });
            }
          } else if (evt.type === "dispatch_activity" && evt.agent_id && evt.tool) {
            const agentId = evt.agent_id;
            const label = friendlyActivity(agentId, evt.tool, evt.input);
            setAgentActivity((prev) => ({ ...prev, [agentId]: label }));
            const snap = toPlanSnapshot(evt.tool, evt.input, agentId);
            if (snap) setPlan(snap);
          } else if (evt.type === "token" && typeof evt.content === "string") {
            const tokenText = evt.content;
            if (pendingNewSageBubble) {
              // First token after a dispatch — open a fresh Sage bubble below the
              // specialist's, rather than appending to the pre-dispatch bubble.
              pendingNewSageBubble = false;
              currentPrimaryId = `stream_post_${Date.now()}`;
              clientBubbleIds.push(currentPrimaryId);
              const newId = currentPrimaryId;
              setMessages((prev) => [
                ...prev,
                {
                  id: newId,
                  role: "agent" as const,
                  agentId: "sage",
                  senderName: "Sage",
                  content: tokenText,
                  timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  isStreaming: true,
                },
              ]);
            } else {
              const sageId = currentPrimaryId;
              setMessages((prev) =>
                prev.map((m) => (m.id === sageId ? { ...m, content: m.content + tokenText } : m)),
              );
            }
          } else if (evt.type === "dispatch_start" && evt.agent_id) {
            // Sage handed off to a specialist: tag Sage's bubble with a dispatch
            // card and open a fresh streaming bubble for the specialist.
            const dispatchAgentId = evt.agent_id;
            const dispatchAgentName = evt.agent_name ?? dispatchAgentId;
            const task = evt.task ?? "";
            setIsTyping(false);
            setWorkingAgents((prev) =>
              prev.includes(dispatchAgentId) ? prev : [...prev, dispatchAgentId],
            );
            setAgentActivity((prev) => ({
              ...prev,
              [dispatchAgentId]:
                dispatchAgentId === "atlas"
                  ? "Warming the forge…"
                  : dispatchAgentId === "echo"
                    ? "Sharpening the red pen…"
                    : "Spinning up…",
              sage: `Handing the build to ${dispatchAgentName} →`,
            }));
            dispatchStreamId = `dispatch_${dispatchAgentId}_${Date.now()}`;
            const newBubbleId = dispatchStreamId;
            clientBubbleIds.push(newBubbleId);
            const cardSageId = currentPrimaryId;
            setMessages((prev) => [
              ...prev.map((m) =>
                m.id === cardSageId
                  ? {
                      ...m,
                      dispatch: {
                        agentId: dispatchAgentId,
                        agentName: dispatchAgentName,
                        task,
                        status: "working" as const,
                      },
                    }
                  : m,
              ),
              {
                id: newBubbleId,
                role: "agent" as const,
                agentId: dispatchAgentId,
                senderName: dispatchAgentName,
                attribution: "via Sage",
                content: "",
                timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                isStreaming: true,
              },
            ]);
          } else if (evt.type === "dispatch_token" && typeof evt.content === "string") {
            const bubbleId = dispatchStreamId;
            if (bubbleId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === bubbleId ? { ...m, content: m.content + evt.content } : m,
                ),
              );
            }
          } else if (evt.type === "dispatch_done") {
            const bubbleId = dispatchStreamId;
            const failed = Boolean(evt.errored);
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id === bubbleId) return { ...m, isStreaming: false };
                if (m.dispatch && m.dispatch.status === "working")
                  return {
                    ...m,
                    dispatch: { ...m.dispatch, status: failed ? "failed" : "completed" },
                  };
                return m;
              }),
            );
            dispatchStreamId = null;
            pendingNewSageBubble = true; // Sage's continuation opens a new bubble below
            setIsTyping(true); // Sage resumes the turn
            // Specialist is done: drop it from the roster, hand state back to Sage.
            if (evt.agent_id) {
              const finishedId = evt.agent_id;
              setWorkingAgents((prev) => prev.filter((a) => a !== finishedId));
              setAgentActivity((prev) => {
                const next = { ...prev };
                delete next[finishedId];
                next.sage = `Reviewing ${finishedId === "atlas" ? "Atlas" : "the specialist"}'s work…`;
                return next;
              });
            }
            fetchDiff(); // the specialist just edited the worktree — refresh the diff
          } else if (evt.type === "dispatch_error") {
            setSendError(evt.message ?? "Dispatched agent error");
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
            esRef.current = null;
            setIsTyping(false);
            setWorkingAgents([]);
            setAgentActivity({});
            // Drop every client-side streaming bubble created this turn (Sage-pre,
            // specialist, Sage-post); router.refresh() repopulates them from the DB.
            setMessages((prev) =>
              prev.filter((m) => !clientBubbleIds.includes(m.id) && !m.id.startsWith("dispatch_")),
            );
            fetchDiff();
            startTransition(() => router.refresh());
          }
        } catch {
          // ignore non-JSON keepalives
        }
      };
      es.onerror = () => {
        es.close();
        setIsTyping(false);
        setWorkingAgents([]);
        setAgentActivity({});
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

  // Clear the session log: set a server-side cleared_at marker so the view AND
  // Sage's memory start fresh (and persist across reloads). Messages stay in the
  // DB; nothing is deleted.
  const handleClearLog = async () => {
    try {
      const res = await fetch(`/api/sessions/${session.id}/clear`, { method: "POST" });
      if (res.ok) {
        setMessages([]);
        setSendError(null);
      } else {
        setSendError("Couldn't clear the log — try again.");
      }
    } catch {
      setSendError("Couldn't clear the log — try again.");
    }
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

          <div className="hidden sm:block h-4 w-[1px] bg-[#1e2632]" />

          <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 bg-[#161c25] border border-[#1e2632] rounded-md cursor-pointer hover:bg-[#1c2330] transition-colors">
            <span className="text-[9px] font-mono text-[#5c6470] uppercase tracking-wider">PROJECT</span>
            <span className="text-xs font-semibold text-[#e6edf3]">{session.project}</span>
            <ChevronDown className="w-3.5 h-3.5 text-[#5c6470]" />
          </div>

          <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 bg-[#161c25] border border-[#2a3441] rounded-md">
            <div className="w-2 h-2 rounded-full bg-[#3fb950] animate-pulse shadow-[0_0_8px_#3fb950]" />
            <span className="text-[10px] font-mono text-[#8b949e]">{session.branch}</span>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="hidden md:flex items-center gap-4 text-[11px] font-mono text-[#8b949e]">
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
        <section className={`w-full md:w-[280px] bg-[#11161d] border-r border-[#1e2632] flex flex-col shrink-0 ${
          mobileActiveTab === "team" ? "flex" : "hidden md:flex"
        }`}>
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
                <div className="flex-1 min-width-0">
                  <div className="font-semibold text-sm text-[#e6edf3] font-heading leading-tight">{sage.name}</div>
                  <div className="text-[10px] font-mono text-[#8b949e]">Orchestration Engine</div>
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

          <ScrollArea className="flex-1">
            <div className="p-1.5 flex flex-col gap-1">
              {otherAgents.map((member) => {
                const isWorking = workingAgents.includes(member.id);
                const activity = agentActivity[member.id];
                const accent = AGENT_ACCENT[member.id] ?? { border: "border-[#00e0ff]/40", name: "text-[#e6edf3]", bg: "bg-[#161c25]/40" };
                return (
                <div
                  key={member.id}
                  style={{ "--glow": AGENT_GLOW[member.id] ?? "#00e0ff" } as React.CSSProperties}
                  className={`group relative overflow-hidden p-2.5 rounded-lg border transition-all duration-200 cursor-pointer flex flex-col gap-2 ring-1 ring-inset ring-white/[0.04] shadow-md shadow-black/40 hover:-translate-y-0.5 hover:shadow-lg ${accent.bg} ${
                    isWorking
                      ? `${accent.border} animate-breathe`
                      : "border-transparent hover:border-[#2a3441]"
                  }`}
                >
                  {/* top-lit glass highlight for depth */}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-white/[0.05] to-transparent"
                  />
                  {/* slow diagonal sheen sweep while the agent is active */}
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
                        <span className="text-[9px] font-mono text-[#5c6470]">
                          {isWorking ? "now" : member.lastActive}
                        </span>
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
                  </div>
                </div>
                );
              })}
            </div>
          </ScrollArea>
        </section>

        {/* ─── MIDDLE PANE: ORCHESTRATOR CHAT ─── */}
        <section className={`flex-1 bg-[#0a0e14] border-r border-[#1e2632] flex flex-col min-w-0 md:min-w-[400px] ${
          mobileActiveTab === "chat" ? "flex" : "hidden md:flex"
        }`}>
          <div className="h-11 w-full bg-[#11161d] border-b border-[#1e2632] px-4 flex items-center gap-2 justify-between shrink-0 select-none">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-xs text-[#e6edf3] font-heading">Session Logs</span>
              <span className="text-[10px] font-mono text-[#5c6470] tracking-wider block">ID: {session.id}</span>
            </div>

            <div className="flex items-center gap-2">
              <div className="hidden sm:flex text-[10px] font-mono text-[#8b949e] items-center gap-1">
                <span className="text-[#5c6470]">Target Directory:</span>
                <code className="bg-[#161c25] border border-[#1e2632] px-1.5 py-0.2 rounded text-[#00e0ff]">
                  {session.repoPath}
                </code>
              </div>
              {messages.length > 0 && (
                <button
                  onClick={handleClearLog}
                  title="Clear the conversation — fresh start for you and Sage (messages kept in history, not deleted)"
                  className="shrink-0 flex items-center gap-1 text-[9.5px] font-mono text-[#8b949e] hover:text-[#00e0ff] bg-[#161c25] border border-[#2a3441] hover:border-cyan-500/40 px-2 py-0.5 rounded transition-colors"
                >
                  <Eraser className="w-3 h-3" />
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {messages.length === 0 && (
              <div className="text-center text-[#5c6470] font-mono text-xs py-16 select-none">
                Let&apos;s start fresh then…
              </div>
            )}
            {messages.map((msg) => {
              const speaker = msg.role === "agent" ? team.find((a) => a.id === msg.agentId) : undefined;
              const { accent, tint } = speakerStyle(msg.role, msg.agentId);
              return (
              <div key={msg.id} className="max-w-full flex gap-2.5 animate-message-in">
                <div className="shrink-0 pt-0.5 select-none">
                  {msg.role === "user" ? (
                    <div className="w-6 h-6 rounded-md bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center text-black text-[8px] font-extrabold">
                      AX
                    </div>
                  ) : msg.role === "agent" ? (
                    <div
                      className={`w-6 h-6 rounded-md bg-gradient-to-br ${speaker?.color ?? "from-slate-400 to-slate-600"} flex items-center justify-center text-black shadow-sm`}
                    >
                      <AgentIcon id={msg.agentId ?? ""} className="w-3.5 h-3.5" />
                    </div>
                  ) : (
                    <div className="w-6 h-6 rounded-md bg-[#161c25] border border-[#1e2632] flex items-center justify-center text-[#3b82f6] text-[11px]">
                      ❖
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
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
                    <span>{msg.content}</span>
                    <span className="text-[#5c6470] ml-auto">{msg.timestamp}</span>
                  </div>
                )}

                {msg.role === "user" && (
                  <div
                    className="text-xs leading-relaxed p-3 rounded-md border border-l-2 border-[#2a3441] text-[#e6edf3] whitespace-pre-wrap"
                    style={{ borderLeftColor: accent, backgroundColor: tint }}
                  >
                    {msg.content}
                  </div>
                )}

                {msg.role === "agent" && (() => {
                  const hasText = msg.content.trim().length > 0;
                  const segments = hasText ? splitMessageSegments(msg.content) : [];
                  return (
                    <div className="space-y-1.5">
                      {segments.map((segment, i) => (
                        <div
                          key={i}
                          className="text-xs leading-relaxed p-3 rounded-md border border-l-2 border-[#1e2632] text-[#8b949e]"
                          style={{ borderLeftColor: accent, backgroundColor: tint }}
                        >
                          <Markdown>{segment}</Markdown>
                          {msg.isStreaming && i === segments.length - 1 && (
                            <span
                              aria-hidden
                              className="inline-block w-[7px] h-3.5 ml-0.5 align-text-bottom rounded-sm animate-blink"
                              style={{ backgroundColor: accent }}
                            />
                          )}
                        </div>
                      ))}

                      {/* No text yet: show a working spinner ONLY when the global
                          "… is typing" indicator isn't already covering this turn
                          (i.e. a dispatched specialist's bubble, where isTyping is
                          false). Avoids a double spinner on a direct @-addressed turn.
                          When a dispatch card is attached, show just the card. */}
                      {!hasText && msg.isStreaming && !msg.dispatch && !isTyping && (
                        <div className="text-xs p-3 rounded-md border bg-[#11161d] border-[#1e2632] text-[#5c6470] flex items-center gap-1.5 font-mono">
                          <RefreshCw className="w-3 h-3 animate-spin text-[#00e0ff]" />
                          working…
                        </div>
                      )}

                      {msg.dispatch && (() => {
                        const dispatchAgent = team.find((a) => a.id === msg.dispatch!.agentId);
                        const status = msg.dispatch.status;
                        return (
                          <div className="mt-3 p-2.5 bg-[#060810] border border-cyan-500/10 rounded-md relative group overflow-hidden">
                            <div className="absolute left-0 inset-y-0 w-1 bg-gradient-to-b from-[#00e0ff] to-transparent" />
                            <div className="flex justify-between items-center text-[9px] font-mono text-cyan-400 uppercase tracking-wider mb-1.5">
                              <div className="flex items-center gap-1.5">
                                <Layers className="w-3.5 h-3.5" />
                                Orchestrated Dispatch
                              </div>
                              {status === "working" ? (
                                <span className="text-[#3fb950] animate-pulse">Running</span>
                              ) : status === "failed" ? (
                                <span className="text-red-500">Failed</span>
                              ) : (
                                <span className="text-[#3fb950]">Done</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-xs font-semibold text-[#e6edf3]">
                              <span
                                className={`w-5 h-5 rounded bg-gradient-to-br ${
                                  dispatchAgent?.color ?? "from-blue-400 to-indigo-600"
                                } flex items-center justify-center text-black`}
                              >
                                <AgentIcon id={msg.dispatch.agentId} className="w-3 h-3" />
                              </span>
                              {msg.dispatch.agentName} <ArrowRight className="w-3 h-3 text-[#5c6470]" />{" "}
                              {dispatchAgent?.role ?? "Specialist"}
                            </div>
                            <p className="text-[11px] text-[#8b949e] mt-1">{msg.dispatch.task}</p>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })()}

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
              </div>
              );
            })}

            {isTyping && (
              <div className="flex items-center gap-2 text-xs font-mono pl-[34px]">
                <span className="font-semibold" style={{ color: typingColor }}>
                  {typingName}
                </span>
                <span className="flex items-center gap-1">
                  <span
                    className="w-1.5 h-1.5 rounded-full animate-typing-dot"
                    style={{ backgroundColor: typingColor, animationDelay: "0ms" }}
                  />
                  <span
                    className="w-1.5 h-1.5 rounded-full animate-typing-dot"
                    style={{ backgroundColor: typingColor, animationDelay: "150ms" }}
                  />
                  <span
                    className="w-1.5 h-1.5 rounded-full animate-typing-dot"
                    style={{ backgroundColor: typingColor, animationDelay: "300ms" }}
                  />
                </span>
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
              {isTyping ? (
                <button
                  type="button"
                  onClick={handleStop}
                  className="bg-transparent border border-red-500/50 hover:bg-red-500/10 text-red-400 font-bold px-4 rounded-md text-xs flex items-center justify-center gap-1.5 transition-colors"
                >
                  <span className="w-2.5 h-2.5 bg-red-400 rounded-[2px]" />
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={isPending}
                  className="bg-[#00e0ff] hover:bg-[#00c0dd] disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold px-4 rounded-md text-xs flex items-center justify-center gap-1.5 transition-colors shadow-md shadow-cyan-500/10"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Send</span>
                </button>
              )}
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
        <section className={`flex-1 bg-[#0a0e14] flex flex-col overflow-hidden min-w-0 md:min-w-[400px] ${
          mobileActiveTab === "workspace" ? "flex" : "hidden md:flex"
        }`}>
          <div className="h-11 bg-[#11161d] border-b border-[#1e2632] flex items-center justify-between px-4 shrink-0 select-none">
            <div className="flex h-full gap-0.5 sm:gap-1">
              <button
                onClick={() => setActiveTab("preview")}
                className={`px-2 sm:px-3 flex items-center gap-1 sm:gap-1.5 border-b-2 text-[10px] sm:text-xs font-mono uppercase tracking-wider transition-colors ${
                  activeTab === "preview"
                    ? "border-[#00e0ff] text-[#00e0ff] font-semibold"
                    : "border-transparent text-[#5c6470] hover:text-[#8b949e]"
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                Preview
              </button>

              <button
                onClick={() => setActiveTab("plan")}
                className={`px-2 sm:px-3 flex items-center gap-1 sm:gap-1.5 border-b-2 text-[10px] sm:text-xs font-mono uppercase tracking-wider transition-colors ${
                  activeTab === "plan"
                    ? "border-[#00e0ff] text-[#00e0ff] font-semibold"
                    : "border-transparent text-[#5c6470] hover:text-[#8b949e]"
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                Plan
                {plan && plan.todos.length > 0 && (
                  <span className="bg-cyan-500/10 border border-cyan-500/25 text-[#00e0ff] text-[8.5px] px-1 py-0.2 rounded font-bold">
                    {plan.todos.filter((t) => t.status === "completed").length}/{plan.todos.length}
                  </span>
                )}
              </button>

              <button
                onClick={() => setActiveTab("code")}
                className={`px-2 sm:px-3 flex items-center gap-1 sm:gap-1.5 border-b-2 text-[10px] sm:text-xs font-mono uppercase tracking-wider transition-colors ${
                  activeTab === "code"
                    ? "border-[#00e0ff] text-[#00e0ff] font-semibold"
                    : "border-transparent text-[#5c6470] hover:text-[#8b949e]"
                }`}
              >
                <Compass className="w-3.5 h-3.5" />
                Code Diff
                {diffFiles.length > 0 && (
                  <span className="bg-cyan-500/10 border border-cyan-500/25 text-[#00e0ff] text-[8.5px] px-1 py-0.2 rounded font-bold">
                    {diffFiles.length}
                  </span>
                )}
              </button>

              <button
                onClick={() => setActiveTab("terminal")}
                className={`px-2 sm:px-3 flex items-center gap-1 sm:gap-1.5 border-b-2 text-[10px] sm:text-xs font-mono uppercase tracking-wider transition-colors ${
                  activeTab === "terminal"
                    ? "border-[#00e0ff] text-[#00e0ff] font-semibold"
                    : "border-transparent text-[#5c6470] hover:text-[#8b949e]"
                }`}
              >
                <TerminalIcon className="w-3.5 h-3.5" />
                Terminal
                {terminalLines.length > 0 && (
                  <span className="bg-cyan-500/10 border border-cyan-500/25 text-[#00e0ff] text-[8.5px] px-1 py-0.2 rounded font-bold">
                    {terminalLines.length}
                  </span>
                )}
              </button>
            </div>

            <div className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono text-[#8b949e]">
              <span className="w-2 h-2 rounded-full bg-[#3fb950] animate-pulse" />
              <span>WORKSPACE ACTIVE</span>
            </div>
          </div>

          <div className="flex-1 overflow-hidden p-4 relative">
            {activeTab === "preview" && (
              <div className="h-full flex flex-col bg-[#11161d] border border-[#1e2632] rounded-lg overflow-hidden">
                <div className="h-9 w-full bg-[#161c25] border-b border-[#1e2632] px-3 flex items-center justify-between text-xs select-none gap-2">
                  <div className="font-mono text-[10px] text-[#8b949e] flex items-center gap-2 min-w-0">
                    {previewStatus === "ready" && previewUrl ? (
                      <>
                        <span className="w-2 h-2 rounded-full bg-[#3fb950] shrink-0" />
                        <span className="truncate text-[#8b949e]">Built from worktree · {previewUrl}</span>
                      </>
                    ) : previewStatus === "building" ? (
                      <span className="text-[#00e0ff] flex items-center gap-1.5">
                        <RefreshCw className="w-3 h-3 animate-spin" /> Building site…
                      </span>
                    ) : previewStatus === "error" ? (
                      <span className="text-red-400">Build failed</span>
                    ) : (
                      <span className="text-[#5c6470]">Build the worktree to preview the live site</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {previewStatus === "ready" && (
                      <button
                        onClick={() => setPreviewNonce((n) => n + 1)}
                        className="flex items-center gap-1 text-[9.5px] font-mono text-[#8b949e] hover:text-[#00e0ff] bg-[#11161d] border border-[#2a3441] px-2 py-0.5 rounded transition-colors"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Reload
                      </button>
                    )}
                    <button
                      onClick={() => buildPreview()}
                      disabled={previewStatus === "building"}
                      className="flex items-center gap-1 text-[9.5px] font-mono text-[#060810] bg-[#00e0ff] hover:bg-[#00c0dd] font-bold px-2.5 py-0.5 rounded transition-colors disabled:opacity-50"
                    >
                      <Eye className="w-3 h-3" />
                      {previewStatus === "ready" ? "Rebuild" : "Build & preview"}
                    </button>
                  </div>
                </div>

                <div className="flex-1 min-h-0 bg-white relative">
                  {previewStatus === "ready" && previewUrl ? (
                    <iframe
                      key={previewNonce}
                      src={previewUrl}
                      title="Site preview"
                      className="w-full h-full border-0"
                      sandbox="allow-scripts allow-same-origin allow-forms"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#060810] p-6">
                      {previewStatus === "error" ? (
                        <pre className="max-h-full overflow-auto text-[10.5px] font-mono text-red-300 whitespace-pre-wrap">
                          {previewLog || "Build failed."}
                        </pre>
                      ) : (
                        <div className="text-center text-[#5c6470] text-xs font-mono">
                          {previewStatus === "building"
                            ? "Building the site — this takes ~15-20s…"
                            : "No preview yet. Hit “Build & preview” to render the worktree's site."}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === "plan" && <PlanView snapshot={plan} />}

            {activeTab === "code" && (
              <DiffViewer
                files={diffFiles}
                base={diffBase}
                loading={diffLoading}
                onRefresh={() => fetchDiff()}
              />
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

                <TerminalView lines={terminalLines} />
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Sleek Mobile Tab Bar */}
      <div className="md:hidden h-14 bg-[#11161d]/90 backdrop-blur-md border-t border-[#1e2632] flex items-center justify-around shrink-0 select-none px-4">
        {/* Roster / Team Tab */}
        <button
          onClick={() => setMobileActiveTab("team")}
          className={`flex flex-col items-center justify-center gap-1 flex-1 py-1.5 transition-all relative ${
            mobileActiveTab === "team" ? "text-[#00e0ff]" : "text-[#5c6470]"
          }`}
        >
          <Users className="w-5 h-5" />
          <span className="text-[9px] font-semibold tracking-wider">TEAM</span>
          {workingAgents.length > 0 && (
            <span className="absolute top-1.5 right-1/4 w-2.5 h-2.5 rounded-full bg-[#3fb950] animate-pulse shadow-[0_0_4px_#3fb950]" />
          )}
        </button>

        {/* Chat Tab */}
        <button
          onClick={() => setMobileActiveTab("chat")}
          className={`flex flex-col items-center justify-center gap-1 flex-1 py-1.5 transition-all relative ${
            mobileActiveTab === "chat" ? "text-[#00e0ff]" : "text-[#5c6470]"
          }`}
        >
          <MessageSquare className="w-5 h-5" />
          <span className="text-[9px] font-semibold tracking-wider">CHAT</span>
          {messages.some((m) => m.approval && m.approval.status === "pending") && (
            <span className="absolute top-1.5 right-1/4 w-2.5 h-2.5 rounded-full bg-[#d29922] animate-bounce shadow-[0_0_4px_#d29922]" />
          )}
        </button>

        {/* Workspace Tab */}
        <button
          onClick={() => setMobileActiveTab("workspace")}
          className={`flex flex-col items-center justify-center gap-1 flex-1 py-1.5 transition-all relative ${
            mobileActiveTab === "workspace" ? "text-[#00e0ff]" : "text-[#5c6470]"
          }`}
        >
          <Briefcase className="w-5 h-5" />
          <span className="text-[9px] font-semibold tracking-wider">WORKSPACE</span>
          {diffFiles.length > 0 && (
            <span className="absolute top-1 right-1/4 bg-[#00e0ff] text-black text-[9px] font-extrabold px-1.5 py-0.2 rounded-full scale-90">
              {diffFiles.length}
            </span>
          )}
        </button>
      </div>

      {/* ─── Footer strip ─── */}
      <footer className="hidden md:flex h-8 w-full bg-[#11161d] border-t border-[#1e2632] px-4 flex items-center justify-between text-[10px] font-mono text-[#5c6470] shrink-0 select-none">
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
