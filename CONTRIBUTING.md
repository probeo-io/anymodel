# Contributing to @probeo/anymodel

Thanks for your interest in contributing! Here's how to get started.

## Setup

```bash
git clone https://github.com/probeo-io/anymodel.git
cd anymodel
npm install
```

## Development

```bash
# Build
npm run build

# Watch mode (rebuilds on changes)
npm run dev

# Run tests
npm test

# Watch tests
npm run test:watch

# Type check
npm run lint
```

## Project Structure

```
src/
  client.ts          # AnyModel SDK class
  router.ts          # Request routing, fallback, retries
  config.ts          # Config file loading and resolution
  server.ts          # HTTP server mode
  cli.ts             # CLI entry point
  types.ts           # All TypeScript interfaces
  providers/
    adapter.ts       # ProviderAdapter interface
    registry.ts      # Provider registry
    openai.ts        # OpenAI adapter
    anthropic.ts     # Anthropic adapter
    google.ts        # Google/Gemini adapter
    custom.ts        # Custom OpenAI-compatible providers
  batch/
    manager.ts       # Batch processing orchestration
    store.ts         # Disk-based batch persistence
  utils/
    id.ts            # ID generation
    model-parser.ts  # provider/model string parsing
    validate.ts      # Request validation
    retry.ts         # Retry with backoff
    rate-limiter.ts  # Per-provider rate limit tracking
    transforms.ts    # Middle-out context truncation
    generation-stats.ts  # Generation stats store
tests/               # Vitest test files
examples/             # Runnable usage examples
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add or update tests as needed
4. Run `npm test` and `npm run lint` to make sure everything passes
5. Write a clear commit message describing what and why
6. Open a pull request

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Include tests for new functionality
- Update the README if you're adding user-facing features
- Make sure CI passes before requesting review

## Adding a Provider

1. Create `src/providers/yourprovider.ts` implementing `ProviderAdapter`
2. Add it to `src/providers/index.ts`
3. Wire it into `src/client.ts` in `registerProviders()`
4. Add tests in `tests/`
5. Update the README with the new provider

## Reporting Issues

Use [GitHub Issues](https://github.com/probeo-io/anymodel/issues). Include:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Node.js version and OS

## Code Style

- TypeScript strict mode
- No external runtime dependencies (stdlib only)
- Keep things simple — no premature abstractions
