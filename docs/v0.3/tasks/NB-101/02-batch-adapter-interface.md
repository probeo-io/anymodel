# Task: Batch Adapter Interface

**Story:** NB-101 — Batch Provider Detection

## Description

Define a `BatchAdapter` interface that native batch providers implement. This separates batch logic from the chat completion adapter.

## Acceptance Criteria

- [ ] `BatchAdapter` interface defined with methods: `createBatch()`, `pollBatch()`, `getBatchResults()`, `cancelBatch()`
- [ ] `createBatch()` accepts unified batch request, returns provider batch ID
- [ ] `pollBatch()` accepts provider batch ID, returns status and counts
- [ ] `getBatchResults()` returns translated `BatchResultItem[]`
- [ ] `cancelBatch()` cancels via provider API
- [ ] Interface exported from `src/providers/adapter.ts`
