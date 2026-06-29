"use client";
import { pickFemaleVoice } from "./chunk";

export function voiceSupport(): { tts: boolean; stt: boolean } {
  if (typeof window === "undefined") return { tts: false, stt: false };
  const stt = "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
  return { tts: "speechSynthesis" in window, stt };
}

let cachedVoice: SpeechSynthesisVoice | null = null;

/** Speak a chunk of text aloud using a preferred female voice. No-op if unsupported. */
export function speak(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text.trim()) return;
  const u = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  if (!cachedVoice && voices.length) {
    const pick = pickFemaleVoice(voices.map((v) => ({ name: v.name, lang: v.lang })));
    cachedVoice = voices.find((v) => v.name === pick?.name) ?? null;
  }
  if (cachedVoice) u.voice = cachedVoice;
  window.speechSynthesis.speak(u);
}

/** Cancel any in-progress speech. */
export function stopSpeaking(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

interface Recognizer {
  start: () => void;
  stop: () => void;
}

/** Create a one-shot speech recognizer, or null if unsupported. */
export function createRecognizer(handlers: { onResult: (t: string) => void; onEnd: () => void }): Recognizer | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    (window as unknown as { SpeechRecognition?: new () => unknown }).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor() as {
    lang: string;
    interimResults: boolean;
    maxAlternatives: number;
    onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
    onend: () => void;
    start: () => void;
    stop: () => void;
  };
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => handlers.onResult(e.results[0][0].transcript);
  rec.onend = handlers.onEnd;
  return rec;
}
