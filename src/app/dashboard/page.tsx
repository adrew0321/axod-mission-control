import { desc, asc, eq, sql, and, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db/client";
import { agents, sessions, messages, projects, approvals } from "@/db/schema";
import MissionControl from "@/components/mission-control";
import { type Agent, type Message, type Session } from "@/lib/mock-data";
import { dispatchAttribution } from "@/lib/dispatch-presentation";
import { resolveActiveProject, ACTIVE_PROJECT_COOKIE } from "@/lib/projects";
import { getOrCreateActiveSession } from "@/lib/active-project";
import { getLiveFeed } from "@/lib/live-feed";
import { getTaskBoard } from "@/lib/task-board-data";
import { getProposals } from "@/lib/proposals-data";
import { getSkills } from "@/lib/skills-data";
import { getSchedules } from "@/lib/schedules-data";
import { getDreams } from "@/lib/dreams-data";
import { getLatestPlanForSession } from "@/lib/plans";

export const dynamic = "force-dynamic";

const AGENT_DISPLAY: Record<string, { avatar: string; modelLabel: string }> = {
  sage: { avatar: "🜂", modelLabel: "Claude Opus 4.7" },
  atlas: { avatar: "⚒", modelLabel: "Claude Sonnet 4.6" },
  echo: { avatar: "⛬", modelLabel: "Claude Sonnet 4.6" },
};

// Maps the agent's DB `role` to its roster subtitle. Falls back to the raw role.
const ROLE_LABEL: Record<string, string> = {
  orchestrator: "Orchestration Engine",
  developer: "Lead Developer",
  qa: "QA Critic",
  researcher: "Researcher",
  devops: "DevOps",
  designer: "Designer",
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

export default async function DashboardPage() {
  const teamRows = await db.select().from(agents);

  const projectRows = await db.select().from(projects);
  if (projectRows.length === 0) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#060810] text-[#8b949e] font-mono text-sm">
        No projects yet — run <code className="text-[#00e0ff] ml-1">pnpm seed</code> to populate
        the database.
      </div>
    );
  }

  const recentSession = await db
    .select()
    .from(sessions)
    .orderBy(desc(sessions.updated_at))
    .limit(1)
    .then((rows) => rows[0]);

  const jar = await cookies();
  const project = resolveActiveProject(
    projectRows,
    jar.get(ACTIVE_PROJECT_COOKIE)?.value,
    recentSession?.project_id ?? undefined,
  )!; // non-null: projectRows is non-empty (guarded above)

  const currentSessionRow = await getOrCreateActiveSession(project.id);

  const sessionRows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.project_id, project.id), isNull(sessions.archived_at)))
    .orderBy(desc(sessions.updated_at));

  // Cleared sessions only surface messages created after the clear marker; the
  // rest stay in the DB (archived). cleared_at is null for un-cleared sessions.
  const messageRows = await db
    .select()
    .from(messages)
    .where(
      currentSessionRow.cleared_at
        ? and(
            eq(messages.session_id, currentSessionRow.id),
            gt(messages.created_at, currentSessionRow.cleared_at),
          )
        : eq(messages.session_id, currentSessionRow.id),
    )
    // rowid (insertion order) breaks created_at ties so a dispatch turn keeps
    // its true order: Sage-pre → specialist → Sage-post, even within one second.
    .orderBy(asc(messages.created_at), asc(sql`rowid`));

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
  const atlasWorking = messageRows.some((m) => m.agent_id === "atlas");

  const team: Agent[] = teamRows.map((a) => {
    const display = AGENT_DISPLAY[a.id] ?? { avatar: "●", modelLabel: a.model };
    const isWorking = a.id === "sage" || (a.id === "atlas" && atlasWorking);
    return {
      id: a.id,
      name: a.name,
      role: ROLE_LABEL[a.role] ?? a.role,
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
    project: project?.name ?? currentSessionRow.project_id ?? "",
    branch: currentSessionRow.branch ?? "(no branch)",
    repoPath: project?.repo_path ?? "",
    worktreePath: currentSessionRow.worktree_path ?? "",
    status: (currentSessionRow.status as Session["status"]) ?? "active",
    costUsd: Number(totals?.costUsd ?? 0),
    tokensIn: Number(totals?.tokensIn ?? 0),
    tokensOut: Number(totals?.tokensOut ?? 0),
    createdAt: currentSessionRow.created_at.toISOString(),
    clearedAt: currentSessionRow.cleared_at ? currentSessionRow.cleared_at.toISOString() : null,
  };

  const pendingApproval = approvalRows.find((a) => a.status === "pending");

  const messagesForUi: Message[] = messageRows.map((m) => {
    const agentRow = m.agent_id ? teamRows.find((a) => a.id === m.agent_id) : undefined;
    const senderName =
      m.role === "user" ? "AXOD" : agentRow?.name ?? "System";
    const attribution = dispatchAttribution(m.dispatched_via);

    return {
      id: m.id,
      role: m.role as Message["role"],
      agentId: m.agent_id ?? undefined,
      senderName,
      content: m.content,
      timestamp: formatTime(m.created_at),
      attribution,
      dispatchedVia: m.dispatched_via ?? undefined,
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

  const liveFeedEvents = await getLiveFeed();
  const initialTaskBoard = await getTaskBoard(project.id);
  const initialProposals = await getProposals();
  const initialSkills = await getSkills();
  const initialSchedules = await getSchedules();
  const initialDreams = await getDreams();
  const initialPlan = await getLatestPlanForSession(currentSessionRow.id);

  return (
    <MissionControl
      team={team}
      session={sessionForUi}
      initialMessages={messagesForUi}
      projects={projectRows.map((p) => ({ id: p.id, name: p.name }))}
      activeProjectId={project.id}
      sessions={sessionRows.map((s) => ({
        id: s.id,
        title: (s.title ?? "").trim() || "New session",
        baseBranch: s.base_branch ?? project.default_branch ?? "dev",
        hasChanges: s.worktree_path != null,
        isActive: s.id === currentSessionRow.id,
      }))}
      activeSessionId={currentSessionRow.id}
      initialLiveFeedEvents={liveFeedEvents}
      initialTaskBoard={initialTaskBoard}
      initialProposals={initialProposals}
      initialSkills={initialSkills}
      initialSchedules={initialSchedules}
      initialDreams={initialDreams}
      initialPlan={initialPlan}
    />
  );
}
