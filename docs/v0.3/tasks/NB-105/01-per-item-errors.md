# Task: Per-Item Error Handling

**Story:** NB-105 — Batch Error Handling

## Description

Ensure individual request failures within a native batch are captured per-item.

## Acceptance Criteria

- [ ] OpenAI: items with non-200 status_code in output mapped to `{status: "error", error: {code, message}}`
- [ ] OpenAI: items in error_file mapped to error results
- [ ] Anthropic: items with `type: "errored"` mapped to `{status: "error", error: {code, message}}`
- [ ] Anthropic: expired and canceled items also mapped as errors
- [ ] `BatchObject.failed` count reflects total errored items
