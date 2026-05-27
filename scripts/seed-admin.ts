import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { scrypt } from '@noble/hashes/scrypt.js';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import * as schema from '../src/db/schema';

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;

function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const dk = scrypt(new TextEncoder().encode(plain), salt, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${bytesToHex(salt)}$${bytesToHex(dk)}`;
}

async function promptPassword(rl: readline.Interface, label: string): Promise<string> {
  // Hide input by intercepting writes to stdout during the read.
  const originalWrite = stdout.write.bind(stdout);
  process.stdout.write(label);
  let muted = true;
  (stdout.write as unknown as (chunk: string) => boolean) = (chunk: string) => {
    if (muted && chunk !== label) return true;
    return originalWrite(chunk);
  };
  try {
    const answer = await rl.question('');
    return answer;
  } finally {
    muted = false;
    stdout.write = originalWrite;
    stdout.write('\n');
  }
}

async function main() {
  const sqlite = new Database(process.env.DATABASE_PATH ?? './data/mission-control.db');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const emailRaw = (await rl.question('Admin email: ')).trim().toLowerCase();
    if (!emailRaw) throw new Error('Email is required');

    const existing = await db.select().from(schema.auth_users).where(eq(schema.auth_users.email, emailRaw)).limit(1).then((r) => r[0]);

    const password = await promptPassword(rl, 'Password (input hidden): ');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    const confirm = await promptPassword(rl, 'Confirm password: ');
    if (password !== confirm) throw new Error('Passwords do not match');

    const hash = hashPassword(password);

    if (existing) {
      await db.update(schema.auth_users).set({ password_hash: hash }).where(eq(schema.auth_users.id, existing.id));
      console.log(`Updated password for ${emailRaw} (id: ${existing.id})`);
    } else {
      const id = `user_${bytesToHex(randomBytes(6))}`;
      await db.insert(schema.auth_users).values({ id, email: emailRaw, password_hash: hash, created_at: new Date() });
      console.log(`Created admin ${emailRaw} (id: ${id})`);
    }
  } finally {
    rl.close();
    sqlite.close();
  }
}

main().catch((err) => {
  console.error('seed-admin failed:', err.message);
  process.exit(1);
});
