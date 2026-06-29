"use client";
import { useEffect, useRef } from "react";

export type OrbMode = "idle" | "listening" | "speaking" | "thinking";

/**
 * AKIRA's ice-blue particle energy sphere. Ported from docs/design/akira-hud.html.
 * Three live states drive the animation; `mode` is read through a ref so prop
 * changes never restart the loop.
 */
export function Orb({ mode, size = 320 }: { mode: OrbMode; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef<OrbMode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = size * 0.4;
    const NB = 56;
    const spec = new Float32Array(NB);
    const count = 850;
    const P: {
      ang: number; rad: number; stray: boolean; sdx: number; sdy: number;
      ph: number; jb: number; tw: number;
    }[] = [];
    for (let k = 0; k < count; k++) {
      P.push({
        ang: Math.random() * 6.28,
        rad: R * Math.sqrt(Math.random()),
        stray: Math.random() < 0.1,
        sdx: (Math.random() - 0.5) * R * 1.6,
        sdy: -(R * 0.3 + Math.random() * R * 1.6),
        ph: Math.random() * 6.28,
        jb: 0.6 + Math.random() * 0.8,
        tw: Math.random() * 6.28,
      });
    }
    const ripples: { r: number; vr: number; a: number }[] = [];
    let t = 0;
    let lastEnv = 0;
    let cool = 0;
    let raf = 0;

    function frame(now: number) {
      const mode = modeRef.current;
      t += (1 - t) * 0.05;
      const e = t * t * (3 - 2 * t);
      const speaking = mode === "speaking";
      const listening = mode === "listening";
      const thinking = mode === "thinking";
      const swx = Math.sin(now / 1800) * 4;
      const swy = Math.sin(now / 2600) * 3;
      const spin = now / (thinking ? 2200 : 5000);
      const env = speaking
        ? Math.max(0, Math.abs(Math.sin(now / 150)) * Math.abs(Math.sin(now / 61)) * 1.15)
        : listening
          ? 0.3 + 0.22 * Math.abs(Math.sin(now / 240))
          : thinking
            ? 0.18 + 0.12 * Math.abs(Math.sin(now / 300))
            : 0.06;
      for (let b = 0; b < NB; b++) {
        let v = 0.5 * Math.sin(now / 120 + b * 0.5) + 0.3 * Math.sin(now / 70 + b * 1.3) + 0.2 * Math.sin(now / 210 - b * 0.7);
        v = Math.abs(v) * env;
        spec[b] += (v - spec[b]) * 0.4;
      }
      const pulse = speaking
        ? 1 + 0.05 * Math.sin(now / 280)
        : listening
          ? 1 - 0.05 + 0.03 * Math.sin(now / 360)
          : 1 + 0.02 * Math.sin(now / 900);
      ctx!.clearRect(0, 0, W, H);
      const col = listening ? "170,236,255" : "127,220,255";
      const g = ctx!.createRadialGradient(cx, cy, 4, cx, cy, R * 1.28);
      g.addColorStop(0, `rgba(${col},${0.07 + 0.14 * t + env * 0.08})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, W, H);
      const ps = Math.max(0.8, R / 95);
      ctx!.lineCap = "round";
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        let tx: number, ty: number;
        if (p.stray) {
          const sm = speaking ? 0.4 : 0.12;
          tx = cx + p.sdx * sm;
          ty = cy + p.sdy * sm;
        } else {
          const ang = p.ang + spin;
          const bin = (((ang % 6.283) + 6.283) % 6.283) / 6.283 * NB | 0;
          const spike = spec[bin] * (R * 0.42) * (p.rad / R) * (listening ? -0.5 : 1);
          const rad = p.rad * pulse + spike;
          tx = cx + Math.cos(ang) * rad;
          ty = cy + Math.sin(ang) * rad;
        }
        const bx = cx + (tx - cx) * e + swx;
        const by = cy + (ty - cy) * e + swy;
        const x = bx + Math.sin(now / 620 + p.ph) * 0.5 * p.jb;
        const y = by + Math.cos(now / 680 + p.ph) * 0.5 * p.jb;
        const tw = 0.68 + 0.32 * Math.sin(now / 220 + p.tw);
        const nd = p.stray ? 1 : p.rad / R;
        const alpha = (0.26 + 0.6 * e - (p.stray ? 0.14 : 0)) * tw;
        ctx!.fillStyle = e > 0.5 && nd < 0.5 && !p.stray ? `rgba(234,255,255,${alpha})` : `rgba(${col},${alpha})`;
        ctx!.beginPath();
        ctx!.arc(x, y, ps, 0, 6.283);
        ctx!.fill();
      }
      if (speaking || listening) {
        ctx!.lineWidth = Math.max(1, R / 95);
        const rim = R * pulse + R * 0.18;
        const dir = listening ? -1 : 1;
        for (let b2 = 0; b2 < NB; b2++) {
          const ang = (b2 / NB) * 6.283 + spin;
          const len = R * 0.05 + spec[b2] * (R * 0.4);
          const ix = cx + Math.cos(ang) * rim + swx;
          const iy = cy + Math.sin(ang) * rim + swy;
          const ox = cx + Math.cos(ang) * (rim + len * dir) + swx;
          const oy = cy + Math.sin(ang) * (rim + len * dir) + swy;
          ctx!.strokeStyle = `rgba(${col},${(0.18 + 0.42 * Math.min(1, spec[b2] * 2))})`;
          ctx!.beginPath();
          ctx!.moveTo(ix, iy);
          ctx!.lineTo(ox, oy);
          ctx!.stroke();
        }
      }
      cool -= 16;
      if (env > 0.7 && lastEnv <= 0.7 && cool <= 0) {
        if (speaking) {
          ripples.push({ r: R + 12, vr: 2.4 * (R / 62), a: 0.45 });
          cool = 260;
        } else if (listening) {
          ripples.push({ r: R * 2.0, vr: -1.8 * (R / 62), a: 0.4 });
          cool = 340;
        }
      }
      lastEnv = env;
      for (let ri = ripples.length - 1; ri >= 0; ri--) {
        const rp = ripples[ri];
        rp.r += rp.vr;
        rp.a *= 0.97;
        const fall = Math.max(0, 1 - Math.abs(rp.r - R) / (R * 0.62));
        const ea = rp.a * fall;
        if (ea > 0.004) {
          ctx!.strokeStyle = `rgba(${col},${ea})`;
          ctx!.lineWidth = 1.5;
          ctx!.beginPath();
          ctx!.arc(cx + swx, cy + swy, Math.max(2, rp.r), 0, 6.283);
          ctx!.stroke();
        }
        if (rp.a < 0.02 || fall <= 0) ripples.splice(ri, 1);
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={canvasRef} width={size} height={size} style={{ width: size, height: size }} />;
}
