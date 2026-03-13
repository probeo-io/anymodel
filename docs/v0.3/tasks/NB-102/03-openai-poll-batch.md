# Task: OpenAI Poll Batch

**Story:** NB-102 — OpenAI Native Batch

## Description

Poll OpenAI batch status and map to unified status.

## Acceptance Criteria

- [ ] `GET /v1/batches/{id}` at configurable interval
- [ ] Map OpenAI statuses: `validating`→`pending`, `in_progress`→`processing`, `completed`→`completed`, `failed`→`failed`, `expired`→`failed`, `cancelled`→`cancelled`
- [ ] Update `BatchObject` counts from `request_counts` (completed, failed, total)
- [ ] Persist updated meta to disk on each poll
- [ ] `onProgress` callback fires with current state
