# Task: OpenAI Download and Parse Results

**Story:** NB-102 — OpenAI Native Batch

## Description

Download output file and parse JSONL results into unified format.

## Acceptance Criteria

- [ ] Get `output_file_id` from completed batch object
- [ ] Download via `GET /v1/files/{output_file_id}/content`
- [ ] Parse JSONL — each line has `custom_id`, `response.body`, `error`
- [ ] Translate each `response.body` (OpenAI ChatCompletion) to unified `ChatCompletion` with `gen-` prefixed ID
- [ ] Failed items mapped to `BatchResultItem` with `status: "error"`
- [ ] Also download `error_file_id` if present for failed items
- [ ] All results persisted to `results.jsonl` on disk
