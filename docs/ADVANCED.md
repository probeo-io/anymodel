# Advanced Usage

This document covers advanced features of `@probeo/anymodel`. For installation, quick start, and core usage, see the [README](../README.md).

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

## Batch Processing (Advanced)

### Submit now, check later

Submit a batch and get back an ID immediately. No need to keep the process running for native batches (OpenAI, Anthropic, Google):

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

// Check status any time, even after a process restart
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

### BatchBuilder API

An ergonomic interface for building batches. Just pass strings, and anymodel handles IDs, system prompt injection, and provider-specific formatting:

```typescript
const batch = client.batches.open({
  model: "anthropic/claude-sonnet-4-6",
  system: "You are an expert.",
});

batch.add("What is an LLC?");
batch.add("How do I dissolve an LLC?");

await batch.submit();
const results = await batch.poll();

console.log(results.succeeded); // successful responses with per-item costs
console.log(results.failed);    // failed items
console.log(results.usage);     // aggregate usage and estimated_cost

// Retry failed items
const retryBatch = batch.retry(results.failed);
await retryBatch.submit();
const retryResults = await retryBatch.poll();
```

### Batch mode

Force concurrent execution instead of native batch APIs (useful when you want flex pricing on individual requests):

```typescript
const results = await client.batches.createAndPoll({
  model: "openai/gpt-4o",
  batch_mode: "concurrent", // skip native batch, run as individual requests
  requests: [
    { custom_id: "req-1", messages: [{ role: "user", content: "Hello" }] },
  ],
});
```

### Service tier on batch requests

Use flex pricing on concurrent batches for 50% cost savings:

```typescript
const results = await client.batches.createAndPoll({
  model: "openai/gpt-4o",
  batch_mode: "concurrent",
  service_tier: "flex", // flex pricing on each concurrent request
  requests: [
    { custom_id: "req-1", messages: [{ role: "user", content: "Hello" }] },
  ],
});
```

### Poll logging

Enable console logging during batch polling to monitor progress:

```typescript
// Per-call option
const results = await client.batches.createAndPoll(request, {
  logToConsole: true,
});

// Or enable globally via environment variable
// ANYMODEL_BATCH_POLL_LOG=1
```

### Adaptive Concurrency

For concurrent batches, anymodel can automatically discover your provider's rate limit ceiling instead of using a fixed concurrency:

```typescript
const client = new AnyModel({
  batch: {
    concurrencyFallback: "auto",
  },
});
```

This uses TCP-style slow-start (exponential ramp: 5 -> 10 -> 20 -> 40 -> ...) to quickly find your ceiling, then switches to AIMD (additive increase / multiplicative decrease) for fine-tuning. It reads `x-ratelimit-remaining-requests` headers proactively and backs off on 429s. An OpenAI Tier 4 account at 10,000 RPM will ramp to ~160 concurrent in about 155 requests instead of being stuck at 5.

Use `concurrencyMax` to set a hard ceiling. This is useful when multiple batch jobs share the same API key:

```typescript
const client = new AnyModel({
  batch: {
    concurrencyFallback: "auto",
    concurrencyMax: 50, // each job caps at 50, two jobs = 100 total
  },
});
```

### Batch configuration

```typescript
const client = new AnyModel({
  batch: {
    pollInterval: 10000, // default poll interval in ms (default: 5000)
    concurrencyFallback: 10, // concurrent request limit for non-native providers (default: 5)
    // concurrencyFallback: "auto", // or auto-discover from provider rate limits
    // concurrencyMax: 50,          // hard ceiling for auto mode
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

When `max_tokens` isn't set on a batch request, anymodel automatically calculates a safe value per-request based on the estimated input size and the model's context window. This prevents truncated responses and context overflow errors without requiring you to hand-tune each request in a large batch. The estimation uses a ~4 chars/token heuristic with a 5% safety margin. Conservative enough to avoid overflows, lightweight enough to skip tokenizer dependencies.

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
console.log(stats.total_cost); // auto-calculated from bundled pricing data
```

### Auto Pricing / Cost Calculation

Pricing for 323 models is baked in at build time from OpenRouter. Always current as of last publish. Costs are calculated automatically from token usage with no configuration needed.

```typescript
// Per-request cost on GenerationStats
const stats = client.generation.get(response.id);
console.log(stats.total_cost); // e.g. 0.0023

// Batch-level cost on BatchUsageSummary
const results = await client.batches.createAndPoll(request);
console.log(results.usage.estimated_cost); // total across all requests

// Native batch pricing is automatically 50% off
// Utility functions also exported
import { getModelPricing, calculateCost, PRICING_AS_OF, PRICING_MODEL_COUNT } from "@probeo/anymodel";
```

## Config File

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

## Server Endpoints

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

See [`examples/basic.ts`](../examples/basic.ts) for runnable demos of completions, streaming, tool calling, fallback routing, batch processing, and generation stats.

```bash
# Run all examples
npx tsx examples/basic.ts

# Run a specific example
npx tsx examples/basic.ts stream
npx tsx examples/basic.ts tools
npx tsx examples/basic.ts batch
```

## Roadmap

- [ ] **A/B testing**: Split routing (% traffic to each model) and compare mode (same request to multiple models, return all responses with stats)
- [x] **Cost tracking**: Per-request and aggregate cost calculation from bundled pricing data (323 models from OpenRouter)
- [ ] **Caching**: Response caching with configurable TTL for identical requests
- [x] **Native batch APIs**: OpenAI Batch API (JSONL upload, 50% cost), Anthropic Message Batches (10K requests, async), and Google Gemini Batch (50% cost). Auto-detects provider and routes to native API, falls back to concurrent for other providers.
- [x] **Adaptive concurrency**: Auto-discover provider rate limit ceilings via TCP slow-start + AIMD, with hard cap support for multi-job workloads
- [ ] **Result export**: `saveResults()` to write batch results to a configurable output directory
- [ ] **Prompt logging**: Optional request/response logging for debugging and evaluation
