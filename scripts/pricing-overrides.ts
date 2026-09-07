/**
 * Hand-maintained rates layered over the fetched pricing sources.
 *
 * No vendor among OpenAI, Anthropic, Google, and xAI publishes machine-readable
 * pricing, so the generated table is only ever as good as the aggregators it is
 * built from. This is the escape hatch: a rate read off a vendor's own pricing
 * page, recorded by hand, that wins over whatever was fetched.
 *
 * Rates are written per million tokens, the way vendors quote them and the way
 * you will be reading them when you transcribe one. The generated table stores
 * per-token; converting here rather than at the keyboard is what stops a
 * misplaced zero from becoming a 10x billing error.
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
  minPromptTokens: number;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

export interface OverrideEntry {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  tiers?: OverrideTier[];
  /** Where the rate was read from — a vendor pricing page, ideally. */
  source?: string;
  /** ISO date the rate was last confirmed against that source. */
  checked?: string;
  note?: string;
}

const PER_MILLION = 1_000_000;

/**
 * Below this, a figure is far likelier to be a per-token rate typed into a
 * per-million field than a real price. Nothing is sold at $0.001 per million.
 */
const IMPLAUSIBLY_SMALL = 0.001;

/** Overrides are transcribed by hand and go stale silently; say so. */
const STALE_AFTER_DAYS = 180;

function requireRate(value: unknown, model: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${model}: '${field}' must be a non-negative number, got ${JSON.stringify(value)}`);
  }
  if (value > 0 && value < IMPLAUSIBLY_SMALL) {
    throw new Error(
      `${model}: '${field}' is ${value}, which looks like a per-token rate. `
      + 'Overrides are written per million tokens — $3.50 per 1M is 3.5, not 0.0000035.',
    );
  }
  return value;
}

function optionalRate(value: unknown, model: string, field: string): number | undefined {
  return value === undefined ? undefined : requireRate(value, model, field);
}

function parseTier(raw: any, model: string, index: number): OverrideTier {
  const where = `${model} tiers[${index}]`;
  const min = raw?.minPromptTokens;
  if (typeof min !== 'number' || !Number.isInteger(min) || min <= 0) {
    throw new Error(`${where}: 'minPromptTokens' must be a positive integer, got ${JSON.stringify(min)}`);
  }
  return {
    minPromptTokens: min,
    inputPerMillion: requireRate(raw.inputPerMillion, where, 'inputPerMillion'),
    outputPerMillion: requireRate(raw.outputPerMillion, where, 'outputPerMillion'),
    cacheReadPerMillion: optionalRate(raw.cacheReadPerMillion, where, 'cacheReadPerMillion'),
    cacheWritePerMillion: optionalRate(raw.cacheWritePerMillion, where, 'cacheWritePerMillion'),
  };
}

/**
 * Validate the override file. Every problem throws and names the model — this
 * is hand-entered data feeding cost accounting, so a malformed entry must stop
 * the build rather than quietly price something wrong.
 */
export function parseOverrides(raw: unknown): Map<string, OverrideEntry> {
  const models = (raw as any)?.models;
  if (models === undefined) return new Map();
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    throw new Error("Override file: 'models' must be an object keyed by model id");
  }

  const parsed = new Map<string, OverrideEntry>();

  for (const [id, value] of Object.entries(models as Record<string, any>)) {
    if (!id.includes('/')) {
      throw new Error(`${id}: model ids are 'provider/model', matching the keys in the generated table`);
    }

    const tiers = (value?.tiers ?? []).map((tier: unknown, i: number) => parseTier(tier, id, i));
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].minPromptTokens <= tiers[i - 1].minPromptTokens) {
        throw new Error(`${id}: tiers must ascend by minPromptTokens`);
      }
    }

    parsed.set(id, {
      inputPerMillion: requireRate(value?.inputPerMillion, id, 'inputPerMillion'),
      outputPerMillion: requireRate(value?.outputPerMillion, id, 'outputPerMillion'),
      cacheReadPerMillion: optionalRate(value?.cacheReadPerMillion, id, 'cacheReadPerMillion'),
      cacheWritePerMillion: optionalRate(value?.cacheWritePerMillion, id, 'cacheWritePerMillion'),
      ...(tiers.length > 0 ? { tiers } : {}),
      source: value?.source,
      checked: value?.checked,
      note: value?.note,
    });
  }

  return parsed;
}

/** Convert a hand-written override into the per-token shape the table stores. */
export function toPricingEntry(override: OverrideEntry): PricingEntry {
  const entry: PricingEntry = {
    prompt: override.inputPerMillion / PER_MILLION,
    completion: override.outputPerMillion / PER_MILLION,
  };
  if (override.cacheReadPerMillion !== undefined) entry.cacheRead = override.cacheReadPerMillion / PER_MILLION;
  if (override.cacheWritePerMillion !== undefined) entry.cacheWrite = override.cacheWritePerMillion / PER_MILLION;

  if (override.tiers?.length) {
    entry.tiers = override.tiers.map(tier => {
      const converted: PricingTier = {
        minPromptTokens: tier.minPromptTokens,
        prompt: tier.inputPerMillion / PER_MILLION,
        completion: tier.outputPerMillion / PER_MILLION,
      };
      if (tier.cacheReadPerMillion !== undefined) converted.cacheRead = tier.cacheReadPerMillion / PER_MILLION;
      if (tier.cacheWritePerMillion !== undefined) converted.cacheWrite = tier.cacheWritePerMillion / PER_MILLION;
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
  /** Now identical to what upstream returns — the override can be retired. */
  redundant: string[];
  /** Confirmed longer ago than STALE_AFTER_DAYS, or never dated. */
  stale: string[];
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

function isStale(checked: string | undefined, now: Date): boolean {
  if (!checked) return true;
  const when = Date.parse(checked);
  if (Number.isNaN(when)) return true;
  return (now.getTime() - when) / 86_400_000 > STALE_AFTER_DAYS;
}

/**
 * Apply overrides in place, reporting what each one did. Redundant and stale
 * entries are called out so the file stays honest — a hand-maintained list
 * whose entries silently duplicate upstream is worse than no list.
 */
export function applyOverrides(
  pricing: Map<string, PricingEntry>,
  overrides: Map<string, OverrideEntry>,
  now: Date = new Date(),
): OverrideReport {
  const report: OverrideReport = { changed: [], added: [], redundant: [], stale: [] };

  for (const [id, override] of overrides) {
    const entry = toPricingEntry(override);
    const fetched = pricing.get(id);

    if (!fetched) report.added.push(id);
    else if (sameRates(fetched, entry)) report.redundant.push(id);
    else report.changed.push(id);

    if (isStale(override.checked, now)) report.stale.push(id);

    pricing.set(id, entry);
  }

  return report;
}
