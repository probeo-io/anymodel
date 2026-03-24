import type {
  BatchCreateRequest,
  BatchObject,
  BatchResults,
  BatchResultItem,
  ChatCompletionRequest,
  BatchUsageSummary,
} from '../types.js';
import { AnyModelError } from '../types.js';
import { generateId } from '../utils/id.js';
import { calculateCost } from '../generated/pricing.js';
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
  /** Log polling progress to console. Default: false (or true when ANYMODEL_BATCH_POLL_LOG=1/true) */
  logToConsole?: boolean;
}

export class BatchManager {
  private store: BatchStore;
  private router: Router;
  private concurrencyLimit: number;
  private defaultPollInterval: number;
  private batchAdapters = new Map<string, BatchAdapter>();

  constructor(router: Router, options?: { dir?: string; concurrency?: number; pollInterval?: number }) {
    this.store = new BatchStore(options?.dir);
    this.router = router;
    this.concurrencyLimit = options?.concurrency ?? 5;
    this.defaultPollInterval = options?.pollInterval ?? 5000;
  }

  /** Expose the store for use by BatchBuilder. */
  getStore(): BatchStore {
    return this.store;
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
    const native = request.batch_mode !== 'concurrent' ? this.getNativeBatchAdapter(request.model) : null;
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

    await this.store.create(batch);
    await this.store.saveRequests(id, request.requests);

    if (native) {
      this.processNativeBatch(id, request, native.adapter).catch(() => {});
    } else {
      this.processConcurrentBatch(id, request.model, request.options as Record<string, unknown> | undefined).catch(() => {});
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
    const interval = options.interval ?? this.defaultPollInterval;
    const timeout = options.timeout ?? 0;
    const startTime = Date.now();
    const envLog = String(process.env.ANYMODEL_BATCH_POLL_LOG || '').trim().toLowerCase();
    const logToConsole = options.logToConsole ?? (envLog === '1' || envLog === 'true' || envLog === 'yes');

    while (true) {
      let batch = await this.store.getMeta(id);
      if (!batch) {
        throw new AnyModelError(404, `Batch ${id} not found`);
      }

      // For native batches, sync status from provider
      if (batch.batch_mode === 'native' && batch.status === 'processing') {
        await this.syncNativeBatchStatus(id);
        batch = await this.store.getMeta(id);
        if (!batch) throw new AnyModelError(404, `Batch ${id} not found`);
      }

      if (options.onProgress) {
        options.onProgress(batch);
      }
      if (logToConsole) {
        console.log(
          `[anymodel][batch.poll] id=${batch.id} status=${batch.status} mode=${batch.batch_mode} progress=${batch.completed}/${batch.total} failed=${batch.failed}`,
        );
      }

      if (batch.status === 'completed' || batch.status === 'failed' || batch.status === 'cancelled') {
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
  async get(id: string): Promise<BatchObject | null> {
    return this.store.getMeta(id);
  }

  /**
   * Get results for a completed batch.
   */
  async getResults(id: string): Promise<BatchResults> {
    const batch = await this.store.getMeta(id);
    if (!batch) {
      throw new AnyModelError(404, `Batch ${id} not found`);
    }

    const results = await this.store.getResults(id);

    const usage: BatchUsageSummary = {
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      estimated_cost: 0,
    };

    for (const result of results) {
      if (result.response) {
        usage.total_prompt_tokens += result.response.usage.prompt_tokens;
        usage.total_completion_tokens += result.response.usage.completion_tokens;
        usage.estimated_cost += calculateCost(
          result.response.model || batch.model,
          result.response.usage.prompt_tokens,
          result.response.usage.completion_tokens,
        );
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
  async list(): Promise<BatchObject[]> {
    const ids = await this.store.listBatches();
    const batches: BatchObject[] = [];
    for (const id of ids) {
      const meta = await this.store.getMeta(id);
      if (meta) batches.push(meta);
    }
    return batches;
  }

  /**
   * Cancel a batch.
   */
  async cancel(id: string): Promise<BatchObject> {
    const batch = await this.store.getMeta(id);
    if (!batch) {
      throw new AnyModelError(404, `Batch ${id} not found`);
    }
    if (batch.status === 'completed' || batch.status === 'cancelled') {
      return batch;
    }

    // If native batch, cancel at provider too
    if (batch.batch_mode === 'native') {
      const providerState = await this.store.loadProviderState(id);
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
    await this.store.updateMeta(batch);
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
    const batch = await this.store.getMeta(batchId);
    if (!batch) return;

    try {
      const model = request.model.includes('/')
        ? request.model.split('/').slice(1).join('/')
        : request.model;

      const { providerBatchId, metadata } = await adapter.createBatch(
        model,
        request.requests,
        request.options as Record<string, unknown> | undefined,
      );

      await this.store.saveProviderState(batchId, {
        providerBatchId,
        providerName: batch.provider_name,
        ...metadata,
      });

      batch.status = 'processing';
      await this.store.updateMeta(batch);
    } catch (err) {
      batch.status = 'failed';
      batch.completed_at = new Date().toISOString();
      await this.store.updateMeta(batch);
      throw err;
    }
  }

  /**
   * Sync native batch status from provider.
   */
  private async syncNativeBatchStatus(batchId: string): Promise<void> {
    const batch = await this.store.getMeta(batchId);
    if (!batch) return;

    const providerState = await this.store.loadProviderState(batchId);
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

        if (status.status === 'completed' || status.status === 'failed') {
          try {
            const results = await adapter.getBatchResults(providerState.providerBatchId as string);
            for (const result of results) {
              await this.store.appendResult(batchId, result);
            }
            batch.completed = results.filter(r => r.status === 'success').length;
            batch.failed = results.filter(r => r.status === 'error').length;
          } catch {
            if (batch.status !== 'failed') {
              batch.status = 'failed';
            }
          }
        }
      } else {
        batch.status = 'processing';
      }

      await this.store.updateMeta(batch);
    } catch {
      // Provider API error during poll — don't change status
    }
  }

  /**
   * Process batch requests concurrently (fallback path).
   * Streams requests from disk to avoid holding them all in memory.
   */
  private async processConcurrentBatch(batchId: string, model: string, options?: Record<string, unknown>): Promise<void> {
    const batch = await this.store.getMeta(batchId);
    if (!batch) return;
    batch.status = 'processing';
    await this.store.updateMeta(batch);

    const active = new Set<Promise<void>>();

    const processItem = async (item: any): Promise<void> => {
      const current = await this.store.getMeta(batchId);
      if (current?.status === 'cancelled') return;

      const chatRequest: ChatCompletionRequest = {
        model,
        messages: item.messages,
        max_tokens: item.max_tokens ?? (options as any)?.max_tokens,
        temperature: item.temperature ?? (options as any)?.temperature,
        top_p: item.top_p ?? (options as any)?.top_p,
        top_k: item.top_k ?? (options as any)?.top_k,
        stop: item.stop ?? (options as any)?.stop,
        response_format: item.response_format ?? (options as any)?.response_format,
        tools: item.tools ?? (options as any)?.tools,
        tool_choice: item.tool_choice ?? (options as any)?.tool_choice,
        service_tier: item.service_tier ?? (options as any)?.service_tier,
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

      await this.store.appendResult(batchId, result);

      const meta = await this.store.getMeta(batchId);
      if (meta) {
        if (result.status === 'success') {
          meta.completed++;
        } else {
          meta.failed++;
        }
        await this.store.updateMeta(meta);
      }
    };

    // Stream requests from disk instead of holding all in memory
    for await (const item of this.store.streamRequests(batchId)) {
      const current = await this.store.getMeta(batchId);
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

    const finalMeta = await this.store.getMeta(batchId);
    if (finalMeta && finalMeta.status !== 'cancelled') {
      finalMeta.status = finalMeta.failed === finalMeta.total ? 'failed' : 'completed';
      finalMeta.completed_at = new Date().toISOString();
      await this.store.updateMeta(finalMeta);
    }
  }
}
