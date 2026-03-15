# Story: Anthropic Native Batch

**ID:** NB-103

As a developer, I want batch requests to Anthropic models to use the Message Batches API so that I get server-side processing and higher throughput.

## Acceptance Criteria

- Requests are translated to Anthropic format (system extraction, tool mapping)
- Batch is created via `POST /v1/messages/batches`
- Polling checks `/v1/messages/batches/{id}` at configurable interval
- Results are streamed from `/v1/messages/batches/{id}/results` as JSONL
- Each result is translated from Anthropic message format to unified `ChatCompletion`
- Failed individual requests are captured with error details
- Provider batch ID is persisted to `provider.json`
- Batch can be cancelled via `POST /v1/messages/batches/{id}/cancel`
