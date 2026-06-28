import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repo_path: text('repo_path').notNull(),
  github_url: text('github_url'),
  default_branch: text('default_branch').default('dev'),
  active_session_id: text('active_session_id'),
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
  base_branch: text('base_branch'),
  worktree_path: text('worktree_path'),
  status: text('status').notNull(),
  // When set, the conversation log + Sage's memory transcript only include
  // messages created after this timestamp (operator "Clear"). Messages before it
  // stay in the DB (archived, not deleted).
  cleared_at: integer('cleared_at', { mode: 'timestamp' }),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  // Concurrency lease: set while a turn runs (browser or CLI), null when idle.
  // A stale value (older than a turn's max duration + grace) is reclaimable.
  running_since: integer('running_since', { mode: 'timestamp' }),
  archived_at: integer('archived_at', { mode: 'timestamp' }),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  session_id: text('session_id').references(() => sessions.id).notNull(),
  agent_id: text('agent_id').references(() => agents.id),
  dispatched_via: text('dispatched_via').references(() => agents.id),
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

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  project_id: text('project_id').references(() => projects.id).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  // 'todo' | 'in_progress' | 'done' (the board column)
  status: text('status').notNull(),
  // Set when the card is dispatched; links the card to its session run.
  session_id: text('session_id').references(() => sessions.id),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  project_id: text('project_id').references(() => projects.id).notNull(),
  title: text('title').notNull(),
  instruction: text('instruction').notNull(),
  // Cadence (friendly presets). cadence_kind: 'every_hours' | 'daily' | 'weekly'.
  cadence_kind: text('cadence_kind').notNull(),
  interval_hours: integer('interval_hours'), // every_hours
  time_of_day: text('time_of_day'), // 'HH:MM' (daily/weekly), server-local
  day_of_week: integer('day_of_week'), // 0=Sun..6=Sat (weekly)
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  // The column the ticker queries: when this schedule next becomes due.
  next_run_at: integer('next_run_at', { mode: 'timestamp' }).notNull(),
  last_run_at: integer('last_run_at', { mode: 'timestamp' }),
  last_status: text('last_status'), // 'ok' | 'fail' | 'error' | 'skipped'
  last_session_id: text('last_session_id').references(() => sessions.id),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const dreams = sqliteTable('dreams', {
  id: text('id').primaryKey(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  // Window start this dream reflected on: previous dream's created_at, or now-7d.
  covers_since: integer('covers_since', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull(), // 'ok' | 'empty' | 'error'
  insight_count: integer('insight_count').notNull().default(0),
  error: text('error'),
});

export const dream_insights = sqliteTable('dream_insights', {
  id: text('id').primaryKey(),
  dream_id: text('dream_id').references(() => dreams.id).notNull(),
  category: text('category').notNull(), // 'pattern' | 'risk' | 'suggestion' | 'praise'
  title: text('title').notNull(),
  detail: text('detail').notNull(),
  status: text('status').notNull().default('new'), // 'new' | 'starred' | 'dismissed'
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const discord_bindings = sqliteTable('discord_bindings', {
  // Discord channel snowflake — one bound channel per row.
  channel_id: text('channel_id').primaryKey(),
  project_id: text('project_id').references(() => projects.id).notNull(),
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
