// Client
export { AnyModel } from './client.js';

// Types
export type {
  // Messages
  Message,
  Role,
  ContentPart,

  // Tools
  Tool,
  FunctionTool,
  WebSearchTool,
  ToolChoice,
  ToolCall,

  // Request / Response
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionChoice,
  ChatCompletionChunk,
  ChunkChoice,
  ChunkDelta,
  ResponseFormat,
  PromptCacheOptions,
  ProviderPreferences,
  Usage,
  FinishReason,

  // Models
  ModelInfo,
  ModelPricing,
  ModelArchitecture,
  ModelTopProvider,

  // Generation
  GenerationStats,

  // Batch
  BatchCreateRequest,
  BatchRequestItem,
  BatchObject,
  BatchResultItem,
  BatchResults,
  BatchUsageSummary,
  BatchStatus,
  BatchMode,

  // Config
  AnyModelConfig,
  ProviderConfig,
  CustomProviderConfig,

  // Response metadata
  ResponseMeta,
  ChatCompletionWithMeta,

  // Errors
  AnyModelErrorMetadata,
} from './types.js';

export { AnyModelError } from './types.js';

// Config
export { resolveConfig } from './config.js';

// Generation stats
export { GenerationStatsStore } from './utils/generation-stats.js';

// Batch
export { BatchManager, BatchStore, BatchBuilder } from './batch/index.js';
export type { BatchPollOptions, BatchBuilderConfig, BatchBuilderResults, BatchBuilderSuccessItem, BatchBuilderFailedItem } from './batch/index.js';

// Prompt caching
export { createPromptCacheKey, withPromptCache } from './cache.js';
export type { PromptCacheKeyOptions } from './cache.js';

// Server
export { createAnyModelServer, startServer } from './server.js';
export type { ServerOptions } from './server.js';

// Filesystem IO (queued, high-volume)
export {
  configureFsIO,
  readFileQueued,
  writeFileQueued,
  writeFileFlushedQueued,
  appendFileQueued,
  ensureDir,
  joinPath,
  getFsQueueStatus,
  waitForFsQueuesIdle,
} from './utils/fs-io.js';

// Provider adapters (for custom adapters)
export type { ProviderAdapter, BatchAdapter, NativeBatchStatus } from './providers/adapter.js';
export { createOpenAIBatchAdapter } from './providers/openai-batch.js';
export { createAnthropicBatchAdapter } from './providers/anthropic-batch.js';
export { createGoogleBatchAdapter } from './providers/google-batch.js';
export { createXAIBatchAdapter } from './providers/xai-batch.js';

// Adaptive concurrency
export { AdaptiveConcurrencyController } from './utils/adaptive-concurrency.js';
export type { AdaptiveConcurrencyOptions } from './utils/adaptive-concurrency.js';

// Token estimation
export { resolveMaxTokens, estimateTokenCount } from './utils/token-estimate.js';

// Pricing
export { getModelPricing, calculateCost, calculateProviderCost, PRICING_AS_OF, PRICING_MODEL_COUNT } from './generated/pricing.js';
export type { PricingEntry } from './generated/pricing.js';
export { providerPricingMultiplier } from './pricing/provider-policy.js';
export type { PricingMode } from './pricing/provider-policy.js';
