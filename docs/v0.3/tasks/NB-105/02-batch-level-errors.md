# Task: Batch-Level Error Handling

**Story:** NB-105 — Batch Error Handling

## Description

Handle batch-level failures from provider APIs.

## Acceptance Criteria

- [ ] OpenAI `expired` status → `BatchObject.status = "failed"` with error metadata
- [ ] OpenAI `failed` status → `BatchObject.status = "failed"`, partial results still available
- [ ] Anthropic ended with all errors → `BatchObject.status = "failed"`
- [ ] Provider API errors during create/poll throw `AnyModelError` with `provider_name` and `raw` metadata
- [ ] File upload errors (OpenAI) throw `AnyModelError` with descriptive message
- [ ] Partial results are persisted and available via `batches.results(id)` even on failure
