/**
 * Fetches model pricing from OpenRouter and DeepInfra and generates a static
 * pricing table. Run at build time: `npx tsx scripts/fetch-pricing.ts`
 *
 * DeepInfra is fetched separately because OpenRouter lists the open models it
 * serves under their originating org (`meta-llama/...`), which says nothing
 * about what DeepInfra charges to serve them. Its own rates are keyed under
 * `deepinfra/` so that a `deepinfra/<org>/<model>` request resolves exactly.
 *
 * Falls back to the last committed version if either fetch fails.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'src', 'generated', 'pricing.ts');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/models';
const DEEPINFRA_API = 'https://api.deepinfra.com/v1/openai/models';

/** DeepInfra quotes USD per 1M tokens; the generated table stores per-token. */
const PER_MILLION = 1_000_000;

// Map OpenRouter model IDs to anymodel provider prefixes
const PROVIDER_MAP: Record<string, string> = {
  'openai': 'openai',
  'anthropic': 'anthropic',
  'google': 'google',
  'mistralai': 'mistral',
  'meta-llama': 'meta',
  'deepseek': 'deepseek',
  'x-ai': 'xai',
  'perplexity': 'perplexity',
  'qwen': 'qwen',
  'cohere': 'cohere',
};

interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;
    completion: string;
    input_cache_read?: string;
    input_cache_write?: string;
    web_search?: string;
  };
  context_length: number;
}

interface DeepInfraModel {
  id: string;
  metadata?: {
    tags?: string[];
    pricing?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
    };
  };
}

interface PricingEntry {
  prompt: number;
  completion: number;
  cacheRead?: number;
  cacheWrite?: number;
}

