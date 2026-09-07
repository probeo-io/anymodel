import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyOverrides,
  parseOverrides,
  toPricingEntry,
  type OverrideEntry,
  type PricingEntry,
} from '../scripts/pricing-overrides.js';

const OVERRIDES_PATH = join(import.meta.dirname, '..', 'scripts', 'pricing-overrides.json');

function entry(over: Partial<OverrideEntry> = {}): OverrideEntry {
  return { inputPerMillion: 4, outputPerMillion: 20, checked: new Date().toISOString().slice(0, 10), ...over };
}

describe('override file', () => {
  it('parses as committed', () => {
    expect(() => parseOverrides(JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8')))).not.toThrow();
  });

  it('treats a file with no models as empty rather than an error', () => {
    expect(parseOverrides({}).size).toBe(0);
    expect(parseOverrides({ models: {} }).size).toBe(0);
  });
});

describe('validation', () => {
  it('rejects a per-token rate typed into a per-million field', () => {
    // The transcription error this format exists to prevent.
    expect(() => parseOverrides({ models: { 'openai/x': { inputPerMillion: 0.0000035, outputPerMillion: 20 } } }))
      .toThrow(/looks like a per-token rate/);
  });

  it('rejects missing, negative, and non-numeric rates', () => {
    expect(() => parseOverrides({ models: { 'openai/x': { outputPerMillion: 20 } } })).toThrow(/inputPerMillion/);
    expect(() => parseOverrides({ models: { 'openai/x': { inputPerMillion: -1, outputPerMillion: 20 } } })).toThrow(/inputPerMillion/);
    expect(() => parseOverrides({ models: { 'openai/x': { inputPerMillion: '4', outputPerMillion: 20 } } })).toThrow(/inputPerMillion/);
  });

  it('names the offending model in the error', () => {
    expect(() => parseOverrides({ models: { 'anthropic/claude-x': { inputPerMillion: 0 } } }))
      .toThrow(/^anthropic\/claude-x:/);
  });

  it('requires provider/model ids', () => {
    expect(() => parseOverrides({ models: { 'gpt-4o': { inputPerMillion: 4, outputPerMillion: 20 } } }))
      .toThrow(/provider\/model/);
  });

  it('rejects unsorted or non-positive tier thresholds', () => {
    const tiers = (t: unknown[]) => ({ models: { 'openai/x': { inputPerMillion: 4, outputPerMillion: 20, tiers: t } } });
    expect(() => parseOverrides(tiers([
      { minPromptTokens: 272000, inputPerMillion: 8, outputPerMillion: 30 },
      { minPromptTokens: 100000, inputPerMillion: 9, outputPerMillion: 31 },
    ]))).toThrow(/ascend/);
    expect(() => parseOverrides(tiers([{ minPromptTokens: 0, inputPerMillion: 8, outputPerMillion: 30 }])))
      .toThrow(/positive integer/);
  });

  it('accepts a fully specified entry', () => {
    const parsed = parseOverrides({
      models: {
        'openai/gpt-x': {
          inputPerMillion: 4, outputPerMillion: 20,
          cacheReadPerMillion: 0.4, cacheWritePerMillion: 5,
          tiers: [{ minPromptTokens: 272000, inputPerMillion: 8, outputPerMillion: 30 }],
          source: 'https://openai.com/api/pricing', checked: '2026-09-07',
        },
      },
    });
    expect(parsed.size).toBe(1);
  });
});

describe('conversion', () => {
  it('converts per-million rates to per-token', () => {
    expect(toPricingEntry(entry({ inputPerMillion: 4, outputPerMillion: 20 })))
      .toEqual({ prompt: 0.000004, completion: 0.00002 });
  });

  it('converts cache rates and tiers too', () => {
    const converted = toPricingEntry(entry({
      cacheReadPerMillion: 0.4,
      tiers: [{ minPromptTokens: 272000, inputPerMillion: 8, outputPerMillion: 30, cacheReadPerMillion: 0.8 }],
    }));
    expect(converted.cacheRead).toBeCloseTo(4e-7, 15);
    expect(converted.tiers).toHaveLength(1);
    expect(converted.tiers![0]!.minPromptTokens).toBe(272000);
    expect(converted.tiers![0]!.prompt).toBeCloseTo(0.000008, 15);
    expect(converted.tiers![0]!.cacheRead).toBeCloseTo(8e-7, 15);
  });
});

describe('applying overrides', () => {
  const fetched = (): Map<string, PricingEntry> => new Map([
    ['openai/a', { prompt: 0.000002, completion: 0.00001 }],
  ]);

  it('replaces a fetched rate and reports it as changed', () => {
    const table = fetched();
    const report = applyOverrides(table, new Map([['openai/a', entry()]]));
    expect(table.get('openai/a')).toEqual({ prompt: 0.000004, completion: 0.00002 });
    expect(report.changed).toEqual(['openai/a']);
    expect(report.redundant).toEqual([]);
  });

  it('reports an override that upstream now matches, so it can be retired', () => {
    const report = applyOverrides(fetched(), new Map([
      ['openai/a', entry({ inputPerMillion: 2, outputPerMillion: 10 })],
    ]));
    expect(report.redundant).toEqual(['openai/a']);
    expect(report.changed).toEqual([]);
  });

  it('spots a redundant override despite float division drift', () => {
    // 0.4/1e6 is 4.0000000000000003e-7; upstream parses "0.0000004" as 4e-7.
    const table = new Map<string, PricingEntry>([
      ['openai/a', { prompt: 0.000002, completion: 0.00001, cacheRead: 4e-7 }],
    ]);
    const report = applyOverrides(table, new Map([
      ['openai/a', entry({ inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.4 })],
    ]));
    expect(report.redundant).toEqual(['openai/a']);
  });

  it('reports a model the fetched sources do not list', () => {
    const report = applyOverrides(fetched(), new Map([['openai/unlisted', entry()]]));
    expect(report.added).toEqual(['openai/unlisted']);
  });

  it('flags entries that are undated or long unconfirmed', () => {
    const now = new Date('2026-09-07');
    const report = applyOverrides(fetched(), new Map([
      ['openai/a', entry({ checked: '2026-09-01' })],
      ['openai/b', entry({ checked: '2020-01-01' })],
      ['openai/c', entry({ checked: undefined })],
    ]), now);
    expect(report.stale).toEqual(['openai/b', 'openai/c']);
  });
});
