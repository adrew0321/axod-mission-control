// Pure builder for AKIRA's per-turn identity preamble: SOUL (who she is) then
// LESSONS (what she's learned) — both lead the turn prompt. No I/O so it unit-tests.
export function soulLessonsPreamble(soul: string, lessons: string): string {
  const lessonsBlock = lessons.trim()
    ? `## LESSONS\nWhat you've learned about how A'Keem wants things done — let these steer you:\n${lessons}`
    : `## LESSONS\n(none yet — save one with the remember tool, type 'lesson', when you learn how to serve him better)`;
  return `## SOUL\n${soul.trim()}\n\n${lessonsBlock}`;
}
