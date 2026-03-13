import type {
  BatchCreateRequest,
  BatchObject,
  BatchResults,
  BatchResultItem,
  ChatCompletionRequest,
  ChatCompletion,
  BatchUsageSummary,
} from '../types.js';
import { AnyModelError } from '../types.js';
import { generateId } from '../utils/id.js';
import { BatchStore } from './store.js';
import type { Router } from '../router.js';
import type { BatchAdapter } from '../providers/adapter.js';

export interface BatchPollOptions {
  /** Poll interval in ms. Default: 5000 */
  interval?: number;
  /** Timeout in ms. 0 = indefinite. Default: 0 */
  timeout?: number;
  /** Progress callback */
  onProgress?: (batch: BatchObject) => void;
}

export class BatchManager {
  private store: BatchStore;
  private router: Router;
  private concurrencyLimit: number;
  private batchAdapters = new Map<string, BatchAdapter>();

  constructor(router: Router, options?: { dir?: string; concurrency?: number }) {
    this.store = new BatchStore(options?.dir);
    this.router = router;
    this.concurrencyLimit = options?.concurrency ?? 5;
  }

  /**
   * Register a native batch adapter for a provider.
   */
  registerBatchAdapter(providerName: string, adapter: BatchAdapter): void {
    this.batchAdapters.set(providerName, adapter);
  }

  /**
   * Check if a provider has native batch support.
   */
  private getNativeBatchAdapter(model: string): { adapter: BatchAdapter; providerName: string } | null {
    const providerName = model.split('/')[0];
    const adapter = this.batchAdapters.get(providerName);
    return adapter ? { adapter, providerName } : null;
  }

  /**
   * Create a batch and return immediately (no polling).
   */
  async create(request: BatchCreateRequest): Promise<BatchObject> {
    const id = generateId('batch');
    const now = new Date().toISOString();
    const providerName = request.model.split('/')[0] || 'unknown';
    const native = this.getNativeBatchAdapter(request.model);
    const batchMode = native ? 'native' as const : 'concurrent' as const;

    const batch: BatchObject = {
      id,
      object: 'batch',
      status: 'pending',
      model: request.model,
      provider_name: providerName,
      batch_mode: batchMode,
      total: request.requests.length,
      completed: 0,
      failed: 0,
      created_at: now,
      completed_at: null,
      expires_at: null,
    };

    this.store.create(batch);
    this.store.saveRequests(id, request.requests);

    if (native) {
      // Native batch path
      this.processNativeBatch(id, request, native.adapter).catch(() => {});
    } else {
      // Concurrent fallback path
      this.processConcurrentBatch(id, request).catch(() => {});
    }

    return batch;
  }

  /**
   * Create a batch and poll until completion.
   */
  async createAndPoll(
    request: BatchCreateRequest,
    options: BatchPollOptions = {},
  ): Promise<BatchResults> {
    const batch = await this.create(request);
    return this.poll(batch.id, options);
  }

