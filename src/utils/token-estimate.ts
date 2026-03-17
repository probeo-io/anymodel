/**
 * Rough token estimation and model-limit lookups for automatic max_tokens calculation.
 */

const CHARS_PER_TOKEN = 4;

/** Estimate the number of tokens in a string (~4 chars per token). */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

interface ModelLimit {
  contextLength: number;
  maxCompletionTokens: number;
}

const MODEL_LIMITS: Array<{ pattern: string; limit: ModelLimit }> = [
  // OpenAI
  { pattern: 'gpt-4o-mini',    limit: { contextLength: 128_000,   maxCompletionTokens: 16_384  } },
  { pattern: 'gpt-4o',         limit: { contextLength: 128_000,   maxCompletionTokens: 16_384  } },
  { pattern: 'gpt-4-turbo',    limit: { contextLength: 128_000,   maxCompletionTokens: 4_096   } },
  { pattern: 'gpt-3.5-turbo',  limit: { contextLength: 16_385,    maxCompletionTokens: 4_096   } },
  { pattern: 'o1',             limit: { contextLength: 200_000,   maxCompletionTokens: 100_000 } },
  { pattern: 'o3',             limit: { contextLength: 200_000,   maxCompletionTokens: 100_000 } },
  { pattern: 'o4-mini',        limit: { contextLength: 200_000,   maxCompletionTokens: 100_000 } },

  // Anthropic
  { pattern: 'claude-opus-4',      limit: { contextLength: 200_000, maxCompletionTokens: 32_768 } },
  { pattern: 'claude-sonnet-4',    limit: { contextLength: 200_000, maxCompletionTokens: 16_384 } },
  { pattern: 'claude-haiku-4',     limit: { contextLength: 200_000, maxCompletionTokens: 8_192  } },
  { pattern: 'claude-3.5-sonnet',  limit: { contextLength: 200_000, maxCompletionTokens: 8_192  } },
  { pattern: 'claude-3-opus',      limit: { contextLength: 200_000, maxCompletionTokens: 4_096  } },

  // Google
  { pattern: 'gemini-2.5-pro',   limit: { contextLength: 1_048_576, maxCompletionTokens: 65_536 } },
  { pattern: 'gemini-2.5-flash', limit: { contextLength: 1_048_576, maxCompletionTokens: 65_536 } },
  { pattern: 'gemini-2.0-flash', limit: { contextLength: 1_048_576, maxCompletionTokens: 65_536 } },
  { pattern: 'gemini-1.5-pro',   limit: { contextLength: 2_097_152, maxCompletionTokens: 8_192  } },
  { pattern: 'gemini-1.5-flash', limit: { contextLength: 1_048_576, maxCompletionTokens: 8_192  } },
];

const DEFAULT_LIMIT: ModelLimit = { contextLength: 128_000, maxCompletionTokens: 4_096 };

/**
 * Look up context-window and max-completion-token limits for a model.
 * Strips any "provider/" prefix before matching.
 */
function getModelLimits(model: string): ModelLimit {
  // Strip provider prefix (e.g. "openai/gpt-4o" -> "gpt-4o")
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;

  for (const entry of MODEL_LIMITS) {
    if (bare.startsWith(entry.pattern) || bare.includes(entry.pattern)) {
      return entry.limit;
    }
  }
  return DEFAULT_LIMIT;
}

/**
 * Determine the best max_tokens value for a request.
 *
 * - If the caller already supplied a value, return it unchanged.
 * - Otherwise estimate input tokens, apply a 5 % safety margin, then
 *   return min(maxCompletionTokens, contextLength - estimatedInput).
 * - The result is clamped to at least 1.
 */
export function resolveMaxTokens(
  model: string,
  messages: unknown[],
  userMaxTokens?: number,
): number {
  if (userMaxTokens !== undefined) return userMaxTokens;

  const inputChars = JSON.stringify(messages).length;
  const estimatedInput = Math.ceil(inputChars / CHARS_PER_TOKEN);
  const estimatedWithMargin = Math.ceil(estimatedInput * 1.05);

  const limits = getModelLimits(model);
  const available = limits.contextLength - estimatedWithMargin;
  const result = Math.min(limits.maxCompletionTokens, available);

  return Math.max(1, result);
}
