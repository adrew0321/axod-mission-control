# AKIRA — HUD design reference

`akira-hud.html` is the **locked visual reference** for AKIRA, the overarching
voice assistant / overseer agent (router above Sage). Open it directly in a
browser — it's a self-contained mockup, no build step.

> AKIRA is female (she/her). "Hermes" was the earlier working name and is retired.

## What it shows

- **Full-screen "summon" landing** — an ice-blue particle energy sphere over a
  drifting constellation field, a time-aware greeting, and a "Tap to speak" mic.
- **Three states** (auto-cycling in the demo; mic triggers them manually):
  - **idle** — calm breathing sphere.
  - **listening** — rim equalizer bars pull *inward*, ripples contract toward
    the core, surface draws in (she "inhales" your voice).
  - **speaking** — bars push *outward*, shockwaves expand and fade smoothly
    before the edge, surface spikes per frequency.
- **Scroll down** flows into a Mission Control summary; the orb shrinks into a
  live **mini-orb docked bottom-left** that stays present while you work
  (click it to scroll back up and "summon" the full orb).
- **"Open full dashboard ↗"** is the hook for hard-navigating to the existing
  built dashboard route.

In the real build the frequency reactivity maps onto live TTS audio via the
Web Audio `AnalyserNode`, and the dashboard data comes from the existing APIs.

## Origin

Iterated in the brainstorming visual companion (2026-06-28). This is the final
of ~10 iterations (face → creepy → no-face energy sphere → frequency reactive →
full-screen + states + dock).
