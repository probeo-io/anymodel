import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyOverrides,
  parseOverrides,
  toPricingEntry,
  type PricingEntry,
} from '../scripts/pricing-overrides.js';

const PRICES_PATH = join(import.meta.dirname, '..', 'prices.json');

describe('prices.json', () => {
  it('parses as committed', () => {
    expect(() => parseOverrides(JSON.parse(readFileSync(PRICES_PATH, 'utf-8')))).not.toThrow();
  });

  it('ignores // and $ keys, since JSON has no comments', () => {
    const parsed = parseOverrides({
      '//': 'a note',
      '$schema': 'whatever',
      'openai/a': { in: 4, out: 20 },
    });
    expect([...parsed.keys()]).toEqual(['openai/a']);
  });

  it('accepts an empty file', () => {
    expect(parseOverrides({}).size).toBe(0);
  });

  it('rejects a non-object file', () => {
    expect(() => parseOverrides([])).toThrow(/JSON object/);
    expect(() => parseOverrides(null)).toThrow(/JSON object/);
  });
});

describe('validation', () => {
  it('rejects a per-token rate typed into a per-million field', () => {
    // The transcription error this format exists to prevent.
    expect(() => parseOverrides({ 'openai/a': { in: 0.0000035, out: 20 } }))
      .toThrow(/looks like a per-token rate/);
  });

  it('rejects missing, negative, and non-numeric rates', () => {
    expect(() => parseOverrides({ 'openai/a': { out: 20 } })).toThrow(/'in'/);
    expect(() => parseOverrides({ 'openai/a': { in: -1, out: 20 } })).toThrow(/'in'/);
    expect(() => parseOverrides({ 'openai/a': { in: '4', out: 20 } })).toThrow(/'in'/);
  });

  it('names the offending model in the error', () => {
    expect(() => parseOverrides({ 'anthropic/claude-x': { in: 0.000001, out: 20 } }))
      .toThrow(/^anthropic\/claude-x:/);
  });

  it('requires provider/model ids', () => {
    expect(() => parseOverrides({ 'gpt-4o': { in: 4, out: 20 } })).toThrow(/provider\/model/);
  });

  it('rejects unsorted or non-positive tier thresholds', () => {
    const withTiers = (t: unknown[]) => ({ 'openai/a': { in: 4, out: 20, tiers: t } });
    expect(() => parseOverrides(withTiers([
      { from: 272000, in: 8, out: 30 },
      { from: 100000, in: 9, out: 31 },
    ]))).toThrow(/ascend/);
    expect(() => parseOverrides(withTiers([{ from: 0, in: 8, out: 30 }]))).toThrow(/positive token count/);
  });
});

describe('conversion', () => {
  it('converts per-million rates to per-token', () => {
    expect(toPricingEntry({ in: 4, out: 20 })).toEqual({ prompt: 0.000004, completion: 0.00002 });
  });

  it('converts cache rates and tiers too', () => {
    const converted = toPricingEntry({
      in: 4, out: 20, cacheRead: 0.4,
      tiers: [{ from: 272000, in: 8, out: 30, cacheRead: 0.8 }],
    });
    expect(converted.cacheRead).toBeCloseTo(4e-7, 15);
    expect(converted.tiers).toHaveLength(1);
    expect(converted.tiers![0]!.minPromptTokens).toBe(272000);
    expect(converted.tiers![0]!.prompt).toBeCloseTo(0.000008, 15);
    expect(converted.tiers![0]!.cacheRead).toBeCloseTo(8e-7, 15);
  });
});

describe('applying prices', () => {
  const fetched = (): Map<string, PricingEntry> => new Map([
    ['openai/a', { prompt: 0.000002, completion: 0.00001 }],
  ]);

  it('replaces a fetched rate and reports it as changed', () => {
    const table = fetched();
    const report = applyOverrides(table, new Map([['openai/a', { in: 4, out: 20 }]]));
    expect(table.get('openai/a')).toEqual({ prompt: 0.000004, completion: 0.00002 });
    expect(report.changed).toEqual(['openai/a']);
    expect(report.redundant).toEqual([]);
  });

  it('reports an entry upstream now matches, so it can be deleted', () => {
    const report = applyOverrides(fetched(), new Map([['openai/a', { in: 2, out: 10 }]]));
    expect(report.redundant).toEqual(['openai/a']);
    expect(report.changed).toEqual([]);
  });

  it('spots a redundant entry despite float division drift', () => {
    // 0.4/1e6 is 4.0000000000000003e-7; upstream parses "0.0000004" as 4e-7.
    const table = new Map<string, PricingEntry>([
      ['openai/a', { prompt: 0.000002, completion: 0.00001, cacheRead: 4e-7 }],
    ]);
    const report = applyOverrides(table, new Map([['openai/a', { in: 2, out: 10, cacheRead: 0.4 }]]));
    expect(report.redundant).toEqual(['openai/a']);
  });

  it('reports a model the fetched sources do not list', () => {
    const report = applyOverrides(fetched(), new Map([['openai/unlisted', { in: 4, out: 20 }]]));
    expect(report.added).toEqual(['openai/unlisted']);
  });
});
