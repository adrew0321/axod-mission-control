# Run DeepSeek for AKIRA

## Goal

Decouple AKIRA from your Claude subscription so she runs free, 24/7, on the Mac Mini — independently of Anthropic. Sage + the specialist team stay on Claude; this is AKIRA-only.

---

## Hardware Reality Check (Mac Mini)

This is the single biggest constraint. From the [room design spec](file:///c:/Users/A'KeemDrew/AXOD/axod-mission-control/docs/superpowers/specs/2026-08-13-akiras-room-design.md):

| | |
|---|---|
| Machine | `Macmini6,2` — Late 2012, quad-core i7 |
| GPU | Intel HD 4000 — no CUDA, no Metal ML, **CPU inference only** |
| RAM | 15 GiB total (~14 GiB available) |
| OS | Ubuntu 24.04, headless |
| Already running | `mission-control.service`, `cloudflared.service`, AKIRA room LXD container |

**What this means for local LLMs:**

| Model size | Q4 file size | Fits in RAM? | CPU tokens/sec (est.) | Verdict |
|---|---|---|---|---|
| 70B+ (DeepSeek full V3/R1) | ~40–80 GB | ❌ No | ~0.5–1 t/s | Unusable |
| 32B | ~20 GB | ❌ No (OOM) | ~1–2 t/s | Unusable |
| 14B | ~9 GB | ⚠️ Tight | ~3–4 t/s | Borderline |
| 8B / 7B | ~5 GB | ✅ Yes | ~5–10 t/s | Functional, slow |
| 1.5B | ~1 GB | ✅ Yes | ~20–30 t/s | Fast but limited |

## The Decision: DeepSeek V4.1 Flash via API

`deepseek-v4.1-flash` (a 763B parameter model available via DeepSeek's API / Ollama Cloud) is an **excellent choice** for AKIRA for three reasons:

1. **Tool-calling capability:** AKIRA relies heavily on tools (`remember`, `navigate`, `web_fetch`). At 763B parameters, this model is vastly better at formatting tool calls correctly than any small 7B model you could run locally. It also has built-in `thinking` capabilities.
2. **Cost:** At $0.15 per 1M input tokens, AKIRA's average turn (planning, searching, recalling memory) will cost a fraction of a cent. It meets your "basically free" requirement without the constraints of running locally.
3. **Hardware independence:** The Mac Mini (a 2012 i7 with no GPU) cannot run a model this smart locally. By using the API, the Mini only has to run a tiny proxy process, keeping it cool and freeing up its RAM for Mission Control and your other services.

**Are there other models to consider?**
- **If you want true offline sovereignty (0 API calls):** `qwen2.5:7b` via Ollama. It fits in the Mini's 16GB RAM and is exceptionally good at tool-calling for its size. *Trade-off:* It will be slow (8 tokens/sec = 1 minute per response) and noticeably less capable than DeepSeek V4.1 Flash.
- **For now, DeepSeek V4.1 Flash is the pragmatic winner.** It gives you top-tier intelligence, decouples you from Anthropic, and costs pennies.

---

## The Path Forward: Proxy Shim (LiteLLM)

We will use [LiteLLM](https://github.com/BerriAI/litellm) as a local proxy on the Mini. It translates the Claude SDK's Anthropic-format calls into DeepSeek's OpenAI-compatible API. The `claude` CLI is pointed at `http://localhost:4000` instead of Anthropic. No new runner code is needed.

**The one risk:** We need to confirm that the Claude CLI's tool-call loop survives LiteLLM's translation layer to DeepSeek. Tool calls (remember, navigate, web fetch) are AKIRA's most critical path.

---

## Proposed Implementation

All paths share the same implementation approach (proxy shim) until the spike proves otherwise.

### Phase 1 — Spike (throwaway, ~1h)

**On the Mac Mini:**
```bash
pip install 'litellm[proxy]'
# or: pipx install 'litellm[proxy]'
```

**`/tmp/litellm_spike.yaml`:**
```yaml
model_list:
  - model_name: deepseek-v4.1-flash:cloud   # what claude CLI will ask for
    litellm_params:
      model: ollama/deepseek-v4.1-flash:cloud
      api_base: "http://localhost:11434" # Assuming Ollama cloud routing handles this
```

**Start proxy:** `litellm --config /tmp/litellm_spike.yaml --port 4000`

**Temporarily in `.env`:** `ANTHROPIC_BASE_URL=http://localhost:4000`

Update AKIRA's `model` in the DB to `deepseek-v4.1-flash:cloud`. Trigger a turn. Observe.

---

### Phase 2 — Permanent wiring (if spike passes)

#### [NEW] `/srv/mission-control/litellm_config.yaml`
- Production LiteLLM config: AKIRA model → DeepSeek API

#### [NEW] `/etc/systemd/system/litellm.service`
- Systemd unit that starts LiteLLM on boot, restarts on crash

#### [MODIFY] [`.env`](file:///c:/Users/A'KeemDrew/AXOD/axod-mission-control/.env) + [`.env.example`](file:///c:/Users/A'KeemDrew/AXOD/axod-mission-control/.env.example)
- Add `ANTHROPIC_BASE_URL=http://localhost:4000` (only set when LiteLLM is the target)
- Add `DEEPSEEK_API_KEY=` to `.env.example`

#### DB — AKIRA agent row
- Update `model` to `deepseek-v4.1-flash:cloud`
- Everything else (`tools_allowlist`, `system_prompt`, caps) unchanged

#### [MODIFY] [`agent-runner-sdk.ts`](file:///c:/Users/A'KeemDrew/AXOD/axod-mission-control/src/lib/agent-runner-sdk.ts)
- No code changes if the proxy is transparent (which is the goal)
- Possibly: update the default model string from `claude-opus-4-7` if it becomes the hardcoded fallback when AKIRA's DB row is empty

---

## Verification Plan

### Spike pass criteria
- AKIRA's turn streams to the HUD
- At least one tool call executes successfully (try `remember` — simplest)
- Response persists to DB (check the session messages table)
- No fatal SDK errors in the Next.js server logs

### Post-implementation
- Trigger AKIRA from Discord (`/mc` or DM) — confirm she responds without Claude credentials
- Remove `ANTHROPIC_API_KEY` from `.env` entirely and confirm AKIRA still runs
- Run `pnpm test` — pure-lib tests are provider-agnostic and should pass unchanged
