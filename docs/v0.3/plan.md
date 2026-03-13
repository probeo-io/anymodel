# v0.3 Implementation Plan — Native Batch APIs

## Overview

5 stories, 16 tasks. Adds native server-side batch support for OpenAI and Anthropic.

## Phase 1: Foundation (NB-101)
- Add `BatchAdapter` interface and `supportsBatch()` to provider adapters
- Add provider detection routing in `BatchManager`

**Tasks:** NB-101/01, NB-101/02

## Phase 2: OpenAI Native Batch (NB-102)
- JSONL formatting and file upload
- Batch creation via `/v1/batches`
- Polling and status mapping
- Result download and translation
- Cancellation

**Tasks:** NB-102/01, NB-102/02, NB-102/03, NB-102/04, NB-102/05

## Phase 3: Anthropic Native Batch (NB-103)
- Request translation to Anthropic format
- Batch creation via `/v1/messages/batches`
- Polling and status mapping
- Result streaming and translation
- Cancellation

**Tasks:** NB-103/01, NB-103/02, NB-103/03, NB-103/04

## Phase 4: Resumability (NB-104)
- Persist provider state to disk
- Resume polling from stored state after restart

**Tasks:** NB-104/01, NB-104/02

## Phase 5: Error Handling & Tests (NB-105)
- Per-item error mapping for both providers
- Batch-level error handling
- Tests for all native batch paths

**Tasks:** NB-105/01, NB-105/02

## Build Order

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
```

Phases 2 and 3 are independent and could be built in parallel, but sequential is cleaner for testing.

## Exit Criteria

- `client.batches.createAndPoll()` uses native API for OpenAI and Anthropic models
- Concurrent fallback still works for all other providers
- Batches survive process restart via disk persistence
- All error paths handled with unified error types
- Tests cover native batch creation, polling, result parsing, cancellation, and error cases
