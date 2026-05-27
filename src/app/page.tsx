import { desc, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { agents, sessions, messages, projects, approvals } from "@/db/schema";
import MissionControl from "@/components/mission-control";
import { mockArtifacts, type Agent, type Message, type Session } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

const AGENT_DISPLAY: Record<string, { avatar: string; modelLabel: string }> = {
  sage: { avatar: "🜂", modelLabel: "Claude Opus 4.7" },
  atlas: { avatar: "⚒", modelLabel: "Claude Sonnet 4.6" },
};

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function relativeAge(d: Date): string {
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function HomePage() {
  const teamRows = await db.select().from(agents);

  const currentSessionRow = await db
    .select()
    .from(sessions)
    .orderBy(desc(sessions.updated_at))
    .limit(1)
    .then((rows) => rows[0]);

  if (!currentSessionRow) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#060810] text-[#8b949e] font-mono text-sm">
        No sessions yet — run <code className="text-[#00e0ff] ml-1">pnpm seed</code> to populate
        the database.
      </div>
    );
  }

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, currentSessionRow.project_id))
    .limit(1)
    .then((rows) => rows[0]);

  const messageRows = await db
    .select()
    .from(messages)
    .where(eq(messages.session_id, currentSessionRow.id))
    .orderBy(asc(messages.created_at));

  const approvalRows = await db
    .select()
    .from(approvals)
    .where(eq(approvals.session_id, currentSessionRow.id));

  const totals = await db
    .select({
      tokensIn: sql<number>`COALESCE(SUM(${messages.token_count_in}), 0)`,
      tokensOut: sql<number>`COALESCE(SUM(${messages.token_count_out}), 0)`,
      costUsd: sql<number>`COALESCE(SUM(${messages.cost_usd}), 0)`,
    })
    .from(messages)
    .where(eq(messages.session_id, currentSessionRow.id))
    .then((rows) => rows[0]);

  const sageRow = teamRows.find((a) => a.id === "sage");
  const atlasRow = teamRows.find((a) => a.id === "atlas");
  const atlasWorking = messageRows.some((m) => m.agent_id === "atlas");

  const team: Agent[] = teamRows.map((a) => {
    const display = AGENT_DISPLAY[a.id] ?? { avatar: "●", modelLabel: a.model };
    const isWorking = a.id === "sage" || (a.id === "atlas" && atlasWorking);
    return {
      id: a.id,
      name: a.name,
      role: a.role === "orchestrator" ? "Orchestration Engine" : "Lead Developer",
      model: display.modelLabel,
      system_prompt: a.system_prompt,
      color: a.color ?? "from-slate-400 to-slate-600",
      status: isWorking ? "working" : "idle",
      avatar: display.avatar,
      currentTask:
        a.id === "sage"
          ? "Sage is orchestrating Atlas on dynamic borders logic."
          : a.id === "atlas"
            ? "Editing src/components/Testimonials.astro"
            : undefined,
      lastActive: relativeAge(currentSessionRow.updated_at),
    };
  });

  const sessionForUi: Session = {
    id: currentSessionRow.id,
    title: currentSessionRow.title ?? "(untitled session)",
    project: project?.name ?? currentSessionRow.project_id,
    branch: currentSessionRow.branch ?? "(no branch)",
    repoPath: project?.repo_path ?? "",
    worktreePath: currentSessionRow.worktree_path ?? "",
    status: (currentSessionRow.status as Session["status"]) ?? "active",
    costUsd: Number(totals?.costUsd ?? 0),
    tokensIn: Number(totals?.tokensIn ?? 0),
    tokensOut: Number(totals?.tokensOut ?? 0),
    createdAt: currentSessionRow.created_at.toISOString(),
  };

  const pendingApproval = approvalRows.find((a) => a.status === "pending");

  const messagesForUi: Message[] = messageRows.map((m) => {
    const agentRow = m.agent_id ? teamRows.find((a) => a.id === m.agent_id) : undefined;
    const senderName =
      m.role === "user" ? "adrew0321" : agentRow?.name ?? "System";
    const attribution =
      m.agent_id && m.agent_id !== "sage" && m.role === "agent" ? "via Sage" : undefined;

    const isOrchestratorWithDispatch =
      m.agent_id === "sage" && m.content.toLowerCase().includes("dispatch") && atlasRow;

    return {
      id: m.id,
      role: m.role as Message["role"],
      agentId: m.agent_id ?? undefined,
      senderName,
      content: m.content,
      timestamp: formatTime(m.created_at),
      attribution,
      dispatch: isOrchestratorWithDispatch
        ? {
            agentId: "atlas",
            agentName: atlasRow!.name,
            task:
              "Inspect src/components/Testimonials.astro, implement high-fidelity marching-ants gradient borders, and verify the build.",
            status: "working" as const,
          }
        : undefined,
    };
  });

  if (pendingApproval) {
    messagesForUi.push({
      id: `sys_${pendingApproval.id}`,
      role: "system",
      senderName: "System",
      content: "Atlas requested tool permissions",
      timestamp: formatTime(currentSessionRow.updated_at),
      approval: {
        id: pendingApproval.id,
        toolName: pendingApproval.tool_name,
        toolArgs: pendingApproval.tool_args,
        status: pendingApproval.status as "pending" | "approved" | "denied",
      },
    });
  }

  void sageRow;

  return (
    <MissionControl
      team={team}
      session={sessionForUi}
      initialMessages={messagesForUi}
      artifacts={mockArtifacts}
    />
  );
}
