import { describe, expect, it } from 'vitest';
import { resolvePromptCache } from '../src/cache.js';

describe('resolvePromptCache', () => {
  it('keeps identical prefixes on one key until the rate budget is full', () => {
    const key = `test:question-taxonomy:${Date.now()}`;
    const requests = Array.from({ length: 25 }, () => resolvePromptCache({ key, mode: 'explicit', ttl: '30m' }, 1_000));

    expect(requests.slice(0, 15).every((request) => request.key === key)).toBe(true);
    expect(requests.slice(15).every((request) => request.key === `${key}:rate-2`)).toBe(true);
  });

  it('returns to the primary key after the one-minute rate window expires', () => {
    const key = `test:question-taxonomy-expiry:${Date.now()}`;
    for (let index = 0; index < 15; index += 1) resolvePromptCache({ key, mode: 'explicit' }, 1_000);

    expect(resolvePromptCache({ key, mode: 'explicit' }, 1_001).key).toBe(`${key}:rate-2`);
    expect(resolvePromptCache({ key, mode: 'explicit' }, 61_001).key).toBe(key);
  });
});
