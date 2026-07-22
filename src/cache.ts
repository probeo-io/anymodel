import type { ChatCompletionRequest, PromptCacheOptions } from './types.js';
import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';

export interface PromptCacheKeyOptions {
  prefix?: string;
  maxLength?: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

async function sha256Base64Url(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/**
 * Create a stable prompt cache key from the inputs that define a reusable prompt
 * prefix, such as workflow version, domain, schema version, and archetype set.
 */
export async function createPromptCacheKey(
  parts: unknown,
  options: PromptCacheKeyOptions = {},
): Promise<string> {
  const maxLength = options.maxLength ?? 128;
  const prefix = options.prefix ? `${options.prefix}:` : '';
  const hash = await sha256Base64Url(stableStringify(parts));
  return `${prefix}${hash}`.slice(0, maxLength);
}

/**
 * Attach provider-neutral prompt cache options to a chat completion request.
 */
export function withPromptCache<T extends ChatCompletionRequest>(
  request: T,
  cache: PromptCacheOptions,
): T {
  return {
    ...request,
    cache: {
      ...request.cache,
      ...cache,
    },
  };
}
