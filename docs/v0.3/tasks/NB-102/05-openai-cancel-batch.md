# Task: OpenAI Cancel Batch

**Story:** NB-102 — OpenAI Native Batch

## Description

Cancel an in-progress OpenAI batch.

## Acceptance Criteria

- [ ] `POST /v1/batches/{id}/cancel` using stored provider batch ID
- [ ] Update `BatchObject.status` to `"cancelled"`
- [ ] Persist updated meta to disk
- [ ] If batch already completed, return current state without error
