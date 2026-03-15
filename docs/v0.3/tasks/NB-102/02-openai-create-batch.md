# Task: OpenAI Create Batch

**Story:** NB-102 — OpenAI Native Batch

## Description

Create a batch via OpenAI Batches API after file upload.

## Acceptance Criteria

- [ ] `POST /v1/batches` with `input_file_id`, `endpoint: "/v1/chat/completions"`, `completion_window: "24h"`
- [ ] Returns OpenAI batch object with ID and status
- [ ] Provider batch ID and input file ID stored in `provider.json`
- [ ] `BatchObject` updated with provider info
- [ ] Throws `AnyModelError` on creation failure
