# Feature: Web search on every provider

## Outcome

A caller that passes `{ type: 'web_search' }` in `tools` gets a model that searches the web,
whichever provider the model is on. Today only OpenAI and xAI honour it. The Anthropic and
Google adapters filter it out with every other non-function tool, so the model answers
without searching and nothing says so.

## Input contract

Unchanged. `WebSearchTool` in `src/types.ts`:

```ts
{ type: 'web_search', search_context_size?: 'low' | 'medium' | 'high',
  filters?: { allowed_domains?: string[], blocked_domains?: string[] } }
```

## Provider translation

| Provider | Today | Change |
|---|---|---|
| OpenAI | Responses API with `web_search` | none |
| xAI | Responses API with `web_search` | none |
| Anthropic | dropped (`isFunctionTool` filter) | send Anthropic's web search server tool, `web_search_20260209` (`name: 'web_search'`), alongside any function tools. Models older than Opus 4.6 / Sonnet 4.6 take `web_search_20250305` instead. `allowed_domains` / `blocked_domains` map across; `search_context_size` has no equivalent and is ignored |
| Google | dropped (`isFunctionTool` filter) | send `{ googleSearch: {} }` with any function declarations |
| Perplexity | passed through raw | the model searches by default; don't send the tool, map filters to `search_domain_filter` |
| DeepInfra | passed through raw | no native search: fail with a clear error, not a raw pass-through |
| Custom | advertises `tools` | pass through unchanged; the endpoint is the caller's |

The batch adapters (`*-batch.ts`) translate the same way as their live adapters.
OpenAI's batch adapter is left as it is: it still sends batches to chat completions, where
`web_search` isn't accepted (Chris, 2026-10-06: *"less concerned about batch"*).

Anthropic's web search runs server-side and can end a response with `stop_reason:
'pause_turn'`; the adapter continues the turn until it finishes, so the caller still gets one
completed answer.

## Checked against the provider docs (2026-10-06)

- Anthropic: an allow list and a block list together is a 400, so the adapter refuses it with
  a clear error. With `web_search_20260209` Claude often runs its searches from code execution
  and its text carries no citations, so `citations` is the pages its searches returned, cited
  ones first. Searches cost $10 per 1,000, reported in `usage.server_tool_use`.
- Google: generateContent takes `{ googleSearch: {} }`. It has no domain filters, so a request
  with filters is refused. Combining it with function declarations is documented for Gemini 3
  only, in preview; older models may reject the pair. Sources are the grounding chunks.
- Perplexity: Sonar searches by default and is now a legacy API. `search_domain_filter` takes
  allow entries as-is and block entries with a `-` prefix, one mode per request.
- DeepInfra: no built-in search.

## Acceptance criteria

- A request with `web_search` to each provider sends that provider's search tool, or for
  DeepInfra fails with an error that names the missing support. Tested per provider on the
  request body.
- Function tools sent with `web_search` still reach the model on Anthropic and Google.
- One live call per provider with search on returns an answer that cites a page on the web.
