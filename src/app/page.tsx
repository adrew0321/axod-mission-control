import { getFleetSnapshotLive } from "@/lib/fleet-contributors";
import { getRecentBrief } from "@/lib/akira/recent-brief";
import { Hud } from "@/components/akira/hud";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const snapshot = await getFleetSnapshotLive();
  // Reuse a recent brief on refresh instead of running a fresh turn (token saver).
  // Tunable without a redeploy via AKIRA_BRIEF_TTL_MINUTES (default 4h).
  const ttlMin = Number(process.env.AKIRA_BRIEF_TTL_MINUTES ?? 240);
  const initialBrief = await getRecentBrief(ttlMin * 60_000);
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
      <Hud snapshot={snapshot} initialBrief={initialBrief} />
    </main>
  );
}
