import { describe, expect, it } from 'vitest';
import { MODEL_PRICING, getModelPricing } from '../src/generated/pricing.js';

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
