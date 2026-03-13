import { describe, it, expect } from 'vitest';
import { AnyModelError } from '../src/types.js';

describe('AnyModelError', () => {
  it('creates error with code, message, metadata', () => {
    const err = new AnyModelError(429, 'Rate limit exceeded', {
      provider_name: 'anthropic',
      raw: { retry_after: 30 },
    });

    expect(err.code).toBe(429);
    expect(err.message).toBe('Rate limit exceeded');
    expect(err.metadata.provider_name).toBe('anthropic');
    expect(err.metadata.raw).toEqual({ retry_after: 30 });
    expect(err.name).toBe('AnyModelError');
    expect(err instanceof Error).toBe(true);
  });

  it('serializes to JSON in standard format', () => {
    const err = new AnyModelError(400, 'Invalid request', { provider_name: 'openai' });
    const json = err.toJSON();

    expect(json).toEqual({
      error: {
        code: 400,
        message: 'Invalid request',
        metadata: { provider_name: 'openai' },
      },
    });
  });

  it('defaults metadata to empty object', () => {
    const err = new AnyModelError(500, 'Server error');
    expect(err.metadata).toEqual({});
  });
});
