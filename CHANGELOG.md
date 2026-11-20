# Changelog

All notable changes to this project will be documented in this file.

## [0.11.0] - Unreleased

### Packaging and server cleanup

- Preserve the feature work below under a distinct package version; CLI version comes from the package manifest.
- Bundle the existing queue dependency so both CommonJS and ESM exports load correctly.
- Failed explicit pricing refresh preserves the previous snapshot and returns a failure status.
- Normal install/build uses committed pricing. Refresh only through `npm run pricing:refresh`, with pinned local tooling.
- Declare Node `^20.19.0 || >=22.12.0` for ESM/CJS compatibility with the existing runtime dependency.
- HTTP server defaults to loopback. Explicit remote binding requires a separate server bearer key; embedded servers reject unkeyed non-loopback clients.
- Correct package names, repository links, runtime/build notes and current provider controls.
- Include the previously unversioned OpenAI explicit prompt-cache breakpoint change and Git `prepare` support from main.


### Added

- **DeepInfra provider** — `DEEPINFRA_API_KEY`, models addressed as `deepinfra/<org>/<model>` (e.g. `deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo`). Chat completions with streaming, tool calling, structured outputs, and `reasoning: { effort }`. `listModels()` reads DeepInfra's per-model metadata, so it returns only chat-surface models with their real context lengths, per-token pricing, and vision/cache/reasoning capabilities.
- **DeepInfra native batch** — OpenAI-compatible JSONL upload → `/batches` → poll → download, wired into `BatchManager` like the other native batch providers. Batch runs are billed at 20% off, reflected in `providerPricingMultiplier('deepinfra', 'native_batch')`.
- Prompt caching on DeepInfra is automatic; a request's `cache.key` is forwarded as `prompt_cache_key` to partition the cache. DeepInfra exposes no retention or mode controls, so the rest of `cache` is not sent.

### Changed

- **Pricing data refreshed** — 513 models, up from 398. Adds 52 newly listed models (including `openai/gpt-6-astra`, `anthropic/claude-fable-5.1`, `google/gemini-3.8-flash`, `deepseek/deepseek-v4-pro-0813`) and drops models OpenRouter has delisted.
- **DeepInfra rates are now bundled** — `scripts/fetch-pricing.ts` also reads DeepInfra's own per-model rates and keys them as `deepinfra/<org>/<model>`. OpenRouter lists the same open weights under their originating org (`meta-llama/…`), which says nothing about what DeepInfra charges to serve them, so a `deepinfra/…` request previously found no pricing entry and cost $0. Both fetches must now succeed for the table to be regenerated.

### Fixed

