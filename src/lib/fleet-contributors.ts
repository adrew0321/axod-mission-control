import 'server-only';
import { eq, isNotNull, isNull, and, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, projects, schedules } from '@/db/schema';
import { getProposals } from './proposals-data';
import { getDreams } from './dreams-data';
import { getSchedules } from './schedules-data';
import { readSoulProposal } from '@/lib/akira/memory/soul';
import {
  getFleetSnapshot,
  type FleetSnapshot,
  type SnapshotContributor,
} from './fleet-snapshot';

const ageMin = (d: Date | string | null): number =>
  d ? Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000)) : 0;

const projectsContributor: SnapshotContributor = {
  key: 'projects',
  collect: async () => {
    const rows = await db.select().from(projects);
    return {
      projects: rows.map((p) => ({
        id: p.id,
        name: p.name,
        activeSessionId: p.active_session_id ?? null,
        lastTurnAt: null,
      })),
    };
  },
};

const runningContributor: SnapshotContributor = {
  key: 'running',
  collect: async () => {
    const rows = await db
      .select({ sessionId: sessions.id, projectId: projects.id, projectName: projects.name })
      .from(sessions)
      .innerJoin(projects, eq(sessions.project_id, projects.id))
      .where(and(isNotNull(sessions.running_since), isNull(sessions.archived_at)));
    return { running: rows.map((r) => ({ projectId: r.projectId, projectName: r.projectName, sessionId: r.sessionId })) };
  },
};

const proposalsContributor: SnapshotContributor = {
  key: 'proposals',
  collect: async () => {
    const ps = await getProposals();
    return {
      proposals: ps.map((p) => ({
        projectId: p.projectId,
        projectName: p.projectName,
        sessionId: p.sessionId,
        summary: p.summary,
        ageMinutes: ageMin(p.ts),
      })),
    };
  },
};

const healthContributor: SnapshotContributor = {
  key: 'health',
  collect: async () => {
    // The named health-check job: most recently run schedule whose title mentions health.
    const rows = await db.select().from(schedules).orderBy(desc(schedules.last_run_at));
    const job = rows.find((s) => /health/i.test(s.title) && s.last_run_at);
    if (!job) return { health: { verdict: 'unknown', at: null } };
    const verdict = job.last_status === 'fail' ? 'fail' : job.last_status === 'ok' ? 'pass' : 'unknown';
    return { health: { verdict, at: job.last_run_at ? job.last_run_at.toISOString() : null } };
  },
};

const insightsContributor: SnapshotContributor = {
  key: 'insights',
  collect: async () => {
    const dreams = await getDreams();
    const newest = dreams[0];
    const items = (newest?.insights ?? []).filter((i) => i.status !== 'dismissed').slice(0, 3);
    const at = newest?.createdAt ?? null;
    return { insights: items.map((i) => ({ title: i.title, detail: i.detail, ageMinutes: ageMin(at) })) };
  },
};

const schedulesContributor: SnapshotContributor = {
  key: 'schedules',
  collect: async () => {
    const all = await getSchedules();
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const due = all.filter((s) => s.enabled && s.nextRunAt && new Date(s.nextRunAt) <= today);
    return { schedules: due.map((s) => ({ projectId: s.projectId, title: s.title, nextRunAt: s.nextRunAt })) };
  },
};

const soulProposalContributor: SnapshotContributor = {
  key: 'soulProposal',
  collect: async () => {
    const p = readSoulProposal();
    return { soulProposal: p ? { reason: p.reason } : null };
  },
};

/**
 * The live contributor set. Adding a new user-visible subsystem? Add a
 * contributor here (and extend FleetSnapshot) so AKIRA stays aware of it.
 */
export const CONTRIBUTORS: SnapshotContributor[] = [
  projectsContributor,
  runningContributor,
  proposalsContributor,
  healthContributor,
  insightsContributor,
  schedulesContributor,
  soulProposalContributor,
];

/** Build the live fleet snapshot from the real DB-backed contributors. */
export function getFleetSnapshotLive(): Promise<FleetSnapshot> {
  return getFleetSnapshot(CONTRIBUTORS);
}
