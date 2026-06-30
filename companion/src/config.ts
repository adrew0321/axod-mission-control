import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CompanionConfig {
  miniUrl: string;
  token: string;
  profileDir: string;
  sensitiveDomains: string[];
}

export function loadConfig(): CompanionConfig {
  const miniUrl = process.env.MINI_URL ?? 'https://bridge.axodcreative.com';
  const token = process.env.COMPANION_TOKEN ?? '';
  if (!token) throw new Error('COMPANION_TOKEN is required (set it in companion/.env)');
  const profileDir = process.env.COMPANION_PROFILE ?? join(homedir(), '.akira-companion', 'profile');
  const sensitiveDomains = (process.env.COMPANION_SENSITIVE ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return { miniUrl, token, profileDir, sensitiveDomains };
}