- `tests/batch-cost.test.ts` derives its expected cost from `getModelPricing()` instead of hardcoded per-token rates, which broke the test on every pricing regeneration.
- **`getModelPricing()` no longer resolves by table order.** Prefix matching returned the first key where either string prefixed the other, and the table is regenerated from a remote API whose ordering is arbitrary — so a model's price could change on a regeneration alone, with no code change and nothing failing. `openai/gpt-6` prefix-matched four entries spanning a 2x rate spread. Resolution is now settled by key length and then alphabetically: exact id first, then the longest known id the query extends (dated and versioned ids still fall back to their base), then the shortest id extending the query. Across 1278 probes over five table orderings, 261 results varied under the old rule and none under the new one; no real model id lost pricing or changed rate.
- `:batch` entries are a pricing mode, not a model, and are no longer returned for a query that doesn't ask for one.
- **Long-context pricing tiers are now applied.** OpenRouter publishes per-model `overrides` that raise rates past a prompt-size threshold, and the generator was discarding them — so a long request was billed at the model's base rate all the way up. 63 models carry tiers, concentrated in the providers most used here: OpenAI (24), Qwen (13), xAI (8), Google (8), Anthropic (3). On a 400k-token prompt this under-reported cost by roughly 100% for `openai/gpt-6-astra` and `x-ai/grok-4.6`, and by 564% for `qwen/qwen3.7-flash`. `PricingEntry` gains an optional `tiers` array and a new `effectiveRates(pricing, promptTokens)` resolves the rates in force for a given prompt size; `calculateCost` uses it. Flat-rate models are unaffected.
- Time-window overrides (off-peak `utc_start`/`utc_end` rates) and audio rates are skipped rather than applied as if they were token tiers — they need inputs a static table doesn't have. The generator reports how many it skipped.
- **Direct-provider rates are cross-checked at generation time.** None of OpenAI, Anthropic, Google, or xAI publish machine-readable pricing — all four model endpoints require auth and return no rates — so OpenRouter remains the source. `scripts/fetch-pricing.ts` now also fetches LiteLLM's independent price table and reports any model where the two disagree. On the current data, 84 of 85 matched models agree exactly; the outlier is `openai/gpt-5.6-sol`, where OpenRouter lists $2/$10 per 1M and LiteLLM lists $4/$20 with $2 as the flex rate. The check is advisory and its failure is a warning, not a build error: it validates the table rather than supplying it.
- **`prices.json`** — hand-verified rates at the project root that beat every fetched source. Since no vendor publishes machine-readable pricing, this is the only way to pin a rate you have actually confirmed, or to price a model no aggregator lists. The format is a model id and two numbers, per million tokens as vendors quote them: `"openai/gpt-4o": { "in": 2.5, "out": 10 }`. Per-token conversion, cache rates, and long-context tiers are handled by the generator; `cacheRead`, `cacheWrite`, and `tiers` are optional. Any value under 0.001 is rejected as an almost-certain per-token typo, and every validation failure names the model and fails the build rather than mispricing quietly. Entries upstream has caught up with are reported as safe to delete. Applied before the LiteLLM cross-check, so a correction turns a reported disagreement into agreement — and the cross-check prints the paste-ready line when it finds one.
- **Generated entries are sorted by model id.** Both upstream APIs return models in an order that shifts between fetches, which reshuffled all 513 lines on every regeneration and buried the actual rate changes. Regenerating is now reproducible apart from the timestamp.

## [0.10.0] - 2026-08-06

### Added

- **OpenAI Responses API support for reasoning models** — set `reasoning: { effort: 'none'|'low'|'medium'|'high'|'xhigh'|'max' }` on a request to route it through `/v1/responses`. The OpenAI adapter translates the common tool-call contract to/from Responses function-call items (function tools, `function_call`/`function_call_output`), so callers can run a full reasoning + tool-call loop without switching to a provider-specific SDK. Existing requests without `reasoning` are unaffected.
- **`calculateProviderCost()`** — normalized, versioned cost accounting that replaces flat batch usage of `calculateCost()`. Accounts for cache read/write tokens separately from uncached prompt tokens, and treats OpenAI Flex/Batch discounts as OpenAI-specific pricing policy (`src/pricing/provider-policy.ts`) rather than a generic 50% multiplier applied to every provider.
- `calculateCost()` now accepts optional `cacheReadTokens`/`cacheWriteTokens` params, billed at each model's generated `cacheRead`/`cacheWrite` rates when available.

## [0.9.1] - 2026-06-01

### Added

- **Prompt caching** — `cache` option on requests (`src/cache.ts`) for constructing stable, reusable prompt cache keys across Anthropic, OpenAI, and Google.
- **xAI provider** — `XAI_API_KEY`, `xai/grok-4` and other Grok models.

## [0.9.0] - 2026-05-01

### Added

- Live pricing refresh via the OpenRouter API at publish time (338 models at the time of release)
- New models: `claude-opus-4-7`, `gpt-5.5`, `gpt-5.5-pro`

### Fixed

- Anthropic fallback model IDs and context lengths corrected against official docs

## [0.8.0] - 2026-03-30

### Added

