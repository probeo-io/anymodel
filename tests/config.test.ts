import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.js';

const TEST_DIR = join(import.meta.dirname, '.test-config');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('resolveConfig', () => {
  it('returns programmatic config when no files exist', () => {
    const config = resolveConfig({ anthropic: { apiKey: 'sk-test' } }, TEST_DIR);
    expect(config.anthropic?.apiKey).toBe('sk-test');
  });

  it('loads local config file', () => {
    writeFileSync(
      join(TEST_DIR, 'anymodel.config.json'),
      JSON.stringify({ aliases: { fast: 'anthropic/claude-haiku-4-5' } }),
    );

    const config = resolveConfig({}, TEST_DIR);
    expect(config.aliases?.fast).toBe('anthropic/claude-haiku-4-5');
  });

  it('programmatic overrides local config', () => {
    writeFileSync(
      join(TEST_DIR, 'anymodel.config.json'),
      JSON.stringify({ defaults: { temperature: 0.5 } }),
    );

    const config = resolveConfig({ defaults: { temperature: 0.9 } }, TEST_DIR);
    expect(config.defaults?.temperature).toBe(0.9);
  });

  it('deep merges provider configs', () => {
    writeFileSync(
      join(TEST_DIR, 'anymodel.config.json'),
      JSON.stringify({ anthropic: { defaultModel: 'claude-haiku-4-5' } }),
    );

    const config = resolveConfig({ anthropic: { apiKey: 'sk-test' } }, TEST_DIR);
    expect(config.anthropic?.apiKey).toBe('sk-test');
    expect(config.anthropic?.defaultModel).toBe('claude-haiku-4-5');
  });

  it('interpolates ${ENV_VAR} in config values', () => {
    process.env.__TEST_KEY = 'sk-from-env';
    writeFileSync(
      join(TEST_DIR, 'anymodel.config.json'),
      JSON.stringify({ openai: { apiKey: '${__TEST_KEY}' } }),
    );

    const config = resolveConfig({}, TEST_DIR);
    expect(config.openai?.apiKey).toBe('sk-from-env');
    delete process.env.__TEST_KEY;
  });

  it('picks up API keys from env vars', () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-env-anthropic';

    const config = resolveConfig({}, TEST_DIR);
    expect(config.anthropic?.apiKey).toBe('sk-env-anthropic');

    if (origKey) {
      process.env.ANTHROPIC_API_KEY = origKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('handles missing config files gracefully', () => {
    const config = resolveConfig({}, '/nonexistent/path');
    expect(config).toBeDefined();
  });
});
