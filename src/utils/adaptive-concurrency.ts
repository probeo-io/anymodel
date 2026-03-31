import type { ResponseMeta } from '../types.js';

export interface AdaptiveConcurrencyOptions {
  /** Starting concurrency. Default: 5 */
  initial?: number;
  /** Minimum concurrency floor. Default: 1 */
  min?: number;
  /** Maximum concurrency ceiling. Default: 500 */
  max?: number;
  /** Multiplicative decrease factor on 429. Default: 0.5 */
  decreaseFactor?: number;
}

const DEFAULTS: Required<AdaptiveConcurrencyOptions> = {
  initial: 5,
  min: 1,
  max: 500,
  decreaseFactor: 0.5,
};

/**
 * Adaptive concurrency controller with TCP-style slow-start + AIMD.
 *
 * Phase 1 — Slow-start: doubles concurrency each window (exponential ramp)
 * until a 429 or header-driven backoff occurs.
 *
 * Phase 2 — Congestion avoidance (AIMD): after the first throttle sets
 * a threshold, switches to additive increase (+1 per window).
 *
 * On 429: multiplicative decrease (halve), set threshold to pre-throttle / 2.
 */
export class AdaptiveConcurrencyController {
  private current: number;
  private readonly min: number;
  private readonly max: number;
  private readonly decreaseFactor: number;
  private pauseUntil = 0;
  private successCount = 0;
  /** Slow-start threshold. Infinity = still in slow-start phase. */
  private ssthresh = Infinity;

  constructor(options?: AdaptiveConcurrencyOptions) {
    const opts = { ...DEFAULTS, ...options };
    this.current = opts.initial;
    this.min = opts.min;
    this.max = opts.max;
    this.decreaseFactor = opts.decreaseFactor;
  }

  /** Current allowed concurrency level. */
  get maxConcurrency(): number {
    return Math.floor(this.current);
  }

  /**
   * Record a successful response. Optionally pass response headers
   * to allow header-driven proactive adjustment.
   */
  recordSuccess(meta?: ResponseMeta): void {
    this.successCount++;

    if (this.successCount >= this.current) {
      if (this.current < this.ssthresh) {
        // Slow-start phase: double each window
        this.current = Math.min(this.current * 2, this.max);
      } else {
        // Congestion avoidance: additive increase (+1 per window)
        this.current = Math.min(this.current + 1, this.max);
      }
      this.successCount = 0;
    }

    // Proactive backoff: if remaining-requests is lower than current concurrency,
    // clamp down to avoid hitting the wall and enter congestion avoidance
    if (meta?.headers) {
      const remaining = meta.headers['x-ratelimit-remaining-requests']
        ?? meta.headers['anthropic-ratelimit-requests-remaining'];
      if (remaining !== undefined) {
        const remainingNum = parseInt(remaining, 10);
        if (!isNaN(remainingNum) && remainingNum < this.current) {
          // Treat this like a soft signal — set threshold and clamp
          this.ssthresh = Math.max(this.min, remainingNum);
          this.current = Math.max(this.min, remainingNum);
          this.successCount = 0;
        }
      }
    }
  }

  /**
   * Record a rate-limit (429) response. Halves concurrency, sets
   * slow-start threshold, and optionally pauses for retry-after.
   */
  recordThrottle(retryAfterMs?: number): void {
    // Set threshold to current / 2 before reducing
    this.ssthresh = Math.max(this.min, Math.floor(this.current * this.decreaseFactor));
    this.current = Math.max(this.min, Math.floor(this.current * this.decreaseFactor));
    this.successCount = 0;

    if (retryAfterMs && retryAfterMs > 0) {
      this.pauseUntil = Date.now() + retryAfterMs;
    }
  }

  /** Returns ms to wait before sending the next request (0 if none). */
  getDelay(): number {
    return Math.max(0, this.pauseUntil - Date.now());
  }
}
