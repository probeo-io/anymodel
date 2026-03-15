import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BatchStore } from '../src/batch/store.js';
import type { BatchObject, BatchResultItem } from '../src/types.js';

const TEST_DIR = join(import.meta.dirname, '.test-batches');

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('BatchStore', () => {
  it('creates and retrieves batch metadata', async () => {
    const store = new BatchStore(TEST_DIR);
    const batch: BatchObject = {
      id: 'batch-test1',
      object: 'batch',
      status: 'pending',
      model: 'anthropic/claude-sonnet-4-6',
      provider_name: 'anthropic',
      batch_mode: 'concurrent',
      total: 3,
      completed: 0,
      failed: 0,
      created_at: new Date().toISOString(),
      completed_at: null,
      expires_at: null,
    };

    await store.create(batch);
    const retrieved = await store.getMeta('batch-test1');
    expect(retrieved).toEqual(batch);
  });

  it('updates metadata', async () => {
    const store = new BatchStore(TEST_DIR);
    const batch: BatchObject = {
      id: 'batch-test2',
      object: 'batch',
      status: 'pending',
      model: 'openai/gpt-4o',
      provider_name: 'openai',
      batch_mode: 'concurrent',
      total: 2,
      completed: 0,
      failed: 0,
      created_at: new Date().toISOString(),
      completed_at: null,
      expires_at: null,
    };

    await store.create(batch);
    batch.status = 'completed';
    batch.completed = 2;
    await store.updateMeta(batch);

    const retrieved = await store.getMeta('batch-test2');
    expect(retrieved!.status).toBe('completed');
    expect(retrieved!.completed).toBe(2);
  });

  it('appends and retrieves results', async () => {
    const store = new BatchStore(TEST_DIR);
    const batch: BatchObject = {
      id: 'batch-test3',
      object: 'batch',
      status: 'processing',
      model: 'openai/gpt-4o',
      provider_name: 'openai',
      batch_mode: 'concurrent',
      total: 2,
      completed: 0,
      failed: 0,
      created_at: new Date().toISOString(),
      completed_at: null,
      expires_at: null,
    };
    await store.create(batch);

    const result1: BatchResultItem = {
      custom_id: 'req-1',
      status: 'success',
      response: {
        id: 'gen-abc',
        object: 'chat.completion',
        created: Date.now(),
        model: 'openai/gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      error: null,
    };

    const result2: BatchResultItem = {
      custom_id: 'req-2',
      status: 'error',
      response: null,
      error: { code: 429, message: 'Rate limited' },
    };

    await store.appendResult('batch-test3', result1);
    await store.appendResult('batch-test3', result2);

    const results = await store.getResults('batch-test3');
    expect(results).toHaveLength(2);
    expect(results[0].custom_id).toBe('req-1');
    expect(results[1].status).toBe('error');
  });

  it('lists batches', async () => {
    const store = new BatchStore(TEST_DIR);
    for (const id of ['batch-a', 'batch-b', 'batch-c']) {
      await store.create({
        id,
        object: 'batch',
        status: 'pending',
        model: 'openai/gpt-4o',
        provider_name: 'openai',
        batch_mode: 'concurrent',
        total: 1,
        completed: 0,
        failed: 0,
        created_at: new Date().toISOString(),
        completed_at: null,
        expires_at: null,
      });
    }

    const batches = await store.listBatches();
    expect(batches).toHaveLength(3);
    expect(batches).toContain('batch-a');
  });

  it('saves and loads provider state', async () => {
    const store = new BatchStore(TEST_DIR);
    await store.create({
      id: 'batch-ps',
      object: 'batch',
      status: 'pending',
      model: 'openai/gpt-4o',
      provider_name: 'openai',
      batch_mode: 'concurrent',
      total: 1,
      completed: 0,
      failed: 0,
      created_at: new Date().toISOString(),
      completed_at: null,
      expires_at: null,
    });

    await store.saveProviderState('batch-ps', { providerBatchId: 'oai-batch-123' });
    const state = await store.loadProviderState('batch-ps');
    expect(state?.providerBatchId).toBe('oai-batch-123');
  });

  it('returns null for nonexistent batch', async () => {
    const store = new BatchStore(TEST_DIR);
    expect(await store.getMeta('nonexistent')).toBeNull();
  });
});
