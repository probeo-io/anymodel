# @probeo/anymodel

OpenRouter-compatible LLM router with unified batch support. Self-hosted, zero fees.

Route requests across OpenAI, Anthropic, and Google with a single API. Add any OpenAI-compatible provider. Run as an SDK or standalone HTTP server.

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

Ollama runs locally with no API key — just set `OLLAMA_BASE_URL` (defaults to `http://localhost:11434/v1`).

## Model Naming

Models use `provider/model` format:

```
anthropic/claude-sonnet-4-6
openai/gpt-4o
google/gemini-2.5-pro
mistral/mistral-large-latest
groq/llama-3.3-70b-versatile
deepseek/deepseek-chat
xai/grok-3
perplexity/sonar-pro
ollama/llama3.3
```

### Flex Pricing (OpenAI)

Get 50% off OpenAI requests with flexible latency:

```typescript
const response = await client.chat.completions.create({
  model: "openai/gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
  service_tier: "flex",
});
```

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

## Tool Calling

Works across all providers with a unified interface:

```typescript
const response = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4-6",
  messages: [{ role: "user", content: "What's the weather in NYC?" }],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather for a location",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" },
          },
          required: ["location"],
        },
      },
    },
  ],
  tool_choice: "auto",
});

if (response.choices[0].message.tool_calls) {
  for (const call of response.choices[0].message.tool_calls) {
    console.log(call.function.name, call.function.arguments);
  }
}
```

## Structured Output

```typescript
const response = await client.chat.completions.create({
  model: "openai/gpt-4o",
  messages: [{ role: "user", content: "List 3 colors" }],
  response_format: { type: "json_object" },
});
```

## Batch Processing

Process many requests with native provider batch APIs or concurrent fallback. OpenAI, Anthropic, and Google batches are processed server-side — OpenAI at 50% cost, Anthropic with async processing for up to 10K requests, Google at 50% cost via `batchGenerateContent`. Other providers fall back to concurrent execution automatically.

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

### Submit now, check later

Submit a batch and get back an ID immediately — no need to keep the process running for native batches (OpenAI, Anthropic, Google):

```typescript
// Submit and get the batch ID
const batch = await client.batches.create({
  model: "anthropic/claude-haiku-4-5",
  requests: [
    { custom_id: "req-1", messages: [{ role: "user", content: "Summarize AI" }] },
    { custom_id: "req-2", messages: [{ role: "user", content: "Summarize ML" }] },
  ],
});
console.log(batch.id); // "batch-abc123"
console.log(batch.batch_mode); // "native" or "concurrent"

// Check status any time — even after a process restart
const status = client.batches.get("batch-abc123");
console.log(status.status); // "pending", "processing", "completed", "failed"

// Wait for results when you're ready (reconnects to provider API)
const results = await client.batches.poll("batch-abc123");

// Or get results directly if already completed
const results = client.batches.results("batch-abc123");
```

### List and cancel

```typescript
// List all batches on disk
const all = client.batches.list();
for (const b of all) {
  console.log(b.id, b.batch_mode, b.status, b.provider_name);
}

// Cancel a running batch (also cancels at the provider for native batches)
await client.batches.cancel("batch-abc123");
```

### Batch configuration

```typescript
const client = new AnyModel({
  batch: {
    pollInterval: 10000, // default poll interval in ms (default: 5000)
    concurrencyFallback: 10, // concurrent request limit for non-native providers (default: 5)
  },
  io: {
    readConcurrency: 30, // concurrent file reads (default: 20)
    writeConcurrency: 15, // concurrent file writes (default: 10)
  },
});

// Override poll interval per call
const results = await client.batches.createAndPoll(request, {
  interval: 3000, // poll every 3s for this batch
  onProgress: (batch) => {
    console.log(`${batch.completed}/${batch.total} done`);
  },
});
```

Batches are persisted to `./.anymodel/batches/` in the current working directory and survive process restarts.

### Automatic max_tokens

When `max_tokens` isn't set on a batch request, anymodel automatically calculates a safe value per-request based on the estimated input size and the model's context window. This prevents truncated responses and context overflow errors without requiring you to hand-tune each request in a large batch. The estimation uses a ~4 chars/token heuristic with a 5% safety margin — conservative enough to avoid overflows, lightweight enough to skip tokenizer dependencies.

## Models Endpoint

```typescript
const models = await client.models.list();
const anthropicModels = await client.models.list({ provider: "anthropic" });
```

## Generation Stats

```typescript
const response = await client.chat.completions.create({ ... });
const stats = client.generation.get(response.id);
console.log(stats.latency, stats.tokens_prompt, stats.tokens_completion);
```

## Configuration

### Programmatic

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
    timeout: 120, // HTTP timeout in seconds (default: 120 = 2 min, flex: 600 = 10 min)
  },
});

