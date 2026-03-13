# Batch Processing

## Overview

Unified batch interface that normalizes batch processing across providers. This is anymodel's key differentiator over OpenRouter — OpenRouter doesn't offer batch at all. Submit a batch of prompts, get results back — same interface regardless of whether it's Claude Message Batches, OpenAI Batch API, or concurrent execution for providers without native batch.

## Requirements

### Batch API

| Method | Path | Description |
|---|---|---|
| `POST` | `/batches` | Submit a batch |
| `GET` | `/batches/:id` | Check status |
| `GET` | `/batches/:id/results` | Retrieve results |
| `DELETE` | `/batches/:id` | Cancel a batch |
| `GET` | `/batches` | List batches |

### Batch Request Format

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "requests": [
    {
      "custom_id": "page-001",
      "messages": [
        { "role": "system", "content": "You are a helpful assistant." },
        { "role": "user", "content": "Rewrite this page..." }
      ],
      "max_tokens": 4096,
      "temperature": 0.3
    },
    {
      "custom_id": "page-002",
      "messages": [...]
    }
  ],
  "options": {
    "temperature": 0.3,
    "max_tokens": 4096
  }
}
```

- `model` — required, `provider/model` format
- `requests[].custom_id` — required, caller-defined ID for matching results
- `requests[].messages` — required, standard message array
- `options` — shared options applied to all requests (per-request params override)
- Per-request params (`max_tokens`, `temperature`, etc.) override shared `options`

### Batch Response Format

```json
{
  "id": "batch_abc123",
  "object": "batch",
  "status": "pending",
  "model": "anthropic/claude-sonnet-4-6",
  "provider_name": "anthropic",
  "batch_mode": "native",
  "total": 100,
  "completed": 0,
  "failed": 0,
  "created_at": "2026-03-13T10:00:00Z",
  "completed_at": null,
  "expires_at": "2026-03-14T10:00:00Z"
}
```

- `batch_mode`: `"native"` (provider batch API, 50% discount) or `"concurrent"` (sequential fallback, full price)
- `status`: `"pending"` | `"processing"` | `"completed"` | `"failed"` | `"cancelled"`

### Batch Results Format

```json
{
  "id": "batch_abc123",
  "status": "completed",
  "results": [
    {
      "custom_id": "page-001",
      "status": "success",
      "response": {
        "id": "gen-xxx",
        "object": "chat.completion",
        "model": "anthropic/claude-sonnet-4-6",
        "choices": [...],
        "usage": { "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150 }
      },
      "error": null
    },
    {
      "custom_id": "page-002",
      "status": "error",
      "response": null,
      "error": {
        "code": 429,
        "message": "Rate limit exceeded"
      }
    }
  ],
  "usage_summary": {
    "total_prompt_tokens": 10000,
    "total_completion_tokens": 5000,
    "estimated_cost": 0.075
  }
}
```

Each result `response` is a standard `ChatCompletion` object — same shape as `/chat/completions`.

### Provider Adapters

#### Anthropic (Claude) — Native Batch

- Translates to Message Batches API (`POST /v1/messages/batches`)
- Polls for completion using configurable interval
- Maps results back to unified format
- 50% discount on input/output tokens

#### OpenAI — Native Batch

- Writes JSONL, uploads file, creates batch, polls, downloads results
- Maps results back to unified format
- 50% discount on input/output tokens

#### Google / Others — Concurrent Fallback

- Falls back to concurrent execution with configurable concurrency limit
- Same interface, same result format — full price
- `batch_mode: "concurrent"` in response so consumers know

### Polling

The SDK provides three ways to track batch progress:

#### 1. Manual polling

```typescript
const batch = await client.batches.create({
  model: 'anthropic/claude-sonnet-4-6',
  requests: [...]
});

// Poll until done
let status;
do {
  status = await client.batches.retrieve(batch.id);
  console.log(`${status.completed}/${status.total} (${status.status})`);
  if (status.status !== 'completed' && status.status !== 'failed') {
    await new Promise(r => setTimeout(r, 30_000)); // 30s default
  }
} while (status.status === 'pending' || status.status === 'processing');

const results = await client.batches.results(batch.id);
```

#### 2. Built-in poll helper

```typescript
// Polls automatically, returns when done
const results = await client.batches.createAndPoll({
  model: 'anthropic/claude-sonnet-4-6',
  requests: [...],
  options: { temperature: 0.3, max_tokens: 4096 }
}, {
  pollInterval: 30_000,   // ms between polls (default: 30s)
  timeout: 0,             // 0 = no timeout, wait indefinitely (default)
  onProgress: (status) => {
    console.log(`${status.completed}/${status.total}`);
  }
});

for (const result of results.results) {
  console.log(result.custom_id, result.response?.choices[0]?.message.content);
}
```

#### 3. Webhook

Optional `webhook` URL on batch creation — POST when batch completes/fails:

```typescript
const batch = await client.batches.create({
  model: 'anthropic/claude-sonnet-4-6',
  requests: [...],
  webhook: 'https://example.com/batch-complete'
});
```

Webhook payload:

```json
{
  "id": "batch_abc123",
  "status": "completed",
  "model": "anthropic/claude-sonnet-4-6",
  "total": 100,
  "completed": 98,
  "failed": 2,
  "results_url": "/api/v1/batches/batch_abc123/results"
}
```

### Status Transitions

```
pending → processing → completed
                     → failed
                     → cancelled (via DELETE)
```

- `pending` — batch accepted, waiting to start
- `processing` — requests are being sent to the provider
- `completed` — all requests finished (some may have individual errors)
- `failed` — batch-level failure (provider down, auth invalid, etc.)
- `cancelled` — cancelled via `DELETE /batches/:id`

During `processing`, the `completed` and `failed` counters on the batch object update as individual requests finish. This powers progress tracking.

### Persistence & Storage

Batches are long-running (minutes to hours). The process may restart, the user may disconnect, batches may run overnight. Anymodel must persist batch state to disk so nothing is lost.

#### Batch Store

All batch state is written to a local directory:

```
~/.anymodel/batches/
  batch_abc123/
    meta.json          # batch metadata (id, model, status, counts, timestamps)
    requests.jsonl     # original requests (for retry/resume)
    results.jsonl      # results written incrementally as they arrive
    provider.json      # provider-side IDs (e.g. Anthropic msgbatch_xxx, OpenAI batch_xxx)
```

Configurable via `ANYMODEL_BATCH_DIR` or config file:

```json
{
  "batch": {
    "dir": "./my-batches",
    "pollInterval": 30000,
    "concurrencyFallback": 10,
    "retentionDays": 30
  }
}
```

#### How it works

1. **On create** — `meta.json` and `requests.jsonl` are written immediately. The provider-side batch ID is saved to `provider.json`.
2. **During processing** — each completed result is appended to `results.jsonl` as it arrives. `meta.json` counters are updated.
3. **On completion** — `meta.json` is finalized with `completed_at` and final counts.
4. **On process restart** — `client.batches.list()` and `client.batches.retrieve()` read from disk. For native batches, the provider-side ID in `provider.json` is used to resume polling against the upstream API — no work is lost.

#### Output directory (SDK)

For script/CLI use, write results directly to an output directory:

```typescript
const results = await client.batches.createAndPoll({
  model: 'anthropic/claude-sonnet-4-6',
  requests: [...],
  outputDir: './output/rewrites'  // writes one JSON file per custom_id
});
// Creates:
//   ./output/rewrites/page-001.json
//   ./output/rewrites/page-002.json
//   ./output/rewrites/_batch_summary.json
```

Each output file contains the full `ChatCompletion` response for that `custom_id`. The `_batch_summary.json` contains the batch metadata and usage summary.

#### Resumability

If the process dies mid-batch:

```typescript
// List all known batches (reads from disk)
const batches = await client.batches.list();
// [{ id: "batch_abc123", status: "processing", completed: 45, total: 100 }]

// Resume polling a batch that was created in a previous process
const results = await client.batches.poll('batch_abc123', {
  onProgress: (s) => console.log(`${s.completed}/${s.total}`)
});
```

For native providers (Anthropic, OpenAI), the upstream batch keeps running regardless of whether anymodel is alive. On resume, anymodel reads `provider.json`, polls the upstream API, and picks up where it left off.

For concurrent fallback providers, incomplete requests are retried on resume.

#### Cleanup

```typescript
// Delete local batch data
await client.batches.delete('batch_abc123');

// Auto-cleanup batches older than retentionDays
// Happens on startup if configured
```

### Polling Internals (per provider)

| Provider | Native Status Field | Poll Endpoint | Results |
|---|---|---|---|
| Anthropic | `processing_status: "in_progress" \| "ended"` | `GET /v1/messages/batches/:id` | Stream from `results_url` |
| OpenAI | `status: "validating" \| "in_progress" \| "completed" \| ...` | `GET /v1/batches/:id` | Download output JSONL file |
| Others | N/A (concurrent) | Internal tracking | Written to `results.jsonl` as they complete |

The adapter normalizes all of these to the unified `status` and `completed/failed/total` counters. All providers write to the same on-disk format.

### SDK (Full Example)

```typescript
import { AnyModel } from '@probeo/anymodel';

const client = new AnyModel({
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY }
});

// Fire and forget — poll later
const batch = await client.batches.create({
  model: 'anthropic/claude-sonnet-4-6',
  requests: [
    { custom_id: 'page-001', messages: [{ role: 'user', content: '...' }] },
    { custom_id: 'page-002', messages: [{ role: 'user', content: '...' }] },
  ],
  options: { temperature: 0.3, max_tokens: 4096 }
});

console.log(batch.id);          // "batch_abc123"
console.log(batch.batch_mode);  // "native" — 50% discount

// Or: create + poll in one call
const results = await client.batches.createAndPoll({
  model: 'anthropic/claude-sonnet-4-6',
  requests: [...],
}, { pollInterval: 30_000 });

// List all batches
const batches = await client.batches.list();

// Cancel
await client.batches.cancel(batch.id);
```

### Pricing Note

Providers with native batch APIs offer 50% discounts (Anthropic, OpenAI). Providers without native batch run at full price with concurrent execution. The `batch_mode` field in responses surfaces which mode was used so consumers can make cost decisions.
