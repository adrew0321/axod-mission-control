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

// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[([0-9;]*)([A-Za-z])/g;

export function parseAnsi(input: string): AnsiSegment[] {
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

  ESC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC.exec(input)) !== null) {
    push(input.slice(lastIndex, m.index));
    lastIndex = ESC.lastIndex;
    if (m[2] === "m") {
      const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
      for (const code of codes) {
        if (code === 0) {
          color = undefined;
          bold = false;
        } else if (code === 1) {
          bold = true;
        } else if (code === 22) {
          bold = false;
        } else if (code === 39) {
          color = undefined;
        } else if (ANSI_FG[code]) {
          color = ANSI_FG[code];
        }
        // other codes: ignored
      }
    }
    // non-'m' final bytes (e.g. K, A, J, H) are control sequences: strip them.
  }
  push(input.slice(lastIndex));
  return segments;
}
