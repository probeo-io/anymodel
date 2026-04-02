# @probeo/anymodel

[![npm version](https://img.shields.io/npm/v/@probeo/anymodel)](https://www.npmjs.com/package/@probeo/anymodel)
[![npm downloads](https://img.shields.io/npm/dm/@probeo/anymodel)](https://www.npmjs.com/package/@probeo/anymodel)
[![license](https://img.shields.io/npm/l/@probeo/anymodel)](https://github.com/probeo-io/anymodel/blob/main/LICENSE)
[![CI](https://github.com/probeo-io/anymodel/actions/workflows/ci.yml/badge.svg)](https://github.com/probeo-io/anymodel/actions/workflows/ci.yml)

OpenRouter-compatible LLM router with unified batch support. Self-hosted, zero fees.

Route requests across OpenAI, Anthropic, and Google with a single API. Add any OpenAI-compatible provider. Run as an SDK or standalone HTTP server.

## Why anymodel?

One SDK, 11+ providers. No vendor lock-in. Switch models by changing a string, not your codebase.

Self-hosted. Your API keys, your infrastructure, zero routing fees. Unlike OpenRouter, there is no middleman and no per-request markup.

Native batch APIs (OpenAI, Anthropic, Google) run at 50% cost with zero config. anymodel detects the provider and routes to the native batch endpoint automatically.

Drop-in compatible with the OpenAI SDK via server mode. Point any OpenAI client at `localhost:4141` and start routing to any provider.

## Install

```bash
npm install @probeo/anymodel
```

## Quick Start

Set your API keys as environment variables:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GOOGLE_API_KEY=AIza...
```

### SDK Usage

```typescript
import { AnyModel } from "@probeo/anymodel";

const client = new AnyModel();

const response = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4-6",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);
```

### Streaming

```typescript
const stream = await client.chat.completions.create({
  model: "openai/gpt-4o",
  messages: [{ role: "user", content: "Write a haiku" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

## Supported Providers

Set the env var and go. Models are auto-discovered from each provider's API.

| Provider | Env Var | Example Model |
|----------|---------|---------------|
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4o` |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-6` |
| Google | `GOOGLE_API_KEY` | `google/gemini-2.5-pro` |
| Mistral | `MISTRAL_API_KEY` | `mistral/mistral-large-latest` |
| Groq | `GROQ_API_KEY` | `groq/llama-3.3-70b-versatile` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek/deepseek-chat` |
| xAI | `XAI_API_KEY` | `xai/grok-3` |
| Together | `TOGETHER_API_KEY` | `together/meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct` |
| Perplexity | `PERPLEXITY_API_KEY` | `perplexity/sonar-pro` |
| Ollama | `OLLAMA_BASE_URL` | `ollama/llama3.3` |

Ollama runs locally with no API key. Just set `OLLAMA_BASE_URL` (defaults to `http://localhost:11434/v1`).

## Fallback Routing

Try multiple models in order. If one fails, the next is attempted:

```typescript
const response = await client.chat.completions.create({
  model: "",
  models: [
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-4o",
    "google/gemini-2.5-pro",
  ],
  route: "fallback",
  messages: [{ role: "user", content: "Hello" }],
});
```

## Batch Processing

Process many requests with native provider batch APIs or concurrent fallback. OpenAI and Google batches run at 50% cost. Anthropic supports async processing for up to 10K requests. Other providers fall back to concurrent execution automatically.

### Submit and wait

```typescript
const results = await client.batches.createAndPoll({
  model: "openai/gpt-4o-mini",
  requests: [
    { custom_id: "req-1", messages: [{ role: "user", content: "Summarize AI" }] },
    { custom_id: "req-2", messages: [{ role: "user", content: "Summarize ML" }] },
    { custom_id: "req-3", messages: [{ role: "user", content: "Summarize NLP" }] },
  ],
});

for (const result of results.results) {
  console.log(result.custom_id, result.response?.choices[0].message.content);
}
```

Native batches (OpenAI, Anthropic, Google) are processed server-side. You can also force concurrent execution with `batch_mode: "concurrent"` when you want flex pricing on individual requests. For adaptive concurrency that auto-discovers your rate limit ceiling, see [Advanced Usage](docs/ADVANCED.md).

See [Advanced Usage](docs/ADVANCED.md) for BatchBuilder, submit-now-check-later, list/cancel, poll logging, service tier options, and batch configuration details.

## Server Mode

Run as a standalone HTTP server compatible with the OpenAI SDK:

```bash
npx anymodel serve --port 4141
```

Point any OpenAI-compatible client at `http://localhost:4141/api/v1` and all provider routing works transparently.

## Configuration

```typescript
const client = new AnyModel({
  anthropic: { apiKey: "sk-ant-..." },
  openai: { apiKey: "sk-..." },
  google: { apiKey: "AIza..." },
  aliases: {
    default: "anthropic/claude-sonnet-4-6",
    fast: "anthropic/claude-haiku-4-5",
    smart: "anthropic/claude-opus-4-6",
  },
  defaults: {
    temperature: 0.7,
    max_tokens: 4096,
    retries: 2,
    timeout: 120,
  },
});

// Use aliases as model names
const response = await client.chat.completions.create({
  model: "fast",
  messages: [{ role: "user", content: "Quick answer" }],
});
```

A config file (`anymodel.config.json`) is also supported for project-level and global configuration. See [Advanced Usage](docs/ADVANCED.md) for config file format and resolution order.

## Built-in Resilience

- **Retries**: Automatic retry with exponential backoff on 429/502/503 errors (configurable via `defaults.retries`)
- **Rate limit tracking**: Per-provider rate limit state from response headers, automatically skips rate-limited providers during fallback routing
- **Adaptive concurrency**: Auto mode discovers your provider's actual rate limit ceiling using TCP-style slow-start + AIMD, reading `x-ratelimit-remaining-requests` headers proactively
- **Parameter translation**: `max_tokens` automatically sent as `max_completion_tokens` for newer OpenAI models (gpt-4o, o1, o3, gpt-5-mini). Unsupported parameters stripped before forwarding.
- **Smart batch defaults**: Automatic `max_tokens` estimation per-request in batches. Calculates safe values from input size and model context limits, preventing truncation and overflow without manual tuning.
- **Memory-efficient batching**: Concurrent batch requests are streamed from disk. Only N requests (default 5) are in-flight at a time, making 10K+ request batches safe without memory spikes.
- **High-volume IO**: All batch file operations use concurrency-limited async queues with atomic durable writes (temp file + fsync + rename) to prevent corruption on crash.

## Advanced Usage

See [Advanced Usage](docs/ADVANCED.md) for tool calling, structured output, BatchBuilder, adaptive concurrency, custom providers, transforms, provider preferences, generation stats, auto pricing, server endpoints, and more.

## See Also

| Package | Description |
|---|---|
| [anymodel-py](https://github.com/probeo-io/anymodel-py) | Python version of this package |
| [anymodel-go](https://github.com/probeo-io/anymodel-go) | Go version of this package |
| [@probeo/anyserp](https://github.com/probeo-io/anyserp) | Unified SERP API router for TypeScript |
| [@probeo/workflow](https://github.com/probeo-io/workflow) | Stage-based pipeline engine for TypeScript |

## Support

If anymodel is useful to you, consider giving it a star. It helps others discover the project.

## License

MIT
