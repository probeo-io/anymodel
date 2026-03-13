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

  constructor(router: Router, options?: { dir?: string; concurrency?: number }) {
    this.store = new BatchStore(options?.dir);
    this.router = router;
    this.concurrencyLimit = options?.concurrency ?? 5;
  }

  /**
   * Create a batch and return immediately (no polling).
   */
  async create(request: BatchCreateRequest): Promise<BatchObject> {
    const id = generateId('batch');
    const now = new Date().toISOString();

    const batch: BatchObject = {
      id,
      object: 'batch',
      status: 'pending',
      model: request.model,
      provider_name: request.model.split('/')[0] || 'unknown',
      batch_mode: 'concurrent',
      total: request.requests.length,
      completed: 0,
      failed: 0,
      created_at: now,
      completed_at: null,
      expires_at: null,
    };

    this.store.create(batch);
    this.store.saveRequests(id, request.requests);

    // Start processing in the background
    this.processBatch(id, request).catch(() => {
      // Processing errors are captured per-item
    });

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
    const timeout = options.timeout ?? 0; // 0 = indefinite
    const startTime = Date.now();

    while (true) {
      const batch = this.store.getMeta(id);
      if (!batch) {
        throw new AnyModelError(404, `Batch ${id} not found`);
      }

      if (options.onProgress) {
        options.onProgress(batch);
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
  cancel(id: string): BatchObject {
    const batch = this.store.getMeta(id);
    if (!batch) {
      throw new AnyModelError(404, `Batch ${id} not found`);
    }
    if (batch.status === 'completed' || batch.status === 'cancelled') {
      return batch;
    }

    batch.status = 'cancelled';
    batch.completed_at = new Date().toISOString();
    this.store.updateMeta(batch);
    return batch;
  }

  /**
   * Process batch requests concurrently.
   */
  private async processBatch(batchId: string, request: BatchCreateRequest): Promise<void> {
    const batch = this.store.getMeta(batchId)!;
    batch.status = 'processing';
    this.store.updateMeta(batch);

    const items = request.requests;
    const queue = [...items];
    const active = new Set<Promise<void>>();

    const processItem = async (item: typeof items[0]): Promise<void> => {
      // Check if batch was cancelled
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

      // Update counts
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

    // Wait for remaining
    await Promise.all(active);

    // Finalize
    const finalMeta = this.store.getMeta(batchId)!;
    if (finalMeta.status !== 'cancelled') {
      finalMeta.status = finalMeta.failed === finalMeta.total ? 'failed' : 'completed';
      finalMeta.completed_at = new Date().toISOString();
      this.store.updateMeta(finalMeta);
    }
  }
}
