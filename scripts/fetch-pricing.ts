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
import { applyOverrides, parseOverrides } from './pricing-overrides.js';
import type { PricingEntry, PricingTier } from './pricing-overrides.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'src', 'generated', 'pricing.ts');
const PRICES_PATH = join(__dirname, '..', 'prices.json');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/models';
const DEEPINFRA_API = 'https://api.deepinfra.com/v1/openai/models';
const LITELLM_PRICES = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * Providers anymodel routes to directly, and whose rates therefore get a
 * second opinion. None of the four publish machine-readable pricing of their
 * own, so OpenRouter is the source and LiteLLM is only a check on it.
 */
const CROSS_CHECKED = ['openai/', 'anthropic/', 'google/', 'x-ai/'];
const LITELLM_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'xai']);

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

interface OpenRouterOverride {
  /** Present on long-context tiers; absent on time-window and audio overrides. */
  min_prompt_tokens?: number;
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  utc_start?: string;
  utc_end?: string;
}

interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;
    completion: string;
    input_cache_read?: string;
    input_cache_write?: string;
    web_search?: string;
    overrides?: OpenRouterOverride[];
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

/**
 * Long-context tiers only. OpenRouter also carries time-window overrides
 * (`utc_start`/`utc_end`, for off-peak rates) and audio rates in the same
 * array; both need inputs a static table has no access to at estimate time,
 * so they are skipped rather than applied as if they were token tiers.
 */
function parseTiers(overrides: OpenRouterOverride[] | undefined): PricingTier[] {
  const tiers: PricingTier[] = [];
  let skipped = 0;

  for (const override of overrides ?? []) {
    if (override.min_prompt_tokens === undefined) { skipped++; continue; }
    if (!override.prompt || !override.completion) { skipped++; continue; }

    const tier: PricingTier = {
      minPromptTokens: override.min_prompt_tokens,
      prompt: parseFloat(override.prompt),
      completion: parseFloat(override.completion),
    };
    if (override.input_cache_read) tier.cacheRead = parseFloat(override.input_cache_read);
    if (override.input_cache_write) tier.cacheWrite = parseFloat(override.input_cache_write);
    tiers.push(tier);
  }

  if (skipped > 0) skippedOverrides += skipped;
  return tiers.sort((a, b) => a.minPromptTokens - b.minPromptTokens);
}

