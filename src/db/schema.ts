import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repo_path: text('repo_path').notNull(),
  github_url: text('github_url'),
  default_branch: text('default_branch').default('dev'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  model: text('model').notNull(),
  system_prompt: text('system_prompt').notNull(),
  tools_allowlist: text('tools_allowlist', { mode: 'json' }).$type<string[]>(),
  color: text('color'),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  project_id: text('project_id').references(() => projects.id).notNull(),
  title: text('title'),
  branch: text('branch'),
  worktree_path: text('worktree_path'),
  status: text('status').notNull(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  session_id: text('session_id').references(() => sessions.id).notNull(),
  agent_id: text('agent_id').references(() => agents.id),
  role: text('role').notNull(),
  content: text('content').notNull(),
  tool_calls: text('tool_calls', { mode: 'json' }).$type<unknown>(),
  token_count_in: integer('token_count_in'),
  token_count_out: integer('token_count_out'),
  cost_usd: real('cost_usd'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  session_id: text('session_id').references(() => sessions.id).notNull(),
  agent_id: text('agent_id').references(() => agents.id).notNull(),
  tool_name: text('tool_name').notNull(),
  tool_args: text('tool_args', { mode: 'json' }).$type<unknown>(),
  status: text('status').notNull(),
  decided_at: integer('decided_at', { mode: 'timestamp' }),
});

export const tool_permissions = sqliteTable(
  'tool_permissions',
  {
    agent_id: text('agent_id').references(() => agents.id).notNull(),
    project_id: text('project_id').references(() => projects.id).notNull(),
    tool_name: text('tool_name').notNull(),
    policy: text('policy').notNull(),
  },
  (t) => [primaryKey({ columns: [t.agent_id, t.project_id, t.tool_name] })],
);

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  session_id: text('session_id').references(() => sessions.id).notNull(),
  agent_id: text('agent_id').references(() => agents.id).notNull(),
  type: text('type').notNull(),
  title: text('title'),
  content: text('content'),
  file_changes: text('file_changes', { mode: 'json' }).$type<unknown>(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const auth_users = sqliteTable('auth_users', {
  id: text('id').primaryKey(),
  email: text('email').unique().notNull(),
  password_hash: text('password_hash').notNull(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const auth_sessions = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(),
  user_id: text('user_id').references(() => auth_users.id).notNull(),
  expires_at: integer('expires_at', { mode: 'timestamp' }).notNull(),
});

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  project: one(projects, { fields: [sessions.project_id], references: [projects.id] }),
  messages: many(messages),
  artifacts: many(artifacts),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  session: one(sessions, { fields: [messages.session_id], references: [sessions.id] }),
  agent: one(agents, { fields: [messages.agent_id], references: [agents.id] }),
}));

export const projectsRelations = relations(projects, ({ many }) => ({
  sessions: many(sessions),
}));
