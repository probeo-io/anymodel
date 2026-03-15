import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BatchManager } from '../src/batch/manager.js';
import { BatchStore } from '../src/batch/store.js';
import type { BatchAdapter, NativeBatchStatus } from '../src/providers/adapter.js';
import type { BatchResultItem } from '../src/types.js';
import type { Router } from '../src/router.js';

const TEST_DIR = join(import.meta.dirname, '.test-native-batches');

function createMockRouter(): Router {
  return {
    complete: vi.fn(),
    stream: vi.fn(),
  } as unknown as Router;
}

function createMockBatchAdapter(overrides: Partial<BatchAdapter> = {}): BatchAdapter {
  return {
    createBatch: vi.fn().mockResolvedValue({
      providerBatchId: 'provider-batch-123',
      metadata: { some: 'data' },
    }),
    pollBatch: vi.fn().mockResolvedValue({
      status: 'completed',
      total: 2,
      completed: 2,
      failed: 0,
    } as NativeBatchStatus),
    getBatchResults: vi.fn().mockResolvedValue([
      {
        custom_id: 'req-1',
        status: 'success',
        response: {
          id: 'gen-1',
          object: 'chat.completion',
          created: 1000,
          model: 'openai/gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello 1' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        error: null,
      },
      {
        custom_id: 'req-2',
        status: 'success',
        response: {
          id: 'gen-2',
          object: 'chat.completion',
          created: 1000,
          model: 'openai/gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello 2' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        error: null,
      },
    ] as BatchResultItem[]),
    cancelBatch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('BatchManager native batch routing', () => {
  it('uses native adapter when provider has one registered', async () => {
    const router = createMockRouter();
    const adapter = createMockBatchAdapter();
    const manager = new BatchManager(router, { dir: TEST_DIR });
    manager.registerBatchAdapter('openai', adapter);

    const batch = await manager.create({
      model: 'openai/gpt-4o',
      requests: [
        { custom_id: 'req-1', messages: [{ role: 'user', content: 'Hi' }] },
        { custom_id: 'req-2', messages: [{ role: 'user', content: 'Hello' }] },
      ],
    });

    expect(batch.batch_mode).toBe('native');
    expect(batch.provider_name).toBe('openai');

    // Give the background process a moment
    await new Promise(r => setTimeout(r, 100));

    expect(adapter.createBatch).toHaveBeenCalledWith(
      'gpt-4o',
      expect.any(Array),
      undefined,
    );
  });

  it('falls back to concurrent when no native adapter', async () => {
    const router = createMockRouter();
    (router.complete as any).mockResolvedValue({
      id: 'gen-1',
      object: 'chat.completion',
      created: 1000,
      model: 'google/gemini-2.0-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });

    const manager = new BatchManager(router, { dir: TEST_DIR });

    const batch = await manager.create({
      model: 'google/gemini-2.0-flash',
      requests: [
        { custom_id: 'req-1', messages: [{ role: 'user', content: 'Hi' }] },
      ],
    });

    expect(batch.batch_mode).toBe('concurrent');
  });

  it('persists provider state for native batches', async () => {
    const router = createMockRouter();
    const adapter = createMockBatchAdapter();
    const manager = new BatchManager(router, { dir: TEST_DIR });
    manager.registerBatchAdapter('openai', adapter);

    const batch = await manager.create({
      model: 'openai/gpt-4o',
      requests: [
        { custom_id: 'req-1', messages: [{ role: 'user', content: 'Hi' }] },
      ],
    });

    await new Promise(r => setTimeout(r, 100));

    const store = new BatchStore(TEST_DIR);
    const state = await store.loadProviderState(batch.id);
    expect(state?.providerBatchId).toBe('provider-batch-123');
    expect(state?.providerName).toBe('openai');
  });

  it('polls and downloads results for native batch', async () => {
    const router = createMockRouter();
    const adapter = createMockBatchAdapter();
    const manager = new BatchManager(router, { dir: TEST_DIR });
    manager.registerBatchAdapter('openai', adapter);

    const results = await manager.createAndPoll(
      {
        model: 'openai/gpt-4o',
        requests: [
          { custom_id: 'req-1', messages: [{ role: 'user', content: 'Hi' }] },
          { custom_id: 'req-2', messages: [{ role: 'user', content: 'Hello' }] },
        ],
      },
      { interval: 50 },
    );

    expect(results.status).toBe('completed');
    expect(results.results).toHaveLength(2);
    expect(results.results[0].custom_id).toBe('req-1');
    expect(results.results[1].custom_id).toBe('req-2');
    expect(results.usage_summary.total_prompt_tokens).toBe(20);
    expect(results.usage_summary.total_completion_tokens).toBe(10);
  });

  it('cancels native batch at provider', async () => {
    const router = createMockRouter();
    const adapter = createMockBatchAdapter({
      pollBatch: vi.fn().mockResolvedValue({
        status: 'processing',
        total: 2,
        completed: 0,
        failed: 0,
      } as NativeBatchStatus),
    });
    const manager = new BatchManager(router, { dir: TEST_DIR });
    manager.registerBatchAdapter('anthropic', adapter);

    const batch = await manager.create({
      model: 'anthropic/claude-sonnet-4-6',
      requests: [
        { custom_id: 'req-1', messages: [{ role: 'user', content: 'Hi' }] },
      ],
    });

    await new Promise(r => setTimeout(r, 100));

    const cancelled = await manager.cancel(batch.id);
    expect(cancelled.status).toBe('cancelled');
    expect(adapter.cancelBatch).toHaveBeenCalledWith('provider-batch-123');
  });

  it('handles native batch creation failure', async () => {
    const router = createMockRouter();
    const adapter = createMockBatchAdapter({
      createBatch: vi.fn().mockRejectedValue(new Error('Upload failed')),
    });
    const manager = new BatchManager(router, { dir: TEST_DIR });
    manager.registerBatchAdapter('openai', adapter);

    const batch = await manager.create({
      model: 'openai/gpt-4o',
      requests: [
        { custom_id: 'req-1', messages: [{ role: 'user', content: 'Hi' }] },
      ],
    });

    await new Promise(r => setTimeout(r, 100));

    const meta = await manager.get(batch.id);
    expect(meta?.status).toBe('failed');
  });

  it('handles per-item errors in native batch results', async () => {
    const router = createMockRouter();
    const adapter = createMockBatchAdapter({
      getBatchResults: vi.fn().mockResolvedValue([
        {
          custom_id: 'req-1',
          status: 'success',
          response: {
            id: 'gen-1',
            object: 'chat.completion',
            created: 1000,
            model: 'openai/gpt-4o',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
          error: null,
        },
        {
          custom_id: 'req-2',
          status: 'error',
          response: null,
          error: { code: 400, message: 'Invalid request' },
        },
      ] as BatchResultItem[]),
      pollBatch: vi.fn().mockResolvedValue({
        status: 'completed',
        total: 2,
        completed: 1,
        failed: 1,
      } as NativeBatchStatus),
    });
    const manager = new BatchManager(router, { dir: TEST_DIR });
    manager.registerBatchAdapter('openai', adapter);

    const results = await manager.createAndPoll(
      {
        model: 'openai/gpt-4o',
        requests: [
          { custom_id: 'req-1', messages: [{ role: 'user', content: 'Hi' }] },
          { custom_id: 'req-2', messages: [{ role: 'user', content: 'Bad request' }] },
        ],
      },
      { interval: 50 },
    );

    expect(results.status).toBe('completed');
    expect(results.results).toHaveLength(2);
    expect(results.results[0].status).toBe('success');
    expect(results.results[1].status).toBe('error');
    expect(results.results[1].error?.message).toBe('Invalid request');
  });

  it('reports progress via onProgress callback', async () => {
    const router = createMockRouter();
    const adapter = createMockBatchAdapter();
    const manager = new BatchManager(router, { dir: TEST_DIR });
    manager.registerBatchAdapter('openai', adapter);

    const progressUpdates: any[] = [];

    await manager.createAndPoll(
      {
        model: 'openai/gpt-4o',
        requests: [
          { custom_id: 'req-1', messages: [{ role: 'user', content: 'Hi' }] },
        ],
      },
      {
        interval: 50,
        onProgress: (batch) => progressUpdates.push({ ...batch }),
      },
    );

    expect(progressUpdates.length).toBeGreaterThan(0);
  });
});
