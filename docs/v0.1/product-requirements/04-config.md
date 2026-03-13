# Configuration

## Overview

Provider credentials, model aliases, defaults, and routing rules. Configuration via environment variables, config file, or programmatic setup. Mirrors OpenRouter's model naming and routing conventions.

## Requirements

### Environment Variables

Standard provider keys — no prefix required:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AIza...
```

Server-specific:

```bash
ANYMODEL_PORT=4141
ANYMODEL_SERVER_KEY=sk-anymodel-...
ANYMODEL_LOG_LEVEL=summary
```

### Config File (optional)

`anymodel.config.json`, `anymodel.config.js`, or passed programmatically:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "defaultModel": "claude-sonnet-4-6"
    },
    "openai": {
      "apiKey": "${OPENAI_API_KEY}",
      "defaultModel": "gpt-4o"
    },
    "google": {
      "apiKey": "${GOOGLE_API_KEY}",
      "defaultModel": "gemini-2.5-pro"
    },
    "custom": {
      "my-ollama": {
        "baseURL": "http://localhost:11434/v1",
        "models": ["llama3", "mistral"]
      },
      "together": {
        "apiKey": "${TOGETHER_API_KEY}",
        "baseURL": "https://api.together.xyz/v1"
      }
    }
  },
  "aliases": {
    "default": "anthropic/claude-sonnet-4-6",
    "fast": "anthropic/claude-haiku-4-5",
    "smart": "anthropic/claude-opus-4-6",
    "cheap": "openai/gpt-4o-mini"
  },
  "defaults": {
    "temperature": 0.3,
    "max_tokens": 4096,
    "retries": 3,
    "timeout": 120000
  },
  "routing": {
    "fallback_order": ["anthropic", "openai", "google"],
    "allow_fallbacks": true
  },
  "batch": {
    "pollInterval": 30000,
    "concurrencyFallback": 10
  }
}
```

### Custom OpenAI-Compatible Providers

Any endpoint that speaks OpenAI's API format can be added under `providers.custom`:

```json
{
  "providers": {
    "custom": {
      "groq": {
        "apiKey": "${GROQ_API_KEY}",
        "baseURL": "https://api.groq.com/openai/v1"
      }
    }
  }
}
```

Referenced as `groq/llama-3.3-70b` in requests. The adapter auto-detects available models via `GET /models` on the custom endpoint.

### Programmatic Setup

```typescript
import { AnyModel } from '@probeo/anymodel';

const client = new AnyModel({
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY },
  aliases: {
    default: 'anthropic/claude-sonnet-4-6'
  },
  defaults: {
    temperature: 0.3
  }
});
```

Minimal — just pass the keys you need:

```typescript
const client = new AnyModel({
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY }
});
```

### Model Discovery

`GET /models` returns all available models across configured providers:

```typescript
const models = await client.models.list();
const anthropicModels = await client.models.list({ provider: 'anthropic' });
```

Response includes per-model metadata matching OpenRouter's format:
- `id` — `provider/model` format
- `name` — human-readable name
- `context_length` — max context window
- `pricing.prompt` — cost per token (string)
- `pricing.completion` — cost per token (string)
- `architecture` — modality, tokenizer, input/output types
- `supported_parameters` — which params this model accepts
- `top_provider.max_completion_tokens` — max output tokens

### Transforms

Mirrors OpenRouter's `transforms` parameter:

- `"middle-out"` — when prompt exceeds context window, truncates messages from the middle (preserves system prompt and recent messages)

Applied at the router level before forwarding to provider adapter.

### Config Resolution Order

1. Programmatic options (highest priority)
2. `anymodel.config.json` / `anymodel.config.js` in working directory
3. `~/.anymodel/config.json` (global)
4. Environment variables (lowest priority for keys, but can override anything)
