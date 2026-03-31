import { describe, it, expect } from 'vitest';
import { AdaptiveConcurrencyController } from '../src/utils/adaptive-concurrency.js';

describe('AdaptiveConcurrencyController', () => {
  it('starts at configured initial concurrency', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 10 });
    expect(controller.maxConcurrency).toBe(10);
  });

  it('defaults to initial=5 when no options provided', () => {
    const controller = new AdaptiveConcurrencyController();
    expect(controller.maxConcurrency).toBe(5);
  });

  // ─── Slow-start phase (exponential) ─────────────────────────────────────

  it('slow-start: doubles concurrency after first window', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 5 });
    // 5 successes = one full window → doubles to 10
    for (let i = 0; i < 5; i++) controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(10);
  });

  it('slow-start: keeps doubling each window', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 5 });
    // Window 1: 5 successes → 10
    for (let i = 0; i < 5; i++) controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(10);
    // Window 2: 10 successes → 20
    for (let i = 0; i < 10; i++) controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(20);
    // Window 3: 20 successes → 40
    for (let i = 0; i < 20; i++) controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(40);
  });

  it('slow-start: reaches high concurrency quickly', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 5 });
    // 5 → 10 → 20 → 40 → 80 → 160
    let total = 0;
    for (let window = 5; window <= 80; window *= 2) {
      for (let i = 0; i < window; i++) controller.recordSuccess();
      total += window;
    }
    expect(controller.maxConcurrency).toBe(160);
    expect(total).toBe(5 + 10 + 20 + 40 + 80); // 155 requests to reach 160 concurrency
  });

  it('does not increase before a full window completes', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 5 });
    for (let i = 0; i < 4; i++) {
      controller.recordSuccess();
    }
    expect(controller.maxConcurrency).toBe(5);
  });

  // ─── Congestion avoidance (AIMD) ────────────────────────────────────────

  it('switches to additive increase after first throttle', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 10 });
    // Throttle: sets ssthresh = 5, current = 5
    controller.recordThrottle();
    expect(controller.maxConcurrency).toBe(5);

    // Now in congestion avoidance — should be +1 per window, not doubling
    for (let i = 0; i < 5; i++) controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(6); // +1, not *2

    for (let i = 0; i < 6; i++) controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(7); // +1 again
  });

  it('multiplicative decrease: halves concurrency on throttle', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 10 });
    controller.recordThrottle();
    expect(controller.maxConcurrency).toBe(5);
  });

  it('respects minimum floor on throttle', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 1 });
    controller.recordThrottle();
    expect(controller.maxConcurrency).toBe(1);
  });

  it('respects maximum ceiling during slow-start', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 8, max: 10 });
    // 8 successes → would double to 16, but clamped to 10
    for (let i = 0; i < 8; i++) controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(10);
    // Fill another window — should stay clamped at 10
    for (let i = 0; i < 10; i++) controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(10);
  });

  // ─── Header-driven proactive backoff ────────────────────────────────────

  it('proactive backoff: clamps to remaining-requests from headers', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 20 });
    controller.recordSuccess({
      headers: { 'x-ratelimit-remaining-requests': '3' },
    });
    expect(controller.maxConcurrency).toBe(3);
  });

  it('proactive backoff switches to congestion avoidance', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 20 });
    // Header clamps to 10 → sets ssthresh, enters congestion avoidance
    controller.recordSuccess({
      headers: { 'x-ratelimit-remaining-requests': '10' },
    });
    expect(controller.maxConcurrency).toBe(10);

    // Should now be additive (+1), not doubling
    for (let i = 0; i < 10; i++) controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(11);
  });

  it('does not reduce below min even with low remaining-requests', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 5, min: 2 });
    controller.recordSuccess({
      headers: { 'x-ratelimit-remaining-requests': '0' },
    });
    expect(controller.maxConcurrency).toBe(2);
  });

  it('ignores remaining-requests when it exceeds current concurrency', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 5 });
    controller.recordSuccess({
      headers: { 'x-ratelimit-remaining-requests': '1000' },
    });
    // Should not jump up — only used for clamping down
    expect(controller.maxConcurrency).toBe(5);
  });

  it('normalizes anthropic header names for proactive backoff', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 20 });
    controller.recordSuccess({
      headers: {
        'anthropic-ratelimit-requests-remaining': '5',
        'x-ratelimit-remaining-requests': '5',
      },
    });
    expect(controller.maxConcurrency).toBe(5);
  });

  // ─── Delay / retry-after ────────────────────────────────────────────────

  it('sets retry-after delay on throttle', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 5 });
    controller.recordThrottle(5000);
    const delay = controller.getDelay();
    expect(delay).toBeGreaterThan(4900);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it('returns 0 delay when no throttle has occurred', () => {
    const controller = new AdaptiveConcurrencyController();
    expect(controller.getDelay()).toBe(0);
  });

  it('delay expires after waiting', async () => {
    const controller = new AdaptiveConcurrencyController({ initial: 5 });
    controller.recordThrottle(50);
    expect(controller.getDelay()).toBeGreaterThan(0);
    await new Promise(r => setTimeout(r, 60));
    expect(controller.getDelay()).toBe(0);
  });

  // ─── Recovery scenarios ─────────────────────────────────────────────────

  it('resets success counter on throttle', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 5 });
    for (let i = 0; i < 3; i++) controller.recordSuccess();
    controller.recordThrottle();
    expect(controller.maxConcurrency).toBe(2); // 5 * 0.5 = 2.5, floored to 2
    // Now in congestion avoidance: 2 successes → 3
    controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(2);
    controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(3);
  });

  it('custom decrease factor', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 10, decreaseFactor: 0.75 });
    controller.recordThrottle();
    expect(controller.maxConcurrency).toBe(7);
  });

  it('slow-start resumes up to ssthresh after throttle recovery', () => {
    const controller = new AdaptiveConcurrencyController({ initial: 20 });
    // Ramp to 40 via slow-start
    for (let i = 0; i < 20; i++) controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(40);

    // Throttle: current = 20, ssthresh = 20
    controller.recordThrottle();
    expect(controller.maxConcurrency).toBe(20);

    // Next window: current (20) >= ssthresh (20), so additive increase
    for (let i = 0; i < 20; i++) controller.recordSuccess();
    expect(controller.maxConcurrency).toBe(21); // +1, not *2
  });
});
