import 'server-only';
import { db } from '@/db/client';
import { projects } from '@/db/schema';
import { pickProjectId } from '@/lib/projects';
import { getOrCreateActiveSession } from '@/lib/active-project';

/**
 * Insert a project row for an on-disk git repo and ensure it has an active
 * session. Shared by the manual "Add Project" route and companion ingestion.
 * Does NOT touch cookies (callers with a request set the active-project cookie).
 */
export async function registerProject(input: {
  name: string;
  repoPath: string;
  defaultBranch?: string;
  githubUrl?: string | null;
}): Promise<{ projectId: string }> {
  const existing = await db.select({ id: projects.id }).from(projects);
  const projectId = pickProjectId(input.name, existing.map((p) => p.id));
  await db.insert(projects).values({
    id: projectId,
    name: input.name.trim(),
    repo_path: input.repoPath,
    github_url: input.githubUrl?.trim() || null,
    default_branch: input.defaultBranch?.trim() || 'dev',
    created_at: new Date(),
  });
  await getOrCreateActiveSession(projectId);
  return { projectId };
}
