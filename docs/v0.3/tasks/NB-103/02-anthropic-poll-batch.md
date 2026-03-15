# Task: Anthropic Poll Batch

**Story:** NB-103 — Anthropic Native Batch

## Description

Poll Anthropic batch status and map to unified status.

## Acceptance Criteria

- [ ] `GET /v1/messages/batches/{id}` at configurable interval
- [ ] Map statuses: `in_progress`→`processing`, `ended`→check results for `completed`/`failed`
- [ ] Update `BatchObject` counts from `request_counts` (processing, succeeded, errored, canceled, expired)
- [ ] Persist updated meta to disk on each poll
- [ ] `onProgress` callback fires with current state
