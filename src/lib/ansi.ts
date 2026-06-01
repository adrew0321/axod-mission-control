// Minimal ANSI SGR parser → styled text segments for the Terminal view.
// Supports reset (0), bold (1/22), default fg (39), and the 16 foreground
// colors (30-37, 90-97). Any other SGR code is ignored; any non-SGR escape
// sequence (cursor moves, screen clears) is stripped from the output.

export interface AnsiSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

const ANSI_FG: Record<number, string> = {
  30: "#5c6470", 31: "#f87171", 32: "#3fb950", 33: "#d29922",
  34: "#3b82f6", 35: "#c084fc", 36: "#00e0ff", 37: "#e6edf3",
  90: "#8b949e", 91: "#fca5a5", 92: "#56d364", 93: "#e3b341",
  94: "#79c0ff", 95: "#d2a8ff", 96: "#56d4dd", 97: "#ffffff",
};

export function parseAnsi(input: string): AnsiSegment[] {
  // Strip OSC sequences (e.g. window-title: ESC ] ... BEL or ESC ] ... ESC \).
  // The CSI loop below only handles ESC [ ... sequences.
  // Replace with a CSI no-op (ESC [ m, i.e. bare reset) so text on either
  // side of an OSC forms two distinct segments rather than merging into one.
  // eslint-disable-next-line no-control-regex
  input = input.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "\x1b[m");

  const segments: AnsiSegment[] = [];
  let color: string | undefined;
  let bold = false;
  let lastIndex = 0;

  const push = (text: string) => {
    if (!text) return;
    const seg: AnsiSegment = { text };
    if (color) seg.color = color;
    if (bold) seg.bold = true;
    segments.push(seg);
  };

  // eslint-disable-next-line no-control-regex
  const esc = /\x1b\[([0-9;]*)([A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = esc.exec(input)) !== null) {
    push(input.slice(lastIndex, m.index));
    lastIndex = esc.lastIndex;
    if (m[2] === "m") {
      const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
      let i = 0;
      while (i < codes.length) {
        const code = codes[i];
        if (code === 0) {
          color = undefined;
          bold = false;
        } else if (code === 1) {
          bold = true;
        } else if (code === 22) {
          bold = false;
        } else if (code === 39) {
          color = undefined;
        } else if (code === 38 || code === 48) {
          // 256-color / truecolor selector (e.g. 38;5;N or 38;2;r;g;b). We don't
          // render extended colors, but must clear the current color so it does
          // not bleed onto the following text. Skip sub-parameters so they are
          // not interpreted as standalone SGR codes (e.g. avoid code 30 in 38;2;10;20;30).
          color = undefined;
          const mode = codes[i + 1];
          if (mode === 5) {
            i += 2; // skip mode + N
          } else if (mode === 2) {
            i += 4; // skip mode + r + g + b
          } else {
            i += 1; // skip mode only (malformed; best-effort)
          }
        } else if (code in ANSI_FG) {
          color = ANSI_FG[code];
        }
        // other codes: ignored
        i++;
      }
    }
    // non-'m' final bytes (e.g. K, A, J, H) are control sequences: strip them.
  }
  push(input.slice(lastIndex));
  return segments;
}
