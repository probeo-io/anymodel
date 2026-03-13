import { describe, it, expect } from 'vitest';
import { generateId } from '../src/utils/id.js';
import { parseModelString } from '../src/utils/model-parser.js';
import { validateRequest } from '../src/utils/validate.js';
import { AnyModelError } from '../src/types.js';
import type { ChatCompletionRequest } from '../src/types.js';

describe('generateId', () => {
  it('generates gen- prefixed IDs', () => {
    const id = generateId();
    expect(id).toMatch(/^gen-/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it('supports custom prefix', () => {
    const id = generateId('batch');
    expect(id).toMatch(/^batch-/);
  });

  it('has at least 16 chars of randomness', () => {
    const id = generateId();
    const random = id.substring(4); // strip "gen-"
    expect(random.length).toBeGreaterThanOrEqual(16);
  });
});

describe('parseModelString', () => {
  it('parses provider/model format', () => {
    const result = parseModelString('anthropic/claude-sonnet-4-6');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('handles models with slashes in name', () => {
    const result = parseModelString('custom/meta-llama/llama-3.3-70b');
    expect(result).toEqual({ provider: 'custom', model: 'meta-llama/llama-3.3-70b' });
  });

  it('resolves aliases', () => {
    const aliases = { default: 'anthropic/claude-sonnet-4-6', fast: 'anthropic/claude-haiku-4-5' };
    const result = parseModelString('default', aliases);
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('throws on missing slash', () => {
    expect(() => parseModelString('justmodelname')).toThrow(AnyModelError);
    expect(() => parseModelString('justmodelname')).toThrow(/provider\/model format/);
  });

  it('throws on empty provider', () => {
    expect(() => parseModelString('/model')).toThrow(AnyModelError);
  });

  it('throws on empty model', () => {
    expect(() => parseModelString('provider/')).toThrow(AnyModelError);
  });
});

describe('validateRequest', () => {
  const validRequest: ChatCompletionRequest = {
    model: 'anthropic/claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'Hello' }],
  };

  it('passes valid request', () => {
    expect(() => validateRequest(validRequest)).not.toThrow();
  });

  it('throws on missing model', () => {
    expect(() => validateRequest({ ...validRequest, model: '' })).toThrow(/model/);
  });

  it('throws on missing messages', () => {
    expect(() => validateRequest({ ...validRequest, messages: [] })).toThrow(/messages/);
  });

  it('throws on invalid temperature', () => {
    expect(() => validateRequest({ ...validRequest, temperature: 3 })).toThrow(/temperature/);
    expect(() => validateRequest({ ...validRequest, temperature: -1 })).toThrow(/temperature/);
  });

  it('throws on invalid top_p', () => {
    expect(() => validateRequest({ ...validRequest, top_p: 1.5 })).toThrow(/top_p/);
  });

  it('throws on top_logprobs without logprobs', () => {
    expect(() => validateRequest({ ...validRequest, top_logprobs: 5 })).toThrow(/logprobs/);
  });

  it('allows top_logprobs with logprobs', () => {
    expect(() => validateRequest({ ...validRequest, logprobs: true, top_logprobs: 5 })).not.toThrow();
  });

  it('throws on too many stop sequences', () => {
    expect(() => validateRequest({ ...validRequest, stop: ['a', 'b', 'c', 'd', 'e'] })).toThrow(/stop/);
  });

  it('passes with models array instead of model', () => {
    expect(() => validateRequest({
      ...validRequest,
      model: '',
      models: ['anthropic/claude-sonnet-4-6'],
      route: 'fallback',
    })).not.toThrow();
  });
});
