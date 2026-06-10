"use client";

import { useState, useEffect } from "react";
import * as Icons from "lucide-react";
import { ChevronLeft, ChevronRight, Settings, LogOut, type LucideIcon } from "lucide-react";
import { NAV_SECTIONS, type NavSection } from "@/lib/nav-sections";

const COLLAPSE_KEY = "mc_nav_collapsed";

// The far-left nav rail. Switches the main view; "Agent Team" is the live one
// (the roster + session logs + workspace), the rest are placeholders for the
// OpenClaw operational views + Hermes pillars. Collapses to an icon rail.
// Desktop-only — on mobile the bottom tab bar handles team/chat/workspace.
export default function NavSidebar({
  activeSectionId,
  onSectionChange,
  onLogout,
  counts = {},
}: {
  activeSectionId: string;
  onSectionChange: (id: string) => void;
  onLogout: () => void;
  // Attention counts per section id (e.g. pending proposals) → amber badge/dot.
  counts?: Record<string, number>;
}) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  }

  const lucide = (name: string): LucideIcon =>
    (Icons as unknown as Record<string, LucideIcon>)[name] ?? Icons.Square;

  const operational = NAV_SECTIONS.filter((s) => s.group === "operational");
  const system = NAV_SECTIONS.filter((s) => s.group === "system");

  function sectionRow(s: NavSection) {
    const Icon = lucide(s.icon);
    const live = s.status === "live";
    const count = counts[s.id] ?? 0;
    return (
      <button
        key={s.id}
        disabled={!live}
        onClick={() => {
          if (live) onSectionChange(s.id);
        }}
        title={collapsed ? `${s.label}${count > 0 ? ` · ${count} waiting` : ""}${live ? "" : " · coming soon"}` : live ? undefined : "Coming soon"}
        className={`relative w-full flex items-center ${collapsed ? "justify-center" : "gap-2"} px-2 py-1.5 rounded-md text-[11px] font-mono transition-colors ${
          s.id === activeSectionId
            ? "bg-[#11233a] text-[#00e0ff]"
            : live
              ? "text-[#8b949e] hover:bg-[#1c2330] cursor-pointer"
              : "text-[#3a424d] cursor-default"
        }`}
      >
        <span className="relative shrink-0">
          <Icon className="w-4 h-4" />
          {collapsed && count > 0 && (
            <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-[#f0a020] shadow-[0_0_4px_#f0a020]" />
          )}
        </span>
        {!collapsed && <span className="flex-1 text-left truncate">{s.label}</span>}
        {!collapsed && count > 0 && (
          <span className="shrink-0 text-[9px] font-mono text-black bg-[#f0a020] rounded-full px-1.5 min-w-[16px] text-center leading-[15px]">
            {count}
          </span>
        )}
        {!collapsed && !live && <span className="text-[8px] uppercase tracking-wider">soon</span>}
      </button>
    );
  }

  return (
    <aside
      className={`hidden md:flex bg-[#0d1117] border-r border-[#1e2632] flex-col shrink-0 ${
        collapsed ? "w-[52px]" : "w-[180px]"
      }`}
    >
      <div className="h-11 flex items-center justify-between px-2 border-b border-[#1e2632] shrink-0 select-none">
        {!collapsed && (
          <span className="text-[10px] font-mono text-[#5c6470] tracking-widest uppercase pl-1">Mission Control</span>
        )}
        <button
          onClick={toggle}
          title={collapsed ? "Expand" : "Collapse"}
          className="w-7 h-7 flex items-center justify-center rounded text-[#5c6470] hover:text-[#00e0ff] hover:bg-[#161c25] transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 py-2 flex flex-col gap-0.5">
        {!collapsed && (
          <div className="text-[8px] font-mono text-[#3a424d] uppercase tracking-widest px-2 mb-0.5">Operational</div>
        )}
        {operational.map(sectionRow)}
        <div className="my-2 h-px bg-[#1e2632]" />
        {!collapsed && (
          <div className="text-[8px] font-mono text-[#3a424d] uppercase tracking-widest px-2 mb-0.5">System</div>
        )}
        {system.map(sectionRow)}
      </div>

      <div className="px-1.5 py-2 border-t border-[#1e2632] shrink-0 flex flex-col gap-0.5">
        <button
          disabled
          title="Coming soon"
          className={`w-full flex items-center ${collapsed ? "justify-center" : "gap-2"} px-2 py-1.5 rounded-md text-[11px] font-mono text-[#3a424d] cursor-default`}
        >
          <Settings className="w-4 h-4 shrink-0" />
          {!collapsed && <span className="flex-1 text-left">Settings</span>}
          {!collapsed && <span className="text-[8px] uppercase tracking-wider">soon</span>}
        </button>
        <button
          onClick={onLogout}
          title="Sign out"
          className={`w-full flex items-center ${collapsed ? "justify-center" : "gap-2"} px-2 py-1.5 rounded-md text-[11px] font-mono text-[#8b949e] hover:bg-[#1c2330] hover:text-[#e6edf3] transition-colors`}
        >
          <LogOut className="w-4 h-4 shrink-0" />
          {!collapsed && <span className="flex-1 text-left">Logout</span>}
        </button>
      </div>
    </aside>
  );
}
