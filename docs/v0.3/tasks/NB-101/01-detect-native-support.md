# Task: Detect Native Batch Support

**Story:** NB-101 — Batch Provider Detection

## Description

Add a `supportsBatch()` method to `ProviderAdapter` interface. Implement batch routing logic in `BatchManager.create()` that checks the provider and routes to native or concurrent path.

## Acceptance Criteria

- [ ] `ProviderAdapter` interface has `supportsBatch(): boolean`
- [ ] OpenAI adapter returns `true`
- [ ] Anthropic adapter returns `true`
- [ ] Google and custom adapters return `false`
- [ ] `BatchManager.create()` parses provider from model string
- [ ] Routes to `processNativeBatch()` when supported
- [ ] Routes to existing `processBatch()` when not supported
- [ ] `BatchObject.batch_mode` set to `"native"` or `"concurrent"`
