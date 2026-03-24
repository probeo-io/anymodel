import type {
  Message,
  BatchRequestItem,
  BatchCreateRequest,
  ResponseFormat,
  Tool,
  ToolChoice,
} from '../types.js';
import { AnyModelError } from '../types.js';
import { generateId } from '../utils/id.js';
import { calculateCost } from '../generated/pricing.js';
import type { BatchStore } from './store.js';
import type { BatchManager, BatchPollOptions } from './manager.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BatchBuilderConfig {
  model: string;
  system?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop?: string | string[];
  response_format?: ResponseFormat;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  service_tier?: 'auto' | 'flex';
  /** Force batch mode: 'native' uses provider batch API, 'concurrent' sends individual requests. */
  batch_mode?: 'native' | 'concurrent';
}

export interface BatchBuilderSuccessItem {
  /** Internal ID for this item. */
  id: string;
  /** The response content. */
  content: string;
  /** Token usage. */
  usage: { prompt_tokens: number; completion_tokens: number };
  /** Estimated cost in USD. */
  cost: number;
  /** Raw response (for tool calls, etc.). */
  raw: unknown;
}

export interface BatchBuilderFailedItem {
  /** Internal ID for this item. */
  id: string;
  /** The original prompt that failed. */
  prompt: string | Message[];
  /** Error details. */
  error: { code: number; message: string; provider?: string };
  /** Whether this error is retryable (429, 500, 502, 503, 408). */
  retryable: boolean;
}

