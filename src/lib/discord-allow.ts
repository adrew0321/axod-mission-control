/** Parse DISCORD_ALLOWED_USER_IDS (comma-separated snowflakes) into a Set. Pure. */
export function parseAllowedIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Fail-closed allowlist check: an empty set denies everyone. Pure. */
export function isAllowed(userId: string, allowed: Set<string>): boolean {
  return allowed.has(userId);
}
