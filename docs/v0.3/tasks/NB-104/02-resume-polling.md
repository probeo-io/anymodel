# Task: Resume Polling from Disk

**Story:** NB-104 — Batch Resumability

## Description

`client.batches.poll(id)` loads provider state from disk and reconnects to the provider's batch API.

## Acceptance Criteria

- [ ] Load `provider.json` to get provider batch ID and provider name
- [ ] Determine correct batch adapter from provider name
- [ ] Resume polling provider API from current state
- [ ] Download results when complete and persist to `results.jsonl`
- [ ] Update `meta.json` with final status
- [ ] Return `BatchResults` as if `createAndPoll` was used
- [ ] Throw `AnyModelError` if batch ID not found on disk or provider API
