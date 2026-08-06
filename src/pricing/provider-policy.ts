export type PricingMode = 'standard' | 'flex' | 'native_batch';

export function providerPricingMultiplier(provider: string, mode: PricingMode): number {
  const policy: Record<string, Partial<Record<PricingMode, number>>> = {
    openai: { standard: 1, flex: 0.5, native_batch: 0.5 },
    anthropic: { standard: 1, native_batch: 0.5 },
    google: { standard: 1, native_batch: 0.5 },
    xai: { standard: 1 },
    perplexity: { standard: 1 },
  };
  return policy[provider]?.[mode] ?? 1;
}
