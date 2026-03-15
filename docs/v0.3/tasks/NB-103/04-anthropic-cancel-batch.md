# Task: Anthropic Cancel Batch

**Story:** NB-103 — Anthropic Native Batch

## Description

Cancel an in-progress Anthropic batch.

## Acceptance Criteria

- [ ] `POST /v1/messages/batches/{id}/cancel` using stored provider batch ID
- [ ] Update `BatchObject.status` to `"cancelled"`
- [ ] Persist updated meta to disk
- [ ] If batch already ended, return current state without error
