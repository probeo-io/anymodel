# Story: Batch Error Handling

**ID:** NB-105

As a developer, I want batch errors to be handled consistently whether using native or concurrent mode so that my error handling code works the same way.

## Acceptance Criteria

- Individual request failures within a batch are captured per-item in `BatchResultItem`
- Batch-level failures set `BatchObject.status` to `"failed"`
- OpenAI expired batches handled as `"failed"` with descriptive error
- Anthropic cancelled batches handled as `"cancelled"`
- Provider API errors during batch creation surface as `AnyModelError`
- Upload/file errors surface as `AnyModelError` with provider metadata
- Partial results are available even if batch fails partway through
