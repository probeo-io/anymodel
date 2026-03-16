# Changelog

All notable changes to this project will be documented in this file.

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
