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

const CACHE_KEY_REQUEST_LIMIT = 15;
const CACHE_KEY_WINDOW_MS = 60_000;
const CACHE_KEY_MAX_LENGTH = 64;

type CacheKeyPool = Map<number, number[]>;

/**
 * OpenAI recommends keeping a prompt cache key to roughly 15 requests per
 * minute. Keep that scheduling detail here, rather than making every caller
 * choose and hash an arbitrary number of cache partitions.
 */
const cacheKeyPools = new Map<string, CacheKeyPool>();

function providerKey(logicalKey: string, slot: number): string {
  if (slot === 0) return logicalKey.slice(0, CACHE_KEY_MAX_LENGTH);
  const suffix = `:rate-${slot + 1}`;
  return `${logicalKey.slice(0, CACHE_KEY_MAX_LENGTH - suffix.length)}${suffix}`;
}

/**
 * Resolve a provider-safe cache key. Identical reusable prefixes use the same
 * key until its request budget is full; only overflow receives another key.
 */
export function resolvePromptCache(cache: PromptCacheOptions, now = Date.now()): PromptCacheOptions {
  if (!cache.key || cache.mode !== 'explicit') return cache;
  const pool = cacheKeyPools.get(cache.key) ?? new Map<number, number[]>();
  const cutoff = now - CACHE_KEY_WINDOW_MS;

  for (const [slot, requests] of pool) {
    const active = requests.filter((time) => time > cutoff);
    if (active.length === 0) pool.delete(slot);
    else pool.set(slot, active);
  }

  let slot = 0;
  while ((pool.get(slot)?.length ?? 0) >= CACHE_KEY_REQUEST_LIMIT) slot += 1;
  const requests = pool.get(slot) ?? [];
  requests.push(now);
  pool.set(slot, requests);
  cacheKeyPools.set(cache.key, pool);

  return { ...cache, key: providerKey(cache.key, slot) };
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
