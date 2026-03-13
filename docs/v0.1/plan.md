# v0.1 Implementation Plan

## Phases

Each phase builds on the previous. A phase is complete when all its stories pass their acceptance criteria.

---

## Phase 1: Foundation

Scaffold the package, define the core types, and establish the adapter contract. No provider calls yet — just the skeleton.

| Order | Story | Title | Tasks | Depends On |
|-------|-------|-------|-------|------------|
| 1.1 | [AM-113](stories/01-core-api/am-113.md) | TypeScript SDK client | 4 | — |
| 1.2 | [AM-201](stories/02-providers/am-201.md) | Provider adapter contract | 3 | AM-113 |
| 1.3 | [AM-101](stories/01-core-api/am-101.md) | Basic chat completion | 5 | AM-201 |
| 1.4 | [AM-112](stories/01-core-api/am-112.md) | Standardized error format | 3 | AM-101 |
| 1.5 | [AM-109](stories/01-core-api/am-109.md) | Provider/model naming | 3 | AM-201 |

**Outcome:** `AnyModel` class exists, types defined, adapter interface established, model string parsing works, errors are standardized. Nothing calls a real API yet.

---

## Phase 2: First Provider (OpenAI)

Get the first end-to-end path working. OpenAI is the easiest — it's a pass-through.

| Order | Story | Title | Tasks | Depends On |
|-------|-------|-------|-------|------------|
| 2.1 | [AM-205](stories/02-providers/am-205.md) | OpenAI pass-through adapter | 2 | Phase 1 |
| 2.2 | [AM-210](stories/02-providers/am-210.md) | Provider error mapping | 3 | AM-205 |
| 2.3 | [AM-102](stories/01-core-api/am-102.md) | Streaming completions | 6 | AM-205 |

**Outcome:** `client.chat.completions.create({ model: 'openai/gpt-4o', ... })` works, streaming works, errors normalized. First real API call.

---

## Phase 3: Anthropic Provider

The primary provider for most users. More complex translation layer.

| Order | Story | Title | Tasks | Depends On |
|-------|-------|-------|-------|------------|
| 3.1 | [AM-202](stories/02-providers/am-202.md) | Anthropic request translation | 6 | Phase 2 |
| 3.2 | [AM-203](stories/02-providers/am-203.md) | Anthropic response normalization | 3 | AM-202 |
| 3.3 | [AM-204](stories/02-providers/am-204.md) | Anthropic streaming translation | 3 | AM-202, AM-102 |

**Outcome:** `client.chat.completions.create({ model: 'anthropic/claude-sonnet-4-6', ... })` works with full translation — messages, tools, streaming, errors.

---

## Phase 4: Google Provider

Third provider. Similar pattern to Anthropic.

| Order | Story | Title | Tasks | Depends On |
|-------|-------|-------|-------|------------|
| 4.1 | [AM-206](stories/02-providers/am-206.md) | Gemini request translation | 4 | Phase 2 |
| 4.2 | [AM-207](stories/02-providers/am-207.md) | Gemini response normalization | 3 | AM-206 |
| 4.3 | [AM-208](stories/02-providers/am-208.md) | Gemini streaming translation | 2 | AM-206, AM-102 |

**Outcome:** Three providers working. Core product is functional.

---

## Phase 5: Tools, Structured Output, Config

Feature completeness for the chat completions path plus the config system.

| Order | Story | Title | Tasks | Depends On |
|-------|-------|-------|-------|------------|
| 5.1 | [AM-103](stories/01-core-api/am-103.md) | Tool/function calling | 4 | Phase 3, Phase 4 |
| 5.2 | [AM-104](stories/01-core-api/am-104.md) | Structured output / response format | 3 | Phase 3, Phase 4 |
| 5.3 | [AM-215](stories/02-providers/am-215.md) | Parameter support discovery | 3 | AM-103, AM-104 |
| 5.4 | [AM-401](stories/04-config/am-401.md) | Provider key env vars | 2 | Phase 1 |
| 5.5 | [AM-403](stories/04-config/am-403.md) | JSON config file | 4 | AM-401 |
| 5.6 | [AM-404](stories/04-config/am-404.md) | Global config file | 2 | AM-403 |
| 5.7 | [AM-405](stories/04-config/am-405.md) | Config resolution order | 2 | AM-403, AM-404 |
| 5.8 | [AM-406](stories/04-config/am-406.md) | Built-in provider config | 2 | AM-405 |
| 5.9 | [AM-409](stories/04-config/am-409.md) | Default request parameters | 2 | AM-405 |
| 5.10 | [AM-408](stories/04-config/am-408.md) | Model aliases | 2 | AM-109, AM-405 |
| 5.11 | [AM-110](stories/01-core-api/am-110.md) | Model aliases (core) | 3 | AM-408 |

