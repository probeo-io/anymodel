# Feature: Provider pricing accounting

## Outcome

Anymodel returns one normalized, versioned cost record for every model call.
Cost is calculated from provider-reported usage and the provider-specific
pricing policy; callers do not apply discounts themselves.

## Contract

The shared pricing API accepts model identity, normalized usage (including cache
read/write tokens where reported), and execution context (provider, service
tier, and batch mode). It returns the pricing-table version, exact rates used,
normalized usage, provider pricing treatment, and estimated cost.

OpenAI Flex and native Batch treatment are OpenAI policy, not generic `0.5`
discounts. Other providers define their own policy or explicitly use standard
pricing. Cache read/write rates come from the generated OpenRouter pricing table
when available; absent cache rates fall back to the provider's normal input
rate and are recorded as such.

## Authority

Anymodel owns usage normalization and pricing. Consumers, including Workforce,
record the returned cost record unchanged and do not reinterpret provider
billing rules.

## Acceptance

- Chat, Responses, streaming final usage, native batch, and concurrent batch
  use the same pricing API.
- OpenAI standard, Flex, and Batch calculations are covered independently.
- Cache reads/writes are costed separately from uncached input.
- A pricing-table refresh changes future calculations while historical cost
  records retain their rates and pricing version.

## Tool fees (2026-10-07)

Server-side tools charge per call on top of tokens. Each adapter puts the call's fee on
`usage.tool_cost` (USD), and `calculateProviderCost`, generation stats and both batch paths add it,
undiscounted by flex or batch. Web search fees per search, from `src/pricing/tool-fees.ts`: OpenAI
$0.010, xAI $0.005, Anthropic $0.010, Google $0.014 (Gemini's 5,000 free searches a month are not
modelled). Perplexity reports its own per-request fee, which is used as given. Gemini usage
counts thinking tokens as output and tool-use prompt tokens as input.