- **Adaptive concurrency for concurrent batches** — set `concurrencyFallback: 'auto'` to dynamically discover your provider's rate limit ceiling instead of using a fixed concurrency. Uses TCP-style slow-start (exponential ramp: 5 → 10 → 20 → 40 → ...) then switches to AIMD (additive increase / multiplicative decrease) after the first 429 or header-driven backoff. Proactively reads `x-ratelimit-remaining-requests` headers to stay under the limit without hitting 429s.
- **`concurrencyMax` config option** — hard ceiling for auto concurrency. Useful when multiple batch jobs share the same API key: set each to e.g. 50 to divide your rate limit budget predictably.
- **Response metadata on provider adapters** — `sendRequestWithMeta()` method on OpenAI, Anthropic, and Google adapters now returns response headers alongside the completion. Rate limit headers (`x-ratelimit-remaining-requests`, `retry-after`, etc.) are extracted and fed into the existing `RateLimitTracker`, which was previously unwired.
- **`completeWithMeta()` on Router** — internal method that returns `ChatCompletionWithMeta` with rate limit headers. Used by the batch manager for adaptive concurrency; also activates the `RateLimitTracker` for fallback routing decisions.
- Exported `AdaptiveConcurrencyController` class and `AdaptiveConcurrencyOptions` type for advanced usage
- Exported `ResponseMeta` and `ChatCompletionWithMeta` types

### Fixed

- **`max_tokens` → `max_completion_tokens` translation** — newer OpenAI models (gpt-4o, gpt-4o-mini, o1, o3, o4-mini, gpt-5-mini) require `max_completion_tokens` instead of `max_tokens`. anymodel now detects the model and sends the correct parameter automatically. The SDK surface stays unchanged — callers always pass `max_tokens`.
- **Flex discount missing on concurrent batch cost calculations** — `BatchManager.getResults()` only applied the 50% native batch discount, ignoring `service_tier: 'flex'` on concurrent batches. Now correctly applies 50% for both native and concurrent+flex.
- **`service_tier` now persisted on `BatchObject`** — previously lost after batch creation, preventing accurate cost calculation on retrieval.
- Added `gpt-5-mini` to token estimation limits (1M context, 65K max completion tokens)

## [0.7.1] - 2026-03-26

### Fixed

- Batch cost calculations now apply 50% discount for native batch APIs (OpenAI, Anthropic, Google)
- BatchBuilder accounts for flex pricing discount on concurrent batches

## [0.7.0] - 2026-03-24

### Added

- **BatchBuilder API** — ergonomic batch construction with `client.batches.open(config)`
  - `add(prompt)` persists to disk immediately, caller just passes strings
  - `submit()` formats and dispatches to provider (Anthropic/OpenAI/Google format handled automatically)
  - `poll()` returns clean `succeeded`/`failed` results with per-item costs
  - `retry(failed)` creates a new builder pre-loaded with failed items
  - Auto-generated IDs, system prompt injection, provider-specific formatting all hidden
- Poll logging: `logToConsole` option and `ANYMODEL_BATCH_POLL_LOG` env var

## [0.6.0] - 2026-03-19

### Added

- Automatic per-request cost calculation from bundled pricing data (323 models)
- Pricing fetched from OpenRouter at build time — always current as of last publish
- `GenerationStats.total_cost` now calculated automatically from token usage
- `BatchUsageSummary.estimated_cost` now calculated automatically from token usage
- Exported `getModelPricing()`, `calculateCost()`, `PRICING_AS_OF`, `PRICING_MODEL_COUNT`
- `batch_mode` option on `BatchCreateRequest` — set to `"concurrent"` to force individual requests (e.g. for flex pricing)
- `service_tier` support on batch requests (concurrent path only — native batch already discounted)

## [0.5.1] - 2026-03-17

### Changed

- Concurrent batch processing now streams requests from disk instead of holding all in memory — safe for 10K+ request batches
- Batch concurrency gating improved: only N requests (default 5) are in-flight at a time, the rest stay on disk until needed

## [0.5.0] - 2026-03-17

### Added

- Native batch API support for Google Gemini via `batchGenerateContent` (50% cost reduction)
- `GoogleBatchAdapter` with inline and file-based result handling
- Google batch status polling with `JOB_STATE_*` mapping
- Google batch cancellation support
- Automatic `max_tokens` estimation for batch requests — when not explicitly set, calculates a safe value per-request based on estimated input token count and model context/completion limits (~4 chars/token heuristic with 5% safety margin)
- `resolveMaxTokens()` and `estimateTokenCount()` exported utilities for manual use
- Model limits lookup table covering OpenAI, Anthropic, and Google model families
- OpenAI `service_tier` support — set `service_tier: "flex"` on requests for 50% cost reduction with flexible latency
- Configurable HTTP request timeout — 2 minutes default for normal requests, 10 minutes for flex (`service_tier: "flex"`) requests, both settable via `setDefaultTimeout()` and `setFlexTimeout()`

