# CLAUDE.md

## Project Overview

`@probeo/anymodel` — OpenRouter-compatible LLM router with unified batch support. Routes requests across OpenAI, Anthropic, Google, and other providers with a single API. Runs as an SDK or standalone HTTP server.

Published to npm as `@probeo/anymodel`. GitHub repo: `probeo-io/anymodel`.

## Tech Stack

- **Language**: TypeScript (strict)
- **Runtime**: Node.js 20+
- **Build**: tsup (ESM + CJS dual output to `dist/`)
- **Test**: Vitest
- **Lint**: ESLint
- **Package manager**: npm

## Key Commands

```bash
npm run build       # Build with tsup
npm run lint        # Lint with ESLint
npm test            # Run tests with Vitest
npx tsc --noEmit    # Type check without emitting
```

## Project Structure

```
src/
├── client.ts           # AnyModel client — main entry point
├── server.ts           # HTTP server (OpenAI-compatible API)
├── types.ts            # All shared types
├── index.ts            # Public exports
├── cli.ts              # CLI entry point (npx anymodel serve)
├── config.ts           # Config file resolution and merging
├── router.ts           # Request routing (fallback, provider preferences)
├── providers/
│   ├── adapter.ts      # ProviderAdapter + BatchAdapter interfaces
│   ├── openai.ts       # OpenAI provider
│   ├── openai-batch.ts # OpenAI native batch (JSONL upload)
│   ├── anthropic.ts    # Anthropic provider
│   ├── anthropic-batch.ts # Anthropic native batch (Message Batches)
│   ├── google.ts       # Google Gemini provider
│   ├── custom.ts       # OpenAI-compatible custom providers
│   └── registry.ts     # Provider registry
├── batch/
│   ├── manager.ts      # BatchManager — native vs concurrent routing
│   └── store.ts        # Disk-based batch persistence (.anymodel/batches/)
└── utils/
    ├── fs-io.ts        # Async file IO with concurrency queues (p-queue)
    ├── id.ts           # ID generation
    ├── generation-stats.ts
    ├── model-parser.ts
    ├── rate-limiter.ts
    ├── retry.ts
    ├── transforms.ts
    └── validate.ts
```

## Architecture Decisions

- **All batch store operations are async** — uses queued IO from `fs-io.ts` for crash safety and throughput
- **Atomic writes** — batch metadata uses temp file → fsync → rename pattern to prevent corruption
- **Batch storage is project-local** — `.anymodel/batches/` in working directory, not home dir
- **Native batch routing** — BatchManager checks for registered BatchAdapter by provider name; native for OpenAI/Anthropic, concurrent fallback for others
- **Config merges, not replaces** — programmatic > local config > global config > env vars, deep-merged

## Release Process

1. Commit and push to main
2. `npm version patch|minor|major --no-git-tag-version`
3. Commit version bump, push
4. `git tag v0.x.x && git push origin v0.x.x`
5. `gh release create v0.x.0 --title "..." --generate-notes`
6. GitHub Actions `publish.yml` triggers and publishes to npm via `NPM_TOKEN` secret

## Domain Conventions

- Model names use `provider/model` format (e.g., `anthropic/claude-sonnet-4-6`)
- Internal IDs are prefixed with `gen-` (generation) or `batch-` (batch)
- Provider adapters implement `ProviderAdapter` interface; batch-capable ones also implement `BatchAdapter`
- All providers must implement `supportsBatch(): boolean`
- Error codes map to HTTP-like status codes (401, 429, 400, 502)

## Coding Standards

### Imports

- Use `import type { ... }` for type-only imports — never mix type and value imports in the same statement
- All local imports must include the `.js` extension (ES module resolution)
- Order: type imports first, then value imports; group by abstraction (types → providers → utils)
- No default exports — always use named exports

```typescript
import type { ChatCompletionRequest, ChatCompletion } from '../types.js';
import { AnyModelError } from '../types.js';
import { generateId } from '../utils/id.js';
```

