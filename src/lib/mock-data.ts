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

export interface Session {
  id: string;
  title: string;
  project: string;
  branch: string;
  status: 'active' | 'paused' | 'completed';
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  agentId?: string;
  senderName: string;
  content: string;
  timestamp: string;
  attribution?: string;
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

export const mockTeam: Agent[] = [
  {
    id: 'sage',
    name: 'Sage',
    role: 'Orchestrator',
    model: 'Claude Opus 4.7',
    system_prompt: 'You are Sage, the orchestrator...',
    color: 'from-cyan-400 to-blue-500',
    status: 'working',
    avatar: '🜂',
    currentTask: 'Orchestrating testimonial card styling updates',
    lastActive: 'Just now'
  },
  {
    id: 'atlas',
    name: 'Atlas',
    role: 'Lead Developer',
    model: 'Claude Sonnet 4.6',
    system_prompt: 'You are Atlas, the lead developer...',
    color: 'from-blue-400 to-indigo-600',
    status: 'working',
    avatar: '⚒',
    currentTask: 'Editing src/components/Testimonials.astro',
    lastActive: '1m ago'
  },
  {
    id: 'nova',
    name: 'Nova',
    role: 'Researcher',
    model: 'Claude Sonnet 4.6',
    system_prompt: 'You are Nova, the researcher...',
    color: 'from-emerald-400 to-teal-600',
    status: 'idle',
    avatar: '⌕',
    lastActive: '2h ago'
  },
  {
    id: 'echo',
    name: 'Echo',
    role: 'QA Critic',
    model: 'Claude Sonnet 4.6',
    system_prompt: 'You are Echo, the critic...',
    color: 'from-purple-400 to-violet-600',
    status: 'idle',
    avatar: '⛬',
    lastActive: '3h ago'
  },
  {
    id: 'pixel',
    name: 'Pixel',
    role: 'Designer',
    model: 'Claude Sonnet 4.6',
    system_prompt: 'You are Pixel, the designer...',
    color: 'from-pink-400 to-fuchsia-600',
    status: 'idle',
    avatar: '◊',
    lastActive: '1d ago'
  },
  {
    id: 'forge',
    name: 'Forge',
    role: 'DevOps',
    model: 'Claude Haiku 4.5',
    system_prompt: 'You are Forge, the devops...',
    color: 'from-amber-400 to-orange-600',
    status: 'idle',
    avatar: '⛁',
    lastActive: '2d ago'
  }
];

export const mockSession: Session = {
  id: 'sess_a4f9',
  title: 'Testimonial Card Borders',
  project: 'AXOD CREATIVE',
  branch: 'feature/testimonials-borders',
  status: 'active',
  costUsd: 0.18,
  tokensIn: 12450,
  tokensOut: 2310,
  createdAt: '2026-05-27T14:10:00-04:00'
};

export const mockMessages: Message[] = [
  {
    id: 'm1',
    role: 'user',
    senderName: 'adrew0321',
    content: "Hey Sage, let's create a beautiful border style for the AXOD landing page testimonial cards.",
    timestamp: '2:10 PM'
  },
  {
    id: 'm2',
    role: 'agent',
    agentId: 'sage',
    senderName: 'Sage',
    content: "Good afternoon! That sounds like an excellent design refinement. Testimonial cards are critical to visual trust, and AXOD's aesthetics deserve a sleek, custom border to make them truly premium.\n\nI'll orchestrate this task by dispatching **Atlas** (our Lead Developer) to inspect the testimonial files and implement a high-fidelity animated gradient border. I will monitor his progress and keep you updated.",
    timestamp: '2:11 PM',
    dispatch: {
      agentId: 'atlas',
      agentName: 'Atlas',
      task: 'Inspect src/components/Testimonials.astro, implement high-fidelity marching-ants gradient borders on testimonials, and verify the build.',
      status: 'working'
    }
  },
  {
    id: 'm3',
    role: 'agent',
    agentId: 'atlas',
    senderName: 'Atlas',
    attribution: 'via Sage',
    content: "I have examined the codebase. The testimonials are located in `src/components/Testimonials.astro` and use static tailwind borders. I plan to create a dedicated CSS class utilizing linear-gradients and an animated background position (marching-ants style) to give it a living, breathing look.\n\nBefore I make changes, I need permission to scan the repository structure and read the file context.",
    timestamp: '2:12 PM'
  },
  {
    id: 'm4',
    role: 'system',
    senderName: 'System',
    content: 'Atlas requested tool permissions',
    timestamp: '2:12 PM',
    approval: {
      id: 'app_1',
      toolName: 'read_file',
      toolArgs: { path: 'src/components/Testimonials.astro' },
      status: 'pending'
    }
  }
];

export const mockArtifacts: Artifact[] = [
  {
    id: 'art_plan',
    type: 'plan',
    title: 'Implementation Plan',
    content: `# Testimonial Card Visual Enhancements

Improve UX engagement of the testimonials grid on AXOD CREATIVE.

## Proposed Upgrades
1. **Dynamic Gradients**: Replace hardcoded borders with an HSL custom gradient (\`#00e0ff\` cyan to \`#3b82f6\` blue).
2. **Micro-Animations**: Add an active-card hover scale (+1.5%) and a subtle glow.
3. **Marching Ants Border**: Optional active state animation.

## Checklist
- [x] Analyze \`Testimonials.astro\` structure
- [/] Write custom marching-ants animation class in \`index.css\`
- [ ] Add class toggle on hover state
- [ ] Verify local Astro server builds without errors`
  },
  {
    id: 'art_code',
    type: 'code',
    title: 'Testimonials.astro',
    subtitle: 'src/components/Testimonials.astro',
    content: `<<<< ORIGINAL
      <div class="relative bg-panel border border-border p-6 rounded-lg">
        <p class="text-text-2 font-medium italic">"{quote}"</p>
        <span class="text-xs text-muted block mt-4 font-mono">{author}</span>
      </div>
====
      <div class="relative bg-panel p-[1px] rounded-lg overflow-hidden group transition-all duration-300 hover:scale-[1.015] hover:shadow-[0_0_30px_rgba(0,224,255,0.12)]">
        <!-- Living Gradient Border -->
        <div class="absolute inset-0 bg-gradient-to-r from-cyan-500 via-blue-500 to-cyan-500 bg-[length:200%_auto] animate-marching-ants opacity-60 group-hover:opacity-100 transition-opacity"></div>
        <!-- Inner Card Content -->
        <div class="relative bg-panel p-6 rounded-[7px] h-full flex flex-col justify-between">
          <p class="text-text-2 font-medium italic">"{quote}"</p>
          <span class="text-xs text-muted block mt-4 font-mono">{author}</span>
        </div>
      </div>
>>>>`
  },
  {
    id: 'art_terminal',
    type: 'terminal',
    title: 'Local Build Logs',
    content: `[14:12:04] [astro] Starting dev server on http://localhost:4321 ...
[14:12:05] [astro] Local network addresses resolved.
[14:12:09] [astro] Compiled src/components/Testimonials.astro (240ms)
[14:12:10] [astro] Build succeeded! No compilation warnings.
[14:12:10] [astro] Watching for file changes...`
  }
];
