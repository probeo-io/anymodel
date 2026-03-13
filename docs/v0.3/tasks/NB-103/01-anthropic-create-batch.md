# Task: Anthropic Create Batch

**Story:** NB-103 — Anthropic Native Batch

## Description

Create a batch via Anthropic Message Batches API with translated requests.

## Acceptance Criteria

- [ ] Translate each request to Anthropic format (system extraction, tool mapping, stop_sequences, max_tokens default)
- [ ] `POST /v1/messages/batches` with `requests` array of `{custom_id, params}`
- [ ] Returns Anthropic batch object with ID and processing_status
- [ ] Provider batch ID stored in `provider.json`
- [ ] `BatchObject` updated with status `"processing"`
- [ ] Throws `AnyModelError` on creation failure
