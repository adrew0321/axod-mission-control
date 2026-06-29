"use client";
import { useEffect, useRef } from "react";

/** Drifting ice-blue particle field that links nearby points — the locked HUD background. */
export function Constellation() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const x = c.getContext("2d");
    if (!x) return;
    let W = 0;
    let H = 0;
    const N = 90;
    const pts = Array.from({ length: N }, () => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00006,
      vy: (Math.random() - 0.5) * 0.00006,
      r: Math.random() * 1.4 + 0.3,
      tw: Math.random() * 6.28,
    }));
    function size() {
      W = c!.width = window.innerWidth;
      H = c!.height = window.innerHeight;
    }
    size();
    window.addEventListener("resize", size);
    let raf = 0;
    function loop(t: number) {
      x!.clearRect(0, 0, W, H);
      for (let i = 0; i < N; i++) {
        const p = pts[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = 1;
        if (p.x > 1) p.x = 0;
        if (p.y < 0) p.y = 1;
        if (p.y > 1) p.y = 0;
        const px = p.x * W;
        const py = p.y * H;
        x!.fillStyle = `rgba(127,220,255,${0.1 + 0.1 * Math.sin(t / 1400 + p.tw)})`;
        x!.beginPath();
        x!.arc(px, py, p.r, 0, 6.28);
        x!.fill();
        for (let j = i + 1; j < N; j++) {
          const q = pts[j];
          const dx = (p.x - q.x) * W;
          const dy = (p.y - q.y) * H;
          const d = dx * dx + dy * dy;
          if (d < 13000) {
            x!.strokeStyle = `rgba(127,220,255,${0.05 * (1 - d / 13000)})`;
            x!.lineWidth = 1;
            x!.beginPath();
            x!.moveTo(px, py);
            x!.lineTo(q.x * W, q.y * H);
            x!.stroke();
          }
        }
      }
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
    };
  }, []);
  return <canvas ref={ref} style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
}
