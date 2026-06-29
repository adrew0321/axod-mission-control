import { getFleetSnapshotLive } from "@/lib/fleet-contributors";
import { Hud } from "@/components/akira/hud";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const snapshot = await getFleetSnapshotLive();
  return (
    <main
      style={{
        background: "radial-gradient(1300px 860px at 50% 38%, #0c1726 0%, #070d16 52%, #04060b 100%)",
        color: "#e6edf3",
        minHeight: "100vh",
        fontFamily: '"Segoe UI", system-ui, sans-serif',
      }}
    >
      <Hud snapshot={snapshot} />
    </main>
  );
}
