# PRD: Native Batch API Support

## Overview

Replace client-side concurrent request batching with native server-side batch APIs from OpenAI and Anthropic. This delivers 50% cost reduction (OpenAI), higher throughput, and eliminates client-side connection management. Providers without native batch support fall back to concurrent execution.

## Background

Current batch implementation (`v0.2`) sends requests concurrently from the client with a configurable concurrency limit. This works but:
- No cost savings — full per-request pricing
- Client manages all connections and retries
- Rate limits apply per-request
- Client must stay running for the duration

Native batch APIs solve all of these:
- **OpenAI Batch API**: Upload JSONL, 50% cost, 24hr window, separate rate limits
- **Anthropic Message Batches**: Submit up to 10K requests, async processing, reduced pricing

## Provider APIs

### OpenAI Batch API

1. Upload JSONL file → `POST /v1/files` (purpose: "batch")
2. Create batch → `POST /v1/batches` (input_file_id, endpoint, completion_window)
3. Poll → `GET /v1/batches/{id}` (status: validating → in_progress → completed/failed/expired/cancelled)
4. Download results → `GET /v1/files/{output_file_id}/content`
5. Cancel → `POST /v1/batches/{id}/cancel`

**JSONL request format:**
```json
{"custom_id": "req-1", "method": "POST", "url": "/v1/chat/completions", "body": {"model": "gpt-4o", "messages": [...]}}
```

**JSONL response format:**
```json
{"id": "batch_req_xxx", "custom_id": "req-1", "response": {"status_code": 200, "body": {...}}, "error": null}
```

### Anthropic Message Batches API

1. Create batch → `POST /v1/messages/batches` (requests array with custom_id + params)
2. Poll → `GET /v1/messages/batches/{id}` (processing_status: in_progress → ended)
3. Get results → `GET /v1/messages/batches/{id}/results` (JSONL stream)
4. Cancel → `POST /v1/messages/batches/{id}/cancel`

**Request format:**
```json
{"custom_id": "req-1", "params": {"model": "claude-haiku-4-5", "max_tokens": 1024, "messages": [...]}}
```

**Result format (JSONL):**
```json
{"custom_id": "req-1", "result": {"type": "succeeded", "message": {...}}}
```

## Requirements

### R1: Provider Detection
- `BatchManager.create()` detects the provider from the model string
- If provider has native batch support, use it
- If not, fall back to concurrent execution (existing behavior)
- `batch_mode` field in `BatchObject` reflects which path was taken: `"native"` or `"concurrent"`

### R2: OpenAI Native Batch
- Upload requests as JSONL to OpenAI Files API
- Create batch via OpenAI Batches API with `completion_window: "24h"`
- Poll OpenAI batch status at configurable interval
- Download and parse output JSONL when complete
- Translate OpenAI batch results to unified `BatchResultItem` format
- Store provider batch ID and file IDs in `provider.json` for resumability
- Support cancellation via OpenAI cancel endpoint

### R3: Anthropic Native Batch
- Submit requests to Anthropic Message Batches API
- Translate unified request format to Anthropic params format (system extraction, tool mapping, etc.)
- Poll batch status at configurable interval
- Download JSONL results stream when ended
- Translate Anthropic message responses to unified `ChatCompletion` format
- Store provider batch ID in `provider.json` for resumability
- Support cancellation

### R4: Unified Interface
- `client.batches.create()` and `client.batches.createAndPoll()` work identically regardless of native vs concurrent
- Same `BatchObject`, `BatchResults`, `BatchResultItem` types
- Same `onProgress` callback behavior
- Same disk persistence in `~/.anymodel/batches/`
- `poll()` and resume work across process restarts for native batches

### R5: Polling & Resumability
- Native batches persist provider batch ID to disk
- `client.batches.poll(id)` reconnects to provider API using stored provider batch ID
- Works after process restart — no state lost
- Progress callback reports provider-side counts when available

### R6: Error Handling
- Individual request failures within a batch are captured per-item
- Batch-level failures (expired, cancelled) set batch status accordingly
- OpenAI expired batches (past 24hr window) handled gracefully
- Provider API errors during upload/create surface as `AnyModelError`

### R7: Cost Tracking (Metadata)
- `BatchObject` includes `batch_mode` so callers know if they got native pricing
- Usage summary aggregates tokens from all results