  /**
   * Poll an existing batch until completion.
   */
  async poll(id: string, options: BatchPollOptions = {}): Promise<BatchResults> {
    const interval = options.interval ?? 5000;
    const timeout = options.timeout ?? 0;
    const startTime = Date.now();

    while (true) {
      const batch = this.store.getMeta(id);
      if (!batch) {
        throw new AnyModelError(404, `Batch ${id} not found`);
      }

      // For native batches, sync status from provider
      if (batch.batch_mode === 'native' && batch.status === 'processing') {
        await this.syncNativeBatchStatus(id);
      }

      // Re-read after possible sync
      const current = this.store.getMeta(id)!;

      if (options.onProgress) {
        options.onProgress(current);
      }

      if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
        return this.getResults(id);
      }

      if (timeout > 0 && Date.now() - startTime > timeout) {
        throw new AnyModelError(408, `Batch ${id} timed out after ${timeout}ms`);
      }

      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  /**
   * Get the current status of a batch.
   */
  get(id: string): BatchObject | null {
    return this.store.getMeta(id);
  }

  /**
   * Get results for a completed batch.
   */
  getResults(id: string): BatchResults {
    const batch = this.store.getMeta(id);
    if (!batch) {
      throw new AnyModelError(404, `Batch ${id} not found`);
    }

    const results = this.store.getResults(id);

    const usage: BatchUsageSummary = {
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      estimated_cost: 0,
    };

    for (const result of results) {
      if (result.response) {
        usage.total_prompt_tokens += result.response.usage.prompt_tokens;
        usage.total_completion_tokens += result.response.usage.completion_tokens;
      }
    }

    return {
      id: batch.id,
      status: batch.status,
      results,
      usage_summary: usage,
    };
  }

  /**
   * List all batches.
   */
  list(): BatchObject[] {
    return this.store.listBatches()
      .map(id => this.store.getMeta(id))
      .filter((b): b is BatchObject => b !== null);
  }

  /**
   * Cancel a batch.
   */
  async cancel(id: string): Promise<BatchObject> {
    const batch = this.store.getMeta(id);
    if (!batch) {
      throw new AnyModelError(404, `Batch ${id} not found`);
    }
    if (batch.status === 'completed' || batch.status === 'cancelled') {
      return batch;
    }

    // If native batch, cancel at provider too
    if (batch.batch_mode === 'native') {
      const providerState = this.store.loadProviderState(id);
      const adapter = this.batchAdapters.get(batch.provider_name);
      if (adapter && providerState?.providerBatchId) {
        try {
          await adapter.cancelBatch(providerState.providerBatchId as string);
        } catch {
          // Best-effort cancellation
        }
      }
    }

    batch.status = 'cancelled';
    batch.completed_at = new Date().toISOString();
    this.store.updateMeta(batch);
    return batch;
  }

  /**
   * Process batch via native provider batch API.
   */
  private async processNativeBatch(
    batchId: string,
    request: BatchCreateRequest,
    adapter: BatchAdapter,
  ): Promise<void> {
    const batch = this.store.getMeta(batchId)!;

    try {
      // Strip provider prefix from model for the provider API
      const model = request.model.includes('/')
        ? request.model.split('/').slice(1).join('/')
        : request.model;

      // Create batch at provider
      const { providerBatchId, metadata } = await adapter.createBatch(
        model,
        request.requests,
        request.options as Record<string, unknown> | undefined,
      );

      // Persist provider state for resumability
      this.store.saveProviderState(batchId, {
        providerBatchId,
        providerName: batch.provider_name,
        ...metadata,
      });

      batch.status = 'processing';
      this.store.updateMeta(batch);
    } catch (err) {
      batch.status = 'failed';
      batch.completed_at = new Date().toISOString();
      this.store.updateMeta(batch);
      throw err;
    }
  }

  /**
   * Sync native batch status from provider.
   * Called during polling to update local state.
   */
  private async syncNativeBatchStatus(batchId: string): Promise<void> {
    const batch = this.store.getMeta(batchId);
    if (!batch) return;

    const providerState = this.store.loadProviderState(batchId);
    if (!providerState?.providerBatchId) return;

    const adapter = this.batchAdapters.get(batch.provider_name);
    if (!adapter) return;

    try {
      const status = await adapter.pollBatch(providerState.providerBatchId as string);

      batch.total = status.total || batch.total;
      batch.completed = status.completed;
      batch.failed = status.failed;

      if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
        batch.status = status.status;
        batch.completed_at = new Date().toISOString();

        // Download and persist results
        if (status.status === 'completed' || status.status === 'failed') {
          try {
            const results = await adapter.getBatchResults(providerState.providerBatchId as string);
            for (const result of results) {
              this.store.appendResult(batchId, result);
            }
            // Update counts from actual results
            batch.completed = results.filter(r => r.status === 'success').length;
            batch.failed = results.filter(r => r.status === 'error').length;
          } catch {
            // Results download failed — mark as failed if not already
            if (batch.status !== 'failed') {
              batch.status = 'failed';
            }
          }
        }
      } else {
        batch.status = 'processing';
      }

      this.store.updateMeta(batch);
    } catch {
      // Provider API error during poll — don't change status
    }
  }

  /**
   * Process batch requests concurrently (fallback path).
   */
  private async processConcurrentBatch(batchId: string, request: BatchCreateRequest): Promise<void> {
    const batch = this.store.getMeta(batchId)!;
    batch.status = 'processing';
    this.store.updateMeta(batch);

    const items = request.requests;
    const queue = [...items];
    const active = new Set<Promise<void>>();

    const processItem = async (item: typeof items[0]): Promise<void> => {
      const current = this.store.getMeta(batchId);
      if (current?.status === 'cancelled') return;

      const chatRequest: ChatCompletionRequest = {
        model: request.model,
        messages: item.messages,
        max_tokens: item.max_tokens ?? request.options?.max_tokens,
        temperature: item.temperature ?? request.options?.temperature,
        top_p: item.top_p ?? request.options?.top_p,
        top_k: item.top_k ?? request.options?.top_k,
        stop: item.stop ?? request.options?.stop,
        response_format: item.response_format ?? request.options?.response_format,
        tools: item.tools ?? request.options?.tools,
        tool_choice: item.tool_choice ?? request.options?.tool_choice,
      };

      let result: BatchResultItem;
      try {
        const response = await this.router.complete(chatRequest);
        result = {
          custom_id: item.custom_id,
          status: 'success',
          response,
          error: null,
        };
      } catch (err) {
        const error = err instanceof AnyModelError ? err : new AnyModelError(500, String(err));
        result = {
          custom_id: item.custom_id,
          status: 'error',
          response: null,
          error: { code: error.code, message: error.message },
        };
      }

      this.store.appendResult(batchId, result);

      const meta = this.store.getMeta(batchId)!;
      if (result.status === 'success') {
        meta.completed++;
      } else {
        meta.failed++;
      }
      this.store.updateMeta(meta);
    };

    for (const item of queue) {
      const current = this.store.getMeta(batchId);
      if (current?.status === 'cancelled') break;

      if (active.size >= this.concurrencyLimit) {
        await Promise.race(active);
      }

      const promise = processItem(item).then(() => {
        active.delete(promise);
      });
      active.add(promise);
    }

    await Promise.all(active);

    const finalMeta = this.store.getMeta(batchId)!;
    if (finalMeta.status !== 'cancelled') {
      finalMeta.status = finalMeta.failed === finalMeta.total ? 'failed' : 'completed';
      finalMeta.completed_at = new Date().toISOString();
      this.store.updateMeta(finalMeta);
    }
  }
}
