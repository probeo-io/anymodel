import type { Usage } from '../types.js';

/* Per-search fees for each provider's server-side web search, in USD, as the
   providers price them (checked 2026-10-06). Tokens are costed separately from
   the pricing table; these are the per-call charges on top. Free allowances,
   such as Gemini's 5,000 searches a month, are not modelled. */
const WEB_SEARCH_FEE: Record<string, number> = {
  openai: 10 / 1000,    // developers.openai.com/api/docs/pricing
  xai: 5 / 1000,        // docs.x.ai/developers/pricing
  anthropic: 10 / 1000, // platform.claude.com web search tool
  google: 14 / 1000,    // ai.google.dev/gemini-api/docs/pricing, Gemini 3.x grounding
};

export function webSearchCost(provider: string, searches: number): number {
  return Math.max(0, searches) * (WEB_SEARCH_FEE[provider] ?? 0);
}

/** Puts a call's tool fees on its usage, where the cost calculation picks them up. */
export function withToolCost(usage: Usage, cost: number): Usage {
  if (cost > 0) usage.tool_cost = (usage.tool_cost ?? 0) + cost;
  return usage;
}
