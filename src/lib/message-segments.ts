// Splits an agent message's text into paragraph segments for rendering as
// separate chat bubbles. Boundaries are runs of one-or-more blank lines —
// EXCEPT inside a fenced code block (``` … ``` or ~~~ … ~~~), which is kept
// atomic so a fence with internal blank lines is never shattered across
// bubbles. An unterminated fence (still streaming) keeps everything from the
// opening fence onward in one trailing segment. Segment text is trimmed and
// CRLF line endings are normalized to LF before processing.

const FENCE = /^\s*(```|~~~)/;

export function splitMessageSegments(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const segments: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) segments.push(text);
    current = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      if (!inFence) {
        // Opening a fence. We do NOT flush here: prose on the immediately
        // preceding line (no blank line between) intentionally stays in the
        // same segment as the fence, since the fence needs that context to
        // render. A blank line before the fence would already have flushed.
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else if (fenceMatch[1] === fenceMarker) {
        // Closing fence (same marker family). Keep the line, stay un-split.
        inFence = false;
        fenceMarker = "";
      }
      current.push(line);
      continue;
    }

    if (!inFence && line.trim() === "") {
      // Blank line outside a fence = a segment boundary.
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return segments;
}
