import 'server-only';
import { z } from 'zod';
import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { db } from '@/db/client';
import { sessions, messages } from '@/db/schema';
import {
  AKIRA_SERVER_NAME,
  type AkiraToolContext,
  type ToolResult,
  ok,
  err,
  navigateHandler,
  openHandler,
  relayHandler,
} from './tool-actions';

export {
  AKIRA_SERVER_NAME,
  AKIRA_NAVIGATE,
  AKIRA_OPEN,
  AKIRA_RELAY,
  AKIRA_LIST_SESSIONS,
  AKIRA_GET_SESSION,
} from './tool-actions';
export type { AkiraToolContext } from './tool-actions';

export async function listSessionsHandler(args: { projectId: string }): Promise<ToolResult> {
  if (!args.projectId) return err('projectId is required.');
  const rows = await db
    .select({ id: sessions.id, title: sessions.title, status: sessions.status, running: sessions.running_since })
    .from(sessions)
    .where(and(eq(sessions.project_id, args.projectId), isNull(sessions.archived_at)))
    .orderBy(desc(sessions.updated_at));
  if (rows.length === 0) return ok('No active sessions in that project.');
  return ok(rows.map((r) => `${r.id} — ${r.title ?? '(untitled)'} [${r.running ? 'running' : r.status}]`).join('\n'));
}

export async function getSessionDetailHandler(args: { sessionId: string }): Promise<ToolResult> {
  if (!args.sessionId) return err('sessionId is required.');
  const s = await db.select().from(sessions).where(eq(sessions.id, args.sessionId)).limit(1).then((r) => r[0]);
  if (!s) return err(`No session ${args.sessionId}.`);
  const last = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.session_id, args.sessionId))
    .orderBy(desc(messages.created_at), desc(sql`rowid`))
    .limit(1)
    .then((r) => r[0]);
  return ok(
    `Session ${s.id} — ${s.title ?? '(untitled)'}\nstatus: ${s.running_since ? 'running' : s.status}\nbase: ${s.base_branch ?? 'n/a'}\nlast message: ${last ? `${last.role}: ${last.content.slice(0, 200)}` : 'none'}`,
  );
}

import { browserToolDefs } from './browser-tools';
import { isOnline } from '@/lib/companion/registry';

/**
 * Build the in-process MCP server exposing AKIRA's tools. Action handlers come
 * from the pure ./tool-actions module (unit-tested); the read handlers live here
 * because they touch the DB. AKIRA never gets dispatch_agent or any edit tool.
 */
export function createAkiraServer(ctx: AkiraToolContext) {
  const navigate = tool(
    'navigate',
    'Take the operator into a project (and optionally a specific session) in the dashboard. Use when he asks to open/go to/show a project or session.',
    {
      projectId: z.string().min(1).describe('The project id to open.'),
      sessionId: z.string().optional().describe('Optional session id within that project.'),
    },
    (a) => navigateHandler(a, ctx),
  );

  const open = tool(
    'open',
    "Open a web destination in the operator's browser (e.g. Outlook, GitHub, Amazon search). Use his words as the target; include a query to perform a search.",
    {
      target: z.string().min(1).describe('What to open, in the operator\'s words (e.g. "outlook", "amazon").'),
      query: z.string().optional().describe('Optional search text for searchable sites.'),
    },
    (a) => openHandler(a, ctx),
  );

  const relay = tool(
    'relay',
    "Propose handing a concrete work request to a project's team (Sage). This PROPOSES only and never starts work — the operator must confirm. Provide the target session and a clear, self-contained instruction.",
    {
      projectId: z.string().min(1).describe('The target project id.'),
      sessionId: z.string().min(1).describe('The target session id within that project.'),
      instruction: z.string().min(1).describe('A concrete, self-contained instruction for the project team.'),
    },
    (a) => relayHandler(a, ctx),
  );

  const listSessions = tool(
    'list_sessions',
    'List the active sessions in a project (id, title, status). Read-only.',
    { projectId: z.string().min(1).describe('The project id.') },
    (a) => listSessionsHandler(a),
  );

  const getSession = tool(
    'get_session_detail',
    'Get detail for one session (status, base branch, last message). Read-only.',
    { sessionId: z.string().min(1).describe('The session id.') },
    (a) => getSessionDetailHandler(a),
  );

  const base = [navigate, open, relay, listSessions, getSession];
  const tools = isOnline() ? [...base, ...browserToolDefs(ctx)] : base;

  return createSdkMcpServer({
    name: AKIRA_SERVER_NAME,
    version: '1.0.0',
    alwaysLoad: true,
    tools,
  });
}
