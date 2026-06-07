import 'server-only';
import { db } from '@/db/client';
import { messages, sessions, projects, agents, approvals, artifacts } from '@/db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';

export interface LiveFeedEvent {
  id: string;
  kind: 'dispatch' | 'reply' | 'approval' | 'artifact' | 'session';
  agentId?: string;
  agentName?: string;
  agentColor?: string;
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  projectName: string;
  label: string;
  quote?: string;
  meta?: {
    costUsd?: number;
    tokensIn?: number;
    tokensOut?: number;
    toolName?: string;
    status?: string;
    type?: string;
    toolArgs?: unknown;
  };
  ts: Date;
}

function truncateQuote(text: string, maxLen = 80): string {
  if (!text) return '';
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length > maxLen) {
    return firstLine.substring(0, maxLen) + '…';
  }
  return firstLine;
}

export async function getLiveFeed(limit = 50): Promise<LiveFeedEvent[]> {
  // 1. Fetch Agent lookup map for colors and names
  const allAgents = await db.select().from(agents);
  const agentMap = new Map(allAgents.map((a) => [a.id, a]));

  // 2. Fetch Messages (role = 'agent')
  const msgRows = await db
    .select({
      id: messages.id,
      agentId: messages.agent_id,
      dispatchedVia: messages.dispatched_via,
      content: messages.content,
      costUsd: messages.cost_usd,
      tokensIn: messages.token_count_in,
      tokensOut: messages.token_count_out,
      createdAt: messages.created_at,
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      projectId: projects.id,
      projectName: projects.name,
      agentName: agents.name,
      agentColor: agents.color,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.session_id, sessions.id))
    .innerJoin(projects, eq(sessions.project_id, projects.id))
    .leftJoin(agents, eq(messages.agent_id, agents.id))
    .where(eq(messages.role, 'agent'))
    .orderBy(desc(messages.created_at))
    .limit(limit);

  // 3. Fetch Approvals
  const approvalRows = await db
    .select({
      id: approvals.id,
      toolName: approvals.tool_name,
      toolArgs: approvals.tool_args,
      status: approvals.status,
      decidedAt: approvals.decided_at,
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      sessionUpdatedAt: sessions.updated_at,
      projectId: projects.id,
      projectName: projects.name,
      agentId: approvals.agent_id,
      agentName: agents.name,
      agentColor: agents.color,
    })
    .from(approvals)
    .innerJoin(sessions, eq(approvals.session_id, sessions.id))
    .innerJoin(projects, eq(sessions.project_id, projects.id))
    .innerJoin(agents, eq(approvals.agent_id, agents.id))
    .orderBy(desc(approvals.decided_at))
    .limit(limit);

  // 4. Fetch Artifacts
  const artifactRows = await db
    .select({
      id: artifacts.id,
      type: artifacts.type,
      title: artifacts.title,
      createdAt: artifacts.created_at,
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      projectId: projects.id,
      projectName: projects.name,
      agentId: artifacts.agent_id,
      agentName: agents.name,
      agentColor: agents.color,
    })
    .from(artifacts)
    .innerJoin(sessions, eq(artifacts.session_id, sessions.id))
    .innerJoin(projects, eq(sessions.project_id, projects.id))
    .innerJoin(agents, eq(artifacts.agent_id, agents.id))
    .orderBy(desc(artifacts.created_at))
    .limit(limit);

  // 5. Fetch Sessions (for lifecycle changes)
  const sessionRows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      updatedAt: sessions.updated_at,
      createdAt: sessions.created_at,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(sessions)
    .innerJoin(projects, eq(sessions.project_id, projects.id))
    .orderBy(desc(sessions.updated_at))
    .limit(limit);

  const events: LiveFeedEvent[] = [];

  // Map Messages
  for (const m of msgRows) {
    const sTitle = m.sessionTitle || '(untitled session)';

    // Construct Reply event
    events.push({
      id: `reply-${m.id}`,
      kind: 'reply',
      agentId: m.agentId ?? undefined,
      agentName: m.agentName ?? 'System',
      agentColor: m.agentColor ?? 'from-slate-400 to-slate-600',
      sessionId: m.sessionId,
      sessionTitle: sTitle,
      projectId: m.projectId,
      projectName: m.projectName,
      label: `${m.agentName ?? 'System'} replied`,
      quote: truncateQuote(m.content),
      meta: {
        costUsd: m.costUsd ?? undefined,
        tokensIn: m.tokensIn ?? undefined,
        tokensOut: m.tokensOut ?? undefined,
      },
      ts: m.createdAt,
    });

    // Construct Dispatch event if dispatched via another agent (Sage)
    if (m.dispatchedVia) {
      const dispatcher = agentMap.get(m.dispatchedVia);
      events.push({
        id: `dispatch-${m.id}`,
        kind: 'dispatch',
        agentId: m.dispatchedVia,
        agentName: dispatcher?.name ?? 'Sage',
        agentColor: dispatcher?.color ?? 'from-cyan-400 to-blue-500',
        sessionId: m.sessionId,
        sessionTitle: sTitle,
        projectId: m.projectId,
        projectName: m.projectName,
        label: `${dispatcher?.name ?? 'Sage'} dispatched ${m.agentName ?? 'specialist'}`,
        quote: `"${sTitle}"`,
        ts: new Date(m.createdAt.getTime() - 1000), // place 1s earlier
      });
    }
  }

  // Map Approvals
  for (const a of approvalRows) {
    const sTitle = a.sessionTitle || '(untitled session)';
    const ts = a.decidedAt || a.sessionUpdatedAt || new Date();
    
    let label = '';
    if (a.status === 'pending') {
      label = `⏳ ${a.agentName} wants ${a.toolName} · awaiting you`;
    } else if (a.status === 'approved') {
      label = `${a.agentName} was granted ${a.toolName}`;
    } else if (a.status === 'denied') {
      label = `${a.agentName} was denied ${a.toolName}`;
    } else {
      label = `${a.agentName} was granted ${a.toolName} (${a.status})`;
    }

    events.push({
      id: `approval-${a.id}`,
      kind: 'approval',
      agentId: a.agentId,
      agentName: a.agentName,
      agentColor: a.agentColor ?? 'from-slate-400 to-slate-600',
      sessionId: a.sessionId,
      sessionTitle: sTitle,
      projectId: a.projectId,
      projectName: a.projectName,
      label,
      quote: a.toolArgs ? JSON.stringify(a.toolArgs) : undefined,
      meta: {
        status: a.status,
        toolName: a.toolName,
        toolArgs: a.toolArgs,
      },
      ts,
    });
  }

  // Map Artifacts
  for (const art of artifactRows) {
    const sTitle = art.sessionTitle || '(untitled session)';
    events.push({
      id: `artifact-${art.id}`,
      kind: 'artifact',
      agentId: art.agentId,
      agentName: art.agentName,
      agentColor: art.agentColor ?? 'from-slate-400 to-slate-600',
      sessionId: art.sessionId,
      sessionTitle: sTitle,
      projectId: art.projectId,
      projectName: art.projectName,
      label: `${art.agentName} created a ${art.type}`,
      quote: art.title ? `"${art.title}"` : undefined,
      meta: {
        type: art.type,
      },
      ts: art.createdAt,
    });
  }

  // Map Sessions
  for (const s of sessionRows) {
    const sTitle = s.title || '(untitled session)';
    const statusLabel = s.status === 'active' ? 'active' : s.status;
    events.push({
      id: `session-${s.id}-${s.status}`,
      kind: 'session',
      sessionId: s.id,
      sessionTitle: sTitle,
      projectId: s.projectId,
      projectName: s.projectName,
      label: `Session "${sTitle}" → ${statusLabel}`,
      meta: {
        status: s.status,
      },
      ts: s.updatedAt || s.createdAt || new Date(),
    });
  }

  // 6. Sort descending by ts and limit
  return events.sort((a, b) => b.ts.getTime() - a.ts.getTime()).slice(0, limit);
}