/** Counted so a growing pile of unhandled override kinds stays visible. */
let skippedOverrides = 0;

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

    const tiers = parseTiers(model.pricing.overrides);
    if (tiers.length > 0) entry.tiers = tiers;

    // Store with OpenRouter ID (provider/model format)
    pricing.set(model.id, entry);
  }

  const tiered = [...pricing.values()].filter(e => e.tiers).length;
  console.log(`Fetched pricing for ${pricing.size} models (${tiered} with long-context tiers)`);
  if (skippedOverrides > 0) {
    console.log(`Skipped ${skippedOverrides} time-window/audio override(s) — not representable in a static table`);
  }
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

  // Sorted so a regeneration diffs only where a rate actually moved. Both
  // upstream APIs return models in an order that shifts between fetches, which
  // otherwise reshuffles all 500-odd lines and buries the real change.
  const sorted = [...pricing.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [id, entry] of sorted) {
    const parts = [`prompt: ${entry.prompt}, completion: ${entry.completion}`];
    if (entry.cacheRead !== undefined) parts.push(`cacheRead: ${entry.cacheRead}`);
    if (entry.cacheWrite !== undefined) parts.push(`cacheWrite: ${entry.cacheWrite}`);
    if (entry.tiers) {
      const tiers = entry.tiers.map(tier => {
        const t = [`minPromptTokens: ${tier.minPromptTokens}`, `prompt: ${tier.prompt}`, `completion: ${tier.completion}`];
        if (tier.cacheRead !== undefined) t.push(`cacheRead: ${tier.cacheRead}`);
        if (tier.cacheWrite !== undefined) t.push(`cacheWrite: ${tier.cacheWrite}`);
        return `{ ${t.join(', ')} }`;
      });
      parts.push(`tiers: [${tiers.join(', ')}]`);
    }
    entries.push(`  '${id}': { ${parts.join(', ')} }`);
  }

  return `// Auto-generated by scripts/fetch-pricing.ts — DO NOT EDIT
// Sources: OpenRouter /api/v1/models, DeepInfra /v1/openai/models
// Generated: ${now}

import { providerPricingMultiplier, type PricingMode } from '../pricing/provider-policy.js';

export interface PricingTier {
  /** Applies once a request's prompt reaches this many tokens. */
  minPromptTokens: number;
  prompt: number;
  completion: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PricingEntry {
  /** Cost per token for input/prompt */
  prompt: number;
  /** Cost per token for output/completion */
  completion: number;
  /** Cost per token for cached input reads */
  cacheRead?: number;
  /** Cost per token for cached input writes */
  cacheWrite?: number;
  /**
   * Long-context pricing, ascending by threshold. Several providers charge
   * more past a prompt size — OpenAI doubles input above 272k tokens on some
   * models, xAI above 200k. Absent when a model bills one flat rate.
   */
  tiers?: PricingTier[];
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
 * The rates in effect for a prompt of this size: the highest long-context tier
 * the request reaches, or the model's base rates when it reaches none.
 */
export function effectiveRates(pricing: PricingEntry, promptTokens: number): PricingEntry {
  let rates: PricingEntry = pricing;
  let threshold = -1;

  for (const tier of pricing.tiers ?? []) {
    if (promptTokens < tier.minPromptTokens || tier.minPromptTokens <= threshold) continue;
    threshold = tier.minPromptTokens;
    rates = {
      prompt: tier.prompt,
      completion: tier.completion,
      cacheRead: tier.cacheRead,
      cacheWrite: tier.cacheWrite,
    };
  }

  return rates;
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
  // Tiers key off the full prompt, cached portion included — that is what the
  // provider measures the request against.
  const rates = effectiveRates(pricing, promptTokens);
  const cachedTokens = cacheReadTokens + cacheWriteTokens;
  const uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
  return (uncachedPromptTokens * rates.prompt)
    + (cacheReadTokens * (rates.cacheRead ?? rates.prompt))
    + (cacheWriteTokens * (rates.cacheWrite ?? rates.prompt))
    + (completionTokens * rates.completion);
}

export function calculateProviderCost(input: { model: string; usage: { promptTokens: number; completionTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; toolCost?: number }; serviceTier?: 'auto' | 'flex'; batchMode?: 'native' | 'concurrent' }): { estimatedCost: number; multiplier: number; pricing: PricingEntry | null } {
  const pricing = getModelPricing(input.model);
  const provider = input.model.split('/')[0];
  const mode: PricingMode = input.batchMode === 'native' ? 'native_batch' : input.serviceTier === 'flex' ? 'flex' : 'standard';
  const multiplier = providerPricingMultiplier(provider, mode);
  // Tool fees (web searches, request fees) are per call and not discounted by batch or flex.
  const tokens = calculateCost(input.model, input.usage.promptTokens, input.usage.completionTokens, input.usage.cacheReadTokens, input.usage.cacheWriteTokens) * multiplier;
  return { estimatedCost: tokens + (input.usage.toolCost ?? 0), multiplier, pricing };
}
`;
}

interface LiteLLMEntry {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
}

/** Reduce a vendor-native or OpenRouter id to a form the two sources share. */
function crossCheckKey(id: string): string {
  const bare = id.toLowerCase().split('/').pop() ?? id.toLowerCase();
  return bare.replace(/-(20\d{6}|v\d+:\d+|latest)$/, '').replace(/[._]/g, '-');
}

