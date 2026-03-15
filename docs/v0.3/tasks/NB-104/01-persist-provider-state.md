# Task: Persist Provider Batch State

**Story:** NB-104 — Batch Resumability

## Description

Ensure native batch provider IDs and file IDs are persisted to disk so polling can resume after restart.

## Acceptance Criteria

- [ ] `provider.json` stores: `providerBatchId`, `providerName`, `inputFileId` (OpenAI), `status`
- [ ] Written immediately after provider batch creation
- [ ] Updated on each poll with latest provider status
