import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../src/utils/retry.js';
import { AnyModelError } from '../src/types.js';

describe('withRetry', () => {
  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 1, maxDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new AnyModelError(429, 'Rate limited'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 2, baseDelay: 1, maxDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 502 and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new AnyModelError(502, 'Bad gateway'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 2, baseDelay: 1, maxDelay: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 400 (non-retryable)', async () => {
    const fn = vi.fn().mockRejectedValue(new AnyModelError(400, 'Bad request'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelay: 1, maxDelay: 10 }),
    ).rejects.toThrow('Bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after max retries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new AnyModelError(429, 'Rate limited'));

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelay: 1, maxDelay: 10 }),
    ).rejects.toThrow('Rate limited');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does not retry non-AnyModelError', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Network error'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelay: 1, maxDelay: 10 }),
    ).rejects.toThrow('Network error');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
