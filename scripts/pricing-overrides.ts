/**
 * Reads prices.json — hand-verified rates that beat every fetched source.
 *
 * No vendor among OpenAI, Anthropic, Google, and xAI publishes machine-readable
 * pricing, so the generated table is only ever as good as the aggregators it is
 * built from. This is the escape hatch.
 *
 * The file is deliberately the smallest thing that can express a price: a model
 * id and two numbers, per million tokens, as vendors quote them. Everything
 * else — per-token conversion, cache rates, long-context tiers, spotting
 * entries upstream has caught up with — is handled here.
 */

export interface PricingTier {
  minPromptTokens: number;
  prompt: number;
  completion: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PricingEntry {
  prompt: number;
  completion: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiers?: PricingTier[];
}

export interface OverrideTier {
  /** Applies once the prompt reaches this many tokens. */
  from: number;
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** All rates per million tokens. Only `in` and `out` are required. */
export interface OverrideEntry {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiers?: OverrideTier[];
}

const PER_MILLION = 1_000_000;

/**
 * Below this, a figure is far likelier to be a per-token rate typed into a
 * per-million field than a real price. Nothing is sold at $0.001 per million.
 */
const IMPLAUSIBLY_SMALL = 0.001;

function requireRate(value: unknown, model: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${model}: '${field}' must be a non-negative number, got ${JSON.stringify(value)}`);
  }
  if (value > 0 && value < IMPLAUSIBLY_SMALL) {
    throw new Error(
      `${model}: '${field}' is ${value}, which looks like a per-token rate. `
      + 'Prices are per million tokens — $3.50 per 1M is 3.5, not 0.0000035.',
    );
  }
  return value;
}

function optionalRate(value: unknown, model: string, field: string): number | undefined {
  return value === undefined ? undefined : requireRate(value, model, field);
}

function parseTier(raw: any, model: string, index: number): OverrideTier {
  const where = `${model} tiers[${index}]`;
  if (typeof raw?.from !== 'number' || !Number.isInteger(raw.from) || raw.from <= 0) {
    throw new Error(`${where}: 'from' must be a positive token count, got ${JSON.stringify(raw?.from)}`);
  }
  return {
    from: raw.from,
    in: requireRate(raw.in, where, 'in'),
    out: requireRate(raw.out, where, 'out'),
    cacheRead: optionalRate(raw.cacheRead, where, 'cacheRead'),
    cacheWrite: optionalRate(raw.cacheWrite, where, 'cacheWrite'),
  };
}

/**
 * Validate the price file. Every problem throws and names the model — this is
 * hand-entered data feeding cost accounting, so a malformed entry must stop the
 * build rather than quietly price something wrong.
 *
 * Keys beginning with "//" or "$" are notes and are ignored, since JSON has no
 * comments.
 */
export function parseOverrides(raw: unknown): Map<string, OverrideEntry> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Price file must be a JSON object of "provider/model": { "in": n, "out": n }');
  }

  const parsed = new Map<string, OverrideEntry>();

  for (const [id, value] of Object.entries(raw as Record<string, any>)) {
    if (id.startsWith('//') || id.startsWith('$')) continue;
    if (!id.includes('/')) {
      throw new Error(`${id}: model ids are 'provider/model', matching the keys in the generated table`);
    }

    const tiers = (value?.tiers ?? []).map((tier: unknown, i: number) => parseTier(tier, id, i));
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].from <= tiers[i - 1].from) {
        throw new Error(`${id}: tiers must ascend by 'from'`);
      }
    }

    parsed.set(id, {
      in: requireRate(value?.in, id, 'in'),
      out: requireRate(value?.out, id, 'out'),
      cacheRead: optionalRate(value?.cacheRead, id, 'cacheRead'),
      cacheWrite: optionalRate(value?.cacheWrite, id, 'cacheWrite'),
      ...(tiers.length > 0 ? { tiers } : {}),
    });
  }

  return parsed;
}

/** Convert a hand-written price into the per-token shape the table stores. */
export function toPricingEntry(override: OverrideEntry): PricingEntry {
  const entry: PricingEntry = {
    prompt: override.in / PER_MILLION,
    completion: override.out / PER_MILLION,
  };
  if (override.cacheRead !== undefined) entry.cacheRead = override.cacheRead / PER_MILLION;
  if (override.cacheWrite !== undefined) entry.cacheWrite = override.cacheWrite / PER_MILLION;

  if (override.tiers?.length) {
    entry.tiers = override.tiers.map(tier => {
      const converted: PricingTier = {
        minPromptTokens: tier.from,
        prompt: tier.in / PER_MILLION,
        completion: tier.out / PER_MILLION,
      };
      if (tier.cacheRead !== undefined) converted.cacheRead = tier.cacheRead / PER_MILLION;
      if (tier.cacheWrite !== undefined) converted.cacheWrite = tier.cacheWrite / PER_MILLION;
      return converted;
    });
  }

  return entry;
}

export interface OverrideReport {
  /** Replaced a fetched rate with a different one. */
  changed: string[];
  /** Priced a model the fetched sources don't list at all. */
  added: string[];
  /** Now identical to what upstream returns — the entry can be deleted. */
  redundant: string[];
}

/**
 * Compared with a relative tolerance, not exact equality. Overrides reach this
 * as a per-million figure divided by 1e6, which lands a bit or two away from
 * the same rate parsed straight from a decimal string — 0.4/1e6 is
 * 4.0000000000000003e-7, not 4e-7. Exact comparison would report an override
 * that exactly matches upstream as a difference.
 */
function sameRate(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a === b) return true;
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-9;
}

function sameRates(a: PricingEntry, b: PricingEntry): boolean {
  if (!sameRate(a.prompt, b.prompt) || !sameRate(a.completion, b.completion)) return false;
  if (!sameRate(a.cacheRead, b.cacheRead) || !sameRate(a.cacheWrite, b.cacheWrite)) return false;

  const at = a.tiers ?? [];
  const bt = b.tiers ?? [];
  if (at.length !== bt.length) return false;
  return at.every((tier, i) => {
    const other = bt[i]!;
    return tier.minPromptTokens === other.minPromptTokens
      && sameRate(tier.prompt, other.prompt)
      && sameRate(tier.completion, other.completion)
      && sameRate(tier.cacheRead, other.cacheRead)
      && sameRate(tier.cacheWrite, other.cacheWrite);
  });
}

/**
 * Apply overrides in place, reporting what each one did. Redundant entries are
 * called out so the file stays honest: once upstream reports the same rate, the
 * hand-written one is dead weight that looks like it is doing something.
 */
export function applyOverrides(
  pricing: Map<string, PricingEntry>,
  overrides: Map<string, OverrideEntry>,
): OverrideReport {
  const report: OverrideReport = { changed: [], added: [], redundant: [] };

  for (const [id, override] of overrides) {
    const entry = toPricingEntry(override);
    const fetched = pricing.get(id);

    if (!fetched) report.added.push(id);
    else if (sameRates(fetched, entry)) report.redundant.push(id);
    else report.changed.push(id);

    pricing.set(id, entry);
  }

  return report;
}
