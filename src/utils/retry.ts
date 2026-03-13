import { AnyModelError } from '../types.js';

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number; // ms
  maxDelay: number;  // ms
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 2,
  baseDelay: 500,
  maxDelay: 10000,
};

// Retryable status codes
const RETRYABLE_CODES = new Set([429, 502, 503, 529]);

function isRetryable(error: unknown): boolean {
  if (error instanceof AnyModelError) {
    return RETRYABLE_CODES.has(error.code);
  }
  return false;
}

function getRetryAfter(error: unknown): number | null {
  if (error instanceof AnyModelError && error.metadata.raw) {
    const raw = error.metadata.raw as any;
    // Check for retry-after header value stored in metadata
    if (raw?.retry_after) return Number(raw.retry_after) * 1000;
    if (raw?.headers?.['retry-after']) return Number(raw.headers['retry-after']) * 1000;
  }
  return null;
}

function computeDelay(attempt: number, options: RetryOptions, error: unknown): number {
  const retryAfter = getRetryAfter(error);
  if (retryAfter && retryAfter > 0) {
    return Math.min(retryAfter, options.maxDelay);
  }
  // Exponential backoff with jitter
  const exponential = options.baseDelay * Math.pow(2, attempt);
  const jitter = exponential * 0.2 * Math.random();
  return Math.min(exponential + jitter, options.maxDelay);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_RETRY, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= opts.maxRetries || !isRetryable(error)) {
        throw error;
      }

      const delay = computeDelay(attempt, opts, error);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
