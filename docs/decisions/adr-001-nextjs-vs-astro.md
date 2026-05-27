# ADR-001: Next.js (not Astro) for Mission Control

> **Status:** Accepted
> **Date:** 2026-05-27
> **Deciders:** [@adrew0321](https://github.com/adrew0321) (operator)
> **Companion ADRs:** none yet

## Context

AXOD's existing portfolio site ([AXOD CREATIVE](https://github.com/adrew0321/AXODCREATIVE)) is built in Astro 6. Astro is excellent at it: mostly static content, scoped CSS, View Transitions, Cloudflare Pages deploy, minimal JS. The operator has 7+ shipped versions on it (v1.6.0 → v1.6.7) and is fluent in the framework.

The natural instinct is: use Astro for Mission Control too. Consistency, leverage existing skills, less context-switching.

After analysis, **Next.js 16 + App Router** is the right choice here, not Astro. This ADR captures why so the decision isn't relitigated mid-build.

## Decision

**Mission Control will be built on Next.js 16 with the App Router, TypeScript, Tailwind 4, and shadcn/ui.**

## Rationale

Mission Control is a **dashboard SPA with heavy real-time + interactive state**, not a content-heavy site. The fundamental shape is different from a portfolio:

| Concern | AXOD CREATIVE (Astro fits) | Mission Control (Next.js fits) |
|---|---|---|
| Page model | ~5 static-ish pages, content-heavy | 1-2 routes, app-heavy |
| JS surface | Minimal — most pages are HTML | Heavy — Monaco editor, xterm.js, streaming, real-time UI |
| Real-time | Cute animations | Server-Sent Events, agent streams, live diffs, live previews |
| Data fetching | Build-time / no DB | Runtime DB queries on every page load |
| Auth | None (public site) | Session-based, middleware-protected routes |
| Server functions | Cloudflare Worker sidecars (chat, research) | API routes adjacent to the UI |
| Ecosystem fit | Static-first frameworks excel | React-ecosystem libraries (shadcn, lucide, react-hook-form, swr, monaco-react, xterm-react) all expect Next or Vite |

Astro CAN do all of this. But its core mental model is "static-first, hydrate islands as needed." Mission Control is the inverse — basically 100% client-interactive once loaded. Forcing it through Astro means fighting the framework instead of leveraging it.

## Alternatives considered

### Astro + React islands
- ✅ Familiar tech
- ❌ Astro is wrong runtime for an app that's 100% interactive
- ❌ shadcn/ui's New York / Default themes assume Next or Vite — Astro integration exists but is second-class
- ❌ Server-Sent Events through Astro endpoints work but with rough edges (streaming response headers, runtime detection)
- ❌ App-style routing (deeply nested layouts, parallel routes) is awkward

**Verdict:** Could be made to work, but at the cost of fighting the tool the whole way.

### SvelteKit
- ✅ Strong SSE support, clean reactivity, fast
- ❌ Operator has no Svelte experience; adds learning overhead
- ❌ Smaller ecosystem for the specific tools we need (Monaco, xterm.js have React wrappers; Svelte wrappers exist but are less maintained)

**Verdict:** Would be the right pick for someone already in Svelte. Not worth the learning curve here.

### Remix / React Router 7
- ✅ Excellent data loading model
- ✅ Standard React ecosystem
- ❌ Remix → React Router 7 transition still settling; less battle-tested for new apps in mid-2026
- ❌ Fewer dashboard-specific resources than Next.js

**Verdict:** Strong second choice. Pick Next.js for momentum.

### Vite + React + Hono backend
- ✅ Full control, minimal magic
- ✅ Faster dev server than Next.js
- ❌ Have to assemble the routing, middleware, SSR, etc. yourself
- ❌ shadcn works but you set up the build chain manually

**Verdict:** Tempting for purists, but the assembly tax slows down week 1.

### Next.js 16 (chosen)
- ✅ App Router handles deeply nested layouts that map naturally to the 3-pane shell
- ✅ Server Components let the team roster, session list, and message history be server-rendered without client-side fetching
- ✅ Client Components for the chat composer, workspace tabs, live stream consumer
- ✅ API routes co-located with the UI
- ✅ Server-Sent Events work in Node runtime out of the box
- ✅ Middleware for auth gating
- ✅ Massive ecosystem alignment with shadcn/ui, lucide, swr, all the dashboard libraries we'll want
- ✅ Operator already knows React (used in `axod-chat` Worker's panel and elsewhere)
- ❌ Heavier than Astro (more abstraction, more "magic")
- ❌ Build tooling more opinionated

**Verdict:** Right tool for this job.

## Consequences

### Positive

- Tap into a large library ecosystem on day 1 (Monaco diff editor, xterm.js wrapper, react-hook-form, swr for client cache, etc.)
- Middleware-based auth gating is one line: `export const config = { matcher: ['/((?!login|api/auth).*)'] }`
- Server Components render the team roster and message history with zero client-side fetch waterfalls
- App Router's parallel routes might be useful in v2.x for split-pane workspaces

### Negative

- Two frameworks in the user's portfolio (Astro for AXOD CREATIVE, Next.js for Mission Control) — small context-switch cost
- Next.js's "magic" is heavier than Astro's — debugging hydration mismatches and Server vs Client Component boundaries can sometimes be annoying
- Slightly heavier deploy artifact than Astro

### Neutral

- Both deploy easily to Hetzner via Docker
- Both have first-class TypeScript
- Both have a mature dev server

## Decision boundary

This decision is locked **only for Mission Control v1-v3**. If, in v4+, Mission Control becomes mostly read-only public dashboards (e.g., "client status pages") with minimal interactivity, revisit and consider extracting those to Astro.

## References

- [Next.js 16 App Router docs](https://nextjs.org/docs/app)
- [shadcn/ui — Next.js install guide](https://ui.shadcn.com/docs/installation/next)
- [AXOD CREATIVE Astro setup](https://github.com/adrew0321/AXODCREATIVE) — for contrast, what NOT to mimic for this project