async function fetchPricing(): Promise<Map<string, PricingEntry>> {
  console.log('Fetching pricing from OpenRouter...');
  const res = await fetch(OPENROUTER_API);
  if (!res.ok) {
    throw new Error(`OpenRouter API returned ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as { data: OpenRouterModel[] };
  const pricing = new Map<string, PricingEntry>();

  for (const model of data.data) {
    if (!model.pricing?.prompt || !model.pricing?.completion) continue;

    const prompt = parseFloat(model.pricing.prompt);
    const completion = parseFloat(model.pricing.completion);

    // Skip free/zero-cost models
    if (prompt === 0 && completion === 0) continue;

    const entry: PricingEntry = { prompt, completion };
    if (model.pricing.input_cache_read) {
      entry.cacheRead = parseFloat(model.pricing.input_cache_read);
    }
    if (model.pricing.input_cache_write) {
      entry.cacheWrite = parseFloat(model.pricing.input_cache_write);
    }

    // Store with OpenRouter ID (provider/model format)
    pricing.set(model.id, entry);
  }

  console.log(`Fetched pricing for ${pricing.size} models`);
  return pricing;
}

/**
 * DeepInfra publishes per-model rates on its own model list. Only the chat
 * surface is priced per input/output token — embed, tts, and image models bill
 * on other units entirely, so they are skipped rather than mispriced.
 */
async function fetchDeepInfraPricing(): Promise<Map<string, PricingEntry>> {
  console.log('Fetching pricing from DeepInfra...');
  const res = await fetch(DEEPINFRA_API);
  if (!res.ok) {
    throw new Error(`DeepInfra API returned ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as { data: DeepInfraModel[] };
  const pricing = new Map<string, PricingEntry>();

  for (const model of data.data) {
    const meta = model.metadata;
    if (!meta?.tags?.includes('chat')) continue;

    const prompt = meta.pricing?.input_tokens ?? 0;
    const completion = meta.pricing?.output_tokens ?? 0;
    if (prompt === 0 && completion === 0) continue;

    const entry: PricingEntry = {
      prompt: prompt / PER_MILLION,
      completion: completion / PER_MILLION,
    };
    // DeepInfra charges for cache reads only — writes are free, so there is no
    // cacheWrite rate to record.
    if (meta.pricing?.cache_read_tokens !== undefined) {
      entry.cacheRead = meta.pricing.cache_read_tokens / PER_MILLION;
    }

    pricing.set(`deepinfra/${model.id}`, entry);
  }

  console.log(`Fetched pricing for ${pricing.size} DeepInfra chat models`);
  return pricing;
}

function generateSource(pricing: Map<string, PricingEntry>): string {
  const now = new Date().toISOString();
  const entries: string[] = [];

  for (const [id, entry] of pricing) {
    const parts = [`prompt: ${entry.prompt}, completion: ${entry.completion}`];
    if (entry.cacheRead !== undefined) parts.push(`cacheRead: ${entry.cacheRead}`);
    if (entry.cacheWrite !== undefined) parts.push(`cacheWrite: ${entry.cacheWrite}`);
    entries.push(`  '${id}': { ${parts.join(', ')} }`);
  }

  return `// Auto-generated by scripts/fetch-pricing.ts — DO NOT EDIT
// Sources: OpenRouter /api/v1/models, DeepInfra /v1/openai/models
// Generated: ${now}

import { providerPricingMultiplier, type PricingMode } from '../pricing/provider-policy.js';

export interface PricingEntry {
  /** Cost per token for input/prompt */
  prompt: number;
  /** Cost per token for output/completion */
  completion: number;
  /** Cost per token for cached input reads */
  cacheRead?: number;
  /** Cost per token for cached input writes */
  cacheWrite?: number;
}

/** Date this pricing data was fetched */
export const PRICING_AS_OF = '${now}';

/** Number of models with pricing data */
export const PRICING_MODEL_COUNT = ${pricing.size};

/**
 * Model pricing table keyed by OpenRouter model ID (provider/model format),
 * plus DeepInfra's own rates keyed as \`deepinfra/<org>/<model>\`.
 * Costs are per-token in USD.
 */
export const MODEL_PRICING: Record<string, PricingEntry> = {
${entries.join(',\n')},
};

/**
 * Look up pricing for a model.
 *
 * Resolution is exact first, then prefix matching decided by key length:
 *   1. The id as given, then its dot/dash-normalized form — the Anthropic API
 *      uses dashes (claude-opus-4-7) where OpenRouter uses dots (claude-opus-4.7).
 *   2. The longest known id that the query extends, so a dated or versioned id
 *      ("openai/gpt-4o-2024-08-06") falls back to its base ("openai/gpt-4o").
 *   3. Failing that, the shortest known id that extends the query.
 *
 * Every step is settled by key length and then alphabetically, never by the
 * order of this table. The table is regenerated from a remote API whose
 * ordering is arbitrary, so first-match-wins made a model's price liable to
 * change on a regeneration alone: "openai/gpt-6" prefix-matches four entries
 * spanning a 2x spread.
 *
 * ":batch" entries are a pricing mode rather than a model, so they only ever
 * match a query that asks for one.
 */
export function getModelPricing(modelId: string): PricingEntry | null {
  const exact = MODEL_PRICING[modelId];
  if (exact) return exact;

  const normalize = (id: string) => id.replace(/(\\d+)\\.(\\d+)/g, '$1-$2');
  const query = normalize(modelId);
  const wantsBatch = modelId.includes(':batch');

  const queryExtends: string[] = [];
  const extendsQuery: string[] = [];

  for (const id of Object.keys(MODEL_PRICING)) {
    if (id.includes(':batch') !== wantsBatch) continue;
    const key = normalize(id);
    if (key === query) return MODEL_PRICING[id];
    if (query.startsWith(key)) queryExtends.push(key);
    else if (key.startsWith(query)) extendsQuery.push(key);
  }

  const byLength = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
  const match = queryExtends.sort(byLength).pop() ?? extendsQuery.sort(byLength).shift();
  if (!match) return null;

  // Keys were normalized for comparison; recover the entry they came from.
  for (const [id, pricing] of Object.entries(MODEL_PRICING)) {
    if (normalize(id) === match) return pricing;
  }
  return null;
}

/**
 * Calculate the cost for a request given token counts.
 */
export function calculateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const pricing = getModelPricing(modelId);
  if (!pricing) return 0;
  const cachedTokens = cacheReadTokens + cacheWriteTokens;
  const uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
  return (uncachedPromptTokens * pricing.prompt)
    + (cacheReadTokens * (pricing.cacheRead ?? pricing.prompt))
    + (cacheWriteTokens * (pricing.cacheWrite ?? pricing.prompt))
    + (completionTokens * pricing.completion);
}

export function calculateProviderCost(input: { model: string; usage: { promptTokens: number; completionTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }; serviceTier?: 'auto' | 'flex'; batchMode?: 'native' | 'concurrent' }): { estimatedCost: number; multiplier: number; pricing: PricingEntry | null } {
  const pricing = getModelPricing(input.model);
  const provider = input.model.split('/')[0];
  const mode: PricingMode = input.batchMode === 'native' ? 'native_batch' : input.serviceTier === 'flex' ? 'flex' : 'standard';
  const multiplier = providerPricingMultiplier(provider, mode);
  return { estimatedCost: calculateCost(input.model, input.usage.promptTokens, input.usage.completionTokens, input.usage.cacheReadTokens, input.usage.cacheWriteTokens) * multiplier, multiplier, pricing };
}
`;
}

async function main() {
  const generatedDir = join(__dirname, '..', 'src', 'generated');
  if (!existsSync(generatedDir)) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(generatedDir, { recursive: true });
  }

  try {
    // Both must succeed: writing a table missing one source would silently
    // zero out every cost for that provider.
    const [openrouter, deepinfra] = await Promise.all([
      fetchPricing(),
      fetchDeepInfraPricing(),
    ]);
    const pricing = new Map([...openrouter, ...deepinfra]);
    console.log(`Total: ${pricing.size} models`);
    const source = generateSource(pricing);
    writeFileSync(OUTPUT_PATH, source);
    console.log(`Written to ${OUTPUT_PATH}`);
  } catch (err) {
    console.error('Failed to fetch pricing:', (err as Error).message);
    if (existsSync(OUTPUT_PATH)) {
      console.log('Using existing pricing data as fallback');
    } else {
      console.error('No fallback available — generating empty pricing table');
      const empty = generateSource(new Map());
      writeFileSync(OUTPUT_PATH, empty);
    }
    process.exit(0); // Don't fail the build
  }
}

main();
