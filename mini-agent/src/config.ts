import 'dotenv/config';
import type { ExecPolicy, AgentMode } from './policy';

export interface AgentConfig {
  miniUrl: string;
  token: string;
  mode: AgentMode;
  policy: ExecPolicy;
}

export function loadConfig(): AgentConfig {
  // Defaults to 'room' so an already-deployed container's .env keeps working
  // untouched after the rename.
  const mode: AgentMode = process.env.AGENT_MODE === 'host' ? 'host' : 'room';

  // Each target has its OWN credential, checked on the Mission Control side
  // against COMPANION_TOKEN / ROOM_COMPANION_TOKEN / HOST_COMPANION_TOKEN.
  // Never share one between targets.
  const token = (mode === 'host' ? process.env.HOST_TOKEN : process.env.ROOM_TOKEN) ?? '';
  if (!token) {
    throw new Error(
      mode === 'host'
        ? 'HOST_TOKEN is required (set it in mini-agent/.env on the host)'
        : 'ROOM_TOKEN is required (set it in mini-agent/.env in the room)',
    );
  }

  const policy: ExecPolicy =
    mode === 'host'
      ? { mode: 'host', defaultCwd: process.env.HOST_DEFAULT_CWD || '/' }
      : {
          mode: 'room',
          roots: {
            room: process.env.ROOM_ROOT || '/home/akira/workshop',
            doorway: process.env.ROOM_DOORWAY || '/mnt/doorway',
          },
        };

  return {
    // The room reaches Mission Control over the host bridge; the host agent is
    // already on the box, so it uses loopback.
    miniUrl:
      process.env.MINI_URL || (mode === 'host' ? 'http://127.0.0.1:3000' : 'http://10.0.0.1:3000'),
    token,
    mode,
    policy,
  };
}