/**
 * Compare our OpenRouter-derived rates against LiteLLM's independent table and
 * report anything the two disagree on. This is advisory: a mismatch can mean a
 * stale entry on either side, or a genuinely different rate, and resolving it
 * needs a human looking at the vendor's pricing page. A failure to reach
 * LiteLLM is warned about rather than fatal — it validates the table, it does
 * not supply it.
 */
async function crossCheckRates(pricing: Map<string, PricingEntry>): Promise<void> {
  console.log('Cross-checking direct-provider rates against LiteLLM...');

  let data: Record<string, LiteLLMEntry>;
  try {
    const res = await fetch(LITELLM_PRICES);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    data = await res.json() as Record<string, LiteLLMEntry>;
  } catch (err) {
    console.warn(`  Skipped — could not reach LiteLLM: ${(err as Error).message}`);
    return;
  }

  const theirs = new Map<string, [number, number]>();
  for (const [id, entry] of Object.entries(data)) {
    if (!entry || !LITELLM_PROVIDERS.has(entry.litellm_provider ?? '')) continue;
    const { input_cost_per_token: input, output_cost_per_token: output } = entry;
    if (!input || !output) continue;
    const key = crossCheckKey(id);
    if (!theirs.has(key)) theirs.set(key, [input, output]);
  }

  const suggestions: Array<{ id: string; theirs: [number, number]; line: string }> = [];
  let matched = 0;

  for (const [id, entry] of pricing) {
    if (id.includes(':batch') || !CROSS_CHECKED.some(prefix => id.startsWith(prefix))) continue;
    const other = theirs.get(crossCheckKey(id));
    if (!other) continue;
    matched++;
    if (Math.abs(other[0] - entry.prompt) < 1e-12 && Math.abs(other[1] - entry.completion) < 1e-12) continue;
    suggestions.push({
      id,
      theirs: other,
      line: `  ! ${id.padEnd(38)} ours ${(entry.prompt * 1e6).toFixed(3)}/${(entry.completion * 1e6).toFixed(3)}`
        + `  litellm ${(other[0] * 1e6).toFixed(3)}/${(other[1] * 1e6).toFixed(3)}  per 1M in/out`,
    });
  }

  console.log(`  Compared ${matched} models, ${matched - suggestions.length} agree, ${suggestions.length} differ`);
  for (const { line } of suggestions) console.log(line);

  if (suggestions.length > 0) {
    console.log('\n  Check the vendor pricing page, then paste the right figure into prices.json:\n');
    for (const { id, theirs } of suggestions) {
      console.log(`    "${id}": { "in": ${theirs[0] * 1e6}, "out": ${theirs[1] * 1e6} },`);
    }
    console.log('');
  }
}

/**
 * Load and apply the hand-maintained overrides. A malformed file is fatal:
 * these rates feed cost accounting, and a silently ignored entry would price
 * requests wrong while looking like it was working.
 */
/**
 * Layer prices.json over the fetched rates. A malformed file is fatal: these
 * feed cost accounting, and a silently ignored entry would price requests wrong
 * while looking like it was working.
 */
function applyManualOverrides(pricing: Map<string, PricingEntry>): void {
  if (!existsSync(PRICES_PATH)) return;

  const overrides = parseOverrides(JSON.parse(readFileSync(PRICES_PATH, 'utf-8')));
  if (overrides.size === 0) return;

  const report = applyOverrides(pricing, overrides);
  console.log(`Applying prices.json... ${overrides.size} entr${overrides.size === 1 ? 'y' : 'ies'}`);
  if (report.changed.length) console.log(`  Replaced fetched rates: ${report.changed.join(', ')}`);
  if (report.added.length) console.log(`  Priced models absent upstream: ${report.added.join(', ')}`);
  if (report.redundant.length) {
    console.log(`  Upstream now matches, safe to delete: ${report.redundant.join(', ')}`);
  }
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
    applyManualOverrides(pricing);
    // Cross-check the final table, so an override that fixes a bad upstream
    // rate shows up as agreement rather than still being reported as a diff.
    await crossCheckRates(pricing);
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
