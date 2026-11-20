import { describe, expect, it } from 'vitest';
import { MODEL_PRICING, calculateCost, effectiveRates, getModelPricing } from '../src/generated/pricing.js';

const keys = Object.keys(MODEL_PRICING);
const normalize = (id: string) => id.replace(/(\d+)\.(\d+)/g, '$1-$2');

/**
 * These assert properties of the resolution rules rather than the rates of any
 * particular model, so they survive a pricing regeneration. The table is
 * rebuilt from a remote API whose ordering is arbitrary, and pinning specifics
 * here is what made the earlier cost test break on every refresh.
 */
describe('getModelPricing resolution', () => {
  it('resolves every known id to its own entry', () => {
    const wrong = keys.filter(id => getModelPricing(id) !== MODEL_PRICING[id]);
    expect(wrong).toEqual([]);
  });

  it('falls back from a dated id to its base model', () => {
    const base = keys.find(id => !id.includes(':batch'))!;
    expect(getModelPricing(`${base}-2024-08-06`)).toBe(MODEL_PRICING[base]);
  });

  it('treats a dashed version as the dotted one, and the reverse', () => {
    const dotted = keys.find(id => /\d\.\d/.test(id) && !id.includes(':batch'));
    if (!dotted) return;
    expect(getModelPricing(normalize(dotted))).toBe(MODEL_PRICING[dotted]);
  });

  it('never answers a plain query with :batch pricing', () => {
    const batchKeys = keys.filter(id => id.includes(':batch'));
    expect(batchKeys.length).toBeGreaterThan(0);

    const leaked = batchKeys.filter(id => {
      const plain = id.replace(':batch', '');
      const resolved = getModelPricing(plain);
      return resolved !== null && resolved === MODEL_PRICING[id] && MODEL_PRICING[plain] !== MODEL_PRICING[id];
    });
    expect(leaked).toEqual([]);
  });

  it('answers a :batch query only from :batch entries', () => {
    const batchKey = keys.find(id => id.includes(':batch'))!;
    expect(getModelPricing(`${batchKey}-2024-08-06`)).toBe(MODEL_PRICING[batchKey]);
  });

  it('picks the shortest candidate when a query prefixes several ids', () => {
    // A query that is a strict prefix of more than one id, and not an id
    // itself — the case that previously resolved by table order.
    let ambiguous: string | undefined;
    let expected: string | undefined;
    for (const id of keys) {
      if (id.includes(':batch')) continue;
      const cut = id.lastIndexOf('-');
      if (cut <= id.indexOf('/') + 1) continue;
      const stem = id.slice(0, cut);
      if (MODEL_PRICING[stem]) continue;
      const matches = keys
        .filter(k => !k.includes(':batch') && normalize(k).startsWith(normalize(stem)))
        .sort((a, b) => a.length - b.length || a.localeCompare(b));
      if (matches.length > 1) { ambiguous = stem; expected = matches[0]; break; }
    }
    expect(ambiguous).toBeDefined();
    expect(getModelPricing(ambiguous!)).toBe(MODEL_PRICING[expected!]);
  });

  it('returns null for a model it has never heard of', () => {
    expect(getModelPricing('notaprovider/notamodel-9000')).toBeNull();
  });
});

describe('long-context pricing tiers', () => {
  const tiered = Object.entries(MODEL_PRICING).filter(([, e]) => e.tiers?.length);

  it('carries tiers for the models that have them', () => {
    expect(tiered.length).toBeGreaterThan(0);
  });

  it('stores every tier ascending by threshold', () => {
    const unsorted = tiered.filter(([, e]) =>
      e.tiers!.some((tier, i) => i > 0 && tier.minPromptTokens <= e.tiers![i - 1]!.minPromptTokens));
    expect(unsorted.map(([id]) => id)).toEqual([]);
  });

  it('charges base rates below the first threshold and tier rates at it', () => {
    for (const [, entry] of tiered) {
      const first = entry.tiers![0]!;
      expect(effectiveRates(entry, first.minPromptTokens - 1)).toBe(entry);
      expect(effectiveRates(entry, first.minPromptTokens).prompt).toBe(first.prompt);
    }
  });

  it('applies the highest tier a prompt reaches', () => {
    const multi = tiered.find(([, e]) => e.tiers!.length > 1);
    if (!multi) return;
    const tiers = multi[1].tiers!;
    const top = tiers[tiers.length - 1]!;
    expect(effectiveRates(multi[1], top.minPromptTokens * 2).prompt).toBe(top.prompt);
  });

  it('bills a long prompt at the tier rate, not the base rate', () => {
    const [id, entry] = tiered.find(([i]) => !i.includes(':batch'))!;
    const tier = entry.tiers![0]!;
    const promptTokens = tier.minPromptTokens;

    expect(calculateCost(id, promptTokens, 0)).toBeCloseTo(promptTokens * tier.prompt, 9);
    // The bug this guards: a flat table charged base rates all the way up.
    expect(calculateCost(id, promptTokens, 0)).not.toBeCloseTo(promptTokens * entry.prompt, 9);
  });

  it('leaves flat-rate models alone', () => {
    const flat = Object.values(MODEL_PRICING).find(e => !e.tiers)!;
    expect(effectiveRates(flat, 10_000_000)).toBe(flat);
  });
});
