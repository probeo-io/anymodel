# Story: OpenAI Native Batch

**ID:** NB-102

As a developer, I want batch requests to OpenAI models to use the native Batch API so that I get 50% cost reduction and server-side processing.

## Acceptance Criteria

- Requests are formatted as JSONL and uploaded via Files API
- Batch is created via `/v1/batches` with `completion_window: "24h"`
- Polling checks `/v1/batches/{id}` at configurable interval
- Results are downloaded from output file and parsed from JSONL
- Each result is translated to unified `BatchResultItem` format
- Failed individual requests are captured with error details
- Provider batch ID and file IDs are persisted to `provider.json`
- Batch can be cancelled via `/v1/batches/{id}/cancel`
- Expired batches (past 24hr) are handled gracefully with `failed` status
