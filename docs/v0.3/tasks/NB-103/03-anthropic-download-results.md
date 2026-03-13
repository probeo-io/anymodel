# Task: Anthropic Download and Parse Results

**Story:** NB-103 — Anthropic Native Batch

## Description

Stream results from Anthropic and translate to unified format.

## Acceptance Criteria

- [ ] `GET /v1/messages/batches/{id}/results` returns JSONL stream
- [ ] Each line has `custom_id` and `result` with `type` (succeeded/errored/canceled/expired)
- [ ] Translate `result.message` (Anthropic message format) to unified `ChatCompletion`
  - Map content blocks (text, tool_use) to choices
  - Map stop_reason to finish_reason
  - Map usage (input_tokens, output_tokens) to unified usage
  - Generate `gen-` prefixed IDs
- [ ] Errored items mapped to `BatchResultItem` with `status: "error"`
- [ ] All results persisted to `results.jsonl` on disk
