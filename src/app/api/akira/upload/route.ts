import { cookies } from "next/headers";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, bytesToHex } from "@noble/hashes/utils.js";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15_000_000; // 15 MB

/**
 * Save a pasted/dropped file so AKIRA can read it with her Read tool (by path).
 * Returns the absolute path on the server; the HUD passes it into her turn.
 */
export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_BYTES) return Response.json({ error: "file too large" }, { status: 413 });

  const dir = join(process.cwd(), "data", "uploads");
  await mkdir(dir, { recursive: true });
  const safe = (file.name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
  const path = join(dir, `${bytesToHex(randomBytes(6))}-${safe}`);
  await writeFile(path, buf);

  return Response.json({ path, name: file.name, size: buf.length });
}
