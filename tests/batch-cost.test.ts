import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BatchManager } from '../src/batch/manager.js';
import { MODEL_PRICING, calculateCost, calculateProviderCost, getModelPricing } from '../src/generated/pricing.js';
import type { Router } from '../src/router.js';
import type { ChatCompletion, ChatCompletionWithMeta } from '../src/types.js';

const TEST_DIR = join(import.meta.dirname, '.test-batch-cost');

function makeCompletion(model: string): ChatCompletion {
  return {
    id: 'gen-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

function createMockRouter(model: string): Router {
  const completion = makeCompletion(model);
  return {
    complete: async () => completion,
    completeWithMeta: async (): Promise<ChatCompletionWithMeta> => ({
      completion,
      meta: { headers: {} },
    }),
  } as unknown as Router;
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Batch cost calculation', () => {
  it('charges cache reads and writes at their generated rates', () => {
    // Derive the expectation from the table rather than pinning literal rates,
    // which otherwise break this test every time pricing is regenerated.
    const model = 'openai/gpt-5.6-luna';
    const rates = getModelPricing(model)!;
    expect(rates.cacheRead).toBeDefined();
    expect(rates.cacheWrite).toBeDefined();

    const cost = calculateCost(model, 1_000_000, 100_000, 400_000, 100_000);

    expect(cost).toBeCloseTo(
      500_000 * rates.prompt
      + 400_000 * rates.cacheRead!
      + 100_000 * rates.cacheWrite!
      + 100_000 * rates.completion,
      12,
    );
  });

  it('bills DeepInfra requests from DeepInfra\'s own rates, not the originating org\'s', () => {
    // OpenRouter lists the same open weights under meta-llama/…; what DeepInfra
    // charges to serve them is a separate number and must be keyed separately.
    // Assert an exact key, not just a non-null lookup: getModelPricing falls
    // back to prefix matching, so a typo'd or delisted id still resolves — to
    // some neighbouring model's rates.
    expect(MODEL_PRICING['deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo']).toBeDefined();

    const rates = getModelPricing('deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo');
    expect(rates).not.toBeNull();

    const cost = calculateCost('deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo', 1_000, 1_000);
    expect(cost).toBeCloseTo(1_000 * rates!.prompt + 1_000 * rates!.completion, 12);
    expect(cost).toBeGreaterThan(0);
  });

  it('applies the 20% DeepInfra native batch discount', () => {
    const usage = { promptTokens: 100_000, completionTokens: 10_000 };
    const model = 'deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo';

    const standard = calculateProviderCost({ model, usage });
    const native = calculateProviderCost({ model, usage, batchMode: 'native' });

    expect(standard.multiplier).toBe(1);
    expect(native.multiplier).toBe(0.8);
    expect(native.estimatedCost).toBeCloseTo(standard.estimatedCost * 0.8, 12);
  });
  const model = 'openai/gpt-4o';
  const requests = [
    { custom_id: 'req-1', messages: [{ role: 'user' as const, content: 'Hello' }] },
    { custom_id: 'req-2', messages: [{ role: 'user' as const, content: 'World' }] },
  ];

  it('concurrent batch without flex charges full price', async () => {
    const manager = new BatchManager(createMockRouter(model), { dir: TEST_DIR });

    const results = await manager.createAndPoll({
      model,
      requests,
      batch_mode: 'concurrent',
    }, { interval: 50 });

    const fullCost = calculateCost(model, 100, 50);
    expect(results.usage_summary.estimated_cost).toBeCloseTo(fullCost * 2, 10);
  });

  it('concurrent batch with flex charges 50% discount', async () => {
    const manager = new BatchManager(createMockRouter(model), { dir: TEST_DIR });

    const results = await manager.createAndPoll({
      model,
      requests,
      batch_mode: 'concurrent',
      options: { service_tier: 'flex' },
    }, { interval: 50 });

    const fullCost = calculateCost(model, 100, 50);
    expect(results.usage_summary.estimated_cost).toBeCloseTo(fullCost * 2 * 0.5, 10);
  });

  it('concurrent batch with service_tier auto charges full price', async () => {
    const manager = new BatchManager(createMockRouter(model), { dir: TEST_DIR });

    const results = await manager.createAndPoll({
      model,
      requests,
      batch_mode: 'concurrent',
      options: { service_tier: 'auto' },
    }, { interval: 50 });

    const fullCost = calculateCost(model, 100, 50);
    expect(results.usage_summary.estimated_cost).toBeCloseTo(fullCost * 2, 10);
  });

  it('service_tier is persisted on batch metadata', async () => {
    const manager = new BatchManager(createMockRouter(model), { dir: TEST_DIR });

    const batch = await manager.create({
      model,
      requests,
      batch_mode: 'concurrent',
      options: { service_tier: 'flex' },
    });

    expect(batch.service_tier).toBe('flex');

    // Verify it survives a round-trip through the store
    const retrieved = await manager.get(batch.id);
    expect(retrieved?.service_tier).toBe('flex');
  });

  it('service_tier defaults to undefined when not specified', async () => {
    const manager = new BatchManager(createMockRouter(model), { dir: TEST_DIR });

    const batch = await manager.create({
      model,
      requests,
      batch_mode: 'concurrent',
    });

    expect(batch.service_tier).toBeUndefined();
  });

  it('service_tier falls back to first request item', async () => {
    const manager = new BatchManager(createMockRouter(model), { dir: TEST_DIR });

    const batch = await manager.create({
      model,
      requests: [
        { custom_id: 'req-1', messages: [{ role: 'user', content: 'Hi' }], service_tier: 'flex' },
        { custom_id: 'req-2', messages: [{ role: 'user', content: 'Hi' }] },
      ],
      batch_mode: 'concurrent',
    });

    expect(batch.service_tier).toBe('flex');
  });
});
