import { describe, it, expect } from 'vitest';
import { RateLimitTracker } from '../src/utils/rate-limiter.js';

describe('RateLimitTracker', () => {
  it('is not rate-limited by default', () => {
    const tracker = new RateLimitTracker();
    expect(tracker.isRateLimited('openai')).toBe(false);
  });

  it('tracks rate limit from recordRateLimit', () => {
    const tracker = new RateLimitTracker();
    tracker.recordRateLimit('openai', 5000);
    expect(tracker.isRateLimited('openai')).toBe(true);
    expect(tracker.getWaitTime('openai')).toBeGreaterThan(0);
  });

  it('updates from headers', () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders('anthropic', {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
    });

    const state = tracker.getState('anthropic');
    expect(state?.remaining).toBe(0);
    expect(state?.resetAt).toBeGreaterThan(Date.now());
  });

  it('not rate-limited when remaining > 0', () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders('openai', {
      'x-ratelimit-remaining': '50',
    });
    expect(tracker.isRateLimited('openai')).toBe(false);
  });
});