**Outcome:** Tools and JSON mode work across all providers. Config file, env vars, aliases, and defaults all wired up.

---

## Phase 6: Routing & Resilience

Fallbacks, retries, provider preferences, transforms.

| Order | Story | Title | Tasks | Depends On |
|-------|-------|-------|-------|------------|
| 6.1 | [AM-211](stories/02-providers/am-211.md) | Automatic retry with backoff | 3 | Phase 2 |
| 6.2 | [AM-212](stories/02-providers/am-212.md) | Per-provider rate limit tracking | 3 | AM-211 |
| 6.3 | [AM-105](stories/01-core-api/am-105.md) | Model fallback routing | 4 | AM-211 |
| 6.4 | [AM-213](stories/02-providers/am-213.md) | Fallback model routing (execution) | 3 | AM-105 |
| 6.5 | [AM-106](stories/01-core-api/am-106.md) | Provider preferences | 5 | AM-213 |
| 6.6 | [AM-214](stories/02-providers/am-214.md) | Provider preference routing | 3 | AM-106 |
| 6.7 | [AM-410](stories/04-config/am-410.md) | Default routing config | 2 | AM-214 |
| 6.8 | [AM-107](stories/01-core-api/am-107.md) | Middle-out transform | 3 | Phase 2 |
| 6.9 | [AM-412](stories/04-config/am-412.md) | Transforms config | 2 | AM-107 |

**Outcome:** Production-grade resilience. Retries, fallbacks, provider preferences, context truncation all working.

---

## Phase 7: Models & Stats

Discovery, pricing metadata, generation stats.

| Order | Story | Title | Tasks | Depends On |
|-------|-------|-------|-------|------------|
| 7.1 | [AM-108](stories/01-core-api/am-108.md) | List available models | 4 | Phase 3, Phase 4 |
| 7.2 | [AM-413](stories/04-config/am-413.md) | Model discovery via SDK | 3 | AM-108 |
| 7.3 | [AM-111](stories/01-core-api/am-111.md) | Generation stats endpoint | 5 | Phase 2 |

**Outcome:** `client.models.list()` returns models with pricing. Generation stats tracked and queryable.

---

## Phase 8: Custom Providers

OpenAI-compatible endpoints (Groq, Together, Ollama, vLLM).

| Order | Story | Title | Tasks | Depends On |
|-------|-------|-------|-------|------------|
| 8.1 | [AM-209](stories/02-providers/am-209.md) | Custom provider registration | 3 | Phase 2 |
| 8.2 | [AM-407](stories/04-config/am-407.md) | Custom provider config | 3 | AM-209, AM-405 |

**Outcome:** Any OpenAI-compatible endpoint can be added via config and used as `custom-name/model`.

---

## Phase 9: Batch Processing

The full batch subsystem — anymodel's key differentiator.

| Order | Story | Title | Tasks | Depends On |
|-------|-------|-------|-------|------------|
| 9.1 | [AM-411](stories/04-config/am-411.md) | Batch settings | 2 | AM-405 |
| 9.2 | [AM-310](stories/03-batch/am-310.md) | Batch state persistence | 4 | AM-411 |
| 9.3 | [AM-301](stories/03-batch/am-301.md) | Create a batch | 5 | AM-310 |
| 9.4 | [AM-302](stories/03-batch/am-302.md) | Retrieve batch status | 3 | AM-301 |
| 9.5 | [AM-303](stories/03-batch/am-303.md) | Retrieve batch results | 4 | AM-301 |
| 9.6 | [AM-304](stories/03-batch/am-304.md) | Cancel a batch | 3 | AM-301 |
| 9.7 | [AM-305](stories/03-batch/am-305.md) | List batches | 3 | AM-301 |
| 9.8 | [AM-315](stories/03-batch/am-315.md) | Concurrent fallback adapter | 4 | AM-301 |
| 9.9 | [AM-313](stories/03-batch/am-313.md) | Anthropic batch adapter | 5 | AM-301, AM-202 |
| 9.10 | [AM-314](stories/03-batch/am-314.md) | OpenAI batch adapter | 5 | AM-301, AM-205 |
| 9.11 | [AM-306](stories/03-batch/am-306.md) | Manual polling (SDK) | 2 | AM-302 |
| 9.12 | [AM-307](stories/03-batch/am-307.md) | createAndPoll helper | 4 | AM-306 |
| 9.13 | [AM-308](stories/03-batch/am-308.md) | Resume polling | 2 | AM-307, AM-310 |
| 9.14 | [AM-311](stories/03-batch/am-311.md) | Output directory for results | 3 | AM-307 |
| 9.15 | [AM-312](stories/03-batch/am-312.md) | Batch cleanup and retention | 3 | AM-310 |
| 9.16 | [AM-309](stories/03-batch/am-309.md) | Webhook notification | 3 | AM-301 |

