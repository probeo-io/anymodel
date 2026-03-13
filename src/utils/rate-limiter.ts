/**
 * Per-provider rate limit tracker.
 * Tracks rate limit state from provider response headers and 429 errors.
 */
export interface RateLimitState {
  provider: string;
  remaining: number | null;
  resetAt: number | null; // epoch ms
  retryAfter: number | null; // ms
  lastUpdated: number;
}

export class RateLimitTracker {
  private state = new Map<string, RateLimitState>();

  /**
   * Update rate limit state from response headers.
   */
  updateFromHeaders(provider: string, headers: Record<string, string>): void {
    const state = this.getOrCreate(provider);

    const remaining = headers['x-ratelimit-remaining'] || headers['x-ratelimit-remaining-requests'];
    if (remaining !== undefined) {
      state.remaining = parseInt(remaining, 10);
    }

    const reset = headers['x-ratelimit-reset'] || headers['x-ratelimit-reset-requests'];
    if (reset !== undefined) {
      // Could be epoch seconds or ISO date
      const parsed = Number(reset);
      state.resetAt = parsed > 1e12 ? parsed : parsed * 1000;
    }

    const retryAfter = headers['retry-after'];
    if (retryAfter !== undefined) {
      state.retryAfter = Number(retryAfter) * 1000;
    }

    state.lastUpdated = Date.now();
  }

  /**
   * Record a 429 for a provider.
   */
  recordRateLimit(provider: string, retryAfterMs?: number): void {
    const state = this.getOrCreate(provider);
    state.remaining = 0;
    if (retryAfterMs) {
      state.retryAfter = retryAfterMs;
      state.resetAt = Date.now() + retryAfterMs;
    }
    state.lastUpdated = Date.now();
  }

  /**
   * Check if a provider is currently rate-limited.
   */
  isRateLimited(provider: string): boolean {
    const state = this.state.get(provider);
    if (!state) return false;

    // Check remaining count
    if (state.remaining === 0 && state.resetAt) {
      return Date.now() < state.resetAt;
    }

    return false;
  }

  /**
   * Get ms until rate limit resets for a provider.
   */
  getWaitTime(provider: string): number {
    const state = this.state.get(provider);
    if (!state?.resetAt) return 0;

    const wait = state.resetAt - Date.now();
    return Math.max(0, wait);
  }

  /**
   * Get state for a provider.
   */
  getState(provider: string): RateLimitState | undefined {
    return this.state.get(provider);
  }

  private getOrCreate(provider: string): RateLimitState {
    let state = this.state.get(provider);
    if (!state) {
      state = {
        provider,
        remaining: null,
        resetAt: null,
        retryAfter: null,
        lastUpdated: Date.now(),
      };
      this.state.set(provider, state);
    }
    return state;
  }
}
