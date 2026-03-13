import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { AnyModelConfig } from './types.js';

const LOCAL_CONFIG_NAMES = ['anymodel.config.json'];
const GLOBAL_CONFIG_DIR = join(homedir(), '.anymodel');
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json');

/**
 * Interpolate ${ENV_VAR} references in string values.
 */
function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '');
}

/**
 * Recursively walk an object and interpolate string values.
 */
function interpolateDeep(obj: unknown): unknown {
  if (typeof obj === 'string') return interpolateEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(interpolateDeep);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateDeep(val);
    }
    return result;
  }
  return obj;
}

/**
 * Load a JSON config file, returning null if not found.
 */
function loadJsonFile(path: string): AnyModelConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return interpolateDeep(parsed) as AnyModelConfig;
  } catch {
    return null;
  }
}

/**
 * Find local config file in the working directory.
 */
function findLocalConfig(cwd?: string): AnyModelConfig | null {
  const dir = cwd || process.cwd();
  for (const name of LOCAL_CONFIG_NAMES) {
    const config = loadJsonFile(resolve(dir, name));
    if (config) return config;
  }
  return null;
}

/**
 * Load global config from ~/.anymodel/config.json
 */
function findGlobalConfig(): AnyModelConfig | null {
  return loadJsonFile(GLOBAL_CONFIG_FILE);
}

/**
 * Deep merge two config objects. Source values override target values.
 * Provider-level objects are merged, not replaced.
 */
function deepMerge(target: AnyModelConfig, source: AnyModelConfig): AnyModelConfig {
  const result: Record<string, unknown> = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    const existing = (target as Record<string, unknown>)[key];
    if (
      existing !== null && typeof existing === 'object' && !Array.isArray(existing) &&
      value !== null && typeof value === 'object' && !Array.isArray(value)
    ) {
      result[key] = deepMerge(existing as AnyModelConfig, value as AnyModelConfig);
    } else {
      result[key] = value;
    }
  }

  return result as AnyModelConfig;
}

/**
 * Build config from env vars only (auto-detected API keys).
 */
function envConfig(): AnyModelConfig {
  const config: AnyModelConfig = {};

  if (process.env.ANTHROPIC_API_KEY) {
    config.anthropic = { apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    config.openai = { apiKey: process.env.OPENAI_API_KEY };
  }
  if (process.env.GOOGLE_API_KEY) {
    config.google = { apiKey: process.env.GOOGLE_API_KEY };
  }

  return config;
}

/**
 * Resolve config with precedence: programmatic → local → global → env vars.
 */
export function resolveConfig(programmatic: AnyModelConfig = {}, cwd?: string): AnyModelConfig {
  const env = envConfig();
  const global = findGlobalConfig() || {};
  const local = findLocalConfig(cwd) || {};

  // Lowest priority first, each layer overrides the previous
  let config = deepMerge(env, global);
  config = deepMerge(config, local);
  config = deepMerge(config, programmatic);

  return config;
}
