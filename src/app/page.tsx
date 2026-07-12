import { getFleetSnapshotLive } from "@/lib/fleet-contributors";
import { getRecentTurns, type Turn } from "@/lib/akira/history";
import { Hud } from "@/components/akira/hud";
import { isOnline } from "@/lib/companion/registry";

export const metadata = { title: "AXOD — AKIRA" };

export const dynamic = "force-dynamic";

const HISTORY_LIMIT = 8; // shallow window on the front door; deep history lives in the dashboard

export default async function HomePage() {
  const snapshot = await getFleetSnapshotLive();
  // Load recent turns; reuse the newest reply if it's fresh (token saver).
  // TTL tunable without a redeploy via AKIRA_BRIEF_TTL_MINUTES (default 4h).
  const ttlMin = Number(process.env.AKIRA_BRIEF_TTL_MINUTES ?? 240);
  let initialTurns: Turn[] = [];
  let freshBrief = false;
  try {
    const recent = await getRecentTurns(HISTORY_LIMIT, ttlMin * 60_000);
    initialTurns = recent.turns;
    freshBrief = recent.freshBrief;
  } catch {
    // DB hiccup — render the front door anyway and run a fresh brief.
  }
  return (
    <main
      className="akira-page"
      style={{
        background: "radial-gradient(1300px 860px at 50% 38%, #0c1726 0%, #070d16 52%, #04060b 100%)",
        color: "#e6edf3",
        minHeight: "100vh",
        fontFamily: '"Segoe UI", system-ui, sans-serif',
      }}
    >
      <Hud snapshot={snapshot} initialTurns={initialTurns} freshBrief={freshBrief} companionOnline={isOnline()} />
    </main>
  );
}
