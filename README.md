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

## Model Naming

Models use `provider/model` format:

```
anthropic/claude-sonnet-4-6
anthropic/claude-opus-4-6
anthropic/claude-haiku-4-5
openai/gpt-4o
openai/o3
google/gemini-2.5-pro
google/gemini-2.5-flash
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

Process many requests concurrently with disk persistence:

```typescript
const results = await client.batches.createAndPoll({
  model: "anthropic/claude-haiku-4-5",
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

Batches are persisted to `~/.anymodel/batches/` and survive process restarts. Resume polling a batch by ID:

```typescript
const batch = await client.batches.create(request);
// ... later, even after restart ...
const results = await client.batches.poll(batch.id);
```

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

## License

MIT
