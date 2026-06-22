"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ScheduleRow } from "@/lib/schedules-data";

type CadenceKind = "every_hours" | "daily" | "weekly";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Props {
  schedules: ScheduleRow[];
  projects: { id: string; name: string }[];
}

export default function SchedulerView({ schedules, projects }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [instruction, setInstruction] = useState("");
  const [kind, setKind] = useState<CadenceKind>("daily");
  const [intervalHours, setIntervalHours] = useState(4);
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildCadence() {
    if (kind === "every_hours") return { kind, intervalHours };
    if (kind === "daily") return { kind, timeOfDay };
    return { kind, dayOfWeek, timeOfDay };
  }

  async function createSchedule() {
    if (!title.trim() || !instruction.trim() || !projectId) {
      setError("Title, project, and instruction are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title, instruction, cadence: buildCadence() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Create failed");
      }
      setTitle("");
      setInstruction("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    await fetch(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    router.refresh();
  }

  async function remove(id: string) {
    await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    router.refresh();
  }

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
  const statusColor = (s: string | null) =>
    s === "ok" ? "text-emerald-400" : s === "error" ? "text-red-400" : "text-amber-400";

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-[#060810] text-[#e2e8f0]">
      <div className="mb-5">
        <h1 className="text-lg font-semibold">Scheduler</h1>
        <p className="text-xs text-[#7c8794]">
          Recurring agent tasks — fire an instruction at a repo on a cadence, no browser needed.
        </p>
      </div>

      <div className="flex gap-4">
        {/* list */}
        <div className="flex-1 flex flex-col gap-2.5">
          {schedules.length === 0 ? (
            <div className="text-sm text-[#7c8794] border border-[#232c3a] rounded-lg p-6 text-center">
              No schedules yet. Create one on the right.
            </div>
          ) : (
            schedules.map((s) => (
              <div
                key={s.id}
                className={`bg-[#131a24] border border-[#232c3a] rounded-lg p-3.5 ${s.enabled ? "" : "opacity-60"}`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="font-semibold">{s.title}</span>
                  <span className="text-[11px] text-[#67e8f9] bg-[#0e2730] border border-[#1d4e5a] rounded px-1.5 py-px">
                    {projects.find((p) => p.id === s.projectId)?.name ?? s.projectId}
                  </span>
                  <button
                    onClick={() => toggle(s.id, !s.enabled)}
                    className={`ml-auto text-[11px] ${s.enabled ? "text-emerald-400" : "text-[#7c8794]"}`}
                  >
                    {s.enabled ? "enabled" : "paused"}
                  </button>
                  <button onClick={() => remove(s.id)} className="text-[#5b6675] hover:text-red-400 text-sm">
                    🗑
                  </button>
                </div>
                <div className="text-[12.5px] text-[#aab4c0] my-2">{s.instruction}</div>
                <div className="flex items-center gap-4 text-[11.5px] text-[#7c8794] flex-wrap">
                  <span>🕒 <b className="text-[#cdd6e0]">{s.cadenceSummary}</b></span>
                  <span>next · {s.enabled ? fmt(s.nextRunAt) : "—"}</span>
                  <span>
                    last · {fmt(s.lastRunAt)}
                    {s.lastStatus && <span className={`ml-1 ${statusColor(s.lastStatus)}`}>{s.lastStatus}</span>}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* create panel */}
        <div className="w-72 bg-[#0e141c] border border-[#232c3a] rounded-lg p-3.5 h-fit">
          <div className="text-sm font-semibold mb-3">New schedule</div>
          {error && <div className="text-[11px] text-red-400 mb-2">{error}</div>}

          <label className="block text-[10px] uppercase tracking-wide text-[#5b6675] mb-1">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-2.5 outline-none"
          />

          <label className="block text-[10px] uppercase tracking-wide text-[#5b6675] mb-1">Project</label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-2.5 outline-none"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <label className="block text-[10px] uppercase tracking-wide text-[#5b6675] mb-1">Instruction</label>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-2.5 outline-none resize-none"
          />

          <label className="block text-[10px] uppercase tracking-wide text-[#5b6675] mb-1">Cadence</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as CadenceKind)}
            className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-2 outline-none"
          >
            <option value="every_hours">Every N hours</option>
            <option value="daily">Daily at time</option>
            <option value="weekly">Weekly on day at time</option>
          </select>

          {kind === "every_hours" && (
            <input
              type="number"
              min={1}
              max={168}
              value={intervalHours}
              onChange={(e) => setIntervalHours(Number(e.target.value))}
              className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-3 outline-none"
            />
          )}
          {kind === "daily" && (
            <input
              type="time"
              value={timeOfDay}
              onChange={(e) => setTimeOfDay(e.target.value)}
              className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-3 outline-none"
            />
          )}
          {kind === "weekly" && (
            <div className="flex gap-2 mb-3">
              <select
                value={dayOfWeek}
                onChange={(e) => setDayOfWeek(Number(e.target.value))}
                className="flex-1 bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs outline-none"
              >
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>{d}</option>
                ))}
              </select>
              <input
                type="time"
                value={timeOfDay}
                onChange={(e) => setTimeOfDay(e.target.value)}
                className="w-28 bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs outline-none"
              />
            </div>
          )}

          <button
            onClick={createSchedule}
            disabled={busy}
            className="w-full bg-gradient-to-r from-cyan-400 to-blue-500 text-[#04121a] font-semibold rounded-md py-2 text-[13px] disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}