export interface BatchBuilderResults {
  /** Batch ID. */
  id: string;
  /** Successfully completed items. */
  succeeded: BatchBuilderSuccessItem[];
  /** Failed items with original prompts preserved. */
  failed: BatchBuilderFailedItem[];
  /** Aggregate usage. */
  usage: {
    total_prompt_tokens: number;
    total_completion_tokens: number;
    estimated_cost: number;
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const RETRYABLE_CODES = new Set([408, 429, 500, 502, 503, 529]);

// ─── BatchBuilder ───────────────────────────────────────────────────────────

/**
 * Ergonomic batch builder. Add prompts one at a time, submit when ready.
 *
 * ```ts
 * const batch = client.batches.open({ model: "anthropic/claude-sonnet-4-6", system: "You are an expert." });
 * batch.add("What is an LLC?");
 * batch.add("How do I dissolve an LLC?");
 * await batch.submit();
 * const results = await batch.poll();
 * ```
 */
export class BatchBuilder {
  private batchId: string;
  private config: BatchBuilderConfig;
  private store: BatchStore;
  private manager: BatchManager;
  private count = 0;
  private submitted = false;

  constructor(config: BatchBuilderConfig, store: BatchStore, manager: BatchManager) {
    this.batchId = generateId('batch');
    this.config = config;
    this.store = store;
    this.manager = manager;
  }

  /** The batch ID (available immediately after construction). */
  get id(): string {
    return this.batchId;
  }

  /** Number of prompts added so far. */
  get size(): number {
    return this.count;
  }

  /**
   * Add a prompt to the batch. Written to disk immediately.
   * @param content - A string prompt or an array of messages for multi-turn.
   */
  add(content: string | Message[]): this {
    if (this.submitted) {
      throw new AnyModelError(400, 'Cannot add to a submitted batch. Use retry() for failed items.');
    }

    let messages: Message[];

    if (typeof content === 'string') {
      messages = [];
      if (this.config.system) {
        messages.push({ role: 'system', content: this.config.system });
      }
      messages.push({ role: 'user', content });
    } else {
      messages = [...content];
      // Prepend system if configured and not already present
      if (this.config.system && !messages.some(m => m.role === 'system')) {
        messages.unshift({ role: 'system', content: this.config.system });
      }
    }

    const customId = `req-${String(this.count).padStart(6, '0')}`;

    const item: BatchRequestItem = {
      custom_id: customId,
      messages,
    };

    // Apply batch-level options
    if (this.config.max_tokens !== undefined) item.max_tokens = this.config.max_tokens;
    if (this.config.temperature !== undefined) item.temperature = this.config.temperature;
    if (this.config.top_p !== undefined) item.top_p = this.config.top_p;
    if (this.config.top_k !== undefined) item.top_k = this.config.top_k;
    if (this.config.stop !== undefined) item.stop = this.config.stop;
    if (this.config.response_format !== undefined) item.response_format = this.config.response_format;
    if (this.config.tools !== undefined) item.tools = this.config.tools;
    if (this.config.tool_choice !== undefined) item.tool_choice = this.config.tool_choice;
    if (this.config.service_tier !== undefined) item.service_tier = this.config.service_tier;

    // Write to disk immediately (fire and forget — appendRequest is fast)
    this.store.appendRequest(this.batchId, item);

    this.count++;
    return this;
  }

  /**
   * Submit the batch for processing.
   * Reads prompts from disk and dispatches to the provider.
   */
  async submit(): Promise<string> {
    if (this.submitted) {
      throw new AnyModelError(400, 'Batch already submitted.');
    }
    if (this.count === 0) {
      throw new AnyModelError(400, 'Cannot submit an empty batch. Call add() first.');
    }

    // Collect requests from disk
    const requests: BatchRequestItem[] = [];
    for await (const item of this.store.streamRequests(this.batchId)) {
      requests.push(item as BatchRequestItem);
    }

    const createRequest: BatchCreateRequest = {
      model: this.config.model,
      requests,
    };

    if (this.config.batch_mode) {
      createRequest.batch_mode = this.config.batch_mode;
    }

    // Use the manager's create — it will save requests and dispatch
    await this.manager.create(createRequest);

    this.submitted = true;
    return this.batchId;
  }

  /**
   * Poll until the batch completes. Returns clean succeeded/failed results.
   */
  async poll(options?: BatchPollOptions): Promise<BatchBuilderResults> {
    if (!this.submitted) {
      throw new AnyModelError(400, 'Batch not yet submitted. Call submit() first.');
    }

    const raw = await this.manager.poll(this.batchId, options);
    return this.transformResults(raw);
  }

  /**
   * Get results for an already-completed batch.
   */
  async getResults(): Promise<BatchBuilderResults> {
    if (!this.submitted) {
      throw new AnyModelError(400, 'Batch not yet submitted. Call submit() first.');
    }

    const raw = await this.manager.getResults(this.batchId);
    return this.transformResults(raw);
  }

  /**
   * Create a new batch builder pre-loaded with the failed items from a previous batch.
   * Call submit() on the returned builder to retry.
   */
  retry(failed: BatchBuilderFailedItem[]): BatchBuilder {
    const retryBuilder = new BatchBuilder(this.config, this.store, this.manager);
    for (const item of failed) {
      retryBuilder.add(item.prompt);
    }
    return retryBuilder;
  }

  /**
   * Cancel the batch.
   */
  async cancel(): Promise<void> {
    await this.manager.cancel(this.batchId);
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private async transformResults(raw: { id: string; status: string; results: any[]; usage_summary: any }): Promise<BatchBuilderResults> {
    // Build a map of custom_id → original prompt
    const promptMap = new Map<string, string | Message[]>();
    for await (const item of this.store.streamRequests(this.batchId)) {
      const req = item as BatchRequestItem;
      // Extract the user's original prompt from messages
      const userMessages = req.messages.filter(m => m.role !== 'system');
      if (userMessages.length === 1 && typeof userMessages[0].content === 'string') {
        promptMap.set(req.custom_id, userMessages[0].content);
      } else {
        promptMap.set(req.custom_id, req.messages);
      }
    }

    const succeeded: BatchBuilderSuccessItem[] = [];
    const failed: BatchBuilderFailedItem[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCost = 0;

    for (const result of raw.results) {
      if (result.status === 'success' && result.response) {
        const promptTokens = result.response.usage?.prompt_tokens || 0;
        const completionTokens = result.response.usage?.completion_tokens || 0;
        const cost = calculateCost(
          result.response.model || this.config.model,
          promptTokens,
          completionTokens,
        );

        totalPromptTokens += promptTokens;
        totalCompletionTokens += completionTokens;
        totalCost += cost;

        succeeded.push({
          id: result.custom_id,
          content: result.response.choices?.[0]?.message?.content || '',
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
          cost,
          raw: result.response,
        });
      } else {
        const errorCode = result.error?.code || 500;
        failed.push({
          id: result.custom_id,
          prompt: promptMap.get(result.custom_id) || '',
          error: {
            code: errorCode,
            message: result.error?.message || 'Unknown error',
            provider: this.config.model.split('/')[0],
          },
          retryable: RETRYABLE_CODES.has(errorCode),
        });
      }
    }

    return {
      id: this.batchId,
      succeeded,
      failed,
      usage: {
        total_prompt_tokens: totalPromptTokens,
        total_completion_tokens: totalCompletionTokens,
        estimated_cost: totalCost,
      },
    };
  }
}
