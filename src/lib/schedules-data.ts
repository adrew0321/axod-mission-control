import 'server-only';
import { desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { schedules } from '@/db/schema';
import { parseCadence, summarizeCadence } from '@/lib/schedule';

/** Serializable schedule shape for the client (Dates → ISO strings). */
export interface ScheduleRow {
  id: string;
  projectId: string;
  title: string;
  instruction: string;
  cadenceKind: string;
  intervalHours: number | null;
  timeOfDay: string | null;
  dayOfWeek: number | null;
  cadenceSummary: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastSessionId: string | null;
}

export async function getSchedules(): Promise<ScheduleRow[]> {
  const rows = await db.select().from(schedules).orderBy(desc(schedules.created_at));
  return rows.map((s) => ({
    id: s.id,
    projectId: s.project_id,
    title: s.title,
    instruction: s.instruction,
    cadenceKind: s.cadence_kind,
    intervalHours: s.interval_hours,
    timeOfDay: s.time_of_day,
    dayOfWeek: s.day_of_week,
    cadenceSummary: summarizeCadence(parseCadence(s)),
    enabled: s.enabled,
    nextRunAt: s.next_run_at ? s.next_run_at.toISOString() : null,
    lastRunAt: s.last_run_at ? s.last_run_at.toISOString() : null,
    lastStatus: s.last_status,
    lastSessionId: s.last_session_id,
  }));
}
