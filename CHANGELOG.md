# Changelog

All notable changes to this project will be documented in this file.

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
