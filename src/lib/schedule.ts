// Pure cadence helpers for the Scheduler: next-run math, UI summary, and
// flat-column <-> Cadence conversion. No DB, no server-only — unit-testable.
// All HH:MM times are interpreted in the host's LOCAL timezone.

export type Cadence =
  | { kind: "every_hours"; intervalHours: number }
  | { kind: "daily"; timeOfDay: string } // "HH:MM"
  | { kind: "weekly"; dayOfWeek: number; timeOfDay: string }; // 0=Sun..6=Sat

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Next occurrence strictly after `from`, in the host's local time. */
export function computeNextRun(cadence: Cadence, from: Date): Date {
  if (cadence.kind === "every_hours") {
    return new Date(from.getTime() + cadence.intervalHours * 3_600_000);
  }
  const [h, m] = cadence.timeOfDay.split(":").map(Number);
  const next = new Date(from);
  next.setHours(h, m, 0, 0); // local time; setHours/setDate are DST-safe
  if (cadence.kind === "daily") {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  // weekly
  const dayDiff = (cadence.dayOfWeek - next.getDay() + 7) % 7;
  if (dayDiff > 0) next.setDate(next.getDate() + dayDiff);
  if (next <= from) next.setDate(next.getDate() + 7);
  return next;
}

/** Human label for the UI, e.g. "Daily at 09:00". */
export function summarizeCadence(cadence: Cadence): string {
  if (cadence.kind === "every_hours") {
    return `Every ${cadence.intervalHours} hour${cadence.intervalHours === 1 ? "" : "s"}`;
  }
  if (cadence.kind === "daily") return `Daily at ${cadence.timeOfDay}`;
  return `Weekly on ${DAYS[cadence.dayOfWeek]} at ${cadence.timeOfDay}`;
}

/** Build a Cadence from the flat DB columns. */
export function parseCadence(row: {
  cadence_kind: string;
  interval_hours: number | null;
  time_of_day: string | null;
  day_of_week: number | null;
}): Cadence {
  if (row.cadence_kind === "every_hours") {
    return { kind: "every_hours", intervalHours: row.interval_hours ?? 1 };
  }
  if (row.cadence_kind === "daily") {
    return { kind: "daily", timeOfDay: row.time_of_day ?? "09:00" };
  }
  return { kind: "weekly", dayOfWeek: row.day_of_week ?? 1, timeOfDay: row.time_of_day ?? "09:00" };
}

/** Flatten a Cadence into the DB columns. */
export function cadenceColumns(cadence: Cadence): {
  cadence_kind: string;
  interval_hours: number | null;
  time_of_day: string | null;
  day_of_week: number | null;
} {
  return {
    cadence_kind: cadence.kind,
    interval_hours: cadence.kind === "every_hours" ? cadence.intervalHours : null,
    time_of_day: cadence.kind === "every_hours" ? null : cadence.timeOfDay,
    day_of_week: cadence.kind === "weekly" ? cadence.dayOfWeek : null,
  };
}