### Changed

- Google adapter `supportsBatch()` now returns `true`
- README updated to reflect Google as a native batch provider

## [0.4.0] - 2026-03-16

### Added

- Native Perplexity provider with static model listing (sonar, sonar-pro, sonar-reasoning, sonar-reasoning-pro, sonar-deep-research, r1-1776)
- Citation passthrough in Perplexity responses
- Cross-language links in README (Python, Go)

### Changed

- Perplexity upgraded from generic OpenAI-compatible adapter to dedicated native provider
- `perplexity/sonar-pro` added to model naming examples in README

## [0.3.0] - 2026-03-15

### Added

- Native batch API support for OpenAI (JSONL upload, 50% cost reduction, 24hr processing window)
- Native batch API support for Anthropic (Message Batches API, up to 10K requests)
- Automatic provider detection — native batch for OpenAI/Anthropic, concurrent fallback for others
- `batch_mode` field on `BatchObject` (`"native"` or `"concurrent"`)
- Fire-and-forget batch submission via `client.batches.create()` — submit now, poll later
- Batch resumability across process restarts for native batches (provider state persisted to disk)
- Batch cancellation at the provider level for native batches
- Per-item error handling for native batch results
- Configurable poll interval via `batch.pollInterval` config or per-call `options.interval`
- `BatchAdapter` interface for implementing custom native batch providers
- High-volume filesystem IO layer (`fs-io`) — concurrency-limited async queues (20 read, 10 write), atomic durable writes with fsync, directory existence caching, path memoization
- Configurable IO concurrency via `io.readConcurrency` and `io.writeConcurrency` in client config (defaults: 20 read, 10 write)
- Exported `configureFsIO`, `readFileQueued`, `writeFileQueued`, `writeFileFlushedQueued`, `appendFileQueued`, `ensureDir`, `joinPath`, `getFsQueueStatus`, `waitForFsQueuesIdle` utilities

### Changed

- Batch storage directory changed from `~/.anymodel/batches/` to `./.anymodel/batches/` (project-local)
- `BatchStore` now fully async — all methods return Promises, using queued IO instead of blocking sync `fs` calls
- `client.batches.get()`, `client.batches.list()`, `client.batches.results()` are now async (return Promises)
- `client.batches.cancel()` is now async (returns `Promise<BatchObject>`)
- Batch metadata writes use atomic temp-file + fsync + rename pattern to prevent corruption on crash

## [0.2.0] - 2026-03-13

### Added

- Built-in providers: Mistral, Groq, DeepSeek, xAI, Together, Fireworks, Perplexity, Ollama
- Dynamic model list fetching from Anthropic and Google APIs
- OpenAI model filter updated to include o1/o3/o4 prefixes
- Release script (`npm run release`)
- CI workflow (lint, test, build on Node 20 and 22)
- npm publish workflow (triggers on GitHub release)
- SECURITY.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md
- `.editorconfig`
- Runnable examples (`examples/basic.ts`)

### Changed

- README expanded with full provider table and examples

## [0.1.0] - 2026-03-13

### Added

- AnyModel SDK client with `chat.completions.create()`, `models.list()`, `generation.get()`
- Provider adapters for OpenAI, Anthropic, and Google/Gemini
- Custom provider support for any OpenAI-compatible endpoint
- Unified tool calling and structured output across all providers
- Fallback routing with `models` array and `route: "fallback"`
- Provider preferences (`order`, `only`, `ignore`)
- Model aliases
- Streaming support (SSE)
- Automatic retry with exponential backoff on 429/502/503
- Per-provider rate limit tracking
- Middle-out context truncation transform
- Config file support (`anymodel.config.json`, `~/.anymodel/config.json`)
- Environment variable interpolation in config (`${ENV_VAR}`)
- Config resolution order: programmatic > local > global > env vars
- Batch processing with disk persistence and `createAndPoll()`
- Generation stats tracking
- HTTP server mode (`anymodel serve`)
- OpenAI SDK-compatible API at `/api/v1`
- CLI entry point
