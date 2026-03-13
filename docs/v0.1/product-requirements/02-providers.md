# Provider Adapters

## Overview

Each provider adapter translates between the OpenAI-compatible format and the provider's native API. Adapters handle request translation, response normalization, auth, error mapping, and model discovery.

## Requirements

### Adapter Interface

Every adapter must implement:

```typescript
interface ProviderAdapter {
  name: string;                                          // e.g. "anthropic"
  translateRequest(request: ChatRequest): ProviderRequest;
  translateResponse(response: ProviderResponse): ChatCompletion;
  translateStream(stream: ProviderStream): AsyncIterable<ChatCompletionChunk>;
  translateError(error: ProviderError): AnyModelError;
  listModels(): Promise<ModelInfo[]>;
  supportsParameter(param: string): boolean;             // for require_parameters routing
}
```

### Provider: Anthropic (Claude)

- Maps `messages` to Anthropic format (system message extracted to top-level `system`)
- Maps `tools` to Anthropic tool format
- Maps `max_tokens` (required in Anthropic, optional in OpenAI — adapter provides default)
- Maps `response_format: { type: "json_object" }` to appropriate Anthropic handling
- Maps `top_k` directly (Anthropic supports natively)
- Streaming maps Anthropic SSE events (`content_block_delta`, `message_delta`) to OpenAI delta chunks
- Supports native batch via Message Batches API

### Provider: OpenAI

- Pass-through — request/response already in the right format
- Still goes through adapter for consistent error handling, logging, and `gen-` ID prefixing
- Supports native batch via Batch API (JSONL upload)

### Provider: Google (Gemini)

- Maps `messages` to Gemini `contents` format
- Maps `tools` to Gemini function declarations
- Maps streaming format (Gemini SSE → OpenAI delta chunks)
- No native batch — falls back to concurrent execution

### Provider: Custom OpenAI-Compatible

- Any endpoint that speaks the OpenAI API format (Groq, Together, Mistral, local models via Ollama/vLLM)
- Configure with `baseURL` — adapter handles it as pass-through like OpenAI
- Automatically discovered via config

### Provider: Additional (v2)

- Amazon Bedrock (uses AWS SDK auth)
- Dedicated Mistral adapter (for Mistral-specific features)

### Error Normalization

All provider errors map to a standard shape matching OpenRouter's format:

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

Error code mapping per provider:

| Provider Error | Mapped Code | Type |
|---|---|---|
| 401/403 | 401 | Invalid API key |
| 429 | 429 | Rate limit |
| 400 | 400 | Invalid request |
| 500/502/503 | 502 | Provider unavailable |
| Timeout | 408 | Request timeout |
| Context too long | 400 | Invalid request |

### Rate Limiting & Retries

- Per-provider rate limit tracking (reads `Retry-After`, `x-ratelimit-*` headers)
- Automatic retry with exponential backoff on 429s and 5xx
- Configurable max retries and initial backoff per provider
- If `models` fallback array provided, moves to next model on failure instead of retrying

### Provider Routing

When `provider` preferences are set in the request:

1. **`provider.order`** — try providers in this order
2. **`provider.only`** — restrict to these providers
3. **`provider.ignore`** — exclude these providers
4. **`provider.allow_fallbacks`** — if false, fail rather than trying alternate providers
5. **`provider.require_parameters`** — only route to providers that support all requested params
6. **`provider.sort`** — `"price"`, `"throughput"`, `"latency"` (requires provider metrics tracking)

When `models` array + `route: "fallback"` is set:
- Try models in order
- On failure (error, timeout), try next model
- Return result from first successful model
- Response `model` field reflects which model actually served the request

### Supported Parameters Discovery

Each adapter reports which parameters it supports via `supportsParameter()`. This powers:
- `supported_parameters` in the models list endpoint
- `require_parameters` routing filter
- Parameter stripping (remove unsupported params before forwarding to avoid provider errors)
