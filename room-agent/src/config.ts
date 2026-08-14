import 'dotenv/config';
import type { Roots } from './paths';

export interface RoomConfig {
  miniUrl: string;
  token: string;
  roots: Roots;
}

export function loadConfig(): RoomConfig {
  const token = process.env.ROOM_TOKEN ?? '';
  if (!token) throw new Error('ROOM_TOKEN is required (set it in room-agent/.env)');
  return {
    // The room reaches Mission Control over the host bridge, not the public tunnel.
    miniUrl: process.env.MINI_URL ?? 'http://10.0.0.1:3000',
    token,
    roots: {
      room: process.env.ROOM_ROOT ?? '/home/akira/workshop',
      doorway: process.env.ROOM_DOORWAY ?? '/mnt/doorway',
    },
  };
}
