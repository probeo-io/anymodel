# Task: OpenAI JSONL File Upload

**Story:** NB-102 — OpenAI Native Batch

## Description

Format batch requests as OpenAI JSONL and upload via the Files API.

## Acceptance Criteria

- [ ] Each request formatted as `{"custom_id": "...", "method": "POST", "url": "/v1/chat/completions", "body": {...}}`
- [ ] Request body includes model, messages, and all optional params
- [ ] JSONL string built from array of formatted requests
- [ ] Upload via `POST /v1/files` with `purpose: "batch"`
- [ ] Returns file ID on success
- [ ] Throws `AnyModelError` on upload failure