**Outcome:** Full batch system — create, poll, resume, output, cleanup. Native adapters for Anthropic + OpenAI. Concurrent fallback for others.

---

## Phase 10: Server Mode

HTTP server that exposes everything as an API.

| Order | Story | Title | Tasks | Depends On |
|-------|-------|-------|-------|------------|
| 10.1 | [AM-501](stories/05-server-mode/am-501.md) | Start HTTP server via CLI | 4 | Phase 5 (config) |
| 10.2 | [AM-502](stories/04-config/am-502.md) | CLI options | 3 | AM-501 |
| 10.3 | [AM-402](stories/04-config/am-402.md) | Server env vars | 2 | AM-501 |
| 10.4 | [AM-515](stories/05-server-mode/am-515.md) | Health check | 2 | AM-501 |
| 10.5 | [AM-508](stories/05-server-mode/am-508.md) | Server API key auth | 2 | AM-501 |
| 10.6 | [AM-509](stories/05-server-mode/am-509.md) | Open mode (no auth) | 2 | AM-508 |
| 10.7 | [AM-503](stories/05-server-mode/am-503.md) | Chat completions endpoint | 4 | AM-501, Phase 2 |
| 10.8 | [AM-504](stories/05-server-mode/am-504.md) | Models endpoint | 2 | AM-501, AM-108 |
| 10.9 | [AM-506](stories/05-server-mode/am-506.md) | Generation stats endpoint | 2 | AM-501, AM-111 |
| 10.10 | [AM-507](stories/05-server-mode/am-507.md) | Model endpoints info | 2 | AM-504 |
| 10.11 | [AM-505](stories/05-server-mode/am-505.md) | Batch endpoints | 3 | AM-501, Phase 9 |
| 10.12 | [AM-510](stories/05-server-mode/am-510.md) | Summary logging | 3 | AM-503 |
| 10.13 | [AM-511](stories/05-server-mode/am-511.md) | Full logging | 3 | AM-510 |
| 10.14 | [AM-512](stories/05-server-mode/am-512.md) | Log off | 2 | AM-510 |
| 10.15 | [AM-513](stories/05-server-mode/am-513.md) | Drop-in OpenAI SDK usage | 2 | AM-503 |
| 10.16 | [AM-514](stories/05-server-mode/am-514.md) | Docker sidecar deployment | 3 | AM-501 |

**Outcome:** `npx @probeo/anymodel serve` runs a full HTTP server. OpenAI SDK compatible. Auth, logging, all endpoints.

---

## Summary

| Phase | Name | Stories | Tasks | Cumulative |
|-------|------|---------|-------|------------|
| 1 | Foundation | 5 | 18 | 18 |
| 2 | First Provider (OpenAI) | 3 | 11 | 29 |
| 3 | Anthropic Provider | 3 | 12 | 41 |
| 4 | Google Provider | 3 | 9 | 50 |
| 5 | Tools, Config | 11 | 30 | 80 |
| 6 | Routing & Resilience | 9 | 28 | 108 |
| 7 | Models & Stats | 3 | 12 | 120 |
| 8 | Custom Providers | 2 | 6 | 126 |
| 9 | Batch Processing | 16 | 55 | 181 |
| 10 | Server Mode | 16 | 40 | 221 |
| **Total** | | **71** | **221** | |

## MVP Checkpoint

After **Phase 5**, the SDK is usable:
- Three providers (OpenAI, Anthropic, Google)
- Chat completions with streaming, tools, JSON mode
- Config file, env vars, aliases
- Error handling

Everything after Phase 5 adds resilience (Phase 6), observability (Phase 7), extensibility (Phase 8), batch (Phase 9), and server mode (Phase 10).

## Build Order Per Phase

Within each phase, stories should be built in the order listed. Tasks within a story can generally be built in order (types → implementation → tests), though some tasks within a story are independent and can be parallelized.
