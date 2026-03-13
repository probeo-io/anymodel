# Server Mode

## Overview

Optional HTTP server that exposes the anymodel API as a local or hosted service. Acts as a drop-in proxy — point any OpenAI SDK or OpenRouter-compatible client at it and it routes to any configured provider. Zero transaction fees.

## Requirements

### Server

- `npx @probeo/anymodel serve` — starts HTTP server
- Default port 4141, configurable via `--port` or `ANYMODEL_PORT`
- Base path: `/api/v1` (matches OpenRouter's base path)

### Endpoints Served

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/chat/completions` | Chat completions |
| `GET` | `/api/v1/models` | List available models |
| `GET` | `/api/v1/models/:provider/:model/endpoints` | Provider endpoints for a model |
| `GET` | `/api/v1/generation` | Generation stats (by `?id=gen-xxx`) |
| `POST` | `/api/v1/batches` | Submit batch |
| `GET` | `/api/v1/batches/:id` | Batch status |
| `GET` | `/api/v1/batches/:id/results` | Batch results |
| `DELETE` | `/api/v1/batches/:id` | Cancel batch |
| `GET` | `/api/v1/batches` | List batches |

### OpenAI SDK Compatible

Point any OpenAI client at it:

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:4141/api/v1',
  apiKey: 'your-anymodel-server-key', // or empty string if no auth
});

const response = await client.chat.completions.create({
  model: 'anthropic/claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### Use Cases

- **Local proxy** — run on your machine, point tools at it
- **Team server** — run centrally, team shares one set of API keys
- **Docker sidecar** — run alongside your app in the same network
- **Dev/test** — swap models without changing client code

### Auth

- Optional API key for the server itself (`ANYMODEL_SERVER_KEY`)
- If set, clients must pass `Authorization: Bearer <key>`
- If not set, server is open (for local/Docker use)

### Logging

Configurable via `--log` flag or `ANYMODEL_LOG_LEVEL`:

| Level | Output |
|---|---|
| `off` | No logging |
| `summary` | Model, tokens, cost, latency per request (default) |
| `full` | Request/response bodies included |

### Generation Stats

Every request generates a `gen-xxx` ID. Query stats after the fact:

```bash
curl http://localhost:4141/api/v1/generation?id=gen-abc123
```

Returns: model used, provider, token counts, cost, latency — same as OpenRouter's `/generation` endpoint.

### CLI Options

```
npx @probeo/anymodel serve [options]

Options:
  --port <number>     Port to listen on (default: 4141)
  --host <string>     Host to bind to (default: 0.0.0.0)
  --config <path>     Path to config file
  --log <level>       Log level: off, summary, full (default: summary)
```

## Non-Goals

- Not a production hosted service (v1) — self-hosted only
- No multi-tenant auth
- No billing/metering
- No usage dashboard (use generation stats endpoint + your own tooling)
