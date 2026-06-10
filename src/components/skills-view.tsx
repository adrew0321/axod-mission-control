"use client";

import { AgentIcon } from "@/components/mission-control-bits";
import type { AgentSkills, SkillKind } from "@/lib/skills";

const KIND_STYLE: Record<SkillKind, string> = {
  read: "text-[#5c6470] border-[#2a3441]",
  edit: "text-[#f0a020] border-[#f0a020]/40",
  run: "text-[#f85149] border-[#f85149]/40",
};

export default function SkillsView({ skills }: { skills: AgentSkills[] }) {
  return (
    <section className="flex-1 flex flex-col min-w-0 bg-[#0a0e14]">
      <div className="h-11 shrink-0 bg-[#11161d] border-b border-[#1e2632] px-4 flex items-center gap-2 select-none">
        <span className="font-semibold text-xs text-[#e6edf3] font-heading">Skills</span>
        <span className="text-[10px] font-mono text-[#5c6470]">what each agent is allowed to do</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3 content-start">
        {skills.map((a) => (
          <div key={a.id} className="rounded-lg border border-[#1e2632] bg-[#11161d] p-3">
            <div className="flex items-center gap-2.5 pb-2 border-b border-[#1e2632]">
              <div className={`w-8 h-8 rounded-md bg-gradient-to-br ${a.color} flex items-center justify-center text-black shrink-0`}>
                <AgentIcon id={a.id} className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs text-[#e6edf3] font-heading truncate">{a.name}</div>
                <div className="text-[10px] font-mono text-[#8b949e]">{a.role} · {a.model}</div>
              </div>
              <span className="ml-auto text-[8.5px] font-mono text-[#5c6470] shrink-0">claude-sdk</span>
            </div>

            <div className="mt-2 flex flex-col gap-1.5">
              {a.skills.length === 0 && (
                <div className="text-[10px] font-mono text-[#3a424d]">no tools</div>
              )}
              {a.skills.map((s) => (
                <div key={s.name} className="flex items-center gap-2">
                  <span className="text-[11px] font-mono text-[#e6edf3] w-[92px] shrink-0 truncate">{s.label}</span>
                  <span className="text-[10px] text-[#8b949e] flex-1 min-w-0 truncate">{s.description}</span>
                  <span className={`shrink-0 text-[8px] font-mono uppercase tracking-wider border rounded px-1.5 py-0.5 ${KIND_STYLE[s.kind]}`}>
                    {s.kind}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