// Use aliases as model names
const response = await client.chat.completions.create({
  model: "fast",
  messages: [{ role: "user", content: "Quick answer" }],
});
```

### Config File

Create `anymodel.config.json` in your project root:

```json
{
  "anthropic": {
    "apiKey": "${ANTHROPIC_API_KEY}"
  },
  "aliases": {
    "default": "anthropic/claude-sonnet-4-6",
    "fast": "anthropic/claude-haiku-4-5"
  },
  "defaults": {
    "temperature": 0.7,
    "max_tokens": 4096
  },
  "batch": {
    "pollInterval": 5000,
    "concurrencyFallback": 5
  },
  "io": {
    "readConcurrency": 20,
    "writeConcurrency": 10
  }
}
```

`${ENV_VAR}` references are interpolated from environment variables.

### Config Resolution Order

1. Programmatic options (highest priority)
2. Local `anymodel.config.json`
3. Global `~/.anymodel/config.json`
4. Environment variables (lowest priority)

Configs are deep-merged, not replaced.

## Custom Providers

Add any OpenAI-compatible endpoint:

```typescript
const client = new AnyModel({
  custom: {
    ollama: {
      baseURL: "http://localhost:11434/v1",
      models: ["llama3.3", "mistral"],
    },
    together: {
      baseURL: "https://api.together.xyz/v1",
      apiKey: "your-key",
    },
  },
});

const response = await client.chat.completions.create({
  model: "ollama/llama3.3",
  messages: [{ role: "user", content: "Hello from Ollama" }],
});
```

## Provider Preferences

Control which providers are used and in what order:

```typescript
const response = await client.chat.completions.create({
  model: "",
  models: ["anthropic/claude-sonnet-4-6", "openai/gpt-4o", "google/gemini-2.5-pro"],
  route: "fallback",
  provider: {
    order: ["anthropic", "openai"],
    ignore: ["google"],
  },
  messages: [{ role: "user", content: "Hello" }],
});
```

## Transforms

Automatically truncate long conversations to fit within context windows:

```typescript
const response = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4-6",
  messages: veryLongConversation,
  transforms: ["middle-out"],
});
```

`middle-out` preserves the system prompt and most recent messages, removing from the middle.

## Server Mode

Run as a standalone HTTP server compatible with the OpenAI SDK:

```bash
npx anymodel serve --port 4141
```

Then point any OpenAI-compatible client at it:

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:4141/api/v1",
  apiKey: "unused",
});

const response = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4-6",
  messages: [{ role: "user", content: "Hello via server" }],
});
```

### Server Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/chat/completions` | Chat completion (streaming supported) |
| GET | `/api/v1/models` | List available models |
| GET | `/api/v1/generation/:id` | Get generation stats |
| POST | `/api/v1/batches` | Create a batch |
| GET | `/api/v1/batches` | List batches |
| GET | `/api/v1/batches/:id` | Get batch status |
| GET | `/api/v1/batches/:id/results` | Get batch results |
| POST | `/api/v1/batches/:id/cancel` | Cancel a batch |
| GET | `/health` | Health check |

## Examples

See [`examples/basic.ts`](examples/basic.ts) for runnable demos of completions, streaming, tool calling, fallback routing, batch processing, and generation stats.

```bash
# Run all examples
npx tsx examples/basic.ts

# Run a specific example
npx tsx examples/basic.ts stream
npx tsx examples/basic.ts tools
npx tsx examples/basic.ts batch
```

## Built-in Resilience

- **Retries**: Automatic retry with exponential backoff on 429/502/503 errors (configurable via `defaults.retries`)
- **Rate limit tracking**: Per-provider rate limit state, automatically skips rate-limited providers during fallback routing
- **Parameter stripping**: Unsupported parameters are automatically removed before forwarding to providers
- **Smart batch defaults**: Automatic `max_tokens` estimation per-request in batches — calculates safe values from input size and model context limits, preventing truncation and overflow without manual tuning
- **Memory-efficient batching**: Concurrent batch requests are streamed from disk — only N requests (default 5) are in-flight at a time, making 10K+ request batches safe without memory spikes
- **High-volume IO**: All batch file operations use concurrency-limited async queues with atomic durable writes (temp file + fsync + rename) to prevent corruption on crash. Defaults: 20 concurrent reads, 10 concurrent writes — configurable via `io.readConcurrency` and `io.writeConcurrency`

## Roadmap

- [ ] **A/B testing** — split routing (% traffic to each model) and compare mode (same request to multiple models, return all responses with stats)
- [ ] **Cost tracking** — per-request and aggregate cost calculation from provider pricing
- [ ] **Caching** — response caching with configurable TTL for identical requests
- [x] **Native batch APIs** — OpenAI Batch API (JSONL upload, 50% cost), Anthropic Message Batches (10K requests, async), and Google Gemini Batch (50% cost). Auto-detects provider and routes to native API, falls back to concurrent for other providers
- [ ] **Result export** — `saveResults()` to write batch results to a configurable output directory
- [ ] **Prompt logging** — optional request/response logging for debugging and evaluation

## Also Available

- **Python**: [`anymodel-py`](https://github.com/probeo-io/anymodel-py) on PyPI
- **Go**: [`anymodel-go`](https://github.com/probeo-io/anymodel-go)

## License

MIT
