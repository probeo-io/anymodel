# Story: Batch Provider Detection

**ID:** NB-101

As a developer, I want the batch manager to automatically detect whether the target provider supports native batching so that I get the best performance and pricing without changing my code.

## Acceptance Criteria

- BatchManager detects provider from model string (e.g., `openai/gpt-4o` → openai)
- Routes to native batch implementation for OpenAI and Anthropic
- Falls back to concurrent execution for all other providers
- `BatchObject.batch_mode` is `"native"` or `"concurrent"` accordingly
- No changes to the public API — `create()` and `createAndPoll()` signatures unchanged
