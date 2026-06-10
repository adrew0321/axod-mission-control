// Shared UI types. The mock seed data that once lived here was removed in the
// Week 4 Day 5 cleanup — every panel now reads live session data from the DB.
// Kept as the single source for these view-model shapes (imported by page.tsx,
// mission-control.tsx, and friends).

export interface Agent {
  id: string;
  name: string;
  role: string;
  model: string;
  system_prompt: string;
  color: string;
  status: 'working' | 'waiting' | 'idle';
  avatar: string;
  currentTask?: string;
  lastActive: string;
}

export interface ProjectOption {
  id: string;
  name: string;
}

export interface Session {
  id: string;
  title: string;
  project: string;
  branch: string;
  repoPath: string;
  worktreePath: string;
  status: 'active' | 'paused' | 'completed' | 'errored';
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
  clearedAt?: string | null;
}

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  agentId?: string;
  senderName: string;
  content: string;
  timestamp: string;
  attribution?: string;
  dispatchedVia?: string;
  dispatchFailed?: boolean;
  isStreaming?: boolean;
  dispatch?: {
    agentId: string;
    agentName: string;
    task: string;
    status: 'working' | 'completed' | 'failed';
  };
  approval?: {
    id: string;
    toolName: string;
    toolArgs: any;
    status: 'pending' | 'approved' | 'denied';
  };
}

export interface Artifact {
  id: string;
  type: 'preview' | 'code' | 'plan' | 'terminal' | 'research';
  title: string;
  content: string;
  subtitle?: string;
  meta?: any;
}