### Naming

| What | Convention | Example |
|------|-----------|---------|
| Constants | `SCREAMING_SNAKE_CASE` | `ANTHROPIC_API_BASE`, `SUPPORTED_PARAMS` |
| Variables / functions | `camelCase` | `apiKey`, `buildRequestBody` |
| Types / interfaces / classes | `PascalCase` | `BatchManager`, `ChatCompletion` |
| Files | `kebab-case` | `rate-limiter.ts`, `fs-io.ts` |
| Enum-like unions | string literals | `'pending' \| 'processing' \| 'completed'` |

### Module Patterns

- **Factory functions** for stateless adapters — return an object conforming to the interface, with helper functions scoped inside the factory closure:

```typescript
export function createAnthropicAdapter(apiKey: string): ProviderAdapter {
  function mapErrorCode(status: number): number { ... }
  async function makeRequest(path: string, body: unknown): Promise<Response> { ... }

  const adapter: ProviderAdapter = {
    name: 'anthropic',
    async sendRequest(request) { ... },
    // ...
  };
  return adapter;
}
```

- **Classes** for stateful managers (BatchManager, ProviderRegistry, BatchStore) that hold maps, caches, or connections
- **Barrel files** (`index.ts`) for re-exporting public API — keep them minimal

### Functions

- Top-level / exported functions: use `function` declarations
- Callbacks, map/filter/reduce, promise handlers: use arrow functions
- Async generators for streaming: `async *translateStream(...)`
- Always use `async/await` over raw `.then()` chains

### Types

- Prefer `interface` for object shapes, `type` for unions and aliases
- Use `Record<string, unknown>` for flexible/dynamic objects
- Use generics for reusable utilities: `readJsonQueued<T>(path): Promise<T>`
- `as any` is acceptable only when parsing untyped vendor API responses — minimize and contain it
- Use `??` (nullish coalescing) over `||` for defaults that could be `0` or `''`
- Use optional chaining (`?.`) over manual null checks

### Error Handling

- Throw `AnyModelError` with an HTTP-like status code and `{ provider_name, raw }` metadata
- Parse error responses with a try/catch fallback to `res.statusText`
- Use bare `catch { }` (no binding) for best-effort operations like cancellation
- Graceful degradation: return fallback data (e.g., `FALLBACK_MODELS`) when a non-critical API call fails

```typescript
throw new AnyModelError(mapErrorCode(res.status), msg, {
  provider_name: 'anthropic',
  raw: errorBody,
});
```

### Comments

- Section dividers in `types.ts` use Unicode box-drawing: `// ─── Section Name ───...`
- JSDoc on public methods and exported utility functions
- Inline comments only when the "why" isn't obvious — no restating what the code does
- No `@param` / `@returns` boilerplate unless the signature is genuinely ambiguous

### Formatting

- 2-space indentation (enforced by `.editorconfig`)
- Single quotes for strings; template literals only when interpolating
- Trailing commas in multi-line objects/arrays/params
- Semicolons always
- LF line endings, UTF-8, trailing newline at EOF
- No strict line-length limit, but keep lines reasonable

### Async / IO

- All file operations go through `fs-io.ts` queued functions — never use raw `fs` calls
- Metadata and critical state: `writeFileFlushedQueued()` (atomic: temp → fsync → rename)
- Append-style data (results): `appendFileQueued()`
- Bulk reads: `readJsonQueued<T>()`, `readFileQueued()`
- Always `await` store operations — everything in `BatchStore` is async

### Tests

- Test framework: Vitest (`describe`, `it`, `expect`, `beforeEach`, `afterEach`)
- Test files live in `tests/` at project root, named `*.test.ts`
- Clean up temp directories in `beforeEach` / `afterEach` with `rmSync(..., { recursive: true, force: true })`
- Test against real interfaces, not mocks — mock only external HTTP calls when necessary
