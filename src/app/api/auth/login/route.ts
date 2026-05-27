import { cookies, headers } from 'next/headers';
import { z } from 'zod';
import { SESSION_COOKIE, cookieOptions, createSession, findUserByEmail, verifyPassword } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
});

export async function POST(req: Request) {
  const hdrs = await headers();
  const ip =
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    hdrs.get('x-real-ip') ??
    'local';

  const rl = rateLimit(`login:${ip}`, 5, 15 * 60 * 1000);
  if (!rl.ok) {
    return Response.json(
      { error: 'Too many attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid credentials' }, { status: 400 });
  }

  const user = await findUserByEmail(parsed.data.email);
  if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
    return Response.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  const { token } = await createSession(user.id);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOptions());

  return Response.json({ ok: true });
}
