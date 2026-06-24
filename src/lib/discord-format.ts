/**
 * Split text into Discord-sendable chunks each ≤ max chars (default 2000).
 * Prefers to break on the last newline, then the last space, before max; a single
 * token longer than max is hard-split. Never returns an empty array. Pure.
 */
export function chunkReply(text: string, max = 2000): string[] {
  if (text.length === 0) return [' ']; // Discord rejects empty content
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max; // no boundary → hard split
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(rest[cut] === '\n' || rest[cut] === ' ' ? cut + 1 : cut);
  }
  chunks.push(rest);
  return chunks;
}
