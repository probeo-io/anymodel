import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BatchManager } from '../src/batch/manager.js';
import { calculateCost } from '../src/generated/pricing.js';
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
