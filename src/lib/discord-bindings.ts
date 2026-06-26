import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { discord_bindings, projects } from '@/db/schema';

export async function getBinding(channelId: string) {
  return db
    .select({ project_id: discord_bindings.project_id })
    .from(discord_bindings)
    .where(eq(discord_bindings.channel_id, channelId))
    .limit(1)
    .then((r) => r[0]);
}

export async function setBinding(channelId: string, projectId: string): Promise<void> {
  await db
    .insert(discord_bindings)
    .values({ channel_id: channelId, project_id: projectId, created_at: new Date() })
    .onConflictDoUpdate({
      target: discord_bindings.channel_id,
      set: { project_id: projectId },
    });
}

export async function removeBinding(channelId: string): Promise<void> {
  await db.delete(discord_bindings).where(eq(discord_bindings.channel_id, channelId));
}

/** All channel ids bound to a project (reverse of getBinding). A project may bind several. */
export async function getChannelsForProject(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ channel_id: discord_bindings.channel_id })
    .from(discord_bindings)
    .where(eq(discord_bindings.project_id, projectId));
  return rows.map((r) => r.channel_id);
}

/** Case-insensitive exact match on project name. */
export async function findProjectByName(name: string) {
  return db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(sql`lower(${projects.name}) = lower(${name})`)
    .limit(1)
    .then((r) => r[0]);
}
