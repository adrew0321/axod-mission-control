import 'server-only';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { SignJWT, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { auth_users, auth_sessions } from '@/db/schema';

export { hashPassword, verifyPassword } from './password';

const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'mc_session';

function getSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('SESSION_SECRET must be set to a string of at least 32 chars');
  }
  return new TextEncoder().encode(raw);
}

function randomToken(bytes = 32): string {
  return bytesToHex(randomBytes(bytes));
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const sessionId = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(auth_sessions).values({ id: sessionId, user_id: userId, expires_at: expiresAt });
  const token = await new SignJWT({ sid: sessionId, uid: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getSecret());
  return { token, expiresAt };
}

export interface SessionInfo {
  userId: string;
  sessionId: string;
}

export async function verifySession(token: string): Promise<SessionInfo | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const sid = typeof payload.sid === 'string' ? payload.sid : null;
    const uid = typeof payload.uid === 'string' ? payload.uid : null;
    if (!sid || !uid) return null;
    const row = await db.select().from(auth_sessions).where(eq(auth_sessions.id, sid)).limit(1).then((r) => r[0]);
    if (!row) return null;
    if (row.expires_at.getTime() <= Date.now()) {
      await db.delete(auth_sessions).where(eq(auth_sessions.id, sid));
      return null;
    }
    if (row.user_id !== uid) return null;
    return { userId: uid, sessionId: sid };
  } catch {
    return null;
  }
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(auth_sessions).where(eq(auth_sessions.id, sessionId));
}

export async function findUserByEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  return db.select().from(auth_users).where(eq(auth_users.email, normalized)).limit(1).then((r) => r[0]);
}

export function cookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/' as const,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
