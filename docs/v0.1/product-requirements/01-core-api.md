# Core API Surface

## Overview

OpenRouter-compatible API surface that routes to any LLM provider. Same `provider/model` naming, same request/response shapes, same streaming format. Drop-in replacement — point the OpenAI SDK or any OpenRouter client at it and it works.

**Key difference from OpenRouter:** self-hosted, no transaction fee, native batch support.

## Requirements

### Chat Completions

`POST /chat/completions`

#### Request Body

**Standard OpenAI-compatible parameters:**

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `model` | string | Yes | `provider/model` format, e.g. `anthropic/claude-sonnet-4-6` |
| `messages` | Message[] | Yes | Standard role/content message objects |
| `max_tokens` | integer | No | Output token limit |
| `temperature` | float | No | 0.0–2.0 |
| `top_p` | float | No | 0.0–1.0 |
| `top_k` | integer | No | Token selection restriction |
| `frequency_penalty` | float | No | -2.0 to 2.0 |
| `presence_penalty` | float | No | -2.0 to 2.0 |
| `repetition_penalty` | float | No | 0.0–2.0 |
| `seed` | integer | No | Deterministic sampling |
| `stop` | string or string[] | No | Up to 4 stop sequences |
| `stream` | boolean | No | Enable SSE streaming |
| `logprobs` | boolean | No | Return log probabilities |
| `top_logprobs` | integer | No | 0–20, requires logprobs=true |
| `response_format` | object | No | `{ type: "text" \| "json_object" \| "json_schema" }` |
| `tools` | Tool[] | No | OpenAI-compatible function definitions |
| `tool_choice` | string or object | No | `"none"`, `"auto"`, `"required"`, or named |
| `user` | string | No | Unique user identifier |

**Anymodel-specific parameters (mirrors OpenRouter):**

| Parameter | Type | Description |
|---|---|---|
| `models` | string[] | Fallback model list — tries in order |
| `route` | string | `"fallback"` — used with `models` array |
| `transforms` | string[] | `["middle-out"]` — truncates middle messages to fit context |
| `provider` | ProviderPreferences | Routing/provider preferences (see below) |

#### ProviderPreferences Object

| Field | Type | Description |
|---|---|---|
| `order` | string[] | Ordered list of provider slugs to try |
| `only` | string[] | Allowlist of providers |
| `ignore` | string[] | Blocklist of providers |
| `allow_fallbacks` | boolean | Use backup providers if primary unavailable (default: true) |
| `require_parameters` | boolean | Only route to providers supporting all params in request |
| `sort` | string | `"price"`, `"throughput"`, `"latency"` |

#### Response Format

```json
{
  "id": "gen-abc123",
  "object": "chat.completion",
  "created": 1710300000,
  "model": "anthropic/claude-sonnet-4-6",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150
  }
}
```

- `id` uses `gen-` prefix (matches OpenRouter convention)
- `model` reflects actual model used (may differ from request if fallback triggered)
- `finish_reason`: `"stop"`, `"length"`, `"tool_calls"`, `"content_filter"`, `"error"`

### Streaming

SSE format, OpenAI-compatible chunks:

```
data: {"id":"gen-xxx","object":"chat.completion.chunk","created":1710300000,"model":"anthropic/claude-sonnet-4-6","choices":[{"index":0,"delta":{"content":"token"},"finish_reason":null}]}

data: {"id":"gen-xxx","object":"chat.completion.chunk","created":1710300000,"model":"anthropic/claude-sonnet-4-6","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}

data: [DONE]
```

- Keepalive comments during processing: `: ANYMODEL PROCESSING`
- `usage` included in final chunk only
- Mid-stream errors: HTTP 200, error in chunk with `finish_reason: "error"`

### Generation Stats

`GET /generation?id=gen-xxx`

Returns cost and usage details after a request completes:

```json
{
  "id": "gen-xxx",
  "model": "anthropic/claude-sonnet-4-6",
  "provider_name": "anthropic",
  "total_cost": 0.0042,
  "tokens_prompt": 100,
  "tokens_completion": 50,
  "latency": 1250,
  "generation_time": 980,
  "created_at": "2026-03-13T...",
  "finish_reason": "stop",
  "streamed": false
}
```

### Model Naming

- `provider/model` format — e.g., `anthropic/claude-sonnet-4-6`, `openai/gpt-4o`, `google/gemini-2.5-pro`
- Aliasing supported — e.g., `default` → `anthropic/claude-sonnet-4-6`
- Model list endpoint: `GET /models`

### Models Endpoint

`GET /models`

```json
{
  "data": [
    {
      "id": "anthropic/claude-sonnet-4-6",
      "name": "Claude Sonnet 4.6",
      "created": 1710300000,
      "description": "...",
      "context_length": 200000,
      "pricing": {
        "prompt": "0.000003",
        "completion": "0.000015"
      },
      "architecture": {
        "modality": "text+image->text",
        "input_modalities": ["text", "image"],
        "output_modalities": ["text"],
        "tokenizer": "claude"
      },
      "top_provider": {
        "context_length": 200000,
        "max_completion_tokens": 8192,
        "is_moderated": false
      },
      "supported_parameters": ["temperature", "top_p", "tools", "stream", "response_format"]
    }
  ]
}
```

Pricing values are strings representing cost per token (matches OpenRouter convention).

### Authentication

- Provider API keys configured via environment variables or config file
- In server mode, optional `ANYMODEL_SERVER_KEY` — clients pass as `Authorization: Bearer <key>`
- If no server key set, server is open (local/Docker use)

### Error Format

```json
{
  "error": {
    "code": 429,
    "message": "Rate limit exceeded",
    "metadata": {
      "provider_name": "anthropic",
      "raw": { ... }
    }
  }
}
```

| Code | Meaning |
|---|---|
| 400 | Invalid/missing parameters |
| 401 | Invalid API key |
| 408 | Request timeout |
| 422 | Unprocessable entity |
| 429 | Rate limit exceeded |
| 500 | Internal server error |
| 502 | Provider unavailable |
| 503 | No provider meets routing requirements |

### SDK (TypeScript)

```typescript
import { AnyModel } from '@probeo/anymodel';

const client = new AnyModel({
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY },
});

// Basic
const response = await client.chat.completions.create({
  model: 'anthropic/claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello' }],
});

// With fallbacks
const response = await client.chat.completions.create({
  models: ['anthropic/claude-sonnet-4-6', 'openai/gpt-4o'],
  route: 'fallback',
  messages: [{ role: 'user', content: 'Hello' }],
});

// Streaming
const stream = await client.chat.completions.create({
  model: 'anthropic/claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}

// Generation stats
const stats = await client.generation.get('gen-xxx');
console.log(stats.total_cost);
```

## Non-Goals

- No embeddings endpoint (v1)
- No image generation
- No fine-tuning
- No assistants/responses API
- No hosted service — self-hosted only
