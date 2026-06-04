"use client";

import React, { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Login failed (${res.status})`);
        setPending(false);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-[360px] bg-[#11161d] border border-[#1e2632] rounded-lg p-6 shadow-lg shadow-black/40"
    >
      <div className="flex items-center gap-2 mb-5">
        <div className="w-7 h-7 rounded bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center font-extrabold text-[12px] text-black shadow-md shadow-cyan-500/10">
          MC
        </div>
        <div>
          <div className="text-sm font-semibold tracking-tight">AXOD MISSION CONTROL</div>
          <div className="text-[10px] font-mono text-[#5c6470] tracking-wider uppercase">Operator sign-in</div>
        </div>
      </div>

      <label className="block text-[10px] font-mono text-[#5c6470] tracking-wider uppercase mb-1">Email</label>
      <input
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full bg-[#060810] border border-[#2a3441] focus:border-[#00e0ff] rounded-md px-3 py-2 text-xs text-[#e6edf3] placeholder-[#5c6470] focus:outline-none transition-colors mb-3"
        placeholder="you@axodcreative.com"
      />

      <label className="block text-[10px] font-mono text-[#5c6470] tracking-wider uppercase mb-1">Password</label>
      <input
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full bg-[#060810] border border-[#2a3441] focus:border-[#00e0ff] rounded-md px-3 py-2 text-xs text-[#e6edf3] placeholder-[#5c6470] focus:outline-none transition-colors mb-4"
      />

      {error && (
        <div className="mb-3 px-3 py-2 rounded text-[11px] font-mono bg-red-500/10 border border-red-500/40 text-red-400">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full bg-[#00e0ff] hover:bg-[#00c0dd] disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-2 rounded-md text-xs transition-colors shadow-md shadow-cyan-500/10"
      >
        {pending ? "Authenticating..." : "Sign In"}
      </button>

      <p className="mt-5 text-center text-[9.5px] font-mono text-[#5c6470] tracking-wide">
        Powered by <span className="text-cyan-400">AXOD</span> · Built in Detroit
      </p>
      <p className="mt-1 text-center text-[9px] font-mono text-[#3a424d]">© 2026 AXOD</p>
    </form>
  );
}
