# Story: Batch Resumability

**ID:** NB-104

As a developer, I want to resume polling a native batch after a process restart so that long-running batches aren't lost.

## Acceptance Criteria

- Provider batch ID is persisted to `~/.anymodel/batches/{id}/provider.json`
- `client.batches.poll(id)` loads provider state from disk and reconnects to provider API
- Works after full process restart with no state loss
- Progress callback fires with current provider-side counts
- Results are downloaded and persisted even if the original `create()` call is gone